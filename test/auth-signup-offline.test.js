// 演练里的模拟注册(2.11.1 起断网跑,经容器里的 psql):SQL 怎么拼、psql 的输出怎么读成报告。不需要 Docker;
// 真的断网跑一遍(含 dblink 触发器写不出去)在 auth-drill.test.js 里。
import { test } from "node:test";
import assert from "node:assert/strict";
import { signupOutcome, signupScript } from "../dist/auth-drill.js";

const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const out = (state, context = "", message = "") => ({ code: 0, stdout: `backupdrill-signup ${state} ${hex(context)} ${hex(message)}\n` });
const OWN_BLOCK = 'SQL statement "insert into auth.users (id) values (1)"\nPL/pgSQL function inline_code_block line 9 at SQL statement';

test("signupScript: rolls back, runs as supabase_auth_admin, and quotes the block with this sign-up's random marker", () => {
  const marker = "0123456789abcdef";
  const a = signupScript("insert into auth.users (\"$bd_x$\") values (1)", "insert into auth.identities (id) values (1)", marker);
  assert.match(a, /^do \$bd_0123456789abcdef\$$/m);
  assert.equal(a.split("$bd_0123456789abcdef$").length, 3, "the marker only opens and closes the block");
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

test("signupOutcome: 'may need network access' only with evidence of a connection failure; anything else is a real sign-up failure", () => {
  const inTrigger = (statement) => `${statement}\nPL/pgSQL function public.tell_crm() line 2 at PERFORM\n${OWN_BLOCK}`;
  const dblinkCall = inTrigger(`SQL statement "SELECT public.dblink_exec('host=10.0.0.1', 'insert into t default values')"`);
  const httpCall = inTrigger(`SQL statement "SELECT http_post('https://crm.example/hook', '{}', 'application/json')"`);
  const notTested = (r) => {
    assert.equal(r.ran, false, JSON.stringify(r));
    assert.match(r.detail, /^an operation in the offline sandbox may need network access — .+$/);
  };
  // 连接类 SQLSTATE(dblink、postgres_fdw 连不上)
  notTested(signupOutcome(out("08001", dblinkCall, "could not establish connection")));
  // 联网调用自己报的连接/解析失败(http 扩展的 libcurl 错误是 XX000)
  notTested(signupOutcome(out("XX000", httpCall, "Couldn't resolve host name")));
  // COPY ... PROGRAM:消息里有连不上的证据才算
  const copyProgram = inTrigger(`SQL statement "copy (select 1) to program 'wget -q https://crm.example/hook'"`);
  notTested(signupOutcome(out("38000", copyProgram, "wget: bad address 'crm.example'")));

  const failed = (r, sqlstate) =>
    assert.deepEqual(r, {
      ran: true,
      ok: false,
      detail: `a new sign-up would fail: ${sqlstate} (tested as an email sign-up with no user metadata)`,
    });
  // 出错的语句里也调了 net.http_post,但失败的是检查约束(审查复现的情况):真问题
  failed(
    signupOutcome(out("23514", inTrigger(`SQL statement "insert into public.hooks (r) values (net.http_post(url := 'https://crm.example'))"`), "new row violates check constraint")),
    "a check constraint was violated (SQLSTATE 23514)"
  );
  // dblink 调用本身报权限不够(42501)、dblink 没装(42883):真问题
  failed(signupOutcome(out("42501", dblinkCall, "permission denied for function dblink_exec")), "permission denied (SQLSTATE 42501)");
  failed(signupOutcome(out("42883", dblinkCall, "function public.dblink_exec(unknown, unknown) does not exist")), "a function doesn't exist (SQLSTATE 42883)");
  // COPY ... PROGRAM 只说程序失败、看不出原因:真问题
  failed(signupOutcome(out("38000", copyProgram, 'program "wget -q https://crm.example/hook" failed')), "an error (SQLSTATE 38000)");
  // http 调用报的不是连接问题,或者触发器自己 RAISE:真问题
  failed(signupOutcome(out("XX000", httpCall, "invalid content type")), "an error (SQLSTATE XX000)");
  failed(signupOutcome(out("P0001", httpCall, "could not connect")), "an exception was raised (SQLSTATE P0001)");
});

test("signupOutcome: psql that didn't finish (timeout, killed) or printed no result line means no sign-up was simulated", () => {
  assert.deepEqual(signupOutcome({ code: 3, stdout: "" }), { ran: false, detail: "psql returned no usable sign-up test result" });
  assert.deepEqual(signupOutcome({ code: null, stdout: "backupdrill-signup ok  \n" }), {
    ran: false,
    detail: "psql returned no usable sign-up test result",
  });
  assert.equal(signupOutcome({ code: 0, stdout: "something else\n" }).ran, false);
});
