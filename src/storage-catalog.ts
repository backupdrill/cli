// Storage 目录采集(Manifest v2,恢复闭环 PRD §5.1.3):bucket 属性 + 每文件元数据。
// 通道 = 源库 storage.buckets / storage.objects —— 备份本来就持有只读库连接,零新增凭据;
// S3 兼容端点拿不到 bucket 的 public/限额属性,这是 DB 通道存在的原因(R0 spike 实证)。
// 任何失败都由调用方降级为"未捕获"(manifest 缺字段),绝不让元数据采集弄失败一次备份。
import { Client } from "pg";
import type { BucketAttrs, StorageFile } from "./manifest.js";
import { pgConnectOptions } from "./supabase-ca.js";

export interface FileMeta {
  contentType?: string;
  cacheControl?: string;
  contentEncoding?: string;
  metadata?: Record<string, unknown>;
  lastModified?: string;
}

interface BucketRow {
  name: string;
  public: boolean | null;
  file_size_limit: string | number | null;
  allowed_mime_types: string[] | null;
}

interface ObjectRow {
  bucket_id: string;
  name: string;
  mimetype: string | null;
  cache_control: string | null;
  content_encoding: string | null;
  user_metadata: Record<string, unknown> | null;
  updated_at: Date | string | null;
}

/** map 键 = `${bucket}/${key}`,与快照对象键布局同构。 */
export function fileMetaKey(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

/**
 * 行 → manifest 形状的纯映射。null 原样保留(= 源端未设置);
 * user_metadata 为空对象时省略字段——{} 没有恢复价值,只会撑大 manifest。
 *
 * 完整性关口:查询结果必须覆盖每一个请求的 bucket。storage.buckets 上的 RLS
 * 或并发删除会**静默**少返回行——把不完整清单写进 manifest,恢复端就会漏建 bucket
 * 还以为自己全知。缺任何一个 → 抛错,由调用方整体降级为"未捕获"。
 */
export function catalogFromRows(
  requestedBuckets: string[],
  bucketRows: BucketRow[],
  objectRows: ObjectRow[]
): { buckets: BucketAttrs[]; fileMeta: Map<string, FileMeta> } {
  const returned = new Set(bucketRows.map((r) => r.name));
  const missing = requestedBuckets.filter((name) => !returned.has(name));
  if (missing.length) {
    throw new Error(
      `storage.buckets returned no row for: ${missing.join(", ")} ` +
        `(RLS filtering or concurrent deletion) — refusing a partial bucket capture`
    );
  }
  const buckets = bucketRows.map((r) => ({
    name: r.name,
    public: r.public,
    fileSizeLimit: r.file_size_limit === null ? null : Number(r.file_size_limit),
    allowedMimeTypes: r.allowed_mime_types,
  }));
  const fileMeta = new Map<string, FileMeta>();
  for (const r of objectRows) {
    const meta: FileMeta = {};
    if (r.mimetype) meta.contentType = r.mimetype;
    if (r.cache_control) meta.cacheControl = r.cache_control;
    if (r.content_encoding) meta.contentEncoding = r.content_encoding;
    if (r.user_metadata && Object.keys(r.user_metadata).length) meta.metadata = r.user_metadata;
    if (r.updated_at) {
      meta.lastModified =
        r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at);
    }
    fileMeta.set(fileMetaKey(r.bucket_id, r.name), meta);
  }
  return { buckets, fileMeta };
}

/**
 * 把目录元数据合并进已同步的文件清单。文件在 DB 里查不到(同步与查询之间被删/改名)
 * → 保持原样 = 该文件元数据未捕获,恢复端如实处理,不猜测。
 */
export function mergeFileMetadata(
  files: StorageFile[],
  fileMeta: Map<string, FileMeta>
): StorageFile[] {
  return files.map((f) => {
    const meta = fileMeta.get(fileMetaKey(f.bucket, f.key));
    return meta ? { ...f, ...meta } : f;
  });
}

/**
 * 查询源库的 storage 目录。bucketNames 来自本次实际同步的 bucket 集合
 * (含空 bucket——恢复端要能重建它们)。
 * 单次全量拉取:目录行很小(每文件几百字节),大 Storage 项目按 egress 否决项结论
 * 本就是禁区,不为其做分页复杂度。
 */
export async function inspectStorageCatalog(
  databaseUrl: string,
  bucketNames: string[]
): Promise<{ buckets: BucketAttrs[]; fileMeta: Map<string, FileMeta> }> {
  const client = new Client(pgConnectOptions(databaseUrl));
  await client.connect();
  try {
    const bucketRows = await client.query<BucketRow>(
      `select name, public, file_size_limit, allowed_mime_types
         from storage.buckets where name = any($1::text[]) order by name`,
      [bucketNames]
    );
    const objectRows = await client.query<ObjectRow>(
      `select bucket_id, name,
              metadata->>'mimetype' as mimetype,
              metadata->>'cacheControl' as cache_control,
              metadata->>'contentEncoding' as content_encoding,
              user_metadata,
              updated_at
         from storage.objects where bucket_id = any($1::text[])`,
      [bucketNames]
    );
    return catalogFromRows(bucketNames, bucketRows.rows, objectRows.rows);
  } finally {
    await client.end();
  }
}
