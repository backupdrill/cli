import { createHash } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { SupabaseStorageConfig } from "./config.js";
import type { StorageFile } from "./manifest.js";
import { log } from "./log.js";

/**
 * Supabase Storage 通过 S3 兼容端点访问(endpoint 形如
 * https://<ref>.storage.supabase.co/storage/v1/s3)。这里的凭据是"读取源"的密钥,
 * 与备份"写入目标"桶的密钥是两套 —— 数据只从 Supabase 流出到用户自己的桶。
 */
function sourceClient(cfg: SupabaseStorageConfig): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true, // Supabase 的 S3 端点需要 path-style
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
}

async function resolveBuckets(
  client: S3Client,
  override?: string[]
): Promise<string[]> {
  if (override && override.length) return override;
  const res = await client.send(new ListBucketsCommand({}));
  return (res.Buckets ?? []).map((b) => b.Name!).filter(Boolean);
}

async function* listObjects(
  client: S3Client,
  bucket: string
): AsyncGenerator<{ key: string; size: number }> {
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) yield { key: obj.Key, size: obj.Size ?? 0 };
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

/**
 * 仅列举、不下载 —— 用于接入时的容量/egress 估算,几乎不产生 egress。
 */
export async function measureStorage(
  cfg: SupabaseStorageConfig
): Promise<{ fileCount: number; totalBytes: number; buckets: string[] }> {
  const client = sourceClient(cfg);
  const buckets = await resolveBuckets(client, cfg.buckets);
  let fileCount = 0;
  let totalBytes = 0;
  for (const bucket of buckets) {
    for await (const obj of listObjects(client, bucket)) {
      fileCount += 1;
      totalBytes += obj.size;
    }
  }
  return { fileCount, totalBytes, buckets };
}

/**
 * 把 Supabase Storage 的每个文件流式拷贝到目标桶,边拷边算 sha256。
 * 目标键:<base>/storage/<bucket>/<原始 key>。
 */
export async function syncStorage(
  cfg: SupabaseStorageConfig,
  target: { client: S3Client; bucket: string; base: string }
): Promise<{ fileCount: number; totalBytes: number; files: StorageFile[]; buckets: string[] }> {
  const src = sourceClient(cfg);
  const buckets = await resolveBuckets(src, cfg.buckets);
  const files: StorageFile[] = [];
  let totalBytes = 0;

  for (const bucket of buckets) {
    for await (const obj of listObjects(src, bucket)) {
      const got = await src.send(
        new GetObjectCommand({ Bucket: bucket, Key: obj.key })
      );
      const body = got.Body as Readable;

      const hash = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          bytes += chunk.length;
          cb(null, chunk);
        },
      });
      // pipeline(而非裸 pipe)才会传播源流错误;否则 Supabase 侧读取中断时
      // meter 永不 end,Upload.done() 永久挂起。两侧任一失败都终止另一侧。
      const copy = pipeline(body, meter);
      const upload = new Upload({
        client: target.client,
        params: {
          Bucket: target.bucket,
          Key: `${target.base}/storage/${bucket}/${obj.key}`,
          Body: meter,
        },
      });
      try {
        await Promise.all([copy, upload.done()]);
      } catch (error) {
        meter.destroy();
        body.destroy();
        await upload.abort().catch(() => {});
        throw error;
      }

      files.push({ bucket, key: obj.key, bytes, sha256: hash.digest("hex") });
      totalBytes += bytes;
    }
    log.step(`  ${bucket}: ${files.filter((f) => f.bucket === bucket).length} files`);
  }

  // buckets 含空 bucket(files 推不出来)——manifest v2 的 bucket 属性采集要按它查
  return { fileCount: files.length, totalBytes, files, buckets };
}
