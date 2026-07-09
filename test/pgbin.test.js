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
