// 故障注入矩阵(恢复闭环 PRD §11.4,R1 退出条件):带状态的假 Storage 服务器 +
// 故障序列注入,验证"任务显示成功但关键阶段实际失败"的假成功在每条路径上都不存在,
// 以及安全门(净度/残留哈希/可见性)都发生在任何写入之前。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { restoreStorage, planStorageRestore } from "../dist/storage-restore.js";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const REF = "faketargetproject123";
const TARGET = { supabaseUrl: `https://${REF}.supabase.co`, serviceRoleKey: "sk-test" };

/** 带状态的假 Supabase Storage:桶/对象内存态 + 按(方法,路径)的故障状态码序列。 */
class FakeStorage {
  constructor() {
    this.buckets = new Map(); // name → {public, file_size_limit, allowed_mime_types}
    this.objects = new Map(); // bucket → Map<key, Buffer>
    this.faults = []; // [{match: (method,path)=>bool, statuses: [500, ...]}]
    this.uploads = 0; // 发生过的写请求数(断言"零写入"用)
    this.foreignRequests = []; // 发往非目标源的请求(凭据泄露断言)
    this.tus = new Map(); // uploadId → {bucket, key, length, received: Buffer, meta}
  }

  bucketObjects(name) {
    if (!this.objects.has(name)) this.objects.set(name, new Map());
    return this.objects.get(name);
  }

  fault(match, ...statuses) {
    this.faults.push({ match, statuses });
  }

  #injected(method, path) {
    for (const f of this.faults) {
      if (f.match(method, path) && f.statuses.length) return f.statuses.shift();
    }
    return null;
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (url.origin !== TARGET.supabaseUrl) {
      this.foreignRequests.push(url.origin);
      return new Response("foreign", { status: 421 });
    }
    const path = url.pathname.replace(/^\/storage\/v1/, "");
    const injected = this.#injected(method, path);
    if (injected) return new Response(JSON.stringify({ error: "injected" }), { status: injected });

    // ── TUS ──
    if (method === "POST" && path === "/upload/resumable") {
      const meta = Object.fromEntries(
        (init.headers["Upload-Metadata"] ?? "").split(",").map((kv) => {
          const [k, v] = kv.trim().split(" ");
          return [k, Buffer.from(v ?? "", "base64").toString()];
        })
      );
      const id = `tus-${this.tus.size + 1}`;
      this.tus.set(id, {
        bucket: meta.bucketName,
        key: meta.objectName,
        length: Number(init.headers["Upload-Length"]),
        received: Buffer.alloc(0),
      });
      return new Response(null, {
        status: 201,
        headers: { location: `/storage/v1/upload/resumable/${id}` },
      });
    }
    const tusMatch = path.match(/^\/upload\/resumable\/(tus-\d+)$/);
    if (tusMatch) {
      const session = this.tus.get(tusMatch[1]);
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "upload-offset": String(session.received.length) },
        });
      }
      if (method === "PATCH") {
        this.uploads += 1;
        const chunk = Buffer.from(await new Response(init.body).arrayBuffer());
        assert.equal(Number(init.headers["Upload-Offset"]), session.received.length, "offset 必须对准");
        session.received = Buffer.concat([session.received, chunk]);
        if (session.received.length === session.length) {
          this.bucketObjects(session.bucket).set(session.key, session.received);
        }
        return new Response(null, {
          status: 204,
          headers: { "upload-offset": String(session.received.length) },
        });
      }
    }

    // ── 桶 ──
    const bucketGet = path.match(/^\/bucket\/([^/]+)$/);
    if (method === "GET" && bucketGet) {
      const name = decodeURIComponent(bucketGet[1]);
      const bucket = this.buckets.get(name);
      if (!bucket) return new Response(JSON.stringify({ message: "Bucket not found" }), { status: 404 });
      return new Response(JSON.stringify(bucket), { status: 200 });
    }
    if (method === "POST" && path === "/bucket") {
      this.uploads += 1;
      const body = JSON.parse(String(init.body));
      this.buckets.set(body.name, {
        public: body.public ?? false,
        file_size_limit: body.file_size_limit ?? null,
        allowed_mime_types: body.allowed_mime_types ?? null,
      });
      return new Response(JSON.stringify({ name: body.name }), { status: 200 });
    }

    // ── 对象 ──
    const listMatch = path.match(/^\/object\/list\/([^/]+)$/);
    if (method === "POST" && listMatch) {
      const { prefix, offset } = JSON.parse(String(init.body));
      const stored = this.bucketObjects(decodeURIComponent(listMatch[1]));
      // 目录级列举:返回 prefix 下的直接子项(文件带 metadata,目录 id=null)
      const children = new Map();
      for (const [key, buf] of stored) {
        if (prefix && !key.startsWith(`${prefix}/`)) continue;
        const rest = prefix ? key.slice(prefix.length + 1) : key;
        const slash = rest.indexOf("/");
        if (slash === -1) children.set(rest, { name: rest, id: key, metadata: { size: buf.length } });
        else if (!children.has(rest.slice(0, slash)))
          children.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null, metadata: null });
      }
      return new Response(JSON.stringify([...children.values()].slice(offset ?? 0)), { status: 200 });
    }
    const objMatch = path.match(/^\/object\/([^/]+)\/(.+)$/);
    if (objMatch) {
      const bucket = decodeURIComponent(objMatch[1]);
      const key = objMatch[2].split("/").map(decodeURIComponent).join("/");
      if (method === "GET") {
        const buf = this.bucketObjects(bucket).get(key);
        if (!buf) return new Response("no such object", { status: 404 });
        return new Response(Uint8Array.from(buf), { status: 200 });
      }
      if (method === "POST") {
        this.uploads += 1;
        const buf = Buffer.from(await new Response(init.body).arrayBuffer());
        if (this.bucketObjects(bucket).has(key)) {
          return new Response(JSON.stringify({ error: "Duplicate" }), { status: 409 });
        }
        this.bucketObjects(bucket).set(key, buf);
        return new Response(JSON.stringify({ Key: `${bucket}/${key}` }), { status: 200 });
      }
    }
    return new Response(`unhandled ${method} ${path}`, { status: 500 });
  };
}

