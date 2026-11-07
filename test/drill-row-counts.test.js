// 逐表确切行数比对(2.11.0):演练从备份文件本身数出每张表的行数,和恢复后的 count(*) 逐表比,
// 少一行也判失败。manifest 里的行数是统计估算,只能管"别变空"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drillDump, verifyRestored } from "../dist/drill.js";
import { countRowsInDump } from "../dist/restore-engine.js";

const x = promisify(execFile);
const pgDump = process.env.BACKUPDRILL_PG_DUMP || "pg_dump";
const pgRestore = process.env.BACKUPDRILL_PG_RESTORE || "pg_restore";

async function available(cmd, args) {
  try {
    await x(cmd, args);
    return true;
  } catch {
    return false;
  }
}
const canRun = (await available("docker", ["version"])) && (await available(pgDump, ["--version"]));

/** 起一个一次性 Postgres,等它在 TCP 上就绪,返回容器 id 和连接串。 */
async function startPostgres() {
  const { stdout } = await x("docker", [
    "run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=seed", "-p", "127.0.0.1:0:5432", "postgres:17-alpine",
  ]);
  const id = stdout.trim();
  const port = (await x("docker", ["port", id, "5432/tcp"])).stdout.trim().split(":").pop().trim();
  for (let i = 0; i < 60; i++) {
    try {
      // -h 强制 TCP:镜像初始化阶段的临时服务只听 socket(见 drill.test.js)
      await x("docker", ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-q"]);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { id, conn: `postgresql://postgres:seed@127.0.0.1:${port}/postgres` };
}

const psql = (id, sql) => x("docker", ["exec", id, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql]);

test(
  "drill: row counts are compared exactly against the backup file, one missing row fails",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 300_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bd-row-counts-"));
    const dumpPath = join(tmp, "dump.pgcustom");
    const source = await startPostgres();
    let target = null;
    try {
      await psql(
        source.id,
        // orders:值里有换行、制表符、反斜杠、以 \. 开头的文本,COPY 里都转义在一行之内
        "create table orders(id int primary key, note text); " +
          "insert into orders select g, case g % 4 when 0 then E'two\\nlines' when 1 then E'tab\\there' " +
          "when 2 then E'\\\\.looks like the end' else 'plain' end from generate_series(1, 1000) g; " +
          // 老式继承:父表自己 2 行、子表 3 行。父表的 count(*) 会算上子表,dump 里父表只有自己的 2 行
          "create table animals(id int, name text); create table dogs() inherits (animals); " +
          "insert into animals values (1, 'cat'), (2, 'owl'); insert into dogs values (3, 'a'), (4, 'b'), (5, 'c'); " +
          // 分区表:数据在两个分区上,父表本身不比
          "create table events(id int, at date) partition by range (at); " +
          "create table events_2025 partition of events for values from ('2025-01-01') to ('2026-01-01'); " +
          "create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01'); " +
          "insert into events select g, date '2025-06-01' + g from generate_series(1, 400) g; " +
          // 没有列的表:每行数据是空行
          "create table nocols(); insert into nocols select from generate_series(1, 3); " +
          "create table empty_table(id int); " +
          'create table "Odd Name"(id int); insert into "Odd Name" values (1), (2); ' +
          "create materialized view orders_mv as select id from orders where id <= 10;"
      );
      await x(pgDump, [
        "--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--dbname", source.conn, "-f", dumpPath,
      ]);

      // 1. 备份文件里的确切行数
      const inBackup = await countRowsInDump(dumpPath);
      assert.deepEqual(
        Object.fromEntries([...inBackup].map(([k, v]) => [k.replace("\u0000", "."), v]).sort()),
        {
          "public.Odd Name": 2,
          "public.animals": 2,
          "public.dogs": 3,
          "public.empty_table": 0,
          "public.events_2025": 213,
          "public.events_2026": 187,
          "public.nocols": 3,
          "public.orders": 1000,
        }
      );
      assert.equal(await countRowsInDump(join(tmp, "missing.pgcustom")), null);

      const names = ["Odd Name", "animals", "dogs", "empty_table", "events", "events_2025", "events_2026", "nocols", "orders", "orders_mv"];
      const buf = readFileSync(dumpPath);
      const manifest = {
        tool: "backupdrill-cli", toolVersion: "test", createdAt: "2026-11-07T00:00:00.000Z",
        projectName: "test",
        database: {
          serverVersion: "17.4", pgDumpVersion: "test", schemas: ["public"],
          tableCount: names.length, estimatedRowTotal: 0,
          // 估算全写 0:逐表比对只认备份文件里数出来的数,和 manifest 的估算无关
          tables: names.map((name) => ({ schema: "public", name, estimatedRows: 0 })),
        },
        dump: {
          key: "seed/dump.pgcustom", format: "custom", bytes: buf.length,
          sha256: createHash("sha256").update(buf).digest("hex"),
        },
        storage: null,
      };

      // 2. 完整演练:每张表都对上
      const report = await drillDump(dumpPath, manifest, "row-counts");
      const rows = report.checks.find((c) => c.name === "row counts match the backup");
      assert.deepEqual(rows, {
        name: "row counts match the backup",
        pass: true,
        detail: "all 8 tables match the backup exactly (1,410 rows)",
      });
      assert.equal(report.pass, true, JSON.stringify(report.checks));

      // 3. 恢复后少一行、子表多一行:都要抓到,并且不是靠"表变空"那项
      target = await startPostgres();
      // dump 自带 CREATE SCHEMA public,新库里已有同名 schema 会让 pg_restore 退出码非 0
      await psql(target.id, "drop schema public cascade;");
      await x(pgRestore, ["--no-owner", "--no-privileges", "--dbname", target.conn, dumpPath]);
      await psql(target.id, "delete from orders where id = 500; insert into dogs values (6, 'd');");
      const verified = await verifyRestored(target.conn, manifest, dumpPath);
      const check = verified.checks.find((c) => c.name === "row counts match the backup");
      assert.equal(check.pass, false);
      assert.equal(check.detail, "public.dogs has 4, the backup has 3; public.orders has 999, the backup has 1,000");
      assert.equal(verified.checks.find((c) => c.name === "populated tables came back").pass, true);

      // 4. 不给 dump 路径(老调用方式):没有可比的确切行数,这一项不出现
      const withoutDump = await verifyRestored(target.conn, manifest);
      assert.equal(withoutDump.checks.find((c) => c.name === "row counts match the backup"), undefined);
    } finally {
      await x("docker", ["rm", "-f", "-v", source.id]).catch(() => {});
      if (target) await x("docker", ["rm", "-f", "-v", target.id]).catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
    }
  }
);
