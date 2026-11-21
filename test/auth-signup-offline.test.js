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
  assert.deepEqual(signupOutcome(out("ok")), { ran: true, ok: true });
  assert.deepEqual(
    signupOutcome(out("P0001", `PL/pgSQL function public.handle_new_user() line 3 at RAISE\n${OWN_BLOCK}`)),
    { ran: true, ok: false, detail: "a new sign-up would fail: an exception was raised (SQLSTATE P0001) (tested as an email sign-up with no user metadata)" }
  );
  // 错在我们造的那一行本身(只有我们自己那层 DO 块的上下文):不算触发器的问题
  assert.deepEqual(signupOutcome(out("23502", OWN_BLOCK)), {
    ran: false,
    detail: "couldn't simulate a sign-up: a not-null constraint was violated (SQLSTATE 23502)",
  });
});

test("signupOutcome: only a failure caused by the missing network is 'not tested'; anything else is a real sign-up failure", () => {
  const dblinkCall =
    `SQL statement "SELECT public.dblink_exec('host=10.0.0.1', 'insert into t default values')"\n` +
    `PL/pgSQL function public.tell_crm() line 2 at PERFORM\n${OWN_BLOCK}`;
  // dblink 连不上:SQLSTATE 08001,出错的就是 dblink 调用
  const connecting = signupOutcome(out("08001", dblinkCall));
  assert.equal(connecting.ran, false);
  assert.match(connecting.detail, /needed the network \(a connection couldn't be made \(SQLSTATE 08001\)\)/);
  assert.match(connecting.detail, /cut off from the network/);
  // 不是连接类的错,但出错的正是要联网的调用(http 扩展、pg_net、COPY ... PROGRAM、外部表)
  for (const statement of [
    `SQL statement "SELECT http_post('https://crm.example/hook', '{}', 'application/json')"`,
    `SQL statement "SELECT net.http_post(url := 'https://crm.example/hook')"`,
    `SQL statement "copy (select 1) to program 'wget -q https://crm.example/hook'"`,
    "remote SQL command: INSERT INTO public.signups(id) VALUES ($1)",
  ]) {
    const r = signupOutcome(out("XX000", `${statement}\nPL/pgSQL function public.tell_crm() line 2 at PERFORM\n${OWN_BLOCK}`));
    assert.equal(r.ran, false, statement);
  }
  // 沙箱里装着 dblink,但触发器是因为权限失败的:照实报成注册会失败,不藏成"没测成"
  const denied = signupOutcome(
    out("42501", `SQL statement "insert into private.audit values (new.id)"\nPL/pgSQL function public.tell_crm() line 4 at SQL statement\n${OWN_BLOCK}`)
  );
  assert.deepEqual(denied, {
    ran: true,
    ok: false,
    detail: "a new sign-up would fail: permission denied (SQLSTATE 42501) (tested as an email sign-up with no user metadata)",
  });
});

test("signupOutcome: psql that didn't finish (timeout, killed) or printed no result line means no sign-up was simulated", () => {
  assert.deepEqual(signupOutcome({ code: 3, stdout: "" }), { ran: false, detail: "couldn't simulate a sign-up: it didn't finish" });
  assert.deepEqual(signupOutcome({ code: null, stdout: "backupdrill-signup ok \n" }), {
    ran: false,
    detail: "couldn't simulate a sign-up: it didn't finish",
  });
  assert.equal(signupOutcome({ code: 0, stdout: "something else\n" }).ran, false);
});
