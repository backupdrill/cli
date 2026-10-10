// S3 / R2 / B2 的分片上传都限 10,000 片,除最后一片外每片至少 5 MiB。
// lib-storage 只有在知道总长度时才会自己放大分片;长度未知的流(pg_dump、
// 没传长度的 Storage 拷贝)一律按 5 MiB 切,单个对象最多约 48.8 GiB,
// 再大就在上传途中报 "Exceeded 10000 parts" 失败。
const MAX_PARTS = 10_000;
const MIB = 1024 * 1024;
const MIN_PART_BYTES = 5 * MIB;

/** 能把 expectedBytes 装进 10,000 片的最小分片大小,按 MiB 取整,不低于 5 MiB。 */
export function partSizeFor(expectedBytes: number): number {
  const neededBytes = Math.ceil(Math.max(0, expectedBytes) / MAX_PARTS);
  return Math.max(MIN_PART_BYTES, Math.ceil(neededBytes / MIB) * MIB);
}
