// 分片大小回归测试:不传 partSize 时 lib-storage 对流固定 5 MiB × 最多 10,000 片,
// 单个对象约 48.8 GiB 封顶,超过就在上传途中失败(套餐上限是每项目 100 GB)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { partSizeFor } from "../dist/part-size.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MAX_PARTS = 10_000;

test("小对象和未知体积都用 5 MiB(与 lib-storage 默认一致,小库行为不变)", () => {
  assert.equal(partSizeFor(0), 5 * MIB);
  assert.equal(partSizeFor(-1), 5 * MIB);
  assert.equal(partSizeFor(1 * GIB), 5 * MIB);
  // 5 MiB × 10,000 片恰好装满
  assert.equal(partSizeFor(5 * MIB * MAX_PARTS), 5 * MIB);
});

test("超过 5 MiB × 10,000 片就放大分片,按整 MiB 取整", () => {
  assert.equal(partSizeFor(5 * MIB * MAX_PARTS + 1), 6 * MIB);
  assert.equal(partSizeFor(200 * GIB), 21 * MIB);
});

test("任何体积都能装进 10,000 片", () => {
  for (const bytes of [49 * GIB, 100 * GIB, 200 * GIB, 1024 * GIB, 5 * 1024 * GIB]) {
    const partSize = partSizeFor(bytes);
    assert.equal(partSize % MIB, 0);
    assert.ok(Math.ceil(bytes / partSize) <= MAX_PARTS, `${bytes} bytes → ${partSize}`);
  }
});
