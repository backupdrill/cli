// drill 被 Ctrl+C / SIGTERM 打断时的收尾,用真信号测:起真 CLI 进程、真沙箱容器,
// 等 --check-cmd 在沙箱上跑起来以后只给 CLI 进程发信号(`kill <pid>` 的情形:子进程收不到)。
// 改之前:node 直接退出,沙箱容器和匿名卷留着,--check-cmd 接着跑,下载的 dump 留在临时目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeS3 } from "./fake-s3.js";

const x = promisify(execFile);
const pgDump = process.env.BACKUPDRILL_PG_DUMP || "pg_dump";
const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function available(cmd, args) {
  try {
    await x(cmd, args);
    return true;
  } catch {
    return false;
  }
}
const canRun = (await available("docker", ["version"])) && (await available(pgDump, ["--version"]));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(what, predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** 一份真 dump:临时源库(数据目录放 tmpfs,不建匿名卷)里一张 200 行的表。 */
async function makeDump(dir) {
  const { stdout } = await x("docker", [
    "run", "-d", "--rm", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_PASSWORD=pw",
    "-p", "127.0.0.1:0:5432", "postgres:17-alpine",
  ]);
  const id = stdout.trim();
  try {
    const port = (await x("docker", ["port", id, "5432/tcp"])).stdout.trim().split("\n")[0].split(":").pop();
    await waitFor("source postgres", () => x("docker", ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-q"]).then(() => true, () => false), 30_000);
    await x("docker", ["exec", id, "psql", "-U", "postgres", "-qc",
      "create table orders(id int primary key, v text); insert into orders select g, 'x' from generate_series(1, 200) g;"]);
    const dumpPath = join(dir, "seed.pgcustom");
    await x(pgDump, ["--format=custom", "--no-owner", "--no-privileges", "--schema=public",
      "--dbname", `postgresql://postgres:pw@127.0.0.1:${port}/postgres`, "-f", dumpPath]);
    return readFileSync(dumpPath);
  } finally {
    await x("docker", ["rm", "-fv", id]).catch(() => {});
  }
}

async function seedBucket(s3, dump) {
  const snapshot = "2026-10-23T00-00-00-000Z";
  const key = `backupdrill/sigtest/${snapshot}/dump.pgcustom`;
  s3.objects.set(key, dump);
  s3.objects.set(
    `backupdrill/sigtest/${snapshot}/manifest.json`,
    Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        tool: "backupdrill-cli",
        toolVersion: "test",
        createdAt: "2026-10-23T00:00:00.000Z",
        projectName: "sigtest",
        database: {
          serverVersion: "17.6",
          pgDumpVersion: (await x(pgDump, ["--version"])).stdout.trim(),
          schemas: ["public"],
          tableCount: 1,
          estimatedRowTotal: 200,
          tables: [{ schema: "public", name: "orders", estimatedRows: 200 }],
        },
        dump: { key, format: "custom", bytes: dump.length, sha256: createHash("sha256").update(dump).digest("hex") },
        storage: null,
      })
    )
  );
  return key;
}

/** 起真 CLI。环境只给它需要的,临时目录指到测试自己的目录里,结束后能数有没有剩下东西。 */
function startDrill(s3, tmp, args, { ownGroup = false } = {}) {
  const child = spawn(process.execPath, [CLI, "drill", "--config", join(tmp, "none.json"), ...args], {
    // ownGroup:CLI 自成一个进程组,测试可以像终端按 Ctrl+C 那样给整组发信号
    detached: ownGroup,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      ...(process.env.BACKUPDRILL_PG_RESTORE ? { BACKUPDRILL_PG_RESTORE: process.env.BACKUPDRILL_PG_RESTORE } : {}),
      TMPDIR: tmp,
      NO_COLOR: "1",
      BACKUPDRILL_PROJECT_NAME: "sigtest",
      BACKUPDRILL_S3_ENDPOINT: s3.endpoint,
      BACKUPDRILL_S3_REGION: "us-east-1",
      BACKUPDRILL_S3_BUCKET: s3.bucket,
      BACKUPDRILL_S3_ACCESS_KEY_ID: "test",
      BACKUPDRILL_S3_SECRET_ACCESS_KEY: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.stdout.resume();
  // 等 exit 而不是 close:改之前,被遗弃的 --check-cmd 还占着 CLI 的 stderr 管道,close 永远不来,
  // 测试会卡死、finally 跑不到,反而把容器留下。exit 之后再给管道一点时间把剩下的输出读完
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => setTimeout(() => resolve({ code, signal }), 200))
  );
  return { child, exited, stderr: () => stderr };
}

