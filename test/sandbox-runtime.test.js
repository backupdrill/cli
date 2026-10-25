import { test } from "node:test";
import assert from "node:assert/strict";
import { sandboxRuntimeArgs, runDrill } from "../dist/drill.js";

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
