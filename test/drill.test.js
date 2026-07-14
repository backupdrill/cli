import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drillDump,
  classifyPostDataErrors,
  postDataResult,
  sampleStorageFiles,
} from "../dist/drill.js";

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

// 需要 Docker + pg_dump;缺任一则跳过(本地无环境或纯 lint CI 不至于失败)
const canRun =
  (await available("docker", ["version"])) && (await available(pgDump, ["--version"]));

test(
  "drill: verifies a good backup (PASS) and catches a tampered manifest (FAIL)",
  { skip: canRun ? false : "requires Docker + pg_dump" },
  async () => {
    // 1. 起源库、塞 100 行、dump 成 custom 格式
    const { stdout: idOut } = await x("docker", [
      "run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=seed",
      "-p", "127.0.0.1:0:5432", "postgres:17-alpine",
    ]);
    const id = idOut.trim();
    const dumpPath = join(tmpdir(), `bd-test-${id.slice(0, 8)}.pgcustom`);
    let sha, bytes;
    try {
      const { stdout: portOut } = await x("docker", ["port", id, "5432/tcp"]);
      const port = portOut.trim().split(":").pop().trim();
      for (let i = 0; i < 60; i++) {
        try {
          // -h 强制 TCP:与引擎同一个坑——镜像初始化阶段的临时服务只听 socket,
          // 默认检查会在"临时停/正式起"窗口前误报就绪(VPS 上真实复现过)
          await x("docker", ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-q"]);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      await x("docker", [
        "exec", id, "psql", "-U", "postgres", "-c",
        // PK = 用户自己的 post-data(必须恢复成功);authenticated 角色 + policy 模拟
        // Supabase 库的托管接线(演练沙箱没有该角色 → 必须被归类为预期跳过,而非失败)
        "create table demo(id int primary key, v text); insert into demo select g, 'row'||g from generate_series(1,100) g; " +
        "create role authenticated nologin; alter table demo enable row level security; " +
        "create policy demo_read on demo for select to authenticated using (true); " +
        // matview + 分区表 = 曾经的必然 FAIL 回归:manifest 统计端含它们而校验端不含,
        // 表数不符 + 误报缺表。修复后两端同口径,这个组合必须 PASS。
        "create materialized view demo_mv as select id, v from demo where id <= 10; " +
        "create table parted(id int not null, v text) partition by range(id); " +
        "create table parted_a partition of parted for values from (0) to (50); " +
        "create table parted_b partition of parted for values from (50) to (200); " +
        "insert into parted select g, 'p'||g from generate_series(1,100) g;",
      ]);
      const conn = `postgresql://postgres:seed@127.0.0.1:${port}/postgres`;
      await x(pgDump, [
        "--format=custom", "--no-owner", "--no-privileges", "--schema=public",
        "--dbname", conn, "-f", dumpPath,
      ]);
      const buf = readFileSync(dumpPath);
      bytes = buf.length;
      sha = createHash("sha256").update(buf).digest("hex");
    } finally {
      await x("docker", ["rm", "-f", id]).catch(() => {});
    }

    // 注意:故意不带 extensions 字段 = 0.1.1 及更早的旧 manifest,行为必须不变
    const manifest = {
      tool: "backupdrill-cli", toolVersion: "test", createdAt: "2026-07-04T00:00:00.000Z",
      projectName: "test",
      database: {
        serverVersion: "17.4", pgDumpVersion: "test", schemas: ["public"],
        // 口径 = 普通表 + matview + 分区父表 + 分区子表(与备份统计端一致);
        // 分区父表不存行(estimatedRows 0),行数落在子分区上(1..49 / 50..100)
        tableCount: 5, estimatedRowTotal: 210,
        tables: [
          { schema: "public", name: "demo", estimatedRows: 100 },
          { schema: "public", name: "demo_mv", estimatedRows: 10 },
          { schema: "public", name: "parted", estimatedRows: 0 },
          { schema: "public", name: "parted_a", estimatedRows: 49 },
          { schema: "public", name: "parted_b", estimatedRows: 51 },
        ],
      },
      dump: { key: "seed/dump.pgcustom", format: "custom", bytes, sha256: sha },
      storage: null,
    };

    // 2. PASS:好备份应通过;行数 = demo 100 + matview 10 + 分区叶子 100(父表不重复计)
    const good = await drillDump(dumpPath, manifest, "good");
    assert.equal(good.pass, true, "good backup should pass");
    assert.equal(good.restoredRowTotal, 210);
    assert.equal(good.restoredTableCount, 5);
    // post-data 语义:用户的 PK 恢复成功,Supabase 式 policy(TO authenticated)被
    // 归类为沙箱预期跳过——两边都不许把演练翻成失败,也不许假装没跳过
    const pd = good.checks.find((c) => c.name === "post-data objects");
    assert.ok(pd?.pass, "user post-data objects (PK) must restore");
    assert.match(pd.detail, /Supabase-managed/, "the policy skip must be reported");

    // 3. FAIL:manifest 谎报一张 dump 里没有的表,演练必须抓到
    const tampered = {
      ...manifest,
      database: {
        ...manifest.database,
        tableCount: manifest.database.tableCount + 1,
        tables: [...manifest.database.tables, { schema: "public", name: "ghost", estimatedRows: 5 }],
      },
    };
    const bad = await drillDump(dumpPath, tampered, "bad");
    assert.equal(bad.pass, false, "tampered manifest should fail");
    assert.ok(
      bad.checks.some((c) => c.name === "no missing tables" && !c.pass),
      "the 'no missing tables' check should fail"
    );

    // 4. 应用自检钩子:命令拿到 BACKUPDRILL_SANDBOX_URL 并真连沙箱查数——
    //    证明钩子跑在销毁之前、拿到的是活库
    const hooked = await drillDump(dumpPath, manifest, "hooked", [], {
      appCheckCommand:
        `node -e "const {Client}=require('pg');` +
        `const c=new Client({connectionString:process.env.BACKUPDRILL_SANDBOX_URL});` +
        `c.connect().then(()=>c.query('select count(*) n from demo')).then(r=>` +
        `process.exit(Number(r.rows[0].n)===100?0:1)).catch(()=>process.exit(2))"`,
    });
    assert.equal(hooked.pass, true, "app check querying the live sandbox should pass");
    assert.ok(
      hooked.checks.find((c) => c.name === "app checks")?.pass,
      "app checks row must be present and passing"
    );

    // 5. 语义层失败 → 演练整体失败,但结构层各检查仍然全绿(报告必须区分两层)
    const semanticFail = await drillDump(dumpPath, manifest, "semfail", [], {
      appCheckCommand: `node -e "process.exit(1)"`,
    });
    assert.equal(semanticFail.pass, false, "semantic failure fails the drill");
    assert.ok(
      semanticFail.checks.filter((c) => c.name !== "app checks").every((c) => c.pass),
      "structural checks must all still pass"
    );

    // 6. 默认关闭红线:未配置时报告里不出现 app checks 行
    assert.ok(!good.checks.some((c) => c.name === "app checks"));
    assert.ok(!bad.checks.some((c) => c.name === "app checks"));
  }
);

test(
  "drill: restores a backup with pgvector columns (extension manifest → pgvector sandbox image)",
  { skip: canRun ? false : "requires Docker + pg_dump" },
  async () => {
    // 源库按 Supabase 惯例把 pgvector 装在 "extensions" schema:dump 里的列类型是
    // 限定名 extensions.vector(3),沙箱必须先建同名 schema 并把扩展装进去才解析得到。
    // 曾经的硬崩回归:--schema=public 转储不含 CREATE EXTENSION,alpine 沙箱又没有
    // pgvector,含 vector 列的库演练必然裸报 "pg_restore failed"。
    const { stdout: idOut } = await x("docker", [
      "run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=seed",
      "-p", "127.0.0.1:0:5432", "pgvector/pgvector:pg17",
    ]);
    const id = idOut.trim();
    const dumpPath = join(tmpdir(), `bd-test-vec-${id.slice(0, 8)}.pgcustom`);
    let sha, bytes;
    try {
      const { stdout: portOut } = await x("docker", ["port", id, "5432/tcp"]);
      const port = portOut.trim().split(":").pop().trim();
      for (let i = 0; i < 60; i++) {
        try {
          await x("docker", ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-q"]);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      await x("docker", [
        "exec", id, "psql", "-U", "postgres", "-c",
        "create schema extensions; create extension vector schema extensions; " +
        "create table items(id int primary key, embedding extensions.vector(3)); " +
        "insert into items values (1,'[1,2,3]'),(2,'[4,5,6]');",
      ]);
      const conn = `postgresql://postgres:seed@127.0.0.1:${port}/postgres`;
      await x(pgDump, [
        "--format=custom", "--no-owner", "--no-privileges", "--schema=public",
        "--dbname", conn, "-f", dumpPath,
      ]);
      const buf = readFileSync(dumpPath);
      bytes = buf.length;
      sha = createHash("sha256").update(buf).digest("hex");
    } finally {
      await x("docker", ["rm", "-f", id]).catch(() => {});
    }

    const manifest = {
      tool: "backupdrill-cli", toolVersion: "test", createdAt: "2026-07-04T00:00:00.000Z",
      projectName: "test",
      database: {
        serverVersion: "17.4", pgDumpVersion: "test", schemas: ["public"],
        tableCount: 1, estimatedRowTotal: 2,
        tables: [{ schema: "public", name: "items", estimatedRows: 2 }],
        extensions: [{ name: "vector", version: "0.8.5", schema: "extensions" }],
      },
      dump: { key: "seed/dump.pgcustom", format: "custom", bytes, sha256: sha },
      storage: null,
    };

    const report = await drillDump(dumpPath, manifest, "vector");
    assert.equal(report.pass, true, "vector-column backup should drill PASS");
    assert.equal(report.restoredRowTotal, 2);
    const ext = report.checks.find((c) => c.name === "sandbox extensions");
    assert.ok(ext?.pass, "extension pre-install must be reported");
    assert.match(ext.detail, /vector/);
  }
);

// 回归(adversarial review):沙箱装不上扩展 + 与扩展无关的硬失败(损坏的归档)
// → 必须抛原始错误;不许归因沙箱,更不许断言"备份没事"
test(
  "drill: corrupt archive with unavailable extensions throws the original error",
  { skip: canRun ? false : "requires Docker + pg_dump" },
  async () => {
    const dumpPath = join(tmpdir(), `bd-test-corrupt-${Date.now()}.pgcustom`);
    writeFileSync(dumpPath, "this is not a pg_dump custom archive");
    const manifest = {
      tool: "backupdrill-cli", toolVersion: "test", createdAt: "2026-07-04T00:00:00.000Z",
      projectName: "test",
      database: {
        serverVersion: "17.4", pgDumpVersion: "test", schemas: ["public"],
        tableCount: 0, estimatedRowTotal: 0, tables: [],
        // alpine 沙箱必然装不上的托管扩展 → unavailable 非空,复现误归因前提
        extensions: [{ name: "pg_graphql", version: "1.5.11", schema: "graphql" }],
      },
      dump: { key: "seed/dump.pgcustom", format: "custom", bytes: 36, sha256: "irrelevant" },
      storage: null,
    };
    await assert.rejects(
      () => drillDump(dumpPath, manifest, "corrupt"),
      (err) => {
        assert.match(err.message, /pg_restore failed/, "the original hard failure must surface");
        assert.doesNotMatch(
          err.message,
          /likely because|sandbox/i,
          "an extension-unrelated failure must not be attributed to the sandbox"
        );
        return true;
      }
    );
  }
);

// 纯单测(无需 Docker):post-data 错误分类——Supabase 托管失败 vs 用户对象失败
test("classifyPostDataErrors: supabase-managed vs user failures", () => {
  const stderr = [
    'pg_restore: error: could not execute query: ERROR:  role "authenticated" does not exist',
    "Command was: CREATE POLICY demo_read ON public.demo FOR SELECT TO authenticated;",
    'pg_restore: error: could not execute query: ERROR:  schema "auth" does not exist',
    "Command was: ALTER TABLE accounts ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES auth.users(id);",
    "pg_restore: error: could not execute query: ERROR:  syntax error at or near \"BROKEN\"",
    "Command was: CREATE INDEX broken_idx ON public.demo (BROKEN);",
  ].join("\n");
  const r = classifyPostDataErrors(stderr);
  assert.equal(r.supabaseSkipped, 2, "auth-schema + authenticated-role failures are expected skips");
  assert.equal(r.failures.length, 1, "the user's broken index is a real failure");
  assert.match(r.failures[0], /broken_idx/);
});

test("classifyPostDataErrors: clean stderr → nothing skipped, nothing failed", () => {
  const r = classifyPostDataErrors("");
  assert.equal(r.supabaseSkipped, 0);
  assert.equal(r.failures.length, 0);
});

// 回归(xreview):Command 提到 auth.uid 但真实错误是别的 → 必须判失败,不许误跳过
test("classifyPostDataErrors: auth.uid in Command but unrelated error → failure", () => {
  const stderr = [
    "pg_restore: error: could not execute query: ERROR:  syntax error at or near \"USING\"",
    "Command was: CREATE POLICY p ON public.demo USING (auth.uid() = id);",
  ].join("\n");
  const r = classifyPostDataErrors(stderr);
  assert.equal(r.supabaseSkipped, 0, "unrelated error must not be classified as a skip");
  assert.equal(r.failures.length, 1);
});

// 回归:Storage 抽样必须随机——此前恒取 manifest 顺序前 N 个,超过上限的项目里
// 排序靠后的文件永远不被校验。场景:250 个文件、上限 100。
test("sampleStorageFiles: caps at n, no duplicates, and varies between drills", () => {
  const files = Array.from({ length: 250 }, (_, i) => ({ bucket: "b", key: `file-${i}` }));

  const first = sampleStorageFiles(files, 100);
  assert.equal(first.length, 100, "sample size must equal the cap");
  assert.equal(
    new Set(first.map((f) => f.key)).size,
    100,
    "sampling must be without replacement (no duplicates)"
  );
  const source = new Set(files);
  assert.ok(first.every((f) => source.has(f)), "every sampled entry must come from the input");

  // 两次演练样本可不同:两次独立均匀抽样撞出同一个 100/250 子集的概率是
  // 1/C(250,100) ≈ 10^-72,统计上不可能 flaky;只有退化回"确定性取前 N"才会相等。
  const second = sampleStorageFiles(files, 100);
  const asSetKey = (s) => s.map((f) => f.key).sort().join(",");
  assert.notEqual(
    asSetKey(first),
    asSetKey(second),
    "two drills must be able to sample different subsets"
  );

  // 文件数 ≤ 上限:全量校验,原样返回(不洗牌、不复制)
  const small = files.slice(0, 100);
  assert.equal(sampleStorageFiles(small, 100), small);
});

// 回归(xreview):post-data 非零退出且无可解析错误块 → 通用失败,不许谎报"全部恢复"
test("postDataResult: nonzero exit with no parsed blocks → generic failure", () => {
  const killed = postDataResult(null, "");
  assert.equal(killed.failures.length, 1);
  assert.match(killed.failures[0], /signal/);
  const archiverFatal = postDataResult(1, "pg_restore: [archiver] out of memory");
  assert.equal(archiverFatal.failures.length, 1);
  assert.match(archiverFatal.failures[0], /code 1/);
  // 正常情形:退出 1 但错误已全部归类为 Supabase 跳过 → 不额外报失败
  const explained = postDataResult(
    1,
    'pg_restore: error: could not execute query: ERROR:  role "authenticated" does not exist\nCommand was: CREATE POLICY x;'
  );
  assert.equal(explained.failures.length, 0);
  assert.equal(explained.supabaseSkipped, 1);
});

// ── 应用自检钩子(语义层,无需 Docker)─────────────────────────────

const { runAppCheck } = await import("../dist/drill.js");

test("runAppCheck: exit 0 passes and receives BACKUPDRILL_SANDBOX_URL", async () => {
  const check = await runAppCheck(
    `node -e "process.exit(process.env.BACKUPDRILL_SANDBOX_URL === 'postgresql://sandbox' ? 0 : 1)"`,
    "postgresql://sandbox"
  );
  assert.equal(check.name, "app checks");
  assert.equal(check.pass, true);
  assert.match(check.detail, /exited 0/);
});

test("runAppCheck: nonzero exit fails with the code in the detail", async () => {
  const check = await runAppCheck(`node -e "process.exit(3)"`, "postgresql://sandbox");
  assert.equal(check.pass, false);
  assert.match(check.detail, /exited 3/);
});

test("runAppCheck: hung command is killed at the timeout and fails", async () => {
  const check = await runAppCheck(
    `node -e "setTimeout(() => {}, 30000)"`,
    "postgresql://sandbox",
    500
  );
  assert.equal(check.pass, false);
  assert.match(check.detail, /terminated by SIGKILL/);
});

test("runAppCheck: unlaunchable command fails instead of throwing", async () => {
  // shell 存在但命令不存在 → 非零退出;两种平台行为(error 事件/非零码)都算 fail
  const check = await runAppCheck("definitely-not-a-real-command-xyz", "postgresql://sandbox");
  assert.equal(check.pass, false);
});
