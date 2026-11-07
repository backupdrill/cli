// copyRowCounter:逐块读 pg_restore --data-only 的整份输出,数出每张表的确切行数;
// rowCountsCheck:恢复后的行数和这份数逐表比。真 dump 的端到端见 drill-row-counts.test.js。
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyRowCounter } from "../dist/restore-engine.js";
import { rowCountsCheck } from "../dist/drill.js";

const key = (schema, name) => `${schema}\u0000${name}`;

/** 按给定切点逐块喂,返回 finish() 的结果,Map 转成普通对象方便比较 */
function count(...chunks) {
  const counter = copyRowCounter();
  for (const chunk of chunks) counter.feed(chunk);
  const result = counter.finish();
  return result === null ? null : Object.fromEntries([...result].map(([k, v]) => [k.replace("\u0000", "."), v]));
}

const OUTPUT =
  "--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\n" +
  "--\n-- Data for Name: a; Type: TABLE DATA; Schema: public; Owner: -\n--\n\n" +
  "COPY public.a (id, v) FROM stdin;\n1\tx\n2\t\\\\.starts with an escaped terminator\n3\tline\\nbreak\n\\.\n\n" +
  "COPY public.empty (id) FROM stdin;\n\\.\n\n" +
  // 没有列的表:每行数据是空行
  "COPY public.nocols  FROM stdin;\n\n\n\n\\.\n\n" +
  'COPY "my schema"."T" ("a""b") FROM stdin;\n1\n\\.\n\n' +
  // 值本身就是 \.:COPY 里写成 \\.,不是结束符
  "COPY public.esc (v) FROM stdin;\n\\\\.\n\\\\.x\n\\.\n\n" +
  "SELECT pg_catalog.setval('public.a_id_seq', 3, true);\n";

const EXPECTED = { "public.a": 3, "public.empty": 0, "public.nocols": 3, "my schema.T": 1, "public.esc": 2 };

test("copyRowCounter: counts every COPY section exactly", () => {
  assert.deepEqual(count(OUTPUT), EXPECTED);
});

test("copyRowCounter: the same answer however the output is split into chunks", () => {
  for (let cut = 1; cut < OUTPUT.length; cut++) {
    assert.deepEqual(count(OUTPUT.slice(0, cut), OUTPUT.slice(cut)), EXPECTED, `cut at ${cut}`);
  }
  assert.deepEqual(count(...OUTPUT.split("")), EXPECTED, "one character at a time");
});

test("copyRowCounter: a header that spans lines inside quoted names is read whole", () => {
  // 列名里有 " FROM stdin;"、换行和 \.:只看单行会在第一行"结束"头,再把 \. 当成结束符
  const tricky = 'COPY public.tricky (id, "x FROM stdin;\n\\.\ny") FROM stdin;\n1\ta\n2\tb\n\\.\n';
  assert.deepEqual(count(tricky), { "public.tricky": 2 });
  assert.deepEqual(count('COPY public."line\nbreak" (id) FROM stdin;\n1\n\\.\n'), { "public.line\nbreak": 1 });
});

test("copyRowCounter: a huge row is counted without holding the whole line", () => {
  const counter = copyRowCounter();
  counter.feed("COPY public.big (id, blob) FROM stdin;\n1\t\\\\x");
  for (let i = 0; i < 50; i++) counter.feed("ab".repeat(65_536));
  counter.feed("\n\\.\n");
  assert.deepEqual(Object.fromEntries(counter.finish()), { [key("public", "big")]: 1 });
});

test("copyRowCounter: anything it can't read exactly gives no counts at all", () => {
  // 读不懂的 COPY 头
  assert.equal(count("COPY public.t WITH garbage FROM stdin;\n1\n\\.\n"), null);
  // 头超长
  assert.equal(count('COPY public."' + "x".repeat(100_001)), null);
  // 输出停在数据段中间、或者停在多行头中间(pg_restore 没写完)
  assert.equal(count("COPY public.t (id) FROM stdin;\n1\n2\n"), null);
  assert.equal(count('COPY public."half\n'), null);
  // 没有 COPY 段:空结果,不是 null(由比对那一步决定缺数据段的表怎么办)
  assert.deepEqual(count("REFRESH MATERIALIZED VIEW public.mv;\n"), {});
});

// ── rowCountsCheck ──

const manifest = (names) => ({
  database: { tables: names.map((name) => ({ schema: "public", name, estimatedRows: 0 })) },
});
const table = (name, kind = "r", extension_member = false) => ({ schema: "public", name, kind, extension_member });

test("rowCountsCheck: every table equal passes, with the totals", () => {
  const check = rowCountsCheck(
    new Map([[key("public", "a"), 1000], [key("public", "b"), 0]]),
    manifest(["a", "b"]),
    [table("a"), table("b")],
    new Map([["public.a", 1000], ["public.b", 0]])
  );
  assert.deepEqual(check, {
    name: "row counts match the backup",
    pass: true,
    detail: "all 2 tables match the backup exactly (1,000 rows)",
  });
});

test("rowCountsCheck: one row short fails and names the table", () => {
  const check = rowCountsCheck(
    new Map([[key("public", "orders"), 10_000]]),
    manifest(["orders"]),
    [table("orders")],
    new Map([["public.orders", 9_990]])
  );
  assert.equal(check.pass, false);
  assert.equal(check.detail, "public.orders has 9,990, the backup has 10,000");
});

test("rowCountsCheck: matviews, partition parents and extension tables aren't compared", () => {
  const check = rowCountsCheck(
    new Map([[key("public", "spatial_ref_sys"), 2]]),
    manifest(["mv", "parted", "spatial_ref_sys"]),
    [table("mv", "m"), table("parted", "p"), table("spatial_ref_sys", "r", true)],
    new Map([["public.mv", 5], ["public.parted", 7], ["public.spatial_ref_sys", 8_500]])
  );
  assert.deepEqual(check, { name: "row counts match the backup", pass: true, detail: "no tables to compare" });
});

test("rowCountsCheck: no counts from the backup file, or a table missing from it, fails", () => {
  const none = rowCountsCheck(null, manifest(["a"]), [table("a")], new Map([["public.a", 1]]));
  assert.equal(none.pass, false);
  assert.match(none.detail, /couldn't count the rows in the backup file/);

  const missing = rowCountsCheck(new Map(), manifest(["a"]), [table("a")], new Map([["public.a", 1]]));
  assert.equal(missing.pass, false);
  assert.equal(missing.detail, "public.a has no data section in the backup file");
});

test("rowCountsCheck: lists at most five problems", () => {
  const names = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
  const check = rowCountsCheck(
    new Map(names.map((n) => [key("public", n), 2])),
    manifest(names),
    names.map((n) => table(n)),
    new Map(names.map((n) => [`public.${n}`, 1]))
  );
  assert.equal(check.pass, false);
  assert.match(check.detail, /^public\.t1 has 1, the backup has 2; .*public\.t5 has 1, the backup has 2; and 2 more$/);
});
