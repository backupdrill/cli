// Storage 真实回传(恢复闭环 PRD §5.4):bucket 重建 → 文件上传 → 对账。
// 通道 = 目标项目 Storage HTTP API + service-role key(R0 spike 1 实证:bucket 三属性
// 与 contentType/cacheControl/x-metadata 全保真;x-upsert 幂等重传;InvalidKey 是
// 单文件失败不中断)。对账走目标库 storage.objects(一条 SQL,完整且不受
// list API 目录层级限制);抽样校验和从目标下载重算(默认小样本,控制 egress)。
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { Client } from "pg";
import type { Manifest, StorageFile } from "./manifest.js";
import { sampleStorageFiles } from "./drill.js";
import { pgConnectOptions } from "./supabase-ca.js";
import { log } from "./log.js";

// PRD §5.4.2:默认小并发,避免压垮目标 Storage 或 worker 内存
const UPLOAD_CONCURRENCY = 4;
const CHECKSUM_SAMPLE_CAP = 10;

export interface StorageRestoreTarget {
  supabaseUrl: string; // https://<ref>.supabase.co
  serviceRoleKey: string;
}

export interface StorageRestoreSummary {
  bucketsCreated: string[];
  bucketsExisting: string[];
  /** manifest 未捕获属性的 bucket(以默认设置创建,如实上报,不猜测) */
  bucketsWithoutAttrs: string[];
  filesUploaded: number;
  bytesUploaded: number;
  filesFailed: { file: string; reason: string }[];
  /** 目标库 storage.objects 的对账(需目标 DB 连接;无连接时为 null 并如实说明) */
  reconcile: { targetCount: number; targetBytes: number; matches: boolean } | null;
  checksumSample: { checked: number; mismatched: string[] };
  /** PRD §5.4.3:owner 语义边界,报告必须显示 */
  ownerNote: string;
}

function storageHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, apikey: key };
}

async function storageApi(
  target: StorageRestoreTarget,
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string>; duplex?: "half" } = {}
): Promise<Response> {
  return fetch(`${target.supabaseUrl}/storage/v1${path}`, {
    method,
    headers: { ...storageHeaders(target.serviceRoleKey), ...init.headers },
    body: init.body,
    // @ts-expect-error Node fetch 流式请求体必须声明 half-duplex
    duplex: init.duplex,
  });
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
  const res = await storageApi(target, "POST", "/bucket", {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
  if (res.ok) {
    summary.bucketsCreated.push(name);
    return;
  }
  const text = await res.text();
  // 已存在 = 幂等重试的正常形态(PRD §5.3.4:重试不得重复创建冲突 bucket)
  if (res.status === 409 || /already exists|Duplicate/i.test(text)) {
    summary.bucketsExisting.push(name);
    return;
  }
  throw new Error(`create bucket "${name}" failed: HTTP ${res.status} ${text.slice(0, 160)}`);
}

async function uploadFile(
  source: { s3: S3Client; bucket: string; base: string },
  target: StorageRestoreTarget,
  file: StorageFile
): Promise<void> {
  const got = await source.s3.send(
    new GetObjectCommand({
      Bucket: source.bucket,
      Key: `${source.base}/storage/${file.bucket}/${file.key}`,
    })
  );
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
  const res = await storageApi(
    target,
    "POST",
    `/object/${encodeURIComponent(file.bucket)}/${encodedKey}`,
    { body: Readable.toWeb(got.Body as Readable) as unknown as BodyInit, headers, duplex: "half" }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
  }
}

/** 目标库 storage.objects 对账:数量 + 字节总和(metadata->>'size')。 */
async function reconcileViaDb(
  targetDatabaseUrl: string,
  bucketNames: string[]
): Promise<{ targetCount: number; targetBytes: number }> {
  const client = new Client(pgConnectOptions(targetDatabaseUrl));
  await client.connect();
  try {
    const res = await client.query<{ n: string; bytes: string }>(
      `select count(*)::bigint as n,
              coalesce(sum((metadata->>'size')::bigint), 0)::bigint as bytes
         from storage.objects where bucket_id = any($1::text[])`,
      [bucketNames]
    );
    return { targetCount: Number(res.rows[0].n), targetBytes: Number(res.rows[0].bytes) };
  } finally {
    await client.end();
  }
}

/** 从目标下载抽样文件并重算 sha256(证明目标上的字节 = manifest 承诺的字节)。 */
async function sampleChecksums(
  target: StorageRestoreTarget,
  files: StorageFile[]
): Promise<{ checked: number; mismatched: string[] }> {
  const sample = sampleStorageFiles(files, CHECKSUM_SAMPLE_CAP);
  const mismatched: string[] = [];
  for (const file of sample) {
    const encodedKey = file.key.split("/").map(encodeURIComponent).join("/");
    const res = await storageApi(
      target,
      "GET",
      `/object/${encodeURIComponent(file.bucket)}/${encodedKey}`
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
        await uploadFile(source, target, file);
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
 * → 对账 → 抽样校验和。返回结构化摘要;bucket 创建失败抛出(没桶一切免谈),
 * 文件级失败收集入摘要由调用方裁决。
 */
export async function restoreStorage(
  source: { s3: S3Client; bucket: string; base: string },
  target: StorageRestoreTarget,
  manifest: Manifest,
  opts: { targetDatabaseUrl?: string } = {}
): Promise<StorageRestoreSummary> {
  const summary: StorageRestoreSummary = {
    bucketsCreated: [],
    bucketsExisting: [],
    bucketsWithoutAttrs: [],
    filesUploaded: 0,
    bytesUploaded: 0,
    filesFailed: [],
    reconcile: null,
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

  if (opts.targetDatabaseUrl) {
    log.step("Reconciling against target storage catalog…");
    const counted = await reconcileViaDb(
      opts.targetDatabaseUrl,
      buckets.map((b) => b.name)
    );
    // 对账口径:目标数量/字节 ≥ 本次成功上传量即视为覆盖(目标可能有幂等重试
    // 留下的既有文件);缺量 = 失败。精确等于只在零失败且目标原本为空时成立。
    summary.reconcile = {
      targetCount: counted.targetCount,
      targetBytes: counted.targetBytes,
      matches:
        counted.targetCount >= files.length - summary.filesFailed.length &&
        counted.targetBytes >= summary.bytesUploaded,
    };
  }

  if (files.length && summary.filesFailed.length < files.length) {
    log.step("Sampling checksums from target…");
    const uploadedFiles = files.filter(
      (f) => !summary.filesFailed.some((x) => x.file === `${f.bucket}/${f.key}`)
    );
    summary.checksumSample = await sampleChecksums(target, uploadedFiles);
  }

  return summary;
}
