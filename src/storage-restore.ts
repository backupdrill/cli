// Storage 真实回传(恢复闭环 PRD §5.4):bucket 重建 → 文件上传 → 逐键对账 → 抽样校验和。
// 通道 = 目标项目 Storage HTTP API + service-role key(R0 spike 1 实证:bucket 三属性
// 与 contentType/cacheControl/x-metadata 全保真;x-upsert 幂等重传,PRD §5.3.4 明文
// 许可;InvalidKey 是单文件失败不中断)。对账用 list API 递归遍历目标(不依赖目标 DB
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
  /** 目标上存在但 manifest 没有的对象数(重试残留/并存数据)——如实报告,不判失败 */
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
  // 只在 manifest 有可靠值时恢复属性(PRD §5.4.1.3);未捕获 → 默认私有并如实上报
  const payload: Record<string, unknown> = { name };
  if (attrs) {
    if (attrs.public !== null && attrs.public !== undefined) payload.public = attrs.public;
    if (attrs.fileSizeLimit !== null && attrs.fileSizeLimit !== undefined)
      payload.file_size_limit = attrs.fileSizeLimit;
    if (attrs.allowedMimeTypes !== null && attrs.allowedMimeTypes !== undefined)
      payload.allowed_mime_types = attrs.allowedMimeTypes;
  } else {
    summary.bucketsWithoutAttrs.push(name);
  }
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
    if (attrs) {
      const info = await storageApi(target, "GET", `/bucket/${encodeURIComponent(name)}`, {}, summary);
      if (info.ok) {
        const existing = (await info.json()) as {
          public: boolean | null;
          file_size_limit: number | null;
          allowed_mime_types: string[] | null;
        };
        const drift: string[] = [];
        if (attrs.public !== null && attrs.public !== undefined && existing.public !== attrs.public)
          drift.push(`public ${existing.public} ≠ manifest ${attrs.public}`);
        if (
          attrs.fileSizeLimit !== null &&
          attrs.fileSizeLimit !== undefined &&
          Number(existing.file_size_limit) !== attrs.fileSizeLimit
        )
          drift.push(`file_size_limit ${existing.file_size_limit} ≠ manifest ${attrs.fileSizeLimit}`);
        if (drift.length) summary.bucketAttrDrift.push(`${name}: ${drift.join("; ")}`);
      }
    }
    return;
  }
  throw new Error(`create bucket "${name}" failed: HTTP ${res.status} ${text.slice(0, 160)}`);
}

async function uploadFile(
  source: { s3: S3Client; bucket: string; base: string },
  target: StorageRestoreTarget,
  file: StorageFile,
  summary: StorageRestoreSummary
): Promise<void> {
  const headers: Record<string, string> = {
    "x-upsert": "true", // 幂等重传(spike 1:同 key upsert 成功且对象 Id 不变)
    "Content-Length": String(file.bytes), // 流式体 + 显式长度,不整文件驻留内存
  };
  if (file.contentType) headers["Content-Type"] = file.contentType;
  if (file.cacheControl) headers["Cache-Control"] = file.cacheControl;
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
    matches: missing.length === 0 && sizeMismatched.length === 0,
  };
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
    const encodedKey = file.key.split("/").map(encodeURIComponent).join("/");
    const res = await storageApi(
      target,
      "GET",
      `/object/${encodeURIComponent(file.bucket)}/${encodedKey}`,
      { timeoutMs: UPLOAD_TIMEOUT_MS },
      counters
    );
    if (!res.ok) {
      mismatched.push(`${file.bucket}/${file.key} (unreadable: HTTP ${res.status})`);
      continue;
    }
    const hash = createHash("sha256");
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
    if (hash.digest("hex") !== file.sha256) mismatched.push(`${file.bucket}/${file.key}`);
  }
  return { checked: sample.length, mismatched };
}

/** 简单并发池:PRD §5.4.2 小并发;单文件失败收集不中断(§5.4.4)。 */
async function uploadAll(
  source: { s3: S3Client; bucket: string; base: string },
  target: StorageRestoreTarget,
  files: StorageFile[],
  summary: StorageRestoreSummary
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, async () => {
    while (next < files.length) {
      const file = files[next++];
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

  const files = manifest.storage!.files;
  log.step(`Uploading ${files.length} file(s) → target Storage…`);
  await uploadAll(source, target, files, summary);

  log.step("Reconciling every file against the target listing…");
  const actualByBucket = new Map<string, Map<string, number>>();
  for (const bucket of buckets) {
    actualByBucket.set(bucket.name, await walkTargetObjects(target, bucket.name, summary));
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
