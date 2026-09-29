import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolvePgRestoreBin } from "../dist/pgbin.js";

// 这个函数修的 bug 是"静默拿 pg_dump 当恢复器执行"(推导不命中时原样返回),
// 属于最容易在未来重构中悄悄回归的一类——用不依赖 Docker 的纯单测锁死六种边界。

const saved = {};
beforeEach(() => {
  for (const k of ["BACKUPDRILL_PG_RESTORE", "BACKUPDRILL_PG_DUMP"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ["BACKUPDRILL_PG_RESTORE", "BACKUPDRILL_PG_DUMP"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("explicit BACKUPDRILL_PG_RESTORE wins over everything", () => {
  process.env.BACKUPDRILL_PG_RESTORE = "/custom/pg_restore";
  process.env.BACKUPDRILL_PG_DUMP = "/opt/libpq/bin/pg_dump";
  assert.equal(resolvePgRestoreBin(), "/custom/pg_restore");
});

test("clean derivation: pg_dump sibling becomes pg_restore", () => {
  process.env.BACKUPDRILL_PG_DUMP = "/opt/homebrew/opt/libpq/bin/pg_dump";
  assert.equal(resolvePgRestoreBin(), "/opt/homebrew/opt/libpq/bin/pg_restore");
});

test("versioned binary name (pg_dump-17) falls back to PATH pg_restore", () => {
  process.env.BACKUPDRILL_PG_DUMP = "/usr/bin/pg_dump-17";
  assert.equal(resolvePgRestoreBin(), "pg_restore");
});

test("wrapper script (pg_dump.sh) falls back to PATH pg_restore", () => {
  process.env.BACKUPDRILL_PG_DUMP = "/usr/local/bin/pg_dump.sh";
  assert.equal(resolvePgRestoreBin(), "pg_restore");
});

test("directory containing pg_dump in its name falls back conservatively", () => {
  // 推导后路径仍含 pg_dump(目录名),绝不能把它当恢复器执行
  process.env.BACKUPDRILL_PG_DUMP = "/opt/pg_dump/bin/pg_dump.exe";
  assert.equal(resolvePgRestoreBin(), "pg_restore");
});

test("no env at all: plain pg_restore from PATH", () => {
  assert.equal(resolvePgRestoreBin(), "pg_restore");
});

// pg_restore 17 起先发 SET transaction_timeout,恢复进 ≤16 的服务端第一句就失败(上游不修)。
// 演练沙箱因此跟着工具升版本,恢复预检则在目标 ≤16 时提前拒绝。
test("restoreToolBreaksOnTarget: only pg_restore 17+ into a server older than 17", async () => {
  const { restoreToolBreaksOnTarget } = await import("../dist/pgbin.js");
  assert.equal(restoreToolBreaksOnTarget(17, 15), true);
  assert.equal(restoreToolBreaksOnTarget(17, 16), true);
  assert.equal(restoreToolBreaksOnTarget(18, 16), true);
  assert.equal(restoreToolBreaksOnTarget(17, 17), false);
  assert.equal(restoreToolBreaksOnTarget(18, 17), false);
  assert.equal(restoreToolBreaksOnTarget(16, 15), false);
});

test("sandboxMajorFor: sandbox never older than the local pg_restore; source version when the tool is unknown", async () => {
  const { sandboxMajorFor } = await import("../dist/pgbin.js");
  assert.equal(sandboxMajorFor(15, 17), 17);
  assert.equal(sandboxMajorFor(16, 17), 17);
  assert.equal(sandboxMajorFor(17, 17), 17);
  assert.equal(sandboxMajorFor(17, 16), 17);
  assert.equal(sandboxMajorFor(15, null), 15);
});

test("parsePgDumpMajor is still exported from backup.js after the move", async () => {
  const backup = await import("../dist/backup.js");
  const pgbin = await import("../dist/pgbin.js");
  assert.equal(backup.parsePgDumpMajor, pgbin.parsePgDumpMajor);
  assert.equal(backup.parsePgDumpMajor("pg_restore (PostgreSQL) 17.10 (Debian 17.10-1.pgdg120+1)"), 17);
});

test("restoreToolTargetBlocker: one message for both restore paths, with the older-client way out when the archive allows it", async () => {
  const { restoreToolTargetBlocker } = await import("../dist/pgbin.js");
  assert.equal(restoreToolTargetBlocker(17, 17, 17), null);
  assert.equal(restoreToolTargetBlocker(16, 16, 16), null);
  const needs17 = restoreToolTargetBlocker(17, 16, 17);
  assert.match(needs17, /transaction_timeout/);
  assert.match(needs17, /PostgreSQL 17 or newer\.$/);
  assert.doesNotMatch(needs17, /BACKUPDRILL_PG_RESTORE/, "a v17 archive cannot be read by pg_restore 16, so do not suggest it");
  const needs16 = restoreToolTargetBlocker(17, 16, 16);
  assert.match(needs16, /BACKUPDRILL_PG_RESTORE at a pg_restore 16/);
});

test("restore.ts: dry-run and the real restore both apply restoreToolTargetBlocker", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/restore.ts", import.meta.url), "utf8");
  const calls = source.match(/restoreToolTargetBlocker\(toolMajor, targetMajor, requiredMajor\)/g) ?? [];
  assert.equal(calls.length, 2, "both restore paths must call the version gate");
});
