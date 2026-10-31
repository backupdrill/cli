import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCopyField,
  formatQualified,
  parseCopyHeader,
  parseCreateSchemas,
  parseForeignKeys,
  parsePartitionAttachments,
  parseTableColumns,
} from "../dist/dump-sql.js";
import { firstRestoreError, pgRestoreOutput } from "../dist/restore-engine.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreFailureAdvice } from "../dist/restore.js";

// 夹具:pg_restore 17.11 对 supabase/postgres:17.6.1.084 源库转储(--schema=public)的原样输出
// (`pg_restore -f - -L <FK CONSTRAINT + TABLE ATTACH + SCHEMA 条目>`,注释和 SET 行去掉了)
const DDL = String.raw`\restrict l0cmhaByLhbzNpEYoG6Qut55PxeMSh3EPZztQvykmtqUWgWPfy8SZcJsnLAXslY
CREATE SCHEMA public;
ALTER SCHEMA public OWNER TO pg_database_owner;
ALTER TABLE ONLY public.parted ATTACH PARTITION public.parted_a FOR VALUES FROM (0) TO (100);
ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id);
ALTER TABLE public.parted
    ADD CONSTRAINT parted_owner_fkey FOREIGN KEY (owner) REFERENCES auth.users(id);
ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public."Weird Tab"
    ADD CONSTRAINT "w fk" FOREIGN KEY ("User Id") REFERENCES auth.users(id) MATCH FULL;
\unrestrict l0cmhaByLhbzNpEYoG6Qut55PxeMSh3EPZztQvykmtqUWgWPfy8SZcJsnLAXslY
`;

test("parseForeignKeys:pg_dump 的外键语句,含分区父表(无 ONLY)、带引号的名字、MATCH FULL", () => {
  const fks = parseForeignKeys(DDL);
  assert.equal(fks.length, 4);
  assert.deepEqual(fks[2], {
    constraint: "profiles_id_fkey",
    table: { schema: "public", name: "profiles" },
    columns: ["id"],
    references: { schema: "auth", name: "users" },
    referencedColumns: ["id"],
    validatesRows: true,
    matchFull: false,
    onPartitionedTable: false,
    statement: fks[2].statement,
  });
  assert.match(fks[2].statement, /^ALTER TABLE ONLY public\.profiles\n {4}ADD CONSTRAINT profiles_id_fkey .*;$/);
  assert.deepEqual(fks[1].table, { schema: "public", name: "parted" }, "partitioned parent has no ONLY");
  assert.equal(fks[1].onPartitionedTable, true);
  assert.equal(fks[3].constraint, "w fk");
  assert.deepEqual(fks[3].table, { schema: "public", name: "Weird Tab" });
  assert.deepEqual(fks[3].columns, ["User Id"]);
  assert.equal(fks[3].validatesRows, true, "MATCH FULL still validates rows");
  assert.equal(fks[3].matchFull, true);
});

test("parseForeignKeys:多列、引号里带引号和逗号、NOT VALID / NOT ENFORCED 不校验已有行", () => {
  const sql = [
    `ALTER TABLE ONLY "My ""App""".items`,
    `    ADD CONSTRAINT items_owner_fkey FOREIGN KEY (tenant, "Owner, Id") REFERENCES auth.accounts(tenant_id, id) ON UPDATE CASCADE ON DELETE SET NULL ("Owner, Id");`,
    `ALTER TABLE ONLY public.a`,
    `    ADD CONSTRAINT a_fk FOREIGN KEY (x) REFERENCES auth.users(id) NOT VALID;`,
    `ALTER TABLE ONLY public.b`,
    `    ADD CONSTRAINT b_fk FOREIGN KEY (x) REFERENCES auth.users(id) NOT ENFORCED;`,
    // 列名里出现 NOT VALID 字样不能被当成选项
    `ALTER TABLE ONLY public.c`,
    `    ADD CONSTRAINT c_fk FOREIGN KEY (x) REFERENCES auth.users(id) ON DELETE SET NULL ("NOT VALID");`,
  ].join("\n");
  const fks = parseForeignKeys(sql);
  assert.equal(fks.length, 4);
  assert.deepEqual(fks[0].table, { schema: 'My "App"', name: "items" });
  assert.deepEqual(fks[0].columns, ["tenant", "Owner, Id"]);
  assert.deepEqual(fks[0].referencedColumns, ["tenant_id", "id"]);
  assert.equal(fks[1].validatesRows, false);
  assert.equal(fks[2].validatesRows, false);
  assert.equal(fks[3].validatesRows, true);
});

test("parseForeignKeys:认不出的形态(PG18 时态外键)不猜,调用方按条目数对账", () => {
  const temporal =
    "ALTER TABLE ONLY public.bookings\n    ADD CONSTRAINT bookings_fk FOREIGN KEY (room, PERIOD during) REFERENCES public.rooms(id, PERIOD valid);";
  assert.equal(parseForeignKeys(temporal).length, 0);
});

test("parsePartitionAttachments / parseCreateSchemas", () => {
  assert.deepEqual(parsePartitionAttachments(DDL), [
    { parent: { schema: "public", name: "parted" }, child: { schema: "public", name: "parted_a" } },
  ]);
  assert.deepEqual(parseCreateSchemas(DDL), ["public"]);
  assert.deepEqual(parseCreateSchemas('CREATE SCHEMA "Tenant ""A""";\nCREATE SCHEMA app;\n'), ['Tenant "A"', "app"]);
});

