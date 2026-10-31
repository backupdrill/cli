// 源库自带孤儿行的外键(2026-10-30 生产演练):演练判失败并标明是数据问题,真实恢复把外键建成
// NOT VALID、数据全部恢复。两条路径走同一个 addForeignKeys,结论必须一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { parseForeignKeys } from "../dist/dump-sql.js";
import { archiveTables, isDeferrableForeignKey, notValidStatement, orphanCountSql } from "../dist/orphaned-foreign-keys.js";
import { drillDump } from "../dist/drill.js";
import { withoutRestrictWrapper } from "../dist/restore-engine.js";
import { runRestore } from "../dist/restore.js";

const x = promisify(execFile);
const pgDump = process.env.BACKUPDRILL_PG_DUMP || "pg_dump";

async function available(cmd, args) {
  try {
    await x(cmd, args);
    return true;
  } catch {
    return false;
  }
}
const canRun = (await available("docker", ["version"])) && (await available(pgDump, ["--version"]));

const fk = (sql) => parseForeignKeys(sql)[0];

test("notValidStatement:NOT VALID 加在选项之后、分号之前", () => {
  const statement =
    "ALTER TABLE ONLY public.order_items\n    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT DEFERRABLE;";
  assert.equal(
    notValidStatement(statement),
    "ALTER TABLE ONLY public.order_items\n    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT DEFERRABLE NOT VALID;"
  );
});

test("archiveTables:建表和数据条目分开存整串,名字和属主都可以带空格", () => {
  const listing = [
    "; Archive created at 2026-10-31",
    "3301; 1259 16390 TABLE public orders postgres",
    "3401; 0 16390 TABLE DATA public orders postgres",
    "3402; 0 16400 TABLE DATA public Child Table review owner",
    "3501; 2606 16420 FK CONSTRAINT public orders orders_fk postgres",
  ].join("\n");
  assert.deepEqual(archiveTables(listing), {
    defined: ["public orders postgres"],
    withData: ["public orders postgres", "public Child Table review owner"],
  });
});

test("isDeferrableForeignKey:只挪两端都由 dump 建表并带数据、会校验已有行、不在分区父表上的外键", () => {
  const tables = archiveTables(
    [
      "1; 1259 1 TABLE public a postgres",
      "2; 1259 2 TABLE public b review owner",
      "3; 0 1 TABLE DATA public a postgres",
      "4; 0 2 TABLE DATA public b review owner",
      // 扩展的配置表:CREATE EXTENSION 建表,dump 里只有过了扩展过滤条件的行
      "5; 0 3 TABLE DATA public ext_config postgres",
      // 扩展的普通成员表:建表和数据都不在 dump 里
      "6; 1259 4 TABLE public b_archive postgres",
    ].join("\n")
  );
  const inside = fk("ALTER TABLE ONLY public.a\n    ADD CONSTRAINT a_fk FOREIGN KEY (x) REFERENCES public.b(id);");
  assert.equal(isDeferrableForeignKey(inside, tables), true, "owner names with spaces still match");
  const toAuth = fk("ALTER TABLE ONLY public.a\n    ADD CONSTRAINT a_fk FOREIGN KEY (x) REFERENCES auth.users(id);");
  assert.equal(isDeferrableForeignKey(toAuth, tables), false, "keys into auth.users keep the preflight path");
  // 恢复后是目标上扩展装出来的那份,缺行不能算源库的错
  const toExtension = fk("ALTER TABLE ONLY public.a\n    ADD CONSTRAINT a_fk FOREIGN KEY (x) REFERENCES public.ext_items(id);");
  assert.equal(isDeferrableForeignKey(toExtension, tables), false);
  const toExtensionConfig = fk("ALTER TABLE ONLY public.a\n    ADD CONSTRAINT a_fk FOREIGN KEY (x) REFERENCES public.ext_config(id);");
  assert.equal(isDeferrableForeignKey(toExtensionConfig, tables), false, "a config table's dump holds only the filtered rows");
  const noData = fk("ALTER TABLE ONLY public.a\n    ADD CONSTRAINT a_fk FOREIGN KEY (x) REFERENCES public.b_archive(id);");
  assert.equal(isDeferrableForeignKey(noData, tables), false, "a table dumped without its rows");
  // 前缀比对不能把 public.b 的条目算到 public.b_archive 头上,反过来也一样
  const fromPrefix = fk("ALTER TABLE ONLY public.b_archive\n    ADD CONSTRAINT x_fk FOREIGN KEY (x) REFERENCES public.a(id);");
  assert.equal(isDeferrableForeignKey(fromPrefix, tables), false);
  const notValid = fk("ALTER TABLE ONLY public.a\n    ADD CONSTRAINT a_fk FOREIGN KEY (x) REFERENCES public.b(id) NOT VALID;");
  assert.equal(isDeferrableForeignKey(notValid, tables), false);
  const partitioned = fk("ALTER TABLE public.a\n    ADD CONSTRAINT a_fk FOREIGN KEY (x) REFERENCES public.b(id);");
  assert.equal(isDeferrableForeignKey(partitioned, tables), false, "PostgreSQL has no NOT VALID foreign key on a partitioned table");
});

