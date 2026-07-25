// Storage 真实回传(恢复闭环 PRD §5.4):bucket 重建 → 文件上传 → 逐键对账 → 抽样校验和。
// 通道 = 目标项目 Storage HTTP API + service-role key(R0 spike 1 实证:bucket 三属性
// 与 contentType/cacheControl/x-metadata 全保真;InvalidKey 是单文件失败不中断)。
// 重试幂等 = 上传前预检目标对象:同 key 同尺寸跳过、尺寸不同拒绝覆盖——不用 x-upsert,
// 静默覆盖在任何路径都不可能发生(评审第 11 轮)。对账用 list API 递归遍历目标(不依赖目标 DB
// 凭据,storage-only 恢复也有完整对账),**逐 bucket/key 比对 + 尺寸核对**——聚合数的
// >= 比较会被多余对象掩蔽缺失(评审第 8 轮)。
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Manifest, StorageFile } from "./manifest.js";
import { sampleStorageFiles } from "./drill.js";
import { log } from "./log.js";

// PRD §5.4.2:默认小并发、有界超时与重试,均有安全上限
const UPLOAD_CONCURRENCY = 4;
const CHECKSUM_SAMPLE_CAP = 10;
const API_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

export interface StorageRestoreTarget {
  supabaseUrl: string; // https://<ref>.supabase.co(调用方已经过严格校验)
  serviceRoleKey: string;
}

export interface ReconcileReport {
  /** manifest 文件在目标上逐键找到且尺寸一致的数量 */
  verified: number;
  missing: string[];
  sizeMismatched: string[];
  /** 目标上存在但 manifest 没有的对象数——非快照内容混在恢复目标里 = 不是干净恢复,计入失败裁决 */
  extras: number;
  matches: boolean;
}

export interface StorageRestoreSummary {
  bucketsCreated: string[];
  bucketsExisting: string[];
  /** manifest 未捕获属性的 bucket(以默认设置创建,如实上报,不猜测) */
  bucketsWithoutAttrs: string[];
  /** 既有 bucket 与 manifest 属性不一致的描述(warn 级:可能是用户有意配置) */
  bucketAttrDrift: string[];
  filesUploaded: number;
  bytesUploaded: number;
  /** 目标已有同 key 同尺寸对象而跳过的数量(重试残留;字节级抽样校验覆盖) */
  filesSkippedIdentical: number;
  filesFailed: { file: string; reason: string }[];
  /** 429/5xx/超时后的成功重试次数(可观测性:PRD §10.3) */
  retries: number;
  reconcile: ReconcileReport;
  checksumSample: { checked: number; mismatched: string[] };
  /** PRD §5.4.3:owner 语义边界,报告必须显示 */
  ownerNote: string;
}

function storageHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, apikey: key };
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * 带超时与有界重试的 Storage API 调用。只用于幂等操作(upsert 上传、list、GET、
 * 带 already-exists 处理的创建)——非幂等操作不得经过这里。
 */
