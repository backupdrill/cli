import { test } from "node:test";
import assert from "node:assert/strict";
import {
  catalogFromRows,
  mergeFileMetadata,
  fileMetaKey,
} from "../dist/storage-catalog.js";

// 行形状与真实 Supabase 一致(R0 spike 对 storage.buckets/objects 的实测):
// 未设置的 bucket 限额是 NULL;file_size_limit 经 pg 驱动可能是 string。
const bucketRows = [
  { id: "avatars", name: "avatars", public: false, file_size_limit: "1048576", allowed_mime_types: ["image/png"] },
  { id: "public-assets", name: "public-assets", public: true, file_size_limit: null, allowed_mime_types: null },
];
const allBuckets = ["avatars", "public-assets"];
const objectRows = [
  {
    bucket_id: "avatars",
    name: "u1/pic.png",
    mimetype: "image/png",
    cache_control: "max-age=3600",
    content_encoding: null,
    user_metadata: { origin: "app" },
    updated_at: new Date("2026-07-23T00:00:00Z"),
  },
  {
    bucket_id: "avatars",
    name: "u2/pic.png",
    mimetype: null,
    cache_control: null,
    content_encoding: null,
    user_metadata: {},
    updated_at: null,
  },
  {
    bucket_id: "public-assets",
    name: "bundle.js.gz",
    mimetype: "application/javascript",
    cache_control: null,
    content_encoding: "gzip",
    // user_metadata 是原样 JSON,值可以嵌套——恢复经 x-metadata 头整体回写,不拍平
    user_metadata: { build: { commit: "abc", pipeline: 7 } },
    updated_at: null,
  },
];

test("bucket 属性:null 原样保留(= 源端未设置,不是猜测值);limit 归一为 number", () => {
  const { buckets } = catalogFromRows(allBuckets, bucketRows, []);
  // 注意:期望里没有 id —— BucketAttrs 是 manifest 持久字段集,DB 内部 id 不入档
  assert.deepEqual(buckets, [
    { name: "avatars", public: false, fileSizeLimit: 1048576, allowedMimeTypes: ["image/png"] },
    { name: "public-assets", public: true, fileSizeLimit: null, allowedMimeTypes: null },
  ]);
});

test("完整性关口:任一请求的 bucket 没有返回行(RLS 静默过滤/并发删除)→ 整体拒绝", () => {
  assert.throws(
    () => catalogFromRows(["avatars", "public-assets", "invisible"], bucketRows, []),
    /no row for: invisible.*partial bucket capture/s
  );
  // 零行(权限全无)同样拒绝,不得把"看不见"当成"没有"
  assert.throws(() => catalogFromRows(["avatars"], [], []), /no row for: avatars/);
});

test("文件元数据:有值才落字段;空 user_metadata 省略;Date 序列化为 ISO", () => {
  const { fileMeta } = catalogFromRows(allBuckets, bucketRows, objectRows);
  assert.deepEqual(fileMeta.get(fileMetaKey("avatars", "u1/pic.png")), {
    contentType: "image/png",
    cacheControl: "max-age=3600",
    metadata: { origin: "app" },
    lastModified: "2026-07-23T00:00:00.000Z",
  });
  assert.deepEqual(fileMeta.get(fileMetaKey("avatars", "u2/pic.png")), {});
});

test("contentEncoding 捕获;嵌套 user_metadata 原样保留", () => {
  const { fileMeta } = catalogFromRows(allBuckets, bucketRows, objectRows);
  assert.deepEqual(fileMeta.get(fileMetaKey("public-assets", "bundle.js.gz")), {
    contentType: "application/javascript",
    contentEncoding: "gzip",
    metadata: { build: { commit: "abc", pipeline: 7 } },
  });
});

test("合并:命中的文件带上元数据,DB 查不到的文件保持原样(未捕获≠编造)", () => {
  const { fileMeta } = catalogFromRows(allBuckets, bucketRows, objectRows);
  const files = [
    { bucket: "avatars", key: "u1/pic.png", bytes: 10, sha256: "a" },
    { bucket: "avatars", key: "ghost.png", bytes: 20, sha256: "b" },
  ];
  const merged = mergeFileMetadata(files, fileMeta);
  assert.equal(merged[0].contentType, "image/png");
  assert.equal(merged[0].metadata.origin, "app");
  assert.deepEqual(merged[1], { bucket: "avatars", key: "ghost.png", bytes: 20, sha256: "b" });
});

test("id 与 name 不同的 bucket:按 id 匹配请求标识,对象元数据经 id 回映不丢失", () => {
  const rows = [
    { id: "bkt_123", name: "Avatars(display)", public: false, file_size_limit: null, allowed_mime_types: null },
  ];
  const objects = [
    {
      bucket_id: "bkt_123",
      name: "pic.png",
      mimetype: "image/png",
      cache_control: null,
      content_encoding: null,
      user_metadata: null,
      updated_at: null,
    },
  ];
  // S3 层同步时看到的标识是 id("bkt_123")——manifest 用它,属性来自匹配行
  const { buckets, fileMeta } = catalogFromRows(["bkt_123"], rows, objects);
  assert.equal(buckets[0].name, "bkt_123");
  assert.equal(buckets[0].public, false);
  assert.equal(fileMeta.get(fileMetaKey("bkt_123", "pic.png")).contentType, "image/png");
});

test("user_metadata 是任意 JSON:非对象根(数组/字符串)省略 = 未捕获,不得毒化 manifest", () => {
  const objects = [
    { bucket_id: "avatars", name: "arr.txt", mimetype: null, cache_control: null, content_encoding: null, user_metadata: ["x"], updated_at: null },
    { bucket_id: "avatars", name: "str.txt", mimetype: null, cache_control: null, content_encoding: null, user_metadata: "oops", updated_at: null },
  ];
  const { fileMeta } = catalogFromRows(allBuckets, bucketRows, objects);
  assert.deepEqual(fileMeta.get(fileMetaKey("avatars", "arr.txt")), {});
  assert.deepEqual(fileMeta.get(fileMetaKey("avatars", "str.txt")), {});
});