/** 假 S3 源:manifest 对象布局 <base>/storage/<bucket>/<key>,支持 Range。 */
function fakeSource(files) {
  const store = new Map();
  for (const f of files) store.set(`base/storage/${f.bucket}/${f.key}`, f.body);
  return {
    s3: {
      send: async (cmd) => {
        const buf = store.get(cmd.input.Key);
        if (!buf) throw new Error(`no such source object: ${cmd.input.Key}`);
        let slice = buf;
        const range = cmd.input.Range?.match(/bytes=(\d+)-(\d+)/);
        if (range) slice = buf.subarray(Number(range[1]), Number(range[2]) + 1);
        return { Body: Readable.from(slice) };
      },
    },
    bucket: "backups",
    base: "base",
  };
}

function makeManifest(files, buckets) {
  return {
    schemaVersion: 2,
    tool: "backupdrill-cli",
    toolVersion: "2.0.0",
    createdAt: "2026-07-25T00:00:00.000Z",
    projectName: "faults",
    database: {
      serverVersion: "17.6",
      pgDumpVersion: "pg_dump (PostgreSQL) 18.4",
      schemas: ["public"],
      tableCount: 0,
      estimatedRowTotal: 0,
      tables: [],
      extensions: [],
    },
    dump: { key: "base/dump.pgcustom", format: "custom", bytes: 1, sha256: "x" },
    storage: {
      buckets,
      fileCount: files.length,
      totalBytes: files.reduce((n, f) => n + f.body.length, 0),
      files: files.map((f) => ({
        bucket: f.bucket,
        key: f.key,
        bytes: f.body.length,
        sha256: sha256(f.body),
        contentType: "text/plain",
      })),
    },
  };
}

const FILES = [
  { bucket: "docs", key: "a.txt", body: Buffer.from("alpha") },
  { bucket: "docs", key: "nested/b.txt", body: Buffer.from("bravo-longer") },
];
const BUCKETS = [{ name: "docs", public: false, fileSizeLimit: null, allowedMimeTypes: null }];

let fake;
const realFetch = globalThis.fetch;
beforeEach(() => {
  fake = new FakeStorage();
  globalThis.fetch = fake.fetch;
  delete process.env.BACKUPDRILL_TUS_THRESHOLD;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BACKUPDRILL_TUS_THRESHOLD;
});

