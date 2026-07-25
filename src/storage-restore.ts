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
  /** 元数据降级说明(如 TUS 路径不保真的字段)——如实上报,不静默丢 */
  metadataNotes: string[];
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

interface ExistingBucketInfo {
  public: boolean | null;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
}

/** 只读探测:桶存在返回属性;确证不存在返回 null;其余失败抛错(不可验证 = 不动)。 */
async function probeBucket(
  target: StorageRestoreTarget,
  name: string,
  summary: StorageRestoreSummary
): Promise<ExistingBucketInfo | null> {
  const info = await storageApi(target, "GET", `/bucket/${encodeURIComponent(name)}`, {}, summary);
  if (info.ok) return (await info.json()) as ExistingBucketInfo;
  const text = await info.text();
  if (info.status === 404 || /not found/i.test(text)) return null;
  throw new Error(
    `cannot probe bucket "${name}" (HTTP ${info.status}) — refusing to touch an unverifiable target`
  );
}

/**
 * 校验桶计划(零写入):所有安全裁决在任何创建/上传之前完成(评审第 15 轮 SF1)。
 * 返回是否需要创建。抛错的情形:无属性快照的桶在目标缺失(手动回退,PRD §10.4)、
 * 无属性快照撞上公开既有桶(上传即公开暴露)、public 漂移、属性不可读。
 */
function validateBucketPlan(
  name: string,
  attrs: { public?: boolean | null; fileSizeLimit?: number | null; allowedMimeTypes?: string[] | null } | undefined,
  existing: ExistingBucketInfo | null,
  summary: StorageRestoreSummary
): { create: boolean } {
  if (!attrs) {
    summary.bucketsWithoutAttrs.push(name);
    if (!existing) {
      throw new Error(
        `bucket "${name}" has no recorded attributes in this snapshot (pre-2.0 backup) and does not ` +
          `exist on the target — create it manually with the visibility/limits you know, then re-run.`
      );
    }
    summary.bucketsExisting.push(name);
    if (existing.public) {
      // 评审第 15 轮:无属性快照 + 公开既有桶 → 上传即把可能私有的备份数据公开,
      // 必须在写第一个字节之前拒绝,而不是传完了在退出码里认错
      throw new Error(
        `existing bucket "${name}" is PUBLIC and this snapshot has no recorded attributes — uploading ` +
          `would make restored files publicly readable. Make the bucket private (or restore into a ` +
          `fresh project), then re-run.`
      );
    }
    return { create: false };
  }
  if (!existing) return { create: true };
  summary.bucketsExisting.push(name);
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
  return { create: false };
}

