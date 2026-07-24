import { test } from "node:test";
import assert from "node:assert/strict";
import { fileMetadataFromS3 } from "../dist/storage.js";

// Supabase S3 handler 把 content-type/cache-control/x-amz-meta-* 直接从
// storage.objects.metadata/user_metadata 取出(源码实证 2026-07-24)——
// 这里钉住的是"响应字段 → manifest 字段"的提取层。

test("完整响应:五个可恢复字段全部提取,Date 序列化为 ISO", () => {
  assert.deepEqual(
    fileMetadataFromS3({
      ContentType: "image/png",
      CacheControl: "max-age=3600",
      ContentEncoding: "gzip",
      Metadata: { origin: "app" },
      LastModified: new Date("2026-07-24T00:00:00Z"),
    }),
    {
      contentType: "image/png",
      cacheControl: "max-age=3600",
      contentEncoding: "gzip",
      metadata: { origin: "app" },
      lastModified: "2026-07-24T00:00:00.000Z",
    }
  );
});

test("头缺席就不落字段(= 未捕获,不猜测);空 Metadata 省略", () => {
  assert.deepEqual(fileMetadataFromS3({}), {});
  assert.deepEqual(fileMetadataFromS3({ Metadata: {} }), {});
  assert.deepEqual(fileMetadataFromS3({ ContentType: "text/plain" }), { contentType: "text/plain" });
});

test("MissingMeta > 0:服务端自认头集残缺 → 整个 metadata 字段省略(不写自知残缺的数据)", () => {
  assert.deepEqual(
    fileMetadataFromS3({ Metadata: { origin: "app" }, MissingMeta: 1 }),
    {}
  );
  // MissingMeta 为 0 时正常捕获
  assert.deepEqual(
    fileMetadataFromS3({ Metadata: { origin: "app" }, MissingMeta: 0 }),
    { metadata: { origin: "app" } }
  );
});
