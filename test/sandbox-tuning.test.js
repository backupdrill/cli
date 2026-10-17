import { test } from "node:test";
import assert from "node:assert/strict";
import { sandboxTuning } from "../dist/drill.js";

const GIB = 1024 ** 3;
const pick = (settings, key) => settings.find((s) => s.startsWith(`${key}=`));

test("2 GB machine keeps the floor the old fixed tuning ran at", () => {
  const t = sandboxTuning(2 * GIB);
  assert.equal(pick(t.settings, "shared_buffers"), "shared_buffers=512MB");
  assert.equal(pick(t.settings, "maintenance_work_mem"), "maintenance_work_mem=256MB");
  assert.equal(t.shmSize, "1024m");
});

test("8 GB worker scales memory settings with the machine", () => {
  const t = sandboxTuning(8 * GIB);
  assert.equal(pick(t.settings, "shared_buffers"), "shared_buffers=2048MB");
  assert.equal(pick(t.settings, "maintenance_work_mem"), "maintenance_work_mem=1024MB");
  assert.equal(t.shmSize, "2048m");
});

test("big laptops hit the caps instead of hoarding host memory", () => {
  const t = sandboxTuning(64 * GIB);
  assert.equal(pick(t.settings, "shared_buffers"), "shared_buffers=2048MB");
  assert.equal(pick(t.settings, "maintenance_work_mem"), "maintenance_work_mem=1024MB");
});

test("a 1 GiB Docker Desktop VM gets exactly the pre-scaling floor, never the host's numbers", () => {
  // 交叉审查 2026-09-12:宿主机 32 GB、Docker 虚拟机 1 GiB 时按宿主机算会 OOM 掉沙箱 Postgres。
  // 预算必须来自 docker info 的 MemTotal;这里锁定 1 GiB 预算只能得到下限值。
  const t = sandboxTuning(1 * GIB);
  assert.equal(pick(t.settings, "shared_buffers"), "shared_buffers=256MB");
  assert.equal(pick(t.settings, "maintenance_work_mem"), "maintenance_work_mem=256MB");
  assert.equal(t.shmSize, "1024m");
});

test("an unknown budget (docker info unavailable) falls back to the floor", () => {
  const t = sandboxTuning(0);
  assert.equal(pick(t.settings, "shared_buffers"), "shared_buffers=256MB");
  assert.equal(pick(t.settings, "maintenance_work_mem"), "maintenance_work_mem=256MB");
});

test("tiny machines never go below the floor", () => {
  const t = sandboxTuning(512 * 1024 * 1024);
  assert.equal(pick(t.settings, "shared_buffers"), "shared_buffers=256MB");
  assert.equal(pick(t.settings, "maintenance_work_mem"), "maintenance_work_mem=256MB");
});

test("the 8 GB / 2 vCPU worker restores with 2 jobs and enough /dev/shm for both", () => {
  // 生产 worker 实际值:docker info 报 8,059,232,256 字节、2 核
  const t = sandboxTuning(8_059_232_256, 2);
  assert.equal(t.restoreJobs, 2);
  assert.equal(pick(t.settings, "maintenance_work_mem"), "maintenance_work_mem=960MB");
  assert.equal(t.shmSize, "3840m");
});

test("memory, not CPU count, limits jobs on small Docker VMs", () => {
  assert.equal(sandboxTuning(4_180_131_840, 10).restoreJobs, 2, "4 GB Docker Desktop with 10 CPUs");
  assert.equal(sandboxTuning(1 * GIB, 8).restoreJobs, 1, "1 GiB VM stays single-connection");
});

test("jobs never exceed the CPU count or the cap of 4", () => {
  assert.equal(sandboxTuning(16 * GIB, 1).restoreJobs, 1);
  assert.equal(sandboxTuning(16 * GIB, 3).restoreJobs, 3);
  assert.equal(sandboxTuning(64 * GIB, 32).restoreJobs, 4);
});

test("an unknown budget or CPU count restores single-connection", () => {
  assert.equal(sandboxTuning(0, 8).restoreJobs, 1);
  assert.equal(sandboxTuning(8 * GIB, 0).restoreJobs, 1);
  assert.equal(sandboxTuning(8 * GIB).restoreJobs, 1);
});

test("durability is still switched off regardless of memory", () => {
  const t = sandboxTuning(8 * GIB);
  for (const kv of ["fsync=off", "synchronous_commit=off", "full_page_writes=off", "wal_level=minimal", "max_wal_senders=0"]) {
    assert.ok(t.settings.includes(kv), kv);
  }
});
