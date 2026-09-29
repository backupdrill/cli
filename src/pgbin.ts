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
 * 恢复前的工具/目标版本闸:返回拒绝理由,可放行时返回 null。dry-run 与正式恢复共用,
 * 保证两条路径的判定和给用户的出路一字不差。出路有两条:目标升到 17+;或当归档
 * 本身只需要 ≤16 的 pg_restore(旧版 pg_dump 写的)时,换一个与目标同版本的旧客户端。
 */
export function restoreToolTargetBlocker(
  toolMajor: number,
  targetMajor: number,
  requiredMajor: number
): string | null {
  if (!restoreToolBreaksOnTarget(toolMajor, targetMajor)) return null;
  const olderClient =
    requiredMajor <= targetMajor
      ? ` or point BACKUPDRILL_PG_RESTORE at a pg_restore ${targetMajor} (this archive only needs v${requiredMajor})`
      : "";
  return (
    `local pg_restore is v${toolMajor}, which sends SET transaction_timeout — a setting PostgreSQL ` +
    `${targetMajor} does not have, so the restore would fail on its first statement. ` +
    `Create the target on PostgreSQL 17 or newer${olderClient}.`
  );
}

/**
 * 演练沙箱的主版本:默认与源库同版本(最贴近真实恢复);只有本机 pg_restore 会撞上
 * restoreToolBreaksOnTarget 时,才升到工具的版本。往更新的主版本恢复是官方支持的方向,
 * 而反过来要求用户装与源库同版本的旧工具行不通(旧 pg_restore 读不了新 pg_dump 的归档)。
 * 拿不到工具版本时退回源版本。
 */
export function sandboxMajorFor(sourceMajor: number, toolMajor: number | null): number {
  return toolMajor !== null && restoreToolBreaksOnTarget(toolMajor, sourceMajor) ? toolMajor : sourceMajor;
}
