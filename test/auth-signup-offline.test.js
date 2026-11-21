// 演练里的模拟注册(2.11.1 起断网跑,经容器里的 psql):SQL 怎么拼、psql 的输出怎么读成报告。不需要 Docker;
// 真的断网跑一遍(含 dblink 触发器写不出去)在 auth-drill.test.js 里。
import { test } from "node:test";
import assert from "node:assert/strict";
import { signupOutcome, signupScript } from "../dist/auth-drill.js";

const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const out = (state, context = "") => ({ code: 0, stdout: `backupdrill-signup ${state} ${hex(context)}\n` });
const OWN_BLOCK = 'SQL statement "insert into auth.users (id) values (1)"\nPL/pgSQL function inline_code_block line 9 at SQL statement';

test("signupScript: rolls back, runs as supabase_auth_admin, and uses a fresh dollar-quote tag the inserts can't close", () => {
  const a = signupScript("insert into auth.users (\"$bd_x$\") values (1)", "insert into auth.identities (id) values (1)");
  const b = signupScript("insert into auth.users (id) values (1)", "insert into auth.identities (id) values (1)");
  const tagA = /^do (\$bd_[0-9a-f]{16}\$)$/m.exec(a)[1];
  const tagB = /^do (\$bd_[0-9a-f]{16}\$)$/m.exec(b)[1];
  assert.notEqual(tagA, tagB);
  assert.equal(a.split(tagA).length, 3, "the tag only opens and closes the block");
  assert.match(a, /set local role supabase_auth_admin;/);
  assert.match(a, /set constraints all immediate;/);
  assert.match(a.trimEnd(), /rollback;$/);
  assert.doesNotMatch(a, /\bcommit\b/i);
});

test("signupOutcome: ok, a trigger that fails, and a test row that doesn't fit the table", () => {
  assert.deepEqual(signupOutcome(out("ok"), []), { ran: true, ok: true });
  assert.deepEqual(
    signupOutcome(out("P0001", `PL/pgSQL function public.handle_new_user() line 3 at RAISE\n${OWN_BLOCK}`), []),
    { ran: true, ok: false, detail: "a new sign-up would fail: an exception was raised (SQLSTATE P0001) (tested as an email sign-up with no user metadata)" }
  );
  // 错在我们造的那一行本身(只有我们自己那层 DO 块的上下文):不算触发器的问题
  assert.deepEqual(signupOutcome(out("23502", OWN_BLOCK), []), {
    ran: false,
    detail: "couldn't simulate a sign-up: a not-null constraint was violated (SQLSTATE 23502)",
  });
});

test("signupOutcome: a trigger failing while the sandbox is off the network isn't reported as a broken sign-up", () => {
  const trigger = `PL/pgSQL function public.tell_crm() line 2 at PERFORM\n${OWN_BLOCK}`;
  const viaExtension = signupOutcome(out("XX000", trigger), ["dblink"]);
  assert.equal(viaExtension.ran, false);
  assert.match(viaExtension.detail, /the sandbox has dblink/);
  assert.match(viaExtension.detail, /cut off from the network/);
  const connecting = signupOutcome(out("08001", trigger), []);
  assert.equal(connecting.ran, false);
  assert.match(connecting.detail, /a connection couldn't be made \(SQLSTATE 08001\)/);
  // 和网络无关的失败照旧报出来(没装能连外网的扩展)
  assert.equal(signupOutcome(out("P0001", trigger), []).ok, false);
});

test("signupOutcome: psql that didn't finish (timeout, killed) or printed no result line means no sign-up was simulated", () => {
  assert.deepEqual(signupOutcome({ code: 3, stdout: "" }, []), { ran: false, detail: "couldn't simulate a sign-up: it didn't finish" });
  assert.deepEqual(signupOutcome({ code: null, stdout: "backupdrill-signup ok \n" }, []), {
    ran: false,
    detail: "couldn't simulate a sign-up: it didn't finish",
  });
  assert.equal(signupOutcome({ code: 0, stdout: "something else\n" }, []).ran, false);
});