test("withoutRestrictWrapper:只去掉脚本首尾那一对元命令,字符串里同样字样的行保留", () => {
  const script = [
    "--",
    "-- PostgreSQL database dump",
    "--",
    "\\restrict abc123",
    "SET statement_timeout = 0;",
    "COMMENT ON CONSTRAINT f ON public.t IS 'line one",
    "\\restrict inside the comment",
    "\\unrestrict inside too';",
    "\\unrestrict abc123",
    "",
  ].join("\n");
  assert.equal(
    withoutRestrictWrapper(script),
    [
      "--",
      "-- PostgreSQL database dump",
      "--",
      "SET statement_timeout = 0;",
      "COMMENT ON CONSTRAINT f ON public.t IS 'line one",
      "\\restrict inside the comment",
      "\\unrestrict inside too';",
      "",
    ].join("\n")
  );
  // 旧版 pg_restore 没有包装行:一行都不动
  const old = "SET x = 1;\nCOMMENT ON CONSTRAINT f ON public.t IS 'a\n\\restrict b';\n";
  assert.equal(withoutRestrictWrapper(old), old);
});

const intEq = { schema: "pg_catalog", name: "=", left: "integer", right: "integer" };

test("orphanCountSql:约束自己的运算符和类型、两端 ONLY;MATCH SIMPLE 跳过有空值的行;名字一律加引号", () => {
  const simple = orphanCountSql(
    fk('ALTER TABLE ONLY public."Order Items"\n    ADD CONSTRAINT f FOREIGN KEY (tenant, "Order Id") REFERENCES public.orders(tenant, id);'),
    { operators: [intEq, { schema: "public", name: "=", left: "public.citext", right: "public.citext" }], referencedPartitioned: false }
  );
  assert.equal(
    simple,
    'select count(*)::bigint as n from only "public"."Order Items" c where c."tenant" is not null and c."Order Id" is not null and ' +
      'not exists (select 1 from only "public"."orders" p where p."tenant"::integer OPERATOR("pg_catalog".=) c."tenant"::integer ' +
      'and p."id"::public.citext OPERATOR("public".=) c."Order Id"::public.citext)'
  );
});

