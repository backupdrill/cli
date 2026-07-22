import { test } from "node:test";
import assert from "node:assert/strict";
import { pgRestoreOutcome } from "../dist/restore.js";

test("退出码 0 即成功(stderr 里的 NOTICE/警告不影响)", () => {
  assert.deepEqual(pgRestoreOutcome(0, "pg_restore: warning: errors ignored on restore: 0\n"), {
    ok: true,
  });
});

test("非零退出 + 标准 error 文本 → 失败(旧行为保持)", () => {
  const r = pgRestoreOutcome(1, "pg_restore: error: could not execute query\n");
  assert.equal(r.ok, false);
  assert.match(r.message, /code 1/);
  assert.match(r.message, /could not execute query/);
});

// 假成功回归钉子(增补 PRD §5.2.3/D4):以下三种此前都被判成功。
test("非零退出但 stderr 无 error: 字样 → 仍然失败(非英文 locale 的报错)", () => {
  const r = pgRestoreOutcome(1, "pg_restore: Fehler: Verbindung fehlgeschlagen\n");
  assert.equal(r.ok, false);
  assert.match(r.message, /code 1/);
});

test("被 signal 杀死(code=null)→ 失败", () => {
  const r = pgRestoreOutcome(null, "");
  assert.equal(r.ok, false);
  assert.match(r.message, /signal/);
});

test("非零退出且 stderr 为空 → 失败,并说明没有错误输出", () => {
  const r = pgRestoreOutcome(2, "");
  assert.equal(r.ok, false);
  assert.match(r.message, /no error output/);
});
