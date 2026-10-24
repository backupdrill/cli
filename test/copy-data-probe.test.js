// copyDataProbe:逐块读 pg_restore --data-only 的输出,判断一张表在 dump 里有没有数据行。
// 演练回查"恢复出空表"时用它(drill-empty-in-backup.test.js 是真 dump 的端到端)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyDataProbe } from "../dist/restore-engine.js";

const PREAMBLE = "--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\nSELECT pg_catalog.set_config('search_path', '', false);\n\n";

/** 把整段输出按给定切点喂进去,返回第一个非 null 的结论(喂完还没有就是 null)。 */
function feed(schema, table, ...chunks) {
  const probe = copyDataProbe(schema, table);
  for (const chunk of chunks) {
    const answer = probe(chunk);
    if (answer !== null) return answer;
  }
  return null;
}

test("copyDataProbe: COPY header followed by the terminator is an empty table", () => {
  assert.equal(feed("public", "t", PREAMBLE + "COPY public.t (id, v) FROM stdin;\n\\.\n\n"), "empty");
});

test("copyDataProbe: a data line after the header means rows", () => {
  assert.equal(feed("public", "t", PREAMBLE + "COPY public.t (id, v) FROM stdin;\n1\ta\n\\.\n"), "rows");
  // 数据值以 \. 开头时被转义成 \\.,不是结束符
  assert.equal(feed("public", "t", "COPY public.t (v) FROM stdin;\n\\\\.x\n\\.\n"), "rows");
  // 没有列的表:每行数据是空行
  assert.equal(feed("public", "t", "COPY public.t  FROM stdin;\n\n\\.\n"), "rows");
});

test("copyDataProbe: decides on the first bytes of a huge row instead of buffering the whole line", () => {
  const probe = copyDataProbe("public", "big");
  assert.equal(probe("COPY public.big (id, blob) FROM stdin;\n"), null);
  // 一行几百 MB 的 bytea:第一块里没有换行,也要当场下结论
  assert.equal(probe("1\t\\\\x" + "ab".repeat(32_768)), "rows");
});

test("copyDataProbe: a terminator split across chunks still reads as empty", () => {
  assert.equal(feed("public", "t", "COPY public.t (id) FROM stdin;\n\\", ".", "\n"), "empty");
  assert.equal(feed("public", "t", "COPY public.t (id) FROM st", "din;\n", "\\.\n"), "empty");
});

test("copyDataProbe: quoted names may hold CR, CRLF or a whole fake header", () => {
  assert.equal(feed("public", "cr\rname", 'COPY public."cr\rname" (id) FROM stdin;\n\\.\n'), "empty");
  assert.equal(feed("public", "crlf\r\nname", 'COPY public."crlf\r\nname" (id) FROM stdin;\n\\.\n'), "empty");
  // 列名里有 " FROM stdin;"、换行和 \.:只看单行会在第一行"结束"头,再把 \. 当成空表结束符
  assert.equal(
    feed("public", "tricky", 'COPY public.tricky (id, "x FROM stdin;\n\\.\ny") FROM stdin;\n1\ta\n\\.\n'),
    "rows"
  );
  assert.equal(feed("my schema", "T", 'COPY "my schema"."T" ("a""b") FROM stdin;\n\\.\n'), "empty");
});

test("copyDataProbe: another table's header or an unreadable one is unknown, never a verdict", () => {
  assert.equal(feed("public", "t", "COPY public.other (id) FROM stdin;\n\\.\n"), "unknown");
  assert.equal(feed("public", "t", "COPY public.t WITH garbage FROM stdin;\n\\.\n"), "unknown");
  assert.equal(feed("public", "t", 'COPY public."' + "x".repeat(100_001)), "unknown");
  // 输出里没有 COPY 段(比如 matview 只有 REFRESH):喂完也没有结论,调用方按查不清处理
  assert.equal(feed("public", "mv", PREAMBLE + "REFRESH MATERIALIZED VIEW public.mv;\n"), null);
});
