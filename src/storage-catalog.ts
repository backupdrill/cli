// Bucket 属性采集(Manifest v2,恢复闭环 PRD §5.1.3):public / 大小限制 / MIME 限制。
// 通道 = 源库 storage.buckets —— S3 兼容端点看不到这些属性,而备份本来就持有只读库连接,
// 零新增凭据(R0 spike 实证)。per-file 元数据不在这里:它随 syncStorage 的 GetObject
// 响应原子捕获(见 storage.ts fileMetadataFromS3)。
// 任何失败都由调用方降级为"未捕获"(manifest 缺 buckets 字段),绝不弄失败一次备份。
import { Client } from "pg";
import type { BucketAttrs } from "./manifest.js";
import { pgConnectOptions } from "./supabase-ca.js";

interface BucketRow {
  id: string;
  name: string;
  public: boolean | null;
  file_size_limit: string | number | null;
  allowed_mime_types: string[] | null;
}

/**
 * 行 → manifest 形状的纯映射,含完整性关口:查询结果必须覆盖每一个请求的 bucket。
 * storage.buckets 上的 RLS 或并发删除会**静默**少返回行——把不完整清单写进 manifest,
 * 恢复端就会漏建 bucket 还以为自己全知。缺任何一个 → 抛错,由调用方整体降级为"未捕获"。
 * 请求标识来自 S3 层(ListBuckets),优先按 buckets.id 匹配(id 与 name 允许不同),
 * 无中再退 name。null 属性原样保留(= 源端未设置,不是猜测值)。
 */
export function bucketAttrsFromRows(
  requestedBuckets: string[],
  bucketRows: BucketRow[]
): BucketAttrs[] {
  const attrs: BucketAttrs[] = [];
  const missing: string[] = [];
  for (const req of requestedBuckets) {
    const row =
      bucketRows.find((r) => r.id === req) ?? bucketRows.find((r) => r.name === req);
    if (!row) {
      missing.push(req);
      continue;
    }
    attrs.push({
      name: req, // 快照对象布局用的标识(S3 层名),恢复端按它重建
      public: row.public,
      fileSizeLimit: row.file_size_limit === null ? null : Number(row.file_size_limit),
      allowedMimeTypes: row.allowed_mime_types,
    });
  }
  if (missing.length) {
    throw new Error(
      `storage.buckets returned no row for: ${missing.join(", ")} ` +
        `(RLS filtering or concurrent deletion) — refusing a partial bucket capture`
    );
  }
  return attrs;
}

/** 查询源库的 bucket 属性。bucketNames 含空 bucket(恢复端要能重建它们)。 */
export async function inspectBucketAttrs(
  databaseUrl: string,
  bucketNames: string[]
): Promise<BucketAttrs[]> {
  const client = new Client(pgConnectOptions(databaseUrl));
  await client.connect();
  try {
    const bucketRows = await client.query<BucketRow>(
      `select id, name, public, file_size_limit, allowed_mime_types
         from storage.buckets where id = any($1::text[]) or name = any($1::text[])
        order by name`,
      [bucketNames]
    );
    return bucketAttrsFromRows(bucketNames, bucketRows.rows);
  } finally {
    await client.end();
  }
}
