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
  { name: "avatars", public: false, file_size_limit: "1048576", allowed_mime_types: ["image/png"] },
  { name: "public-assets", public: true, file_size_limit: null, allowed_mime_types: null },
];
const objectRows = [
  {
    bucket_id: "avatars",
    name: "u1/pic.png",
    mimetype: "image/png",
    cache_control: "max-age=3600",
    user_metadata: { origin: "app" },
    updated_at: new Date("2026-07-23T00:00:00Z"),
  },
  {
    bucket_id: "avatars",
    name: "u2/pic.png",
    mimetype: null,
    cache_control: null,
    user_metadata: {},
    updated_at: null,
  },
];

test("bucket 属性:null 原样保留(= 源端未设置,不是猜测值);limit 归一为 number", () => {
  const { buckets } = catalogFromRows(bucketRows, []);
  assert.deepEqual(buckets, [
    { name: "avatars", public: false, fileSizeLimit: 1048576, allowedMimeTypes: ["image/png"] },
    { name: "public-assets", public: true, fileSizeLimit: null, allowedMimeTypes: null },
  ]);
});

test("文件元数据:有值才落字段;空 user_metadata 省略;Date 序列化为 ISO", () => {
  const { fileMeta } = catalogFromRows([], objectRows);
  assert.deepEqual(fileMeta.get(fileMetaKey("avatars", "u1/pic.png")), {
    contentType: "image/png",
    cacheControl: "max-age=3600",
    metadata: { origin: "app" },
    lastModified: "2026-07-23T00:00:00.000Z",
  });
  assert.deepEqual(fileMeta.get(fileMetaKey("avatars", "u2/pic.png")), {});
});

test("合并:命中的文件带上元数据,DB 查不到的文件保持原样(未捕获≠编造)", () => {
  const { fileMeta } = catalogFromRows([], objectRows);
  const files = [
    { bucket: "avatars", key: "u1/pic.png", bytes: 10, sha256: "a" },
    { bucket: "avatars", key: "ghost.png", bytes: 20, sha256: "b" },
  ];
  const merged = mergeFileMetadata(files, fileMeta);
  assert.equal(merged[0].contentType, "image/png");
  assert.equal(merged[0].metadata.origin, "app");
  assert.deepEqual(merged[1], { bucket: "avatars", key: "ghost.png", bytes: 20, sha256: "b" });
});