const leftovers = (tmp) => readdirSync(tmp).filter((name) => name.startsWith("backupdrill-"));

// target "process":只发给 CLI(`kill <pid>`、systemd 的 SIGTERM),子进程收不到;
// "group":发给 CLI 所在的整个进程组,和终端里按 Ctrl+C 一样(--check-cmd 自成一组,照样收不到)
for (const [signal, expectedCode, target] of [
  ["SIGINT", 130, "process"],
  ["SIGTERM", 143, "process"],
  ["SIGINT", 130, "group"],
]) {
  test(
    `drill: ${signal} to the ${target} while --check-cmd runs removes the sandbox, stops the check, deletes the dump, exits ${expectedCode}`,
    { skip: canRun ? false : "requires Docker + pg_dump", timeout: 180_000 },
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "bd-sig-test-"));
      const s3 = await startFakeS3({ bucket: "backups" });
      let containerId = null;
      let checkPid = null;
      try {
        await seedBucket(s3, await makeDump(tmp));
        const marker = join(tmp, "check-started");
        // 检查命令记下自己的 pid 和沙箱地址,然后一直挂着,直到被停掉
        const check =
          `node -e "require('fs').writeFileSync(process.argv[1], process.pid + ' ' + process.env.BACKUPDRILL_SANDBOX_URL); ` +
          `setInterval(() => {}, 1000)" ${marker}`;
        const run = startDrill(s3, tmp, ["--check-cmd", check], { ownGroup: target === "group" });
        await waitFor("--check-cmd to start", () => existsSync(marker) && readFileSync(marker, "utf8").includes(" "), 120_000);
        const [pid, sandboxUrl] = readFileSync(marker, "utf8").split(" ");
        checkPid = Number(pid);
        const port = new URL(sandboxUrl).port;
        containerId = (await x("docker", ["ps", "-q", "--filter", `publish=${port}`])).stdout.trim();
        assert.ok(containerId, "sandbox container is running while the check runs");
        const volumes = JSON.parse((await x("docker", ["inspect", "--format", "{{json .Mounts}}", containerId])).stdout)
          .filter((m) => m.Type === "volume")
          .map((m) => m.Name);
        assert.equal(leftovers(tmp).length, 1, "the downloaded dump's directory exists before the signal");

        if (target === "group") process.kill(-run.child.pid, signal);
        else run.child.kill(signal);
        const { code } = await run.exited;
        assert.equal(code, expectedCode, `exit code; stderr:\n${run.stderr()}`);
        assert.match(run.stderr(), new RegExp(`${signal} received`));
        await assert.rejects(x("docker", ["inspect", containerId]), /no such/i, "sandbox container removed");
        for (const volume of volumes) {
          await assert.rejects(x("docker", ["volume", "inspect", volume]), /no such/i, `volume ${volume} removed`);
        }
        await waitFor("--check-cmd to stop", () => !alive(checkPid), 5_000);
        assert.deepEqual(leftovers(tmp), [], "temporary files removed");
      } finally {
        if (checkPid && alive(checkPid)) process.kill(checkPid, "SIGKILL");
        if (containerId) await x("docker", ["rm", "-fv", containerId]).catch(() => {});
        await s3.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  );
}

test(
  "drill: SIGINT during the dump download exits 130 and leaves no temporary files",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 120_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bd-sig-test-"));
    const s3 = await startFakeS3({ bucket: "backups" });
    try {
      // dump 本身无所谓,下载会一直挂着
      const key = await seedBucket(s3, Buffer.from("not a real dump"));
      s3.fail((req) => (req.method === "GET" && req.key === key ? "hang" : null));
      const run = startDrill(s3, tmp, []);
      await waitFor("the download to start", () => s3.requests.some((r) => r.key === key), 30_000);
      await waitFor("the dump directory", () => leftovers(tmp).length === 1, 5_000);
      run.child.kill("SIGINT");
      const { code } = await run.exited;
      assert.equal(code, 130, `exit code; stderr:\n${run.stderr()}`);
      assert.deepEqual(leftovers(tmp), [], "temporary files removed");
      assert.doesNotMatch(run.stderr(), /Starting ephemeral/, "no sandbox was started");
    } finally {
      await s3.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
);
