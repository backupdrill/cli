import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketAttrsFromRows } from "../dist/storage-catalog.js";

// 行形状与真实 Supabase 一致(R0 spike 对 storage.buckets 的实测):
// 未设置的 bucket 限额是 NULL;file_size_limit 经 pg 驱动可能是 string。
const bucketRows = [
  { id: "avatars", name: "avatars", public: false, file_size_limit: "1048576", allowed_mime_types: ["image/png"] },
  { id: "public-assets", name: "public-assets", public: true, file_size_limit: null, allowed_mime_types: null },
];

test("bucket 属性:null 原样保留(= 源端未设置,不是猜测值);limit 归一为 number", () => {
  assert.deepEqual(bucketAttrsFromRows(["avatars", "public-assets"], bucketRows), [
    { name: "avatars", public: false, fileSizeLimit: 1048576, allowedMimeTypes: ["image/png"] },
    { name: "public-assets", public: true, fileSizeLimit: null, allowedMimeTypes: null },
  ]);
});

test("完整性关口:任一请求的 bucket 没有返回行(RLS 静默过滤/并发删除)→ 整体拒绝", () => {
  assert.throws(
    () => bucketAttrsFromRows(["avatars", "invisible"], bucketRows),
    /no row for: invisible.*partial bucket capture/s
  );
  // 零行(权限全无)同样拒绝,不得把"看不见"当成"没有"
  assert.throws(() => bucketAttrsFromRows(["avatars"], []), /no row for: avatars/);
});

test("id 与 name 不同的 bucket:按 id 匹配请求标识(objects.bucket_id 外键指向 id)", () => {
  const rows = [
    { id: "bkt_123", name: "Avatars(display)", public: false, file_size_limit: null, allowed_mime_types: null },
  ];
  const attrs = bucketAttrsFromRows(["bkt_123"], rows);
  assert.equal(attrs[0].name, "bkt_123"); // manifest 用 S3 层标识,恢复端按它重建
  assert.equal(attrs[0].public, false);
});
