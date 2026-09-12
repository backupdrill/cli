import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
        // 模拟 Supabase 的 auth 运行面(源库真有;--schema=public 转储不带它们):
        // 用户对象在**签名/列默认值**里引用 auth.uid() —— 这是 pre-data,建不出来整遍就炸,
        // 2026-09-11 真实用户 105 表库的首次演练就死在这。沙箱 shim 必须让它们建得出来。
        "create schema auth; create function auth.uid() returns uuid language sql as $$ select null::uuid $$; " +
        "create table auth.users(id uuid primary key); " +
        "create function public.is_admin(p_user_id uuid default auth.uid()) returns boolean language sql as $$ select false $$; " +
        "comment on function public.is_admin(uuid) is 'admin?'; " +
        "create table owned(id int primary key, owner uuid default auth.uid()); insert into owned select g, null from generate_series(1,20) g; " +
        // FK → auth.users:沙箱刻意不建 auth.users(空表会让 FK 校验真失败),必须按托管对象跳过
        "create table profile(id int primary key, user_id uuid references auth.users(id)); insert into profile values (1, null), (2, null); " +
        // 函数**体**引用 auth.users:pg_dump 头部 set check_function_bodies = false,恢复时不校验体,
        // 建得出来、演练照过 —— 只有真调用才炸。这正是 README 说"要靠 --check-cmd 去练"的那类对象。
        "create function public.find_user() returns void language plpgsql as $$ begin perform 1 from auth.users; end $$; " +
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
        tableCount: 7, estimatedRowTotal: 232,
        tables: [
          { schema: "public", name: "demo", estimatedRows: 100 },
          { schema: "public", name: "demo_mv", estimatedRows: 10 },
          { schema: "public", name: "parted", estimatedRows: 0 },
          { schema: "public", name: "parted_a", estimatedRows: 49 },
          { schema: "public", name: "parted_b", estimatedRows: 51 },
          { schema: "public", name: "owned", estimatedRows: 20 },
          { schema: "public", name: "profile", estimatedRows: 2 },
        ],
      },
      dump: { key: "seed/dump.pgcustom", format: "custom", bytes, sha256: sha },
      storage: null,
    };

    // 2. PASS:好备份应通过;行数 = demo 100 + matview 10 + 分区叶子 100(父表不重复计)
    //    + owned 20 + profile 2。owned 的 20 行是 shim 的直接证据:没有 auth.uid() 桩,
    //    这张表在 pre-data 就建不出来,行数会少 20、表数会少 1。
    // 只看匿名卷(Docker 给镜像 VOLUME 自动建的卷带 com.docker.volume.anonymous 标签):
    // 并发跑的其他容器若建命名卷,不该让本用例误红
    const anonVolumes = async () =>
      (await x("docker", ["volume", "ls", "-q", "-f", "label=com.docker.volume.anonymous"])).stdout.trim().split("\n").filter(Boolean);
    const volumesBefore = await anonVolumes();
    const good = await drillDump(dumpPath, manifest, "good");
    assert.equal(good.pass, true, "good backup should pass");
    // 匿名卷泄漏回归(2026-09-12 生产实测一次演练遗留 37.6 GB):销毁后不能多出任何卷
    const volumesAfter = await anonVolumes();
    assert.deepEqual(volumesAfter.filter((v) => !volumesBefore.includes(v)), [], "no docker volume may be left behind");
    assert.equal(good.restoredRowTotal, 232);
    assert.equal(good.restoredTableCount, 7);
    // pre-data 全严格:is_admin(default auth.uid()) 与它的 comment 建不出来会让上面直接失败;
    // find_user() 的函数体引用 auth.users 但恢复时不校验体(check_function_bodies=off),所以也过。
    // post-data 语义:PK 恢复成功;policy(to authenticated)有了角色桩之后**真的建出来了**,
    // 不再是跳过;唯一的预期跳过是 FK → auth.users(沙箱刻意不建那张表)。
    const pd = good.checks.find((c) => c.name === "post-data objects");
    assert.ok(pd?.pass, "user post-data objects (PK) must restore");
    assert.match(pd.detail, /1 Supabase-managed object\(s\) skipped/, "exactly the auth.users FK is skipped");

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

    // 6. 默认关闭红线:未配置时报告里不出现 app checks 行,也没有 keptSandbox
    assert.ok(!good.checks.some((c) => c.name === "app checks"));
    assert.ok(!bad.checks.some((c) => c.name === "app checks"));
    assert.equal(good.keptSandbox, undefined);
    assert.equal(bad.keptSandbox, undefined, "failed drill without --keep must not keep the sandbox");

    // 7. --keep 生命周期(xreview 回归):失败保留沙箱且报告可脚本消费;排查完能删
    const kept = await drillDump(dumpPath, tampered, "kept", [], {
      keepSandboxOnFailure: true,
    });
    assert.equal(kept.pass, false);
    assert.ok(kept.keptSandbox, "failed drill with --keep must expose the kept sandbox");
    try {
      const { stdout: running } = await x("docker", [
        "inspect", "-f", "{{.State.Running}}", kept.keptSandbox.containerId,
      ]);
      assert.equal(running.trim(), "true", "kept sandbox container must still be running");
    } finally {
      // 断言失败也不能把容器留在机器上(xreview:测试自身不许泄漏沙箱)
      await x("docker", ["rm", "-f", kept.keptSandbox.containerId]).catch(() => {});
    }

    // 8. 异常路径 + --keep:恢复抛出时报告不存在,沙箱坐标必须并入错误信息
    const garbagePath = join(tmpdir(), `bd-garbage-${Date.now()}.pgcustom`);
    writeFileSync(garbagePath, "not a pg dump");
    let thrown;
    try {
      await drillDump(garbagePath, manifest, "boom", [], { keepSandboxOnFailure: true });
      assert.fail("garbage dump must throw");
    } catch (e) {
      thrown = e;
    }
    assert.match(thrown.message, /sandbox kept: postgresql:/);
    const keptId = thrown.message.match(/docker rm -f ([0-9a-f]+)/)?.[1];
    assert.ok(keptId, "error message must carry the container id");
    await x("docker", ["rm", "-f", keptId]).catch(() => {});
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
        // HNSW 索引 + 够多的行:并行构建要走 /dev/shm,默认 64 MB 会炸(交叉审查 2026-09-12);
        // 沙箱 --shm-size 至少 1 GB(按机器内存推导),这个索引必须建得出来、演练必须 PASS
        "insert into items select g, array[random(), random(), random()]::real[]::extensions.vector from generate_series(3, 20002) g; " +
        "create index items_embedding_hnsw on items using hnsw (embedding extensions.vector_l2_ops); " +
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
        tableCount: 1, estimatedRowTotal: 20002,
        tables: [{ schema: "public", name: "items", estimatedRows: 20002 }],
        extensions: [{ name: "vector", version: "0.8.5", schema: "extensions" }],
      },
      dump: { key: "seed/dump.pgcustom", format: "custom", bytes, sha256: sha },
      storage: null,
    };

    const report = await drillDump(dumpPath, manifest, "vector");
    assert.equal(report.pass, true, "vector-column backup should drill PASS");
    assert.equal(report.restoredRowTotal, 20002) // 2 原始行 + 20000 行 HNSW 夹具;
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
  assert.match(check.detail, /timed out .* process tree killed/);
});

