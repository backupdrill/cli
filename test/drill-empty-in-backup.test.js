// "populated tables came back" 的误报回归(2026-10-24 生产演练):manifest 的行数是 pg_dump 之前
// 另开连接取的统计估算,队列/会话/一次性密钥这类表取统计时有行、dump 时已删光,恢复出 0 行是对的。
// 修法:恢复出空表时回查 dump —— dump 里也是 0 行才放过,dump 有行照样判失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drillDump, verifyRestored } from "../dist/drill.js";
import { tableDataInDump } from "../dist/restore-engine.js";

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
  "drill: a table the stats call populated but the dump has empty passes; one the dump has rows for still fails",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 300_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bd-empty-in-backup-"));
    const dumpPath = join(tmp, "dump.pgcustom");
    const source = await startPostgres();
    let target = null;
    try {
      // kept:有行;drained:建了表但 dump 时是空的(模拟取统计之后、dump 之前被删光);
      // "Odd Name":带空格和大写的表名,-n/-t 精确名要原样传过去;kept_mv:matview 的数据不是 COPY
      await psql(
        source.id,
        "create table kept(id int primary key, v text); insert into kept select g, 'k'||g from generate_series(1,50) g; " +
          "create table drained(id int primary key, secret text); " +
          'create table "Odd Name"(id int primary key); insert into "Odd Name" values (1), (2); ' +
          "create materialized view kept_mv as select id from kept where id <= 5;"
      );
      // 带引号的名字里能有换行:列名里写上 FROM stdin; 和 \.,只看单行的话 COPY 头会在第一行"结束"、
      // 下一行 \. 被当成空表结束符(交叉审查复现过)。表名里带换行的空表同理要认得出来
      await psql(
        source.id,
        'create table tricky(id int, "x FROM stdin;\n\\.\ny" text); insert into tricky values (1, \'a\'); ' +
          'create table "line\nbreak"(id int); create table "cr\rname"(id int);'
      );
      await x(pgDump, [
        "--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--dbname", source.conn, "-f", dumpPath,
      ]);

      // 1. 直接回查 dump
      assert.equal(await tableDataInDump(dumpPath, "public", "kept"), "rows");
      assert.equal(await tableDataInDump(dumpPath, "public", "drained"), "empty");
      assert.equal(await tableDataInDump(dumpPath, "public", "Odd Name"), "rows");
      assert.equal(await tableDataInDump(dumpPath, "public", "kept_mv"), "unknown", "matview data is a REFRESH, not COPY");
      assert.equal(await tableDataInDump(dumpPath, "public", "no_such_table"), "unknown");
      assert.equal(await tableDataInDump(dumpPath, "public", "tricky"), "rows");
      assert.equal(await tableDataInDump(dumpPath, "public", "line\nbreak"), "empty");
      assert.equal(await tableDataInDump(dumpPath, "public", "cr\rname"), "empty");
      assert.equal(await tableDataInDump(join(tmp, "missing.pgcustom"), "public", "kept"), "unknown");

      const buf = readFileSync(dumpPath);
      const manifest = {
        tool: "backupdrill-cli", toolVersion: "test", createdAt: "2026-10-24T00:00:00.000Z",
        projectName: "test",
        database: {
          serverVersion: "17.4", pgDumpVersion: "test", schemas: ["public"],
          tableCount: 7, estimatedRowTotal: 61,
          tables: [
            { schema: "public", name: "Odd Name", estimatedRows: 2 },
            // 统计说 drained 有 3 行,dump 里其实是空的 —— 生产上 recovery_job_secrets 的样子
            { schema: "public", name: "drained", estimatedRows: 3 },
            { schema: "public", name: "kept", estimatedRows: 50 },
            { schema: "public", name: "kept_mv", estimatedRows: 5 },
            { schema: "public", name: "line\nbreak", estimatedRows: 0 },
            // 统计说有行、dump 里是空的,名字里还带 \r:readline 会把它切断,回查就查不清
            { schema: "public", name: "cr\rname", estimatedRows: 4 },
            { schema: "public", name: "tricky", estimatedRows: 1 },
          ],
        },
        dump: {
          key: "seed/dump.pgcustom", format: "custom", bytes: buf.length,
          sha256: createHash("sha256").update(buf).digest("hex"),
        },
        storage: null,
      };

      // 2. 整个演练:drained 不再误报,报告里写明备份时就是空的
      const report = await drillDump(dumpPath, manifest, "empty-in-backup");
      const populated = report.checks.find((c) => c.name === "populated tables came back");
      assert.equal(populated?.pass, true, JSON.stringify(report.checks));
      assert.equal(
        populated.detail,
        "no populated table restored empty (already empty in the backup: public.drained, public.cr\rname)"
      );
      assert.equal(report.pass, true);

      // 3. 真故障照样抓:目标库只有表结构没有数据(kept 恢复空了,dump 里却有 50 行)
      target = await startPostgres();
      // dump 自带 CREATE SCHEMA public,新库里已有同名 schema 会让 pg_restore 退出码非 0
      await psql(target.id, "drop schema public cascade;");
      await x(pgRestore, ["--schema-only", "--no-owner", "--no-privileges", "--dbname", target.conn, dumpPath]);
      await psql(target.id, "refresh materialized view kept_mv; insert into \"Odd Name\" values (1), (2);");
      // tricky 也恢复空了(只恢复了结构),dump 里却有 1 行:多行 COPY 头要读对,不能误判成空表
      const verified = await verifyRestored(target.conn, manifest, dumpPath);
      const check = verified.checks.find((c) => c.name === "populated tables came back");
      assert.equal(check.pass, false);
      // kept_mv 刷新后跟着 kept 是 0 行;matview 回查不出(数据是 REFRESH 不是 COPY)= 查不清,照样判失败
      assert.equal(check.detail, "restored empty despite manifest rows: public.kept, public.kept_mv, public.tricky");

      // 4. 不给 dump 路径(老调用方式)= 不回查,行为和以前一样
      const withoutDump = await verifyRestored(target.conn, manifest);
      assert.equal(
        withoutDump.checks.find((c) => c.name === "populated tables came back").detail,
        "restored empty despite manifest rows: public.drained, public.kept, public.kept_mv, public.cr\rname, public.tricky"
      );
    } finally {
      await x("docker", ["rm", "-f", source.id]).catch(() => {});
      if (target) await x("docker", ["rm", "-f", target.id]).catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
    }
  }
);