async function storageApi(
  target: StorageRestoreTarget,
  method: string,
  path: string,
  init: {
    body?: BodyInit | (() => BodyInit);
    headers?: Record<string, string>;
    duplex?: "half";
    timeoutMs?: number;
  } = {},
  counters?: { retries: number }
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${target.supabaseUrl}/storage/v1${path}`, {
        method,
        headers: { ...storageHeaders(target.serviceRoleKey), ...init.headers },
        body: typeof init.body === "function" ? init.body() : init.body,
        signal: AbortSignal.timeout(init.timeoutMs ?? API_TIMEOUT_MS),
        // @ts-expect-error Node fetch 流式请求体必须声明 half-duplex
        duplex: init.duplex,
      });
      if (isRetryable(res.status) && attempt < MAX_ATTEMPTS) {
        lastError = new Error(`HTTP ${res.status}`);
      } else {
        if (attempt > 1 && counters) counters.retries += 1;
        return res;
      }
    } catch (error) {
      // 超时/网络层错误:可重试
      lastError = error as Error;
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt * attempt));
  }
  throw lastError ?? new Error("unreachable");
}

/** bucket 名单 = manifest.buckets(含空桶)∪ files 里出现过的桶(v1 快照没有 buckets 字段) */
export function bucketsToRestore(manifest: Manifest): { name: string; attrs: boolean }[] {
  const storage = manifest.storage!;
  const fromAttrs = new Map((storage.buckets ?? []).map((b) => [b.name, true]));
  for (const f of storage.files) if (!fromAttrs.has(f.bucket)) fromAttrs.set(f.bucket, false);
  return [...fromAttrs].map(([name, attrs]) => ({ name, attrs }));
}

async function ensureBucket(
  target: StorageRestoreTarget,
  manifest: Manifest,
  name: string,
  summary: StorageRestoreSummary
): Promise<void> {
  const attrs = (manifest.storage!.buckets ?? []).find((b) => b.name === name);
  // 属性未捕获(v1/降级快照)不自动创建(PRD §10.4:信息不足回退手动流程)——
  // 猜一个可见性可能造出错误的访问行为;要求用户按自己知道的设置先建好桶
  if (!attrs) {
    summary.bucketsWithoutAttrs.push(name);
    const probe = await storageApi(target, "GET", `/bucket/${encodeURIComponent(name)}`, {}, summary);
    if (!probe.ok) {
      throw new Error(
        `bucket "${name}" has no recorded attributes in this snapshot (pre-2.0 backup) and does not ` +
          `exist on the target — create it manually with the visibility/limits you know, then re-run.`
      );
    }
    const existing = (await probe.json()) as { public: boolean | null };
    summary.bucketsExisting.push(name);
    if (existing.public) {
      summary.bucketAttrDrift.push(
        `${name}: existing bucket is PUBLIC and the snapshot has no recorded attributes — uploaded files will be publicly readable`
      );
    }
    return;
  }
  const payload: Record<string, unknown> = { name };
  if (attrs.public !== null && attrs.public !== undefined) payload.public = attrs.public;
  if (attrs.fileSizeLimit !== null && attrs.fileSizeLimit !== undefined)
    payload.file_size_limit = attrs.fileSizeLimit;
  if (attrs.allowedMimeTypes !== null && attrs.allowedMimeTypes !== undefined)
    payload.allowed_mime_types = attrs.allowedMimeTypes;
  const res = await storageApi(
    target,
    "POST",
    "/bucket",
    { body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } },
    summary
  );
  if (res.ok) {
    summary.bucketsCreated.push(name);
    return;
  }
  const text = await res.text();
  // 已存在 = 幂等重试的正常形态(PRD §5.3.4)。但要核对属性:既有桶的 public/限额
  // 与 manifest 漂移时,恢复出的访问行为是错的——如实警告(不强改:可能是用户有意)
  if (res.status === 409 || /already exists|Duplicate/i.test(text)) {
    summary.bucketsExisting.push(name);
    // 既有桶必须可验证(评审第 10 轮):读不到属性 = 不知道自己在往什么可见性的
    // 桶里传文件,直接拒绝——尤其"manifest 说私有、既有桶是公开"会静默暴露数据
    const info = await storageApi(target, "GET", `/bucket/${encodeURIComponent(name)}`, {}, summary);
    if (!info.ok) {
      throw new Error(
        `existing bucket "${name}" attributes are unreadable (HTTP ${info.status}) — ` +
          `refusing to upload into an unverifiable bucket`
      );
    }
    const existing = (await info.json()) as {
      public: boolean | null;
      file_size_limit: number | null;
      allowed_mime_types: string[] | null;
    };
    {
      // public 是安全属性:漂移 = 硬失败(私有文件进公开桶是数据暴露,不是"配置口味")
      if (attrs.public !== null && attrs.public !== undefined && existing.public !== attrs.public) {
        throw new Error(
          `existing bucket "${name}" is ${existing.public ? "PUBLIC" : "private"} but the snapshot ` +
            `recorded it as ${attrs.public ? "public" : "PRIVATE"} — fix the bucket's visibility ` +
            `(or restore into a fresh project) before uploading files into it`
        );
      }
      const drift: string[] = [];
      if (
        attrs.fileSizeLimit !== null &&
        attrs.fileSizeLimit !== undefined &&
        Number(existing.file_size_limit) !== attrs.fileSizeLimit
      )
        drift.push(`file_size_limit ${existing.file_size_limit} ≠ manifest ${attrs.fileSizeLimit}`);
      if (
        attrs.allowedMimeTypes !== null &&
        attrs.allowedMimeTypes !== undefined &&
        JSON.stringify([...(existing.allowed_mime_types ?? [])].sort()) !==
          JSON.stringify([...attrs.allowedMimeTypes].sort())
      )
        drift.push(
          `allowed_mime_types ${JSON.stringify(existing.allowed_mime_types)} ≠ manifest ${JSON.stringify(attrs.allowedMimeTypes)}`
        );
      if (drift.length) summary.bucketAttrDrift.push(`${name}: ${drift.join("; ")}`);
    }
    return;
  }
  throw new Error(`create bucket "${name}" failed: HTTP ${res.status} ${text.slice(0, 160)}`);
}

