import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

/**
 * Parse the major version out of `pg_dump --version` output.
 *
 * MUST tolerate a trailing vendor suffix: Homebrew/macOS prints `pg_dump (PostgreSQL) 17.2`, but
 * Debian/PGDG (what the deployed worker image uses) prints
 * `pg_dump (PostgreSQL) 17.10 (Debian 17.10-1.pgdg120+1)`. Anchoring the match to end-of-string
 * therefore breaks in production while passing on a dev Mac. Anchor on the `(PostgreSQL)` marker
 * instead, falling back to the first dotted version token for non-standard builds.
 */
export function parsePgDumpMajor(raw: string): number | null {
  const match = raw.match(/\(PostgreSQL\)\s+(\d+)/) ?? raw.match(/(\d+)(?:\.\d+)+/);
  return match ? Number(match[1]) : null;
}

/** 本地 pg_restore 主版本(拿不到 → null,由调用方决定 fail-open 还是 fail-closed)。 */
export async function localPgRestoreMajor(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(resolvePgRestoreBin(), ["--version"]);
    return parsePgDumpMajor(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * pg_restore 17 起每次恢复都先发 `SET transaction_timeout = 0`,这个参数 PostgreSQL 17
 * 才有,恢复进 16 及更老的服务端第一句就报 unrecognized configuration parameter。
 * 上游定性为设计如此(pgsql-bugs 2024-10),不会修,只能绕开。
 */
export function restoreToolBreaksOnTarget(toolMajor: number, targetMajor: number): boolean {
  return toolMajor >= 17 && targetMajor < 17;
}

/**
 * 演练沙箱的主版本:源库与本机 pg_restore 取大者。PG15/16 的源库若按源版本起沙箱,
 * 就会撞上 restoreToolBreaksOnTarget;往更新的主版本恢复是官方支持的方向,
 * 所以让沙箱跟着工具升,而不是要求用户装一套和源库同版本的旧工具
 * (旧 pg_restore 也读不了新 pg_dump 写的归档)。拿不到工具版本时退回源版本。
 */
export function sandboxMajorFor(sourceMajor: number, toolMajor: number | null): number {
  return toolMajor === null ? sourceMajor : Math.max(sourceMajor, toolMajor);
}
