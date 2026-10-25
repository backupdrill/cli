import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxRuntimeArgs, runDrill, drillDump } from "../dist/drill.js";

// The suite may itself run with BACKUPDRILL_DOCKER_RUNTIME set (e.g. to exercise the Docker tests
// under runsc), so tests that read the variable set it themselves and put it back.
async function withRuntimeEnv(value, fn) {
  const before = process.env.BACKUPDRILL_DOCKER_RUNTIME;
  if (value === undefined) delete process.env.BACKUPDRILL_DOCKER_RUNTIME;
  else process.env.BACKUPDRILL_DOCKER_RUNTIME = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.BACKUPDRILL_DOCKER_RUNTIME;
    else process.env.BACKUPDRILL_DOCKER_RUNTIME = before;
  }
}

test("no BACKUPDRILL_DOCKER_RUNTIME → no --runtime flag, Docker's default runtime as before", async () => {
  await withRuntimeEnv(undefined, () => assert.deepEqual(sandboxRuntimeArgs(), []));
  await withRuntimeEnv("", () => assert.deepEqual(sandboxRuntimeArgs(), []));
  assert.deepEqual(sandboxRuntimeArgs(""), []);
  assert.deepEqual(sandboxRuntimeArgs("   "), []);
});

test("a runtime name is passed through as a single --runtime=<name> argument", () => {
  assert.deepEqual(sandboxRuntimeArgs("runsc"), ["--runtime=runsc"]);
  assert.deepEqual(sandboxRuntimeArgs(" runsc\n"), ["--runtime=runsc"]);
  assert.deepEqual(sandboxRuntimeArgs("runsc-kvm"), ["--runtime=runsc-kvm"]);
  assert.deepEqual(sandboxRuntimeArgs("io.containerd.runc.v2"), ["--runtime=io.containerd.runc.v2"]);
});

test("anything that isn't a plain runtime name is rejected, so the variable can't smuggle in docker flags", () => {
  for (const value of [
    "--privileged",
    "-runsc",
    "runsc --privileged",
    "runsc\n--privileged",
    "runsc --network=host",
    "runsc,runc",
    "runsc;rm",
    "runsc=x",
    "../runsc",
    "/usr/local/bin/runsc",
    "runsc\0",
  ]) {
    assert.throws(() => sandboxRuntimeArgs(value), /BACKUPDRILL_DOCKER_RUNTIME must be a Docker runtime name/, JSON.stringify(value));
  }
});

test("a bad BACKUPDRILL_DOCKER_RUNTIME stops runDrill before it touches the snapshot store", async () => {
  let opened = false;
  const store = { openSnapshot: async () => { opened = true; throw new Error("store should not be opened"); } };
  await withRuntimeEnv("runsc --privileged", () =>
    assert.rejects(runDrill({}, { store }), /BACKUPDRILL_DOCKER_RUNTIME must be a Docker runtime name/));
  assert.equal(opened, false);
});

// docker 和 pg_restore 换成两个 shell 脚本:不需要真 Docker,也能看到 drill 真正传给 `docker run` 的参数。
// 假 docker 在 run 这一步失败退出,drillDump 到此为止,不会往下恢复。
async function dockerRunArgvWith(runtime) {
  const dir = mkdtempSync(join(tmpdir(), "bd-fake-docker-"));
  const runArgv = join(dir, "run.argv");
  writeFileSync(
    join(dir, "docker"),
    [
      "#!/bin/sh",
      'case "$1" in',
      '  info) echo "8589934592 2" ;;',
      `  run) printf '%s\\n' "$@" > '${runArgv}'; echo "fake docker stops at run" >&2; exit 1 ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n")
  );
  writeFileSync(join(dir, "pg_restore"), '#!/bin/sh\necho "pg_restore (PostgreSQL) 17.2"\n');
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "pg_restore"), 0o755);
  const before = { PATH: process.env.PATH, BACKUPDRILL_PG_RESTORE: process.env.BACKUPDRILL_PG_RESTORE };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.BACKUPDRILL_PG_RESTORE = join(dir, "pg_restore");
  const quiet = mock.method(console, "error", () => {});
  try {
    const manifest = { database: { serverVersion: "17.2", extensions: [] } };
    await withRuntimeEnv(runtime, () =>
      assert.rejects(drillDump(join(dir, "unused.dump"), manifest, "snap"), /fake docker stops at run/));
    return readFileSync(runArgv, "utf8").trimEnd().split("\n");
  } finally {
    quiet.mock.restore();
    process.env.PATH = before.PATH;
    if (before.BACKUPDRILL_PG_RESTORE === undefined) delete process.env.BACKUPDRILL_PG_RESTORE;
    else process.env.BACKUPDRILL_PG_RESTORE = before.BACKUPDRILL_PG_RESTORE;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("docker run gets --runtime=runsc when it is set, and nothing else changes", { skip: process.platform === "win32" ? "shell-script fake docker" : false }, async () => {
  const withoutRuntime = await dockerRunArgvWith(undefined);
  const withRuntime = await dockerRunArgvWith("runsc");

  assert.deepEqual(withoutRuntime.slice(0, 4), ["run", "-d", "--rm", "--name"]);
  assert.equal(withoutRuntime.some((arg) => arg.startsWith("--runtime")), false);

  assert.deepEqual(withRuntime.slice(0, 5), ["run", "-d", "--rm", "--runtime=runsc", "--name"]);
  assert.equal(withRuntime.filter((arg) => arg.startsWith("--runtime")).length, 1);

  // 除了这一个参数和每次随机的容器名,两次的 docker run 参数逐个相同
  const normalized = (argv) => argv.filter((arg) => arg !== "--runtime=runsc").map((arg) => arg.replace(/^backupdrill-drill-[0-9a-f]{12}$/, "<name>"));
  assert.deepEqual(normalized(withRuntime), normalized(withoutRuntime));
});