test("orphanCountSql:被引用的是分区表时带上分区;MATCH FULL 把部分为空的行算进去", () => {
  const parted = orphanCountSql(
    fk("ALTER TABLE ONLY public.a\n    ADD CONSTRAINT f FOREIGN KEY (x) REFERENCES public.b(x);"),
    { operators: [intEq], referencedPartitioned: true }
  );
  assert.match(parted, /not exists \(select 1 from "public"\."b" p where/);
  const full = orphanCountSql(
    fk("ALTER TABLE ONLY public.a\n    ADD CONSTRAINT f FOREIGN KEY (x, y) REFERENCES public.b(x, y) MATCH FULL;"),
    { operators: [intEq, intEq], referencedPartitioned: false }
  );
  assert.match(full, /where \(c\."x" is not null or c\."y" is not null\) and \(not \(c\."x" is not null and c\."y" is not null\) or not exists/);
});

async function startPostgres(ids) {
  const { stdout } = await x("docker", [
    "run", "-d", "--rm", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_PASSWORD=pw",
    "-p", "127.0.0.1:0:5432", "postgres:17-alpine",
  ]);
  const id = stdout.trim();
  ids.push(id);
  const port = (await x("docker", ["port", id, "5432/tcp"])).stdout.trim().split("\n")[0].split(":").pop();
  for (let i = 0; i < 60; i++) {
    try {
      await x("docker", ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-q"]);
      return port;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("postgres did not become ready");
}

async function sql(url, text) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(text);
  } finally {
    await client.end();
  }
}

test(
  "orphaned foreign key: the drill fails as a source-data problem; a real restore brings every row back with the key NOT VALID",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 300_000 },
  async () => {
    const ids = [];
    const work = mkdtempSync(join(tmpdir(), "bd-orphan-fk-"));
    try {
      const [sourcePort, targetPort] = await Promise.all([startPostgres(ids), startPostgres(ids)]);
      const sourceUrl = `postgresql://postgres:pw@127.0.0.1:${sourcePort}/postgres`;
      const targetUrl = `postgresql://postgres:pw@localhost:${targetPort}/postgres`;
      // order_items 有一条正常外键(到 products)和一条带孤儿行的外键(到 orders):
      // replica 模式下删 orders 的行,外键触发器不触发,约束在目录里仍是"已校验"
      await sql(
        sourceUrl,
        `create table public.orders (id int primary key);
         create table public.products (id int primary key);
         create table public.order_items (
           id int primary key,
           order_id int references public.orders(id) on delete restrict,
           product_id int references public.products(id)
         );
         insert into public.orders select generate_series(1, 5);
         insert into public.products values (1);
         insert into public.order_items select g, (g % 5) + 1, 1 from generate_series(1, 20) g;
         -- 外键上的注释依赖外键本身,得跟着外键一起晚加
         comment on constraint order_items_order_id_fkey on public.order_items is 'every item belongs to an order';
         comment on constraint order_items_product_id_fkey on public.order_items is 'catalog link';
         -- citext:外键按不区分大小写比,'red' 对得上 'Red',只有 'blue' 是孤儿
         create extension citext schema public;
         create table public.colors (name public.citext primary key);
         create table public.swatches (id int primary key, color public.citext references public.colors(name));
         insert into public.colors values ('Red');
         insert into public.swatches values (1, 'red'), (2, 'RED');
         -- 继承:普通表上的外键只看父表本身,只在子表里的 7 号不算数
         create table public.regions (id int primary key);
         create table public.regions_eu () inherits (public.regions);
         create table public.stores (id int primary key, region_id int references public.regions(id));
         insert into public.regions values (1);
         insert into public.stores values (1, 1);
         -- 带引号的表名和约束名:目录里注释条目的名字带双引号,照样要跟着外键晚加
         create table public."Child Table" (id int primary key, order_id int,
           constraint "Child FK" foreign key (order_id) references public.orders(id));
         insert into public."Child Table" values (1, 1), (2, 2);
         comment on constraint "Child FK" on public."Child Table" is E'quoted names\\n\\\\restrict this line stays';
         set session_replication_role = replica;
         delete from public.orders where id in (2, 3);
         insert into public.swatches values (3, 'blue');
         insert into public.regions_eu values (7);
         insert into public.stores values (2, 7);
         set session_replication_role = origin;`
      );
      const dumpPath = join(work, "source.pgcustom");
      await x(pgDump, ["--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--dbname", sourceUrl, "-f", dumpPath]);
      const buf = readFileSync(dumpPath);
      const manifest = {
        schemaVersion: 2,
        tool: "backupdrill-cli",
        toolVersion: "test",
        createdAt: "2026-10-31T00:00:00.000Z",
        projectName: "orphans",
        database: {
          serverVersion: "17.6",
          pgDumpVersion: (await x(pgDump, ["--version"])).stdout.trim(),
          schemas: ["public"],
          tableCount: 9,
          estimatedRowTotal: 35,
          tables: [
            { schema: "public", name: "Child Table", estimatedRows: 2 },
            { schema: "public", name: "colors", estimatedRows: 1 },
            { schema: "public", name: "order_items", estimatedRows: 20 },
            { schema: "public", name: "orders", estimatedRows: 3 },
            { schema: "public", name: "products", estimatedRows: 1 },
            { schema: "public", name: "regions", estimatedRows: 1 },
            { schema: "public", name: "regions_eu", estimatedRows: 1 },
            { schema: "public", name: "stores", estimatedRows: 2 },
            { schema: "public", name: "swatches", estimatedRows: 3 },
          ],
          extensions: [{ name: "citext", version: "1.6", schema: "public" }],
        },
        dump: { key: "backupdrill/orphans/snap/dump.pgcustom", format: "custom", bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") },
        storage: null,
      };
      const expected = [
        { constraint: "Child FK", table: 'public."Child Table"', referencedTable: "public.orders", columns: ["order_id"], referencedColumns: ["id"], orphanRows: 1 },
        { constraint: "order_items_order_id_fkey", table: "public.order_items", referencedTable: "public.orders", columns: ["order_id"], referencedColumns: ["id"], orphanRows: 8 },
        { constraint: "stores_region_id_fkey", table: "public.stores", referencedTable: "public.regions", columns: ["region_id"], referencedColumns: ["id"], orphanRows: 1 },
        { constraint: "swatches_color_fkey", table: "public.swatches", referencedTable: "public.colors", columns: ["color"], referencedColumns: ["name"], orphanRows: 1 },
      ];
      const sorted = (list) => [...(list ?? [])].sort((a, b) => a.constraint.localeCompare(b.constraint));

      // 1. 演练:判失败,失败只因数据,报告说清真实恢复会怎样
      const report = await drillDump(dumpPath, manifest, "orphans");
      assert.equal(report.pass, false);
      assert.equal(report.failureCause, "source-data");
      assert.deepEqual(sorted(report.orphanedForeignKeys), expected);
      const postData = report.checks.find((c) => c.name === "post-data objects");
      assert.equal(postData.pass, false);
      assert.match(postData.detail, /^4 failed: \d+ row\(s\) in public\.(?:\w+|"[^"]+") break foreign key .+, which references public\.\w+/);
      assert.match(postData.detail, /adds this foreign key as NOT VALID/);
      assert.ok(report.checks.every((c) => c.pass || c.name === "post-data objects"), JSON.stringify(report.checks));

      // 2. 真实恢复:成功、通过验证,孤儿外键是 NOT VALID,另一条照常校验
      const store = {
        createSnapshot: async () => {
          throw new Error("read-only test store");
        },
        openSnapshot: async () => ({
          name: "snap",
          readManifest: async () => JSON.stringify(manifest),
          downloadDump: async (_m, dest) => {
            copyFileSync(dumpPath, dest);
            return { bytes: buf.length, sha256: manifest.dump.sha256 };
          },
          storageFiles: () => null,
        }),
      };
      const config = { databaseUrl: sourceUrl, projectName: "orphans", schemas: ["public"], storage: { bucket: "unused" } };
      const result = await runRestore(config, { store, targetDatabaseUrl: targetUrl, confirmTarget: "localhost" });
      assert.equal(result.restoredToDatabase, true);
      assert.equal(result.databaseVerified, true);
      assert.deepEqual(sorted(result.orphanedForeignKeys), expected);
      const fkCheck = result.databaseChecks.find((c) => c.name === "foreign keys");
      assert.match(fkCheck.detail, /^4 added as NOT VALID because the snapshot holds rows that break them/);

      const constraints = await sql(
        targetUrl,
        "select conname, convalidated from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace order by 1"
      );
      assert.deepEqual(constraints.rows, [
        { conname: "Child FK", convalidated: false },
        { conname: "order_items_order_id_fkey", convalidated: false },
        { conname: "order_items_product_id_fkey", convalidated: true },
        { conname: "stores_region_id_fkey", convalidated: false },
        { conname: "swatches_color_fkey", convalidated: false },
      ]);
      const comments = await sql(
        targetUrl,
        "select conname, obj_description(oid, 'pg_constraint') as comment from pg_constraint " +
          "where contype = 'f' and (conname like 'order_items_%' or conname = 'Child FK') order by 1"
      );
      assert.deepEqual(comments.rows, [
        { conname: "Child FK", comment: "quoted names\n\\restrict this line stays" },
        { conname: "order_items_order_id_fkey", comment: "every item belongs to an order" },
        { conname: "order_items_product_id_fkey", comment: "catalog link" },
      ]);
      const rows = await sql(targetUrl, "select count(*)::int as n from public.order_items");
      assert.equal(rows.rows[0].n, 20, "every row, orphans included, is back");
      // NOT VALID 照样拦新写入
      await assert.rejects(sql(targetUrl, "insert into public.order_items values (100, 99, 1)"), /violates foreign key constraint/);
    } finally {
      for (const id of ids) await x("docker", ["rm", "-fv", id]).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }
);

// 装一个测试用扩展(两边各装一次,脚本内容相同),在源库上执行 sourceSql,把 public 导出后恢复到空目标上。
// 返回 runRestore 的 promise 和目标库连接串。
async function restoreWithTestExtension(ids, work, extensionScript, sourceSql) {
  const [sourcePort, targetPort] = await Promise.all([startPostgres(ids), startPostgres(ids)]);
  const sourceUrl = `postgresql://postgres:pw@127.0.0.1:${sourcePort}/postgres`;
  const targetUrl = `postgresql://postgres:pw@localhost:${targetPort}/postgres`;
  for (const port of [sourcePort, targetPort]) {
    const id = (await x("docker", ["ps", "-q", "--filter", `publish=${port}`])).stdout.trim();
    await x("docker", ["exec", "-u", "root", id, "sh", "-c",
      "d=$(pg_config --sharedir)/extension; " +
      "printf \"default_version = '1.0'\\nrelocatable = false\\n\" > $d/bdtest_items.control; " +
      `printf '%s' "$1" > $d/bdtest_items--1.0.sql`, "sh", extensionScript]);
  }
  await sql(sourceUrl, `create extension bdtest_items schema public;\n${sourceSql}`);
  const dumpPath = join(work, "source.pgcustom");
  await x(pgDump, ["--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--dbname", sourceUrl, "-f", dumpPath]);
  const buf = readFileSync(dumpPath);
  const manifest = {
    schemaVersion: 2,
    tool: "backupdrill-cli",
    toolVersion: "test",
    createdAt: "2026-10-31T00:00:00.000Z",
    projectName: "ext",
    database: {
      serverVersion: "17.6",
      pgDumpVersion: (await x(pgDump, ["--version"])).stdout.trim(),
      schemas: ["public"],
      tableCount: 1,
      estimatedRowTotal: 1,
      tables: [{ schema: "public", name: "refs", estimatedRows: 1 }],
      extensions: [{ name: "bdtest_items", version: "1.0", schema: "public" }],
    },
    dump: { key: "backupdrill/ext/snap/dump.pgcustom", format: "custom", bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") },
    storage: null,
  };
  const store = {
    createSnapshot: async () => {
      throw new Error("read-only test store");
    },
    openSnapshot: async () => ({
      name: "snap",
      readManifest: async () => JSON.stringify(manifest),
      downloadDump: async (_m, dest) => {
        copyFileSync(dumpPath, dest);
        return { bytes: buf.length, sha256: manifest.dump.sha256 };
      },
      storageFiles: () => null,
    }),
  };
  const config = { databaseUrl: sourceUrl, projectName: "ext", schemas: ["public"], storage: { bucket: "unused" } };
  return { restore: runRestore(config, { store, targetDatabaseUrl: targetUrl, confirmTarget: "localhost" }), targetUrl };
}

async function assertStrictFailure({ restore, targetUrl }) {
  await assert.rejects(restore, (error) => {
    assert.doesNotMatch(error.message, /NOT VALID/);
    return true;
  });
  const leftover = await sql(targetUrl, "select count(*)::int as n from pg_constraint where conname = 'refs_item_id_fkey'");
  assert.equal(leftover.rows[0].n, 0, "the key was not relaxed to NOT VALID");
  const refs = await sql(targetUrl, "select to_regclass('public.refs') is null as gone");
  assert.equal(refs.rows[0].gone, true, "nothing from the snapshot stays on the target");
}

// 交叉审查复现:扩展自带的表在 public 里,数据却不在 dump 里(恢复后是目标上扩展装出来的那份)。
// 缺行是目标的事,不能被放宽成 NOT VALID 再算到源库头上——这条外键必须照旧严格校验
test(
  "a foreign key into an extension's own table stays strict: missing rows on the target fail the restore",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 300_000 },
  async () => {
    const ids = [];
    const work = mkdtempSync(join(tmpdir(), "bd-ext-fk-"));
    try {
      await assertStrictFailure(
        await restoreWithTestExtension(
          ids,
          work,
          "create table ext_items (id int primary key);\ninsert into ext_items values (1), (2);\n",
          `insert into public.ext_items values (3);
           create table public.refs (id int primary key, item_id int references public.ext_items(id));
           insert into public.refs values (1, 3);`
        )
      );
    } finally {
      for (const id of ids) await x("docker", ["rm", "-fv", id]).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }
);

// 交叉审查复现:扩展的配置表有 TABLE DATA,但里面只有过了 pg_extension_config_dump 过滤条件的行。
// 被滤掉的行恢复后不在,同样不能算源库的孤儿行
test(
  "a foreign key into an extension's config table stays strict: rows the extension filters out are not orphans",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 300_000 },
  async () => {
    const ids = [];
    const work = mkdtempSync(join(tmpdir(), "bd-ext-config-fk-"));
    try {
      await assertStrictFailure(
        await restoreWithTestExtension(
          ids,
          work,
          "create table ext_items (id int primary key, builtin bool not null default false);\n" +
            "insert into ext_items values (1, true);\n" +
            "select pg_catalog.pg_extension_config_dump('ext_items', 'where not builtin');\n",
          `insert into public.ext_items values (2, true), (3, false);
           create table public.refs (id int primary key, item_id int references public.ext_items(id));
           insert into public.refs values (1, 2), (2, 3);`
        )
      );
    } finally {
      for (const id of ids) await x("docker", ["rm", "-fv", id]).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }
);