test("parseCopyHeader:带引号的表名和列名;没有列的表", () => {
  assert.deepEqual(parseCopyHeader('COPY public."Weird Tab" ("User Id", k) FROM stdin;'), {
    table: { schema: "public", name: "Weird Tab" },
    columns: ["User Id", "k"],
  });
  // 没有列的表:pg_dump 写的是空列清单,中间两个空格
  assert.deepEqual(parseCopyHeader("COPY public.empty  FROM stdin;"), {
    table: { schema: "public", name: "empty" },
    columns: [],
  });
  assert.equal(parseCopyHeader("SELECT pg_catalog.setval('public.x', 1, true);"), null);
});

test("decodeCopyField:\\N 是 NULL,转义按 COPY 文本格式还原", () => {
  assert.equal(decodeCopyField("\\N"), null);
  assert.equal(decodeCopyField("plain"), "plain");
  assert.equal(decodeCopyField("a\\tb\\nc\\\\d"), "a\tb\nc\\d");
  assert.equal(decodeCopyField("\\101\\x42"), "AB");
  assert.equal(decodeCopyField("\\N/A"), "N/A", "only a bare \\N is NULL");
});

test("formatQualified:只有需要时才加引号", () => {
  assert.equal(formatQualified({ schema: "auth", name: "users" }), "auth.users");
  assert.equal(formatQualified({ schema: "public", name: "Weird Tab" }), 'public."Weird Tab"');
});

test("firstRestoreError:主消息 + DETAIL 全文,不再截在半句话上", () => {
  // 2026-10-22 实验里 CLI 截成了 "... is no",这里必须把整句带出来
  const stderr =
    'pg_restore: error: could not execute query: ERROR:  insert or update on table "profiles" violates foreign key constraint "profiles_id_fkey"\n' +
    'DETAIL:  Key (id)=(97c0507b-c7f1-4d1b-b15d-0b54c5c3f2e0) is not present in table "users".\n' +
    "Command was: ALTER TABLE ONLY public.profiles\n" +
    "    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;\n";
  const message = firstRestoreError(stderr);
  assert.match(message, /^insert or update on table "profiles" violates foreign key constraint "profiles_id_fkey"/);
  assert.match(message, /is not present in table "users"\./);
  assert.match(message, /\(statement: ALTER TABLE ONLY public\.profiles ADD CONSTRAINT profiles_id_fkey/);
  assert.equal(firstRestoreError(""), "(no stderr)");
});

test("restoreFailureAdvice:锁槽用完时告诉用户怎么调 max_locks_per_transaction,其他错误不加话", () => {
  const lockFailure = firstRestoreError(
    "pg_restore: error: could not execute query: ERROR:  out of shared memory\n" +
      'HINT:  You might need to increase "max_locks_per_transaction".\n' +
      "Command was: CREATE TABLE public.t1015 (id bigint NOT NULL);\n"
  );
  assert.match(lockFailure, /out of shared memory HINT: You might need to increase "max_locks_per_transaction"\./);
  assert.match(restoreFailureAdvice(lockFailure), /supabase postgres-config update --config max_locks_per_transaction=256/);
  assert.equal(restoreFailureAdvice('schema "private" does not exist'), "");
});

test("parseTableColumns:pg_dump 建表语句里的列类型(修饰符、COLLATE、DEFAULT、生成列、CHECK 行、跨行的名字)", () => {
  const sql = [
    "CREATE TABLE public.orders (",
    "    id bigint NOT NULL,",
    "    status text DEFAULT 'paid'::text NOT NULL,",
    "    created_at timestamp with time zone DEFAULT now() NOT NULL,",
    "    amount numeric(10,2),",
    '    name character varying(40) COLLATE pg_catalog."C",',
    "    g integer GENERATED ALWAYS AS ((id + 1)) STORED,",
    "    CONSTRAINT orders_amount_check CHECK ((amount > (0)::numeric))",
    ");",
    "CREATE TABLE public.parted (",
    "    owner public.uid",
    ")",
    "PARTITION BY RANGE (owner);",
    'CREATE TABLE public."multi',
    'line" (',
    '    "user',
    'id" uuid',
    ");",
  ].join("\n");
  const tables = parseTableColumns(sql);
  assert.deepEqual([...tables.get("public\u0000orders")], [
    ["id", "bigint"],
    ["status", "text"],
    ["created_at", "timestamp with time zone"],
    ["amount", "numeric(10,2)"],
    ["name", "character varying(40)"],
    ["g", "integer"],
  ]);
  assert.deepEqual([...tables.get("public\u0000parted")], [["owner", "public.uid"]]);
  assert.deepEqual([...tables.get("public\u0000multi\nline")], [["user\nid", "uuid"]]);
});

test("pgRestoreOutput:多字节字符被拆在两块输出里也能解对", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bd-utf8-"));
  try {
    // 假的 pg_restore:把 CREATE SCHEMA "数据";(pg_dump 给非 ASCII 名字加引号)拆在 "数" 的字节中间
    // 分两次写,中间停一下,保证是两块
    const bin = join(dir, "pg_restore");
    writeFileSync(
      bin,
      `#!${process.execPath}
const out = Buffer.from('CREATE SCHEMA "数据";\\n');
const cut = out.indexOf(Buffer.from("数")) + 1;
process.stdout.write(out.subarray(0, cut));
setTimeout(() => process.stdout.write(out.subarray(cut)), 100);
`
    );
    chmodSync(bin, 0o755);
    const result = await pgRestoreOutput(bin, []);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'CREATE SCHEMA "数据";\n');
    assert.deepEqual(parseCreateSchemas(result.stdout), ["数据"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
