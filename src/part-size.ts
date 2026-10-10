// S3 / R2 / B2 的分片上传都限 10,000 片,除最后一片外每片至少 5 MiB。
// lib-storage 只有在知道总长度时才会自己放大分片;长度未知的流(pg_dump、
// 没传长度的 Storage 拷贝)一律按 5 MiB 切,单个对象最多约 48.8 GiB,
// 再大就在上传途中报 "Exceeded 10000 parts" 失败。
const MAX_PARTS = 10_000;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MIN_PART_BYTES = 5 * MIB;

// 转储体积事先不知道,只能拿表的磁盘占用(含索引与 TOAST)去估。pg_dump 的
// custom 格式默认 gzip 压缩,实测转储只有磁盘占用的零头(LZ4 TOAST 的重复文本
// 约 0.16 倍、jsonb 约 0.53 倍);已压缩的 bytea 会以 hex 导出再 gzip,略大于 1 倍。
// 所以按 2 倍留余量。
const DUMP_SIZE_HEADROOM = 2;

// 估算总有失准的时候(比如 pg_dump 没带 zlib、转储不压缩,重复文本能膨胀上百倍),
// 所以分片再设一个保底:按 200 GiB 的转储算,也就是付费最高档每项目 100 GB 的
// 2 倍。这样托管服务里任何套餐允许的转储都传得完,和估算准不准无关。
// 代价是每次上传最多多占几十 MiB 内存(21 MiB 一片,lib-storage 默认并发 4 片)。
const BASELINE_DUMP_BYTES = 200 * GIB;

/** 能把 expectedBytes 装进 10,000 片的最小分片大小,按 MiB 取整,不低于 5 MiB。 */
export function partSizeFor(expectedBytes: number): number {
  const neededBytes = Math.ceil(Math.max(0, expectedBytes) / MAX_PARTS);
  return Math.max(MIN_PART_BYTES, Math.ceil(neededBytes / MIB) * MIB);
}

/** 数据库转储的分片大小:按估算体积 × 2 算,不低于 200 GiB 转储所需;量不出体积就用保底。 */
export function dumpPartSizeFor(relationBytes: number | null): number {
  return partSizeFor(Math.max(BASELINE_DUMP_BYTES, (relationBytes ?? 0) * DUMP_SIZE_HEADROOM));
}