test("runAppCheck: unlaunchable command fails instead of throwing", async () => {
  // shell 存在但命令不存在 → 非零退出;两种平台行为(error 事件/非零码)都算 fail
  const check = await runAppCheck("definitely-not-a-real-command-xyz", "postgresql://sandbox");
  assert.equal(check.pass, false);
});

// ── xreview 回归:进程树击杀 / 空命令拒绝 ─────────────────────────

test("runAppCheck: timeout kills the whole process tree, not just the shell", async () => {
  const marker = join(tmpdir(), `bd-grandchild-${Date.now()}.marker`);
  // 孙进程(后台子 shell)2 秒后落盘;500ms 超时若只杀 shell,marker 仍会出现
  const check = await runAppCheck(
    `(sleep 2 && touch "${marker}") & sleep 30`,
    "postgresql://sandbox",
    500
  );
  assert.equal(check.pass, false);
  assert.match(check.detail, /timed out .* process tree killed/);
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(
    existsSync(marker),
    false,
    "grandchild survived the timeout — process tree was not killed"
  );
});

test("drillDump: empty --check-cmd is rejected before the sandbox starts", async () => {
  await assert.rejects(
    // manifest/dumpPath 无所谓:空命令必须在起 Docker 之前就被拒绝
    () => drillDump("/nonexistent", {}, "x", [], { appCheckCommand: "   " }),
    /--check-cmd is empty/
  );
});
