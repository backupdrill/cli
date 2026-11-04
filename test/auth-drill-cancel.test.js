// 演练里 Auth 检查超时后的收尾(不需要 Docker):叫停之后不再起任何连接或 pg_restore,
// 已经在跑的当场停掉;事后清理会话的那条连接有硬时限,沙箱不回应也挂不住进程。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgRestoreOutput, spawnPgRestore } from "../dist/restore-engine.js";
import { connectCancellable } from "../dist/auth-backup.js";
import { runAuthDrill, stopAuthSessions } from "../dist/auth-drill.js";

/**
 * 假 Postgres。answerStartup 为 true 时对启动包回 AuthenticationOk + ReadyForQuery(客户端认为连上了),
 * 之后的查询一概不回 —— 正是"沙箱卡住、查询石沉大海"的形状;为 false 时连握手都不回。
 */
function stalledPostgres({ answerStartup }) {
  const sockets = [];
  let closed = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("close", () => closed++);
    socket.on("error", () => {});
    // 一直读走(不回):不读的话对端关掉时这边收不到 EOF,也就看不到 close
    socket.resume();
    if (answerStartup) {
      socket.once("data", () => {
        socket.write(Buffer.concat([Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]), Buffer.from([0x5a, 0, 0, 0, 5, 0x49])]));
      });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `postgresql://u:p@127.0.0.1:${server.address().port}/db`,
        connections: () => sockets.length,
        closed: () => closed,
        stop: async () => {
          for (const s of sockets) s.destroy();
          await new Promise((r) => server.close(r));
        },
      })
    );
  });
}

test("spawnPgRestore:已经叫停就不起进程", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bd-cancel-"));
  try {
    const marker = join(dir, "started");
    await assert.rejects(
      spawnPgRestore("touch", [marker], {}, { supabaseHost: false, signal: AbortSignal.abort() }),
      /stopped by the caller/
    );
    assert.equal(existsSync(marker), false, "叫停之后不能再起 pg_restore");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnPgRestore:运行中叫停,进程当场停掉", async () => {
  const stop = new AbortController();
  const started = Date.now();
  const run = spawnPgRestore("sleep", ["30"], {}, { supabaseHost: false, signal: stop.signal });
  setTimeout(() => stop.abort(), 200);
  const result = await run;
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started < 5000, "叫停后进程要立刻退出");
});

test("pgRestoreOutput:已经叫停就不起进程,运行中叫停就停掉", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bd-cancel-"));
  try {
    const marker = join(dir, "started");
    await assert.rejects(pgRestoreOutput("touch", [marker], { signal: AbortSignal.abort() }), /stopped by the caller/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const stop = new AbortController();
  const started = Date.now();
  const run = pgRestoreOutput("sleep", ["30"], { signal: stop.signal });
  setTimeout(() => stop.abort(), 200);
  const result = await run;
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started < 5000, "叫停后进程要立刻退出");
});

test("runAuthDrill:建临时目录失败时还没连沙箱,不会留下连接", async () => {
  const pgServer = await stalledPostgres({ answerStartup: true });
  const dir = mkdtempSync(join(tmpdir(), "bd-cancel-"));
  const previousTmp = process.env.TMPDIR;
  try {
    const authPath = join(dir, "auth.dump");
    writeFileSync(authPath, "not a real archive");
    const sha256 = createHash("sha256").update("not a real archive").digest("hex");
    const manifest = { auth: { status: "included", dump: { sha256 } }, database: { schemas: ["public"] } };
    process.env.TMPDIR = join(dir, "missing", "deeper");
    await assert.rejects(runAuthDrill(pgServer.url, manifest, join(dir, "dump.pgcustom"), { path: authPath }), /ENOENT/);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(pgServer.connections(), 0, "临时目录建不出来时不该已经连上沙箱");
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(dir, { recursive: true, force: true });
    await pgServer.stop();
  }
});

test("connectCancellable:已经叫停就不连", async () => {
  const pgServer = await stalledPostgres({ answerStartup: true });
  try {
    await assert.rejects(connectCancellable(pgServer.url, AbortSignal.abort()), /stopped by the caller/);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(pgServer.connections(), 0, "叫停之后不能再开连接");
  } finally {
    await pgServer.stop();
  }
});

test("connectCancellable:握手中途叫停,connect 立刻 reject(不是永远悬着)", async () => {
  const pgServer = await stalledPostgres({ answerStartup: false });
  try {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const started = Date.now();
    await assert.rejects(connectCancellable(pgServer.url, stop.signal), /stopped by the caller/);
    assert.ok(Date.now() - started < 3000, `等了 ${Date.now() - started} ms`);
  } finally {
    await pgServer.stop();
  }
});

test("stopAuthSessions:沙箱连上了却不回查询,到点就放手并关掉连接", async () => {
  const pgServer = await stalledPostgres({ answerStartup: true });
  try {
    const started = Date.now();
    await stopAuthSessions(pgServer.url, 1000);
    assert.ok(Date.now() - started < 4000, `等了 ${Date.now() - started} ms`);
    assert.equal(pgServer.connections(), 1);
    // socket 必须真的关掉:只停止等待、连接还留着,CLI 就退不出去
    for (let i = 0; i < 50 && pgServer.closed() < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(pgServer.closed(), 1, "清理连接到点后没有关掉");
  } finally {
    await pgServer.stop();
  }
});

test("stopAuthSessions:沙箱连握手都不回,到点就放手并关掉连接", async () => {
  const pgServer = await stalledPostgres({ answerStartup: false });
  try {
    const started = Date.now();
    await stopAuthSessions(pgServer.url, 1000);
    assert.ok(Date.now() - started < 4000, `等了 ${Date.now() - started} ms`);
    for (let i = 0; i < 50 && pgServer.closed() < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(pgServer.closed(), 1, "清理连接到点后没有关掉");
  } finally {
    await pgServer.stop();
  }
});