test("故障注入:上传首击 429 → 有界重试后成功,retries 计数,全量对账+校验和通过", async () => {
  fake.fault((m, p) => m === "POST" && p === "/object/docs/a.txt", 429);
  const summary = await restoreStorage(fakeSource(FILES), TARGET, makeManifest(FILES, BUCKETS));
  assert.equal(summary.filesUploaded, 2);
  assert.equal(summary.filesFailed.length, 0);
  assert.ok(summary.retries >= 1, "429 重试必须计数");
  assert.equal(summary.reconcile.matches, true);
  assert.equal(summary.checksumSample.mismatched.length, 0);
});

test("故障注入:单文件持续 5xx → 该文件失败但不中断其余;对账如实报缺失", async () => {
  fake.fault((m, p) => m === "POST" && p === "/object/docs/a.txt", 500, 500, 500, 500);
  const summary = await restoreStorage(fakeSource(FILES), TARGET, makeManifest(FILES, BUCKETS));
  assert.equal(summary.filesUploaded, 1, "另一个文件必须照常上传");
  assert.equal(summary.filesFailed.length, 1);
  assert.match(summary.filesFailed[0].file, /a\.txt/);
  assert.equal(summary.reconcile.matches, false, "缺文件不得报干净对账");
  assert.deepEqual(summary.reconcile.missing, ["docs/a.txt"]);
});

test("净度门:既有桶里的外来对象 → 计划阶段整体拒绝,零写请求发生", async () => {
  fake.buckets.set("docs", { public: false, file_size_limit: null, allowed_mime_types: null });
  fake.bucketObjects("docs").set("foreign.bin", Buffer.from("xxx"));
  await assert.rejects(
    () => restoreStorage(fakeSource(FILES), TARGET, makeManifest(FILES, BUCKETS)),
    /not clean.*foreign\.bin/s
  );
  assert.equal(fake.uploads, 0, "拒绝必须发生在任何写入之前");
});

test("残留哈希:同尺寸但字节不同 → 计划阶段拒绝,零写请求", async () => {
  fake.buckets.set("docs", { public: false, file_size_limit: null, allowed_mime_types: null });
  fake.bucketObjects("docs").set("a.txt", Buffer.from("alphX")); // 同长度,不同内容
  await assert.rejects(
    () => restoreStorage(fakeSource(FILES), TARGET, makeManifest(FILES, BUCKETS)),
    /residue.*differs/s
  );
  assert.equal(fake.uploads, 0);
});

test("残留哈希:字节一致 → 跳过重传,其余照常;结果仍全量对账", async () => {
  fake.buckets.set("docs", { public: false, file_size_limit: null, allowed_mime_types: null });
  fake.bucketObjects("docs").set("a.txt", Buffer.from("alpha"));
  const summary = await restoreStorage(fakeSource(FILES), TARGET, makeManifest(FILES, BUCKETS));
  assert.equal(summary.filesSkippedIdentical, 1);
  assert.equal(summary.filesUploaded, 1);
  assert.equal(summary.reconcile.matches, true);
});

test("可见性安全门:manifest 记私有、既有桶公开 → 计划阶段拒绝(planStorageRestore 同口径)", async () => {
  fake.buckets.set("docs", { public: true, file_size_limit: null, allowed_mime_types: null });
  await assert.rejects(
    () => planStorageRestore(TARGET, makeManifest(FILES, BUCKETS)),
    /PUBLIC|PRIVATE/
  );
  assert.equal(fake.uploads, 0);
});

test("TUS 全链路(阈值压到 1):分块 PATCH、offset 对准、落桶字节与校验和一致", async () => {
  process.env.BACKUPDRILL_TUS_THRESHOLD = "1";
  const summary = await restoreStorage(fakeSource(FILES), TARGET, makeManifest(FILES, BUCKETS));
  assert.equal(summary.filesUploaded, 2);
  assert.equal(summary.filesFailed.length, 0);
  assert.equal(summary.checksumSample.mismatched.length, 0, "TUS 落桶字节必须与 manifest 一致");
  assert.equal(fake.foreignRequests.length, 0, "凭据只发往目标源");
});

test("凭据边界:任何请求都不发往目标源之外(含 TUS Location)", async () => {
  process.env.BACKUPDRILL_TUS_THRESHOLD = "1";
  await restoreStorage(fakeSource(FILES), TARGET, makeManifest(FILES, BUCKETS));
  assert.deepEqual(fake.foreignRequests, []);
});
