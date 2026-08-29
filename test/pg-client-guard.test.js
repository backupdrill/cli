// 回归钉子(2026-08-28 复盘):引擎连客户数据库用的是裸 new Client(),没挂 error 监听。
// node-postgres 在连接建立后被对端掐断时会在 client 上 emit "error",没人监听就是
// uncaughtException —— 本引擎跑在 BackupDrill worker 进程里,一个客户库断连能杀掉整个 worker。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { attachPgErrorGuard } from "../dist/supabase-ca.js";

const srcDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "src");

test("机制:没挂监听的 client emit error 会抛 —— 这就是崩溃路径", () => {
  assert.throws(() => new EventEmitter().emit("error", new Error("Connection terminated unexpectedly")));
});

test("挂上后不抛,且断连被记录(不是被空函数吞掉)", () => {
  const client = new EventEmitter();
  attachPgErrorGuard(client);
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    assert.doesNotThrow(() => client.emit("error", new Error("Connection terminated unexpectedly")));
  } finally {
    console.warn = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Connection terminated unexpectedly/);
});

// 源码扫描:以后新增一处连接又忘了走 connectPg,这里立刻红。
test("src 里没有绕过 connectPg 的 new Client(", () => {
  const files = readdirSync(srcDir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  let offenders = [];
  for (const file of files) {
    if (file === "supabase-ca.ts") continue; // connectPg 自己
    const body = readFileSync(join(srcDir, file), "utf8");
    if (/new Client\(/.test(body)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "这些文件直接 new Client():连接被掐断会杀掉整个 worker");
  assert.ok(files.length >= 5, "扫描没找到源码文件,扫描逻辑可能失效");
});
