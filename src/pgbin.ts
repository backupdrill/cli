/**
 * pg_restore 二进制解析:显式 BACKUPDRILL_PG_RESTORE 最高优先;否则从
 * BACKUPDRILL_PG_DUMP 同目录推导。推导未命中(结果仍含 pg_dump 或与原值相同,
 * 如指向包装脚本/带版本后缀的路径)时回退到 PATH 上的 pg_restore——
 * 绝不能把 pg_dump 当恢复器执行。
 */
export function resolvePgRestoreBin(): string {
  if (process.env.BACKUPDRILL_PG_RESTORE) return process.env.BACKUPDRILL_PG_RESTORE;
  const pgDump = process.env.BACKUPDRILL_PG_DUMP;
  if (pgDump) {
    const derived = pgDump.replace(/pg_dump$/, "pg_restore");
    if (derived !== pgDump && !derived.includes("pg_dump")) return derived;
  }
  return "pg_restore";
}
