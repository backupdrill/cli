// 带 Auth 的恢复里不需要 Docker 的部分:\restrict 判定、失败时说的话、查事务结果的时限、psql 报错解析
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  authRestoreFailureMessage,
  emitsRestrict,
  firstPsqlError,
  restrictHeader,
  transactionOutcome,
} from "../dist/auth-restore.js";

test("restrictHeader: the first line that isn't a comment must be \\restrict <key>", () => {
  assert.equal(restrictHeader("--\n-- PostgreSQL database dump\n--\n\n\\restrict abcDEF123\n\nSET x = 0;\n"), "ok");
  assert.equal(restrictHeader("--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\n"), "missing");
  // 归档内容冒充成 \restrict 行之前的东西也不行:第一条非注释行就得是它
  assert.equal(restrictHeader("\\! touch /tmp/x\n\\restrict abc\n"), "missing");
  assert.equal(restrictHeader("\\restrict abc def\n"), "missing");
  // 还没读到完整的一行:等更多输出
  assert.equal(restrictHeader("--\n-- PostgreSQL database dump\n--\n\n\\restr"), "more");
  assert.equal(restrictHeader(""), "more");
});

test("emitsRestrict: the August 2025 minor releases and 18+", () => {
  for (const v of [[17, 6], [17, 11], [16, 10], [15, 14], [14, 19], [13, 22], [18, 0], [19, 1]]) {
    assert.equal(emitsRestrict(v), true, v.join("."));
  }
  for (const v of [[17, 5], [16, 9], [15, 13], [14, 18], [13, 21], [12, 22]]) {
    assert.equal(emitsRestrict(v), false, v.join("."));
  }
});

test("authRestoreFailureMessage: says rolled back only when it was, and never infers it", () => {
  const rolledBack = authRestoreFailureMessage({ transaction: "rolled_back", failure: "writing the Auth users failed: x", triggers: [] });
  assert.match(rolledBack, /rolled back, so nothing from the snapshot \(Auth users included\) is on the target/);
  const unknown = authRestoreFailureMessage({ transaction: "unknown", failure: "committing failed: y", xid: "4711", triggers: [] });
  assert.doesNotMatch(unknown, /nothing from the snapshot|rolled back/);
  assert.match(unknown, /couldn't confirm whether the target committed it/);
  assert.match(unknown, /select pg_xact_status\('4711'::xid8\);/);
  const noXid = authRestoreFailureMessage({ transaction: "unknown", failure: "committing failed: y", triggers: [] });
  assert.match(noXid, /Check before doing anything else\. If it committed/);
});

test("firstPsqlError: message and DETAIL/HINT, never CONTEXT (that's where COPY puts the row)", () => {
  const stderr = [
    'psql:<stdin>:12: ERROR:  insert or update on table "notes" violates foreign key constraint "notes_owner_fkey"',
    'DETAIL:  Key (owner)=(1) is not present in table "users".',
    "CONTEXT:  COPY notes, line 1: \"1\tsecret@example.test\"",
  ].join("\n");
  const text = firstPsqlError(stderr);
  assert.match(text, /^insert or update on table "notes" violates foreign key constraint "notes_owner_fkey" DETAIL: Key/);
  assert.doesNotMatch(text, /secret@example\.test|CONTEXT/);
  assert.equal(firstPsqlError(""), "(no error output)");
});

test("transactionOutcome: a target that never answers gives 'unknown' on time and the connection is closed", async () => {
  const sockets = [];
  let closed = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("close", () => closed++);
    socket.on("error", () => {});
    socket.resume(); // 读走、从不回答(连握手都不回)
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const started = Date.now();
    const outcome = await transactionOutcome(`postgresql://u:p@127.0.0.1:${server.address().port}/db`, "42", {
      waitMs: 200,
      pollMs: 50,
      graceMs: 500,
    });
    assert.equal(outcome, "unknown");
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    for (let i = 0; i < 50 && closed < sockets.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(closed, sockets.length, "the connection must be closed when it gives up");
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
