// 回归钉子(2026-08-28 复盘):引擎连客户数据库用的是裸 new Client(),没挂 error 监听。
// node-postgres 在连接建立后被对端掐断时会在 client 上 emit "error",没人监听就是
// uncaughtException —— 本引擎跑在 BackupDrill worker 进程里,一个客户库断连能杀掉整个 worker。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import pg from "pg";
import { attachPgErrorGuard, connectPg } from "../dist/supabase-ca.js";

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

/**
 * 最小的假 Postgres:对任何启动包回 AuthenticationOk(R, 0)+ ReadyForQuery(Z, 'I'),
 * 让真正的 pg.Client 认为连上了;然后由测试掐断 socket —— 这正是线上"连接建立后被对端掐断"的形状。
 */
function fakePostgres() {
  const sockets = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.once("data", () => {
      const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
      const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
      socket.write(Buffer.concat([authOk, ready]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, sockets, server }));
  });
}

test("connectPg + 真 pg.Client:连上后被对端掐断 → 进程不崩、后续查询 reject、断连有记录", async () => {
  const { port, sockets, server } = await fakePostgres();
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  // 证明监听挂在 connect() **之前**:包住 Client.prototype.connect,在它被调用的那一刻数监听
  let listenersAtConnect = -1;
  const originalConnect = pg.Client.prototype.connect;
  const connectSpy = mock.method(pg.Client.prototype, "connect", function (...args) {
    listenersAtConnect = this.listenerCount("error");
    return originalConnect.apply(this, args);
  });
  let client;
  let timeout;
  try {
    client = await connectPg(`postgresql://u:p@127.0.0.1:${port}/db`);
    assert.equal(listenersAtConnect, 1, "监听必须在 connect() 被调用时就已挂上,晚一步就是握手后的空窗");
    // 对端掐断;用 client 自己的 error 事件同步,不靠 sleep
    const dropped = new Promise((resolve) => client.once("error", resolve));
    for (const s of sockets) s.destroy();
    const error = await Promise.race([
      dropped,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("no error event within 5s")), 5000);
      }),
    ]);
    assert.match(error.message, /Connection terminated unexpectedly/);
    assert.equal(uncaught.length, 0, "断连变成了 uncaughtException —— 这就是会杀掉 worker 的路径");
    assert.equal(lines.length, 1, "断连要记一行,不能静默");
    assert.match(lines[0], /Connection terminated unexpectedly/);
    await assert.rejects(client.query("select 1"), /terminated|not queryable|closed/i, "断连后的查询要 reject 给调用方");
  } finally {
    clearTimeout(timeout); // 否则赢了竞速的那次也要拖住事件循环 5 秒
    connectSpy.mock.restore();
    process.off("uncaughtException", onUncaught);
    console.warn = originalWarn;
    // 无论断言成败都收干净:server.close() 不会关已接受的连接,漏一个就挂住测试进程
    if (client) await client.end().catch(() => {});
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
