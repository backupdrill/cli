// drill 被 Ctrl+C / SIGTERM 打断时的收尾,用真信号测:起真 CLI 进程、真沙箱容器,
// 等 --check-cmd 在沙箱上跑起来以后只给 CLI 进程发信号(`kill <pid>` 的情形:子进程收不到)。
// 改之前:node 直接退出,沙箱容器和匿名卷留着,--check-cmd 接着跑,下载的 dump 留在临时目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
function startDrill(s3, tmp, args, { ownGroup = false, env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, "drill", "--config", join(tmp, "none.json"), ...args], {
    // ownGroup:CLI 自成一个进程组,测试可以像终端按 Ctrl+C 那样给整组发信号
    detached: ownGroup,
    env: {
      PATH: env.PATH ?? process.env.PATH,
      ...env,
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

test(
  "drill: SIGINT also kills --check-cmd descendants that ignore SIGTERM",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 180_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bd-sig-test-"));
    const s3 = await startFakeS3({ bucket: "backups" });
    let containerId = null;
    const pids = [];
    try {
      await seedBucket(s3, await makeDump(tmp));
      const marker = join(tmp, "check-started");
      // 检查命令再起一个忽略 SIGTERM 的孙进程(同一进程组):组长被 SIGTERM 停掉之后,孙进程得靠 SIGKILL
      const script = join(tmp, "check.cjs");
      writeFileSync(
        script,
        `const { spawn } = require("child_process");
         const g = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
         require("fs").writeFileSync(process.argv[2], [process.pid, g.pid, process.env.BACKUPDRILL_SANDBOX_URL].join(" "));
         setInterval(() => {}, 1000);`
      );
      const run = startDrill(s3, tmp, ["--check-cmd", `node ${script} ${marker}`]);
      await waitFor("--check-cmd to start", () => existsSync(marker), 120_000);
      const [checkPid, grandchildPid, sandboxUrl] = readFileSync(marker, "utf8").split(" ");
      pids.push(Number(checkPid), Number(grandchildPid));
      containerId = (await x("docker", ["ps", "-q", "--filter", `publish=${new URL(sandboxUrl).port}`])).stdout.trim();
      run.child.kill("SIGINT");
      const { code } = await run.exited;
      assert.equal(code, 130, `exit code; stderr:\n${run.stderr()}`);
      assert.equal(alive(Number(checkPid)), false, "check command stopped");
      assert.equal(alive(Number(grandchildPid)), false, "TERM-ignoring grandchild killed");
      await assert.rejects(x("docker", ["inspect", containerId]), /no such/i, "sandbox container removed");
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
      if (containerId) await x("docker", ["rm", "-fv", containerId]).catch(() => {});
      await s3.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
);

/**
 * 假的 docker:放在 PATH 最前面,别的子命令照转真 docker。
 * mode "slow-pull":image inspect 说镜像不在,pull 挂 10 分钟(模拟第一次拉镜像);
 * mode "late-create":run 先等 4 秒再真的去建容器(模拟守护进程晚一点才把容器建出来)。
 * 每次 pull / run 把自己的 pid 和容器名写进 mark 文件。
 */
async function fakeDocker(tmp, mode) {
  const realDocker = (await x("sh", ["-c", "command -v docker"])).stdout.trim();
  const bin = join(tmp, "bin");
  const marks = { pull: join(tmp, "pull-started"), run: join(tmp, "run-started") };
  await x("mkdir", ["-p", bin]);
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}
const { spawnSync } = require("child_process");
const fs = require("fs");
const args = process.argv.slice(2);
const real = () => process.exit(spawnSync(${JSON.stringify(realDocker)}, args, { stdio: "inherit" }).status ?? 1);
const mode = ${JSON.stringify(mode)};
if (mode === "slow-pull" && args[0] === "image" && args[1] === "inspect") process.exit(1);
if (mode === "slow-pull" && args[0] === "pull") {
  fs.writeFileSync(${JSON.stringify(marks.pull)}, String(process.pid));
  setTimeout(() => process.exit(0), 600000);
} else if (args[0] === "run") {
  fs.writeFileSync(${JSON.stringify(marks.run)}, process.pid + " " + args[args.indexOf("--name") + 1]);
  if (mode === "late-create") setTimeout(real, 4000); else real();
} else real();
`
  );
  chmodSync(join(bin, "docker"), 0o755);
  return { realDocker, marks, PATH: `${bin}:${process.env.PATH}` };
}

test(
  "drill: SIGINT while the sandbox image is still being pulled stops the pull and never starts a sandbox",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 120_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bd-sig-test-"));
    const s3 = await startFakeS3({ bucket: "backups" });
    let pullPid = null;
    try {
      await seedBucket(s3, await makeDump(tmp));
      const docker = await fakeDocker(tmp, "slow-pull");
      const run = startDrill(s3, tmp, [], { env: { PATH: docker.PATH } });
      await waitFor("docker pull to start", () => existsSync(docker.marks.pull), 120_000);
      pullPid = Number(readFileSync(docker.marks.pull, "utf8"));
      const sentAt = Date.now();
      run.child.kill("SIGINT");
      const { code } = await run.exited;
      assert.equal(code, 130, `exit code; stderr:\n${run.stderr()}`);
      assert.ok(Date.now() - sentAt < 15_000, "does not wait for the pull");
      assert.equal(alive(pullPid), false, "the pull was stopped");
      assert.equal(existsSync(docker.marks.run), false, "docker run was never started");
      assert.deepEqual(leftovers(tmp), [], "temporary files removed");
    } finally {
      if (pullPid && alive(pullPid)) process.kill(pullPid, "SIGKILL");
      await s3.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
);

test(
  "drill: SIGINT while docker run is still creating the sandbox waits for it, then removes it",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 120_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bd-sig-test-"));
    const s3 = await startFakeS3({ bucket: "backups" });
    let name = null;
    let realDocker = "docker";
    try {
      await seedBucket(s3, await makeDump(tmp));
      const docker = await fakeDocker(tmp, "late-create");
      realDocker = docker.realDocker;
      const run = startDrill(s3, tmp, [], { env: { PATH: docker.PATH } });
      await waitFor("docker run to start", () => existsSync(docker.marks.run), 120_000);
      name = readFileSync(docker.marks.run, "utf8").split(" ")[1];
      run.child.kill("SIGINT");
      const { code } = await run.exited;
      assert.equal(code, 130, `exit code; stderr:\n${run.stderr()}`);
      // 容器是在信号之后约 4 秒才建出来的;CLI 等它落定再删,退出时和之后都不该有它
      const containers = async () => (await x(realDocker, ["ps", "-aq", "--filter", `name=^${name}$`])).stdout.trim();
      assert.equal(await containers(), "", "no sandbox container at exit");
      await new Promise((r) => setTimeout(r, 2_000));
      assert.equal(await containers(), "", "and none shows up later");
      assert.deepEqual(leftovers(tmp), [], "temporary files removed");
    } finally {
      if (name) await x(realDocker, ["rm", "-fv", name]).catch(() => {});
      await s3.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
);

test(
  "drill: SIGTERM while pg_restore lists the archive (parallel restore) stops it too",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 180_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bd-sig-test-"));
    const s3 = await startFakeS3({ bucket: "backups" });
    let listPid = null;
    try {
      await seedBucket(s3, await makeDump(tmp));
      // pg_restore 包装:--list 那一步挂住(读目录本来很快),其余照转真的 pg_restore
      const realPgRestore = process.env.BACKUPDRILL_PG_RESTORE || (await x("sh", ["-c", "command -v pg_restore"])).stdout.trim();
      const mark = join(tmp, "list-started");
      const wrapper = join(tmp, "pg_restore");
      writeFileSync(
        wrapper,
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--list")) {
  require("fs").writeFileSync(${JSON.stringify(mark)}, String(process.pid));
  setTimeout(() => {}, 600000);
} else process.exit(require("child_process").spawnSync(${JSON.stringify(realPgRestore)}, args, { stdio: "inherit" }).status ?? 1);
`
      );
      chmodSync(wrapper, 0o755);
      const run = startDrill(s3, tmp, [], { env: { BACKUPDRILL_PG_RESTORE: wrapper } });
      const listed = await Promise.race([
        waitFor("pg_restore --list", () => existsSync(mark), 120_000).then(() => true),
        run.exited.then(() => false),
      ]);
      if (!listed) {
        // 只有并行恢复才单独列目录;Docker 只给 1 核或很少内存时演练走单连接,这一步不存在
        assert.match(run.stderr(), /Drill PASSED/, run.stderr());
        return;
      }
      listPid = Number(readFileSync(mark, "utf8"));
      run.child.kill("SIGTERM");
      const { code } = await run.exited;
      assert.equal(code, 143, `exit code; stderr:\n${run.stderr()}`);
      await waitFor("pg_restore --list to stop", () => !alive(listPid), 5_000);
      assert.deepEqual(leftovers(tmp), [], "temporary files removed");
    } finally {
      if (listPid && alive(listPid)) process.kill(listPid, "SIGKILL");
      await s3.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
);

test("interrupt: cleanups registered while the cleanup is running still run before exit", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "bd-sig-test-"));
  try {
    const marker = join(tmp, "late-cleanup-ran");
    const ready = join(tmp, "ready");
    const script = join(tmp, "late.mjs");
    const interruptModule = new URL("../dist/interrupt.js", import.meta.url).href;
    // 第一个清理跑的时候主流程又登记了一个(比如收到信号时刚返回的 docker run):它也得跑
    writeFileSync(
      script,
      `import { exitCleanlyOnSignals, onInterrupt } from ${JSON.stringify(interruptModule)};
       import { writeFileSync } from "node:fs";
       exitCleanlyOnSignals("test");
       onInterrupt(async () => {
         onInterrupt(() => writeFileSync(${JSON.stringify(marker)}, "ran"));
         await new Promise((r) => setTimeout(r, 100));
       });
       writeFileSync(${JSON.stringify(ready)}, "ready");
       setInterval(() => {}, 1000);`
    );
    const child = spawn(process.execPath, [script], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    await waitFor("script ready", () => existsSync(ready), 10_000);
    child.kill("SIGINT");
    assert.equal(await exited, 130);
    assert.equal(existsSync(marker), true, "late registration ran");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// 起一个只装了 exitCleanlyOnSignals 的小脚本:收到信号后的清理要跑 cleanupMs 才写 marker。
// viaForwarder 时像 npx 那样套一层:外层自成进程组,把收到的 SIGINT/SIGTERM 再转发给脚本
// (@npmcli/run-script 的 signal-manager 就是这么做的),退出码照搬脚本的。
function startInterruptScript(tmp, { cleanupMs, viaForwarder }) {
  const marker = join(tmp, "cleanup-ran");
  const ready = join(tmp, "ready");
  const script = join(tmp, "slow-cleanup.mjs");
  const interruptModule = new URL("../dist/interrupt.js", import.meta.url).href;
  writeFileSync(
    script,
    `import { exitCleanlyOnSignals, onInterrupt } from ${JSON.stringify(interruptModule)};
     import { writeFileSync } from "node:fs";
     exitCleanlyOnSignals("test");
     onInterrupt(async () => {
       await new Promise((r) => setTimeout(r, ${cleanupMs}));
       writeFileSync(${JSON.stringify(marker)}, "ran");
     });
     writeFileSync(${JSON.stringify(ready)}, "ready");
     setInterval(() => {}, 1000);`
  );
  const forwarder = join(tmp, "forwarder.mjs");
  writeFileSync(
    forwarder,
    `import { spawn } from "node:child_process";
     const child = spawn(process.execPath, [${JSON.stringify(script)}], { stdio: "inherit" });
     for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
     child.on("exit", (code) => process.exit(code ?? 1));`
  );
  const child = spawn(process.execPath, [viaForwarder ? forwarder : script], {
    detached: viaForwarder,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited, marker, ready, stderr: () => stderr };
}

test("interrupt: one Ctrl+C under npx, which delivers SIGINT twice, still runs the cleanup", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "bd-sig-test-"));
  try {
    const run = startInterruptScript(tmp, { cleanupMs: 300, viaForwarder: true });
    await waitFor("script ready", () => existsSync(run.ready), 10_000);
    // 发给整个进程组,和终端里按 Ctrl+C 一样:脚本直接收到一次,转发层又转来一次
    process.kill(-run.child.pid, "SIGINT");
    assert.equal(await run.exited, 130);
    assert.equal(existsSync(run.marker), true, `cleanup ran; stderr:\n${run.stderr()}`);
    assert.doesNotMatch(run.stderr(), /SIGINT again/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("interrupt: a second Ctrl+C more than a second later skips the cleanup", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "bd-sig-test-"));
  try {
    const run = startInterruptScript(tmp, { cleanupMs: 10_000, viaForwarder: false });
    await waitFor("script ready", () => existsSync(run.ready), 10_000);
    run.child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 1_500));
    run.child.kill("SIGINT");
    assert.equal(await run.exited, 130);
    assert.match(run.stderr(), /SIGINT again — exiting without finishing the cleanup/);
    assert.equal(existsSync(run.marker), false, "cleanup was skipped");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
