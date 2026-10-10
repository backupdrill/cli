// 分片大小回归测试:不传 partSize 时 lib-storage 对流固定 5 MiB × 最多 10,000 片,
// 单个对象约 48.8 GiB 封顶,超过就在上传途中失败(套餐上限是每项目 100 GB)。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { partSizeFor } from "../dist/part-size.js";
import { syncStorage } from "../dist/storage.js";

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

// 接线回归:上面只测算术,把 Upload 的 partSize 删掉也照样绿。这里让源端声称
// 一个 60 GiB 的文件,看 syncStorage 交给 Upload 的分片是不是按长度放大了。
// 真发 60 GiB 不现实,所以给 S3 send 和 Upload.done 打桩。
async function partSizesUsedBySyncStorage(contentLength) {
  const send = mock.method(S3Client.prototype, "send", async (command) => {
    if (command instanceof ListObjectsV2Command) {
      return { Contents: [{ Key: "big.bin", Size: 60 * GIB }], IsTruncated: false };
    }
    if (command instanceof GetObjectCommand) {
      return { ContentLength: contentLength, Body: Readable.from([Buffer.from("x")]) };
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
  const partSizes = [];
  const done = mock.method(Upload.prototype, "done", async function () {
    partSizes.push(this.partSize);
    for await (const _chunk of this.params.Body); // 把流读完,syncStorage 的 pipeline 才会结束
    return {};
  });
  try {
    const client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "k", secretAccessKey: "s" } });
    await syncStorage(
      { endpoint: "http://127.0.0.1:1", region: "us-east-1", accessKeyId: "k", secretAccessKey: "s", buckets: ["b"] },
      { client, bucket: "target", base: "snap" }
    );
  } finally {
    send.mock.restore();
    done.mock.restore();
  }
  return partSizes;
}

test("Storage 拷贝按 GET 的 Content-Length 放大分片", async () => {
  assert.deepEqual(await partSizesUsedBySyncStorage(60 * GIB), [partSizeFor(60 * GIB)]);
  assert.ok(partSizeFor(60 * GIB) > 5 * MIB);
});

test("GET 没给长度时退回列表里的 Size", async () => {
  assert.deepEqual(await partSizesUsedBySyncStorage(undefined), [partSizeFor(60 * GIB)]);
});
