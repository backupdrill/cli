import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import type { BackupConfig } from "./config.js";

/** 读备份桶(用户自己的桶)的 S3 客户端。drill/restore 共用。 */
export function targetClient(config: BackupConfig): S3Client {
  return new S3Client({
    region: config.storage.region,
    endpoint: config.storage.endpoint,
    forcePathStyle: config.storage.forcePathStyle,
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
  });
}

/** 定位快照:显式指定,否则取字典序最大(时间戳格式天然可排序)。返回带尾斜杠的前缀。 */
export async function resolveSnapshot(
  s3: S3Client,
  config: BackupConfig,
  explicit?: string
): Promise<string> {
  const root = `${config.storage.prefix}/${config.projectName}/`;
  if (explicit) return `${root}${explicit}/`;

  const prefixes: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.storage.bucket,
        Prefix: root,
        Delimiter: "/",
        ContinuationToken: token,
      })
    );
    for (const cp of res.CommonPrefixes ?? []) {
      if (cp.Prefix) prefixes.push(cp.Prefix);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  if (!prefixes.length) {
    throw new Error(
      `No snapshots found under s3://${config.storage.bucket}/${root}. Run a backup first.`
    );
  }
  prefixes.sort();
  return prefixes[prefixes.length - 1];
}

export async function getObjectText(
  s3: S3Client,
  bucket: string,
  key: string
): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body!.transformToString();
}

/** 下载对象到本地文件,顺带算 sha256(验证读回的归档没被损坏)。 */
export async function downloadToFile(
  s3: S3Client,
  bucket: string,
  key: string,
  dest: string
): Promise<{ bytes: number; sha256: string }> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const hash = createHash("sha256");
  let bytes = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(res.Body as Readable, hasher, createWriteStream(dest));
  return { bytes, sha256: hash.digest("hex") };
}

/** 只算对象校验和、不落盘(Storage 文件完整性校验用,省内存/磁盘)。 */
export async function hashObject(
  s3: S3Client,
  bucket: string,
  key: string
): Promise<{ bytes: number; sha256: string }> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of res.Body as Readable) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest("hex") };
}