/** 创建缺失桶(净度门通过后才会走到)。计划后出现的 409 = 并发竞态,如实失败。 */
async function createBucket(
  target: StorageRestoreTarget,
  attrs: { public?: boolean | null; fileSizeLimit?: number | null; allowedMimeTypes?: string[] | null },
  name: string,
  summary: StorageRestoreSummary
): Promise<void> {
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
  if (!res.ok) {
    throw new Error(
      `create bucket "${name}" failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}` +
        (res.status === 409 ? " (bucket appeared concurrently — re-run to re-validate)" : "")
    );
  }
  summary.bucketsCreated.push(name);
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
  // TUS 通道保真面比标准上传窄:cacheControl 只能传 max-age 秒数,contentEncoding
  // 无对应槽位——降级必须如实上报,不静默(评审第 14 轮)
  if (file.cacheControl && file.cacheControl.replace(/max-age=\d+/, "").replace(/[,\s]/g, "")) {
    summary.metadataNotes.push(
      `${file.bucket}/${file.key}: Cache-Control directives beyond max-age not preserved over resumable upload ("${file.cacheControl}")`
    );
  }
  if (file.contentEncoding) {
    summary.metadataNotes.push(
      `${file.bucket}/${file.key}: contentEncoding "${file.contentEncoding}" not preserved over resumable upload`
    );
  }
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
      const header = Number(res.headers.get("upload-offset") ?? Number.NaN);
      const newOffset = Number.isFinite(header) ? header : offset + chunk.length;
      if (newOffset > offset && newOffset <= file.bytes) {
        offset = newOffset;
        chunkAttempts = 0;
        continue;
      }
      // 成功状态却没有推进(或越界的 offset):坏网关/代理形态——落进下方的
      // 有界重试与 HEAD 对准,绝不原地死循环(评审第 15 轮)
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
  if (file.contentEncoding) {
    // 尽力转发,但当前 Supabase 不持久化该头(R0 补充实证)——降级如实上报,不静默
    headers["Content-Encoding"] = file.contentEncoding;
    summary.metadataNotes.push(
      `${file.bucket}/${file.key}: contentEncoding "${file.contentEncoding}" forwarded but not persisted ` +
        `by current Supabase Storage — verify serving behavior manually`
    );
  }
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

/**
 * 写前净度检查(纯函数,可测):既有桶里只允许"本快照的同尺寸残留"。
 * 任何外来对象或尺寸冲突都在**写第一个字节之前**整体拒绝——部分写入的脏目标
 * 比干净失败难收拾得多(评审第 14 轮)。
 */
export function targetResidueViolations(
  files: StorageFile[],
  preexisting: Map<string, Map<string, number>>
): string[] {
  const violations: string[] = [];
  // 一次建索引(bucket\n key 作键,\n 不会出现在桶名里):大残留集的重试不能是二次方
  const index = new Map<string, number>();
  for (const f of files) index.set(`${f.bucket}\n${f.key}`, f.bytes);
  for (const [bucket, actual] of preexisting) {
    for (const [key, size] of actual) {
      const expected = index.get(`${bucket}\n${key}`);
      if (expected === undefined) violations.push(`${bucket}/${key} (not in this snapshot)`);
      else if (expected !== size)
        violations.push(`${bucket}/${key} (size ${size} ≠ manifest ${expected})`);
    }
  }
  return violations;
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
  verifiedResidue: Set<string>,
  summary: StorageRestoreSummary
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, async () => {
    while (next < files.length) {
      const file = files[next++];
      // 计划阶段已逐字节验证的残留:跳过(冲突形态在净度门就整体拒绝了,到不了这里)
      if (verifiedResidue.has(`${file.bucket}\n${file.key}`)) continue;
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
function emptySummary(): StorageRestoreSummary {
  return {
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
    metadataNotes: [],
    ownerNote:
      "File bytes and supported metadata were restored. Original Auth ownership was not restored or verified.",
  };
}

interface StoragePlan {
  plans: { name: string; create: boolean }[];
  preexisting: Map<string, Map<string, number>>;
  /** `${bucket}\n${key}`:已逐字节验证的同尺寸残留(上传阶段直接跳过) */
  verifiedResidue: Set<string>;
}

/**
 * 只读计划阶段(评审第 16 轮):探测/校验每个桶 → 残留净度 → 同尺寸残留逐个重哈希。
 * 全部安全裁决在这里完成,零写入——供正式执行(数据库写入**之前**)与 dry-run 共用,
 * 可预见的 Storage 冲突不得在库已恢复之后才发现。
 */
async function readOnlyStoragePlan(
  target: StorageRestoreTarget,
  manifest: Manifest,
  summary: StorageRestoreSummary
): Promise<StoragePlan> {
  const buckets = bucketsToRestore(manifest);
  log.step(`Probing ${buckets.length} bucket(s) on target (read-only)…`);
  const usableAttrs = (name: string) => {
    const recorded = (manifest.storage!.buckets ?? []).find((b) => b.name === name);
    // "可用"必须含 public(安全属性):部分缺字段按未捕获处理,不猜
    return recorded && typeof recorded.public === "boolean" ? recorded : undefined;
  };
  const plans: { name: string; create: boolean }[] = [];
  for (const bucket of buckets) {
    const existing = await probeBucket(target, bucket.name, summary);
    plans.push({
      name: bucket.name,
      create: validateBucketPlan(bucket.name, usableAttrs(bucket.name), existing, summary).create,
    });
  }

  const preexisting = new Map<string, Map<string, number>>();
  for (const plan of plans) {
    preexisting.set(
      plan.name,
      plan.create ? new Map() : await walkTargetObjects(target, plan.name, summary)
    );
  }

  const files = manifest.storage!.files;
  const violations = targetResidueViolations(files, preexisting);
  if (violations.length) {
    throw new Error(
      `target bucket(s) are not clean — refusing to write anything: ` +
        `${violations.slice(0, 5).join(", ")}${violations.length > 5 ? ` …and ${violations.length - 5} more` : ""}. ` +
        `A restore target may only contain residue from a previous run of this same snapshot.`
    );
  }

  // 同尺寸残留在**写第一个字节之前**逐个重哈希:损坏残留 = 目标不净,整体拒写
  const verifiedResidue = new Set<string>();
  const candidates = files.filter((f) => preexisting.get(f.bucket)?.get(f.key) === f.bytes);
  if (candidates.length) {
    log.step(`Verifying ${candidates.length} pre-existing object(s) byte-for-byte (read-only)…`);
    for (const file of candidates) {
      const mismatch = await hashMismatchOnTarget(target, file, summary);
      if (mismatch) {
        throw new Error(
          `target residue ${file.bucket}/${file.key} differs from the snapshot (${mismatch}) — ` +
            `the target is not clean; refusing to write anything`
        );
      }
      verifiedResidue.add(`${file.bucket}\n${file.key}`);
    }
  }
  return { plans, preexisting, verifiedResidue };
}

/** dry-run / 执行前预检的公开形态:一次性 scratch 摘要,只返回计划概要与警告。 */
export async function planStorageRestore(
  target: StorageRestoreTarget,
  manifest: Manifest
): Promise<{ bucketsToCreate: string[]; verifiedResidue: number; warnings: string[] }> {
  const scratch = emptySummary();
  const plan = await readOnlyStoragePlan(target, manifest, scratch);
  return {
    bucketsToCreate: plan.plans.filter((p) => p.create).map((p) => p.name),
    verifiedResidue: plan.verifiedResidue.size,
    warnings: [...scratch.bucketAttrDrift, ...scratch.metadataNotes],
  };
}

export async function restoreStorage(
  source: { s3: S3Client; bucket: string; base: string },
  target: StorageRestoreTarget,
  manifest: Manifest
): Promise<StorageRestoreSummary> {
  const summary = emptySummary();

  const { plans, verifiedResidue } = await readOnlyStoragePlan(target, manifest, summary);
  summary.filesSkippedIdentical = verifiedResidue.size;
  const files = manifest.storage!.files;

  // 阶段三:全部只读检查通过,才开始写——先建缺失桶,再上传
  const toCreate = plans.filter((p) => p.create);
  if (toCreate.length) {
    log.step(`Creating ${toCreate.length} bucket(s)…`);
    for (const plan of toCreate) {
      // 计划阶段已证明该桶有含 public 的可用属性记录(否则走了手动回退)
      const attrs = (manifest.storage!.buckets ?? []).find((b) => b.name === plan.name)!;
      await createBucket(target, attrs, plan.name, summary);
    }
  }

  log.step(`Uploading ${files.length} file(s) → target Storage…`);
  await uploadAll(source, target, files, verifiedResidue, summary);

  log.step("Reconciling every file against the target listing…");
  const actualByBucket = new Map<string, Map<string, number>>();
  for (const plan of plans) {
    actualByBucket.set(plan.name, await walkTargetObjects(target, plan.name, summary));
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