// Supabase 标准上传的官方上限;超过则走 TUS 断点续传(PRD §5.4.2 大文件要求)
export const STANDARD_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
// Supabase TUS 约定块大小:除末块外必须恰为 6MB
const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

/**
 * TUS 启用阈值:默认 = 6MB(Supabase 官方对 resumable 的建议线)——大文件从零重传
 * 的标准上传既脆弱又贵;env 可覆盖(验证时压低,特殊网络环境可调高)。
 */
export function tusThresholdBytes(): number {
  const env = Number(process.env.BACKUPDRILL_TUS_THRESHOLD ?? "");
  const chosen = Number.isFinite(env) && env > 0 ? env : TUS_CHUNK_BYTES;
  // 钳制在标准上传硬上限内:env 调高也不能把 >5GB 文件送进必败的标准上传
  return Math.min(chosen, STANDARD_UPLOAD_LIMIT_BYTES);
}

async function collectBody(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * TUS 断点续传上传(Supabase resumable 端点):创建 → 按 6MB 块 PATCH,块数据经
 * S3 Range 读取(可重取);offset 不符/瞬时失败 → HEAD 重新对准后续传。
 * 每块独立有界重试,整文件不从零重来——这正是它存在的意义。
 */
async function uploadViaTus(
  source: { s3: S3Client; bucket: string; base: string },
  target: StorageRestoreTarget,
  file: StorageFile,
  summary: StorageRestoreSummary
): Promise<void> {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const metaParts = [`bucketName ${b64(file.bucket)}`, `objectName ${b64(file.key)}`];
  if (file.contentType) metaParts.push(`contentType ${b64(file.contentType)}`);
  if (file.cacheControl) {
    // Supabase 的 tus 生命周期把 cacheControl 当秒数解析,非数字整体回落 no-cache
    // (实测:max-age=600 经 TUS 落成 no-cache)——只送数字部分;解析不出则不送
    const maxAge = file.cacheControl.match(/max-age=(\d+)/)?.[1];
    if (maxAge) metaParts.push(`cacheControl ${b64(maxAge)}`);
  }
  if (file.metadata) metaParts.push(`metadata ${b64(JSON.stringify(file.metadata))}`);

  let create: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      create = await fetch(`${target.supabaseUrl}/storage/v1/upload/resumable`, {
        method: "POST",
        headers: {
          ...storageHeaders(target.serviceRoleKey),
          "Tus-Resumable": "1.0.0",
          "Upload-Length": String(file.bytes),
          "Upload-Metadata": metaParts.join(","),
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!isRetryable(create.status) || attempt === MAX_ATTEMPTS) break;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      create = null;
    }
    summary.retries += 1;
    await new Promise((r) => setTimeout(r, 1000 * attempt * attempt));
  }
  if (!create || create.status !== 201) {
    throw new Error(
      `TUS creation failed: HTTP ${create?.status ?? "network error"} ${create ? (await create.text()).slice(0, 160) : ""}`
    );
  }
  const location = create.headers.get("location");
  if (!location) throw new Error("TUS creation returned no Location header");
  const uploadUrl = new URL(location, target.supabaseUrl).toString();
  // Location 可能是任意绝对 URL,而后续 PATCH/HEAD 会带 service key——凭据只许发往
  // 已验证的目标源(与 validateStorageTargetOrigin 同一约束)
  if (new URL(uploadUrl).origin !== target.supabaseUrl) {
    throw new Error(
      `TUS Location resolved outside the verified target origin (${new URL(uploadUrl).origin}) — refusing to send credentials there`
    );
  }

  let offset = 0;
  let chunkAttempts = 0; // 每前进一步清零:重试预算属于"当前卡住的位置",不是整个文件
  while (offset < file.bytes) {
    const end = Math.min(offset + TUS_CHUNK_BYTES, file.bytes) - 1;
    // 源侧 Range 读同样有界重试:一次 S3 瞬断不该报废一个大文件的续传
    let chunk: Buffer | null = null;
    for (let readAttempt = 1; readAttempt <= MAX_ATTEMPTS; readAttempt++) {
      try {
        const got = await source.s3.send(
          new GetObjectCommand({
            Bucket: source.bucket,
            Key: `${source.base}/storage/${file.bucket}/${file.key}`,
            Range: `bytes=${offset}-${end}`,
          })
        );
        chunk = await collectBody(got.Body);
        break;
      } catch (error) {
        if (readAttempt === MAX_ATTEMPTS) throw error;
        summary.retries += 1;
        await new Promise((r) => setTimeout(r, 1000 * readAttempt * readAttempt));
      }
    }
    if (chunk === null) throw new Error("unreachable: range read retry exhausted");
    let res: Response | null = null;
    try {
      res = await fetch(uploadUrl, {
        method: "PATCH",
        headers: {
          ...storageHeaders(target.serviceRoleKey),
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(offset),
          "Content-Type": "application/offset+octet-stream",
        },
        body: new Uint8Array(chunk),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch {
      res = null; // 超时/网络错:统一走下方的重试/对准路径,只计一次失败
    }
    if (res && (res.status === 204 || res.status === 200)) {
      const newOffset = Number(res.headers.get("upload-offset") ?? offset + chunk.length);
      if (newOffset > offset) {
        offset = newOffset;
        chunkAttempts = 0;
      }
      continue;
    }
    if (res && !isRetryable(res.status) && res.status !== 409) {
      throw new Error(`TUS chunk failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    }
    chunkAttempts += 1;
    if (chunkAttempts >= MAX_ATTEMPTS) {
      throw new Error(`TUS upload gave up after ${MAX_ATTEMPTS} attempts at offset ${offset}`);
    }
    // 断点续传的核心:HEAD 问服务端"你收到哪了",从那里继续,不从零重来。
    // HEAD 自身的瞬断不额外惩罚:留在同一 offset,由 chunkAttempts 预算兜底
    try {
      const head = await fetch(uploadUrl, {
        method: "HEAD",
        headers: { ...storageHeaders(target.serviceRoleKey), "Tus-Resumable": "1.0.0" },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (head.ok) {
        const serverOffset = Number(head.headers.get("upload-offset") ?? Number.NaN);
        if (Number.isFinite(serverOffset) && serverOffset > offset) {
          offset = serverOffset;
          chunkAttempts = 0; // 服务端有进展 = 没卡住
        }
      }
    } catch {
      /* HEAD 瞬断:保持当前 offset,下轮重试 */
    }
    summary.retries += 1;
    await new Promise((r) => setTimeout(r, 1000 * chunkAttempts * chunkAttempts));
  }
}

async function uploadFile(
  source: { s3: S3Client; bucket: string; base: string },
  target: StorageRestoreTarget,
  file: StorageFile,
  summary: StorageRestoreSummary
): Promise<void> {
  // 大文件走 TUS:标准上传 5GB 封顶且整文件重试;TUS 分块可续传(PRD §5.4.2)
  if (file.bytes > tusThresholdBytes()) {
    return uploadViaTus(source, target, file, summary);
  }
  // 不用 x-upsert(评审第 11 轮):目标既有对象的处置在上传前已裁决(同尺寸跳过/
  // 冲突拒绝),此处冲突只剩并发竞态 → 409 如实失败,绝不静默覆盖
  const headers: Record<string, string> = {
    "Content-Length": String(file.bytes), // 流式体 + 显式长度,不整文件驻留内存
  };
  if (file.contentType) headers["Content-Type"] = file.contentType;
  if (file.cacheControl) headers["Cache-Control"] = file.cacheControl;
  // 尽力回传:当前 Supabase 不把该头落进目录(R0 补充实证),但发送无害且服务端
  // 一旦支持即自动保真;字段本身在 manifest/报告里是如实在场的
  if (file.contentEncoding) headers["Content-Encoding"] = file.contentEncoding;
  if (file.metadata) {
    headers["x-metadata"] = Buffer.from(JSON.stringify(file.metadata)).toString("base64");
  }
  const encodedKey = file.key.split("/").map(encodeURIComponent).join("/");
  // 流式上传自管重试(不走 storageApi 的通用重试):每次尝试都必须从源桶重新取流
  // ——上一次的流已被消费。同样有界、同样计入 retries。
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const got = await source.s3.send(
        new GetObjectCommand({
          Bucket: source.bucket,
          Key: `${source.base}/storage/${file.bucket}/${file.key}`,
        })
      );
      const res = await fetch(
        `${target.supabaseUrl}/storage/v1/object/${encodeURIComponent(file.bucket)}/${encodedKey}`,
        {
          method: "POST",
          headers: { ...storageHeaders(target.serviceRoleKey), ...headers },
          body: Readable.toWeb(got.Body as Readable) as unknown as BodyInit,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          // @ts-expect-error half-duplex for streaming body
          duplex: "half",
        }
      );
      if (res.ok) {
        if (attempt > 1) summary.retries += 1;
        return;
      }
      const text = await res.text();
      if (!isRetryable(res.status) || attempt === MAX_ATTEMPTS) {
        throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      if ((error as Error).message.startsWith("HTTP ")) throw error;
      // 超时/网络层错误:可重试
      lastError = error as Error;
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt * attempt));
  }
  throw lastError ?? new Error("unreachable");
}

/**
 * 递归遍历目标 bucket 的全部对象(list API 是目录级的:id === null 的条目是"目录")。
 * 返回 key → size。不依赖目标 DB 凭据 → storage-only 恢复也有完整对账。
 */
export async function walkTargetObjects(
  target: StorageRestoreTarget,
  bucket: string,
  counters?: { retries: number }
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const walk = async (prefix: string): Promise<void> => {
    let offset = 0;
    for (;;) {
      const res = await storageApi(
        target,
        "POST",
        `/object/list/${encodeURIComponent(bucket)}`,
        {
          body: JSON.stringify({ prefix, limit: 1000, offset }),
          headers: { "Content-Type": "application/json" },
        },
        counters
      );
      if (!res.ok) throw new Error(`list ${bucket}/${prefix} failed: HTTP ${res.status}`);
      const items = (await res.json()) as { name: string; id: string | null; metadata: { size?: number } | null }[];
      for (const item of items) {
        const full = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id === null) await walk(full);
        else out.set(full, Number(item.metadata?.size ?? Number.NaN));
      }
      if (items.length < 1000) break;
      offset += items.length;
    }
  };
  await walk("");
  return out;
}

/** 逐键对账(纯函数,可测):manifest 每个文件都必须在目标出现且尺寸一致;多余对象另计。 */
export function reconcileFiles(
  files: StorageFile[],
  actualByBucket: Map<string, Map<string, number>>
): ReconcileReport {
  const missing: string[] = [];
  const sizeMismatched: string[] = [];
  let verified = 0;
  const matchedPerBucket = new Map<string, number>();
  for (const f of files) {
    const actual = actualByBucket.get(f.bucket);
    const size = actual?.get(f.key);
    if (size === undefined) {
      missing.push(`${f.bucket}/${f.key}`);
    } else if (size !== f.bytes) {
      sizeMismatched.push(`${f.bucket}/${f.key} (target ${size} ≠ manifest ${f.bytes})`);
      matchedPerBucket.set(f.bucket, (matchedPerBucket.get(f.bucket) ?? 0) + 1);
    } else {
      verified += 1;
      matchedPerBucket.set(f.bucket, (matchedPerBucket.get(f.bucket) ?? 0) + 1);
    }
  }
  let extras = 0;
  for (const [bucket, actual] of actualByBucket) {
    extras += actual.size - (matchedPerBucket.get(bucket) ?? 0);
  }
  return {
    verified,
    missing,
    sizeMismatched,
    extras,
    // extras 也判不匹配(评审第 12 轮):恢复目标应当只含快照内容,混着外来对象
    // 不是干净恢复——要共存请显式分桶,不给静默混装留门
    matches: missing.length === 0 && sizeMismatched.length === 0 && extras === 0,
  };
}

/** 从目标下载单个文件并重算 sha256;读不到/不符时返回原因,匹配返回 null。 */
async function hashMismatchOnTarget(
  target: StorageRestoreTarget,
  file: StorageFile,
  counters: { retries: number }
): Promise<string | null> {
  const encodedKey = file.key.split("/").map(encodeURIComponent).join("/");
  const res = await storageApi(
    target,
    "GET",
    `/object/${encodeURIComponent(file.bucket)}/${encodedKey}`,
    { timeoutMs: UPLOAD_TIMEOUT_MS },
    counters
  );
  if (!res.ok) return `unreadable: HTTP ${res.status}`;
  const hash = createHash("sha256");
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
  return hash.digest("hex") === file.sha256 ? null : "sha256 mismatch";
}

/** 从目标下载抽样文件并重算 sha256(证明目标上的字节 = manifest 承诺的字节)。 */
async function sampleChecksums(
  target: StorageRestoreTarget,
  files: StorageFile[],
  counters: { retries: number }
): Promise<{ checked: number; mismatched: string[] }> {
  const sample = sampleStorageFiles(files, CHECKSUM_SAMPLE_CAP);
  const mismatched: string[] = [];
  for (const file of sample) {
    const mismatch = await hashMismatchOnTarget(target, file, counters);
    if (mismatch) mismatched.push(`${file.bucket}/${file.key} (${mismatch})`);
  }
  return { checked: sample.length, mismatched };
}

/** 简单并发池:PRD §5.4.2 小并发;单文件失败收集不中断(§5.4.4)。 */
async function uploadAll(
  source: { s3: S3Client; bucket: string; base: string },
  target: StorageRestoreTarget,
  files: StorageFile[],
  preexisting: Map<string, Map<string, number>>,
  skippedFiles: StorageFile[],
  summary: StorageRestoreSummary
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, async () => {
    while (next < files.length) {
      const file = files[next++];
      const existingSize = preexisting.get(file.bucket)?.get(file.key);
      if (existingSize !== undefined) {
        if (existingSize === file.bytes) {
          // 同 key 同尺寸:暂记跳过,随后逐个重哈希裁决(同尺寸 ≠ 同字节,评审第 12 轮)
          summary.filesSkippedIdentical += 1;
          skippedFiles.push(file);
        } else {
          summary.filesFailed.push({
            file: `${file.bucket}/${file.key}`,
            reason: `target already has a conflicting object (size ${existingSize} ≠ manifest ${file.bytes}) — refusing to overwrite`,
          });
        }
        continue;
      }
      try {
        await uploadFile(source, target, file, summary);
        summary.filesUploaded += 1;
        summary.bytesUploaded += file.bytes;
      } catch (error) {
        summary.filesFailed.push({
          file: `${file.bucket}/${file.key}`,
          reason: (error as Error).message,
        });
      }
    }
  });
  await Promise.all(workers);
}

/**
 * Storage 回传主流程(PRD §5.4.1 顺序):bucket 清单 → 检查/创建 → 上传(含元数据)
 * → 逐键对账 → 抽样校验和。bucket 创建失败抛出(没桶一切免谈),文件级失败收集
 * 入摘要由调用方裁决。
 */
export async function restoreStorage(
  source: { s3: S3Client; bucket: string; base: string },
  target: StorageRestoreTarget,
  manifest: Manifest
): Promise<StorageRestoreSummary> {
  const summary: StorageRestoreSummary = {
    bucketsCreated: [],
    bucketsExisting: [],
    bucketsWithoutAttrs: [],
    bucketAttrDrift: [],
    filesUploaded: 0,
    bytesUploaded: 0,
    filesSkippedIdentical: 0,
    filesFailed: [],
    retries: 0,
    reconcile: { verified: 0, missing: [], sizeMismatched: [], extras: 0, matches: false },
    checksumSample: { checked: 0, mismatched: [] },
    ownerNote:
      "File bytes and supported metadata were restored. Original Auth ownership was not restored or verified.",
  };

  const buckets = bucketsToRestore(manifest);
  log.step(`Ensuring ${buckets.length} bucket(s) on target…`);
  for (const bucket of buckets) {
    await ensureBucket(target, manifest, bucket.name, summary);
  }

  // 上传前预检目标对象(评审第 11 轮):新建桶必空;既有桶列一遍,让"跳过/拒绝"
  // 的裁决发生在任何写入之前
  const preexisting = new Map<string, Map<string, number>>();
  for (const bucket of buckets) {
    preexisting.set(
      bucket.name,
      summary.bucketsExisting.includes(bucket.name)
        ? await walkTargetObjects(target, bucket.name, summary)
        : new Map()
    );
  }

  const files = manifest.storage!.files;
  log.step(`Uploading ${files.length} file(s) → target Storage…`);
  const skippedFiles: StorageFile[] = [];
  await uploadAll(source, target, files, preexisting, skippedFiles, summary);

  // 跳过的既有对象逐个重哈希(评审第 12 轮):跳过的前提是字节确证一致,
  // 同尺寸的损坏/无关内容不得混进"干净恢复"
  if (skippedFiles.length) {
    log.step(`Verifying ${skippedFiles.length} pre-existing object(s) byte-for-byte…`);
    for (const file of skippedFiles) {
      const mismatch = await hashMismatchOnTarget(target, file, summary);
      if (mismatch) {
        summary.filesSkippedIdentical -= 1;
        summary.filesFailed.push({
          file: `${file.bucket}/${file.key}`,
          reason: `pre-existing same-size object differs (${mismatch}) — refusing to overwrite`,
        });
      }
    }
  }

  log.step("Reconciling every file against the target listing…");
  const actualByBucket = new Map<string, Map<string, number>>();
  for (const bucket of buckets) {
    actualByBucket.set(bucket.name, await walkTargetObjects(target, bucket.name, summary));
  }

  // 超时误报重裁(评审第 10 轮):上传"失败"但目标上尺寸吻合的文件(响应超时时
  // 服务端其实已成功)→ 重哈希裁决;字节确证一致才改判成功,幂等重试的契约成立
  if (summary.filesFailed.length) {
    const reclassified: string[] = [];
    for (const failed of [...summary.filesFailed]) {
      const file = files.find((f) => `${f.bucket}/${f.key}` === failed.file);
      const sizeOnTarget = file && actualByBucket.get(file.bucket)?.get(file.key);
      if (!file || sizeOnTarget !== file.bytes) continue;
      const mismatch = await hashMismatchOnTarget(target, file, summary);
      if (mismatch === null) {
        summary.filesFailed = summary.filesFailed.filter((x) => x !== failed);
        summary.filesUploaded += 1;
        summary.bytesUploaded += file.bytes;
        reclassified.push(failed.file);
      }
    }
    if (reclassified.length) {
      log.ok(
        `${reclassified.length} timed-out upload(s) verified byte-identical on target — reclassified as success`
      );
    }
  }

  summary.reconcile = reconcileFiles(files, actualByBucket);

  if (files.length && summary.filesFailed.length < files.length) {
    log.step("Sampling checksums from target…");
    const uploadedFiles = files.filter(
      (f) => !summary.filesFailed.some((x) => x.file === `${f.bucket}/${f.key}`)
    );
    summary.checksumSample = await sampleChecksums(target, uploadedFiles, summary);
  }

  return summary;
}
