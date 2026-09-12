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

test("durability is still switched off regardless of memory", () => {
  const t = sandboxTuning(8 * GIB);
  for (const kv of ["fsync=off", "synchronous_commit=off", "full_page_writes=off", "wal_level=minimal", "max_wal_senders=0"]) {
    assert.ok(t.settings.includes(kv), kv);
  }
});
