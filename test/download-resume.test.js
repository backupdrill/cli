import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { downloadToFile, writeFully } from "../dist/snapshots.js";

// 2026-09-12:12 GB dump 单条 HTTPS 流第 10 分钟被对端关掉,整次演练报废、无续传。
// 这里用本地假桶 + 真 SDK 复现"半路掐断"并验证按 Range 续传后字节与哈希都对。

const DATA = randomBytes(1_500_000);
const SHA = createHash("sha256").update(DATA).digest("hex");
const ETAG = '"etag-1"';

/** 假桶:按 scenario 决定第一次请求怎么坏。记录每次请求的 Range 头。 */
function fakeBucket(scenario) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range ?? null });
    const n = requests.length;
    if (scenario === "404") {
      res.writeHead(404, { "content-type": "application/xml" });
      res.end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    const range = req.headers.range;
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)[1]);
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-length": String(DATA.length - start),
        "content-range": `bytes ${start}-${DATA.length - 1}/${DATA.length}`,
        "accept-ranges": "bytes",
        etag: ETAG,
      });
      res.end(DATA.subarray(start));
      return;
    }
    // 200 全量(首次)
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(DATA.length),
      "accept-ranges": "bytes",
      etag: ETAG,
    });
    if (scenario === "cut-first" && n === 1) {
      // 发 400 KB 就把连接掐掉:客户端拿到的是一个前缀(多少取决于 TCP 缓冲),然后 "aborted"
      res.write(DATA.subarray(0, 400_000), () => res.socket.destroy());
      return;
    }
    res.end(DATA);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const s3 = new S3Client({
        region: "us-east-1",
        endpoint: `http://127.0.0.1:${port}`,
        forcePathStyle: true,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        maxAttempts: 1, // SDK 自己的重试关掉:本测试验证的是我们的流级续传
      });
      resolve({ s3, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "bd-resume-"));

test("半路掐断 → 从已落盘字节续传(206),最终字节与 sha256 与源一致", async () => {
  const b = await fakeBucket("cut-first");
  try {
    const dest = join(dir, "cut.bin");
    const r = await downloadToFile(b.s3, "bucket", "dump", dest, { maxAttempts: 4 });
    assert.equal(r.bytes, DATA.length);
    assert.equal(r.sha256, SHA, "hash must cover exactly the bytes on disk");
    assert.equal(statSync(dest).size, DATA.length);
    assert.ok(readFileSync(dest).equals(DATA), "file content must equal the source byte-for-byte");
    assert.equal(b.requests.length, 2, "one cut, one resume");
    assert.equal(b.requests[0].range, null);
    const start = Number(/bytes=(\d+)-/.exec(b.requests[1].range)[1]);
    assert.ok(start > 0 && start <= 400_000, `resume must start inside the delivered prefix, got ${start}`);
  } finally {
    await b.close();
  }
});

test("对端不认 Range、续传时回 200 全量 → 拒绝追加(否则文件变脏),报错且不再重试", async () => {
  // 第一次 200 发一半掐断 → 触发续传;第二次无视 Range 回 200 全量
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers.range ?? null);
    res.writeHead(200, {
      "content-length": String(DATA.length),
      "accept-ranges": "bytes",
      etag: ETAG,
    });
    if (requests.length === 1) {
      res.write(DATA.subarray(0, 300_000), () => res.socket.destroy());
      return;
    }
    res.end(DATA); // 第二次:无视 Range,回 200 全量
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const s3 = new S3Client({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "t", secretAccessKey: "t" },
    maxAttempts: 1,
  });
  try {
    const dest = join(dir, "ignore.bin");
    await assert.rejects(
      downloadToFile(s3, "bucket", "dump", dest, { maxAttempts: 4 }),
      /resume rejected: expected 206/
    );
    assert.equal(requests.length, 2, "must not keep retrying after a rejected resume");
    assert.ok(statSync(dest).size < DATA.length, "nothing from the 200 body may be appended");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("ETag 在续传时变了(对象被替换)→ 拒绝拼接", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers.range ?? null);
    if (requests.length === 1) {
      res.writeHead(200, { "content-length": String(DATA.length), "accept-ranges": "bytes", etag: ETAG });
      res.write(DATA.subarray(0, 200_000), () => res.socket.destroy());
      return;
    }
    const start = Number(/bytes=(\d+)-/.exec(req.headers.range)[1]);
    res.writeHead(206, {
      "content-length": String(DATA.length - start),
      "content-range": `bytes ${start}-${DATA.length - 1}/${DATA.length}`,
      etag: '"etag-2"',
    });
    res.end(DATA.subarray(start));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const s3 = new S3Client({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "t", secretAccessKey: "t" },
    maxAttempts: 1,
  });
  try {
    await assert.rejects(
      downloadToFile(s3, "bucket", "dump", join(dir, "etag.bin"), { maxAttempts: 4 }),
      /object changed during download/
    );
    assert.equal(requests.length, 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("404 是事实不是故障:立刻抛,不重试", async () => {
  const b = await fakeBucket("404");
  try {
    await assert.rejects(downloadToFile(b.s3, "bucket", "missing", join(dir, "404.bin"), { maxAttempts: 4 }));
    assert.equal(b.requests.length, 1, "no retry on 404");
  } finally {
    await b.close();
  }
});

// ── 短写 / 半块出错 / 慢写竞态(交叉审查 2026-09-12)──────────────────────────

/** 假句柄:每次只写 `step` 字节;可在写到第 `failAt` 字节后抛错;可加延迟。 */
function fakeHandle({ step = 3, failAt = Infinity, delayMs = 0 } = {}) {
  const chunks = [];
  let size = 0;
  return {
    calls: 0,
    chunks,
    get size() { return size; },
    async write(buffer, offset, length, position) {
      this.calls += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const n = Math.min(step, length);
      if (position + n > failAt) throw new Error("disk full (injected)");
      chunks.push(buffer.subarray(offset, offset + n));
      size = Math.max(size, position + n);
      return { bytesWritten: n };
    },
    async close() {},
  };
}

test("writeFully:一次只写 3 字节的句柄也要写满整块,返回真正落盘的字节数", async () => {
  const fh = fakeHandle({ step: 3 });
  const n = await writeFully(fh, Buffer.from("ABCDEFGH"), 0);
  assert.equal(n, 8);
  assert.equal(fh.calls, 3, "8 bytes at 3 per write = 3 calls");
  assert.equal(Buffer.concat(fh.chunks).toString(), "ABCDEFGH");
});

test("writeFully:半块出错时把已确认字节数挂在错误上(哈希/起点据此对齐磁盘)", async () => {
  const fh = fakeHandle({ step: 3, failAt: 6 });
  await assert.rejects(writeFully(fh, Buffer.from("ABCDEFGH"), 0), (err) => {
    assert.match(err.message, /disk full/);
    assert.equal(err.confirmedBytes, 6);
    return true;
  });
});

test("短写句柄 + 半路掐断 + 续传:哈希与字节仍与源逐字一致(校验和只盖真落盘的字节)", async () => {
  const b = await fakeBucket("cut-first");
  const fh = fakeHandle({ step: 7919 }); // 素数步长,保证块边界与写边界错开
  try {
    const r = await downloadToFile(b.s3, "bucket", "dump", "/dev/null", {
      maxAttempts: 4,
      openFile: async () => fh,
    });
    assert.equal(r.bytes, DATA.length);
    assert.equal(r.sha256, SHA);
    assert.ok(Buffer.concat(fh.chunks).equals(DATA));
    const start = Number(/bytes=(\d+)-/.exec(b.requests[1].range)[1]);
    // 起点是已确认的**完整块**边界(每个网络 chunk 写满才计数),落在送达的前缀之内;
    // "没洞没重叠"由上面 Buffer.concat(...).equals(DATA) 证明
    assert.ok(start > 0 && start <= 400_000, `resume offset must be a confirmed byte count inside the prefix, got ${start}`);
  } finally {
    await b.close();
  }
});

test("慢磁盘竞态:源先断、上一块的写还在途 → 重试前等它落定,续传起点 = 磁盘字节数", async () => {
  const b = await fakeBucket("cut-first");
  // 每次写延迟 150ms:pipeline 会在最后一块还没写完时就因源断而 reject
  const fh = fakeHandle({ step: 1 << 20, delayMs: 150 });
  try {
    const r = await downloadToFile(b.s3, "bucket", "dump", "/dev/null", {
      maxAttempts: 4,
      openFile: async () => fh,
    });
    assert.equal(r.bytes, DATA.length);
    assert.equal(r.sha256, SHA);
    assert.ok(Buffer.concat(fh.chunks).equals(DATA), "no hole, no overlap");
    const start = Number(/bytes=(\d+)-/.exec(b.requests[1].range)[1]);
    // 第二次请求的 Range 起点必须等于当时磁盘上真有的字节数——用最终文件反推:
    // 所有块拼起来正好等于源,说明起点没错位(错位会留下洞或重叠,equals 就会失败)
    assert.ok(start > 0);
  } finally {
    await b.close();
  }
});

test("404 时不碰目标文件:已有内容原样保留(不再先截断再失败)", async () => {
  const b = await fakeBucket("404");
  const dest = join(dir, "keep-me.bin");
  writeFileSync(dest, "precious");
  try {
    await assert.rejects(downloadToFile(b.s3, "bucket", "missing", dest, { maxAttempts: 2 }));
    assert.equal(readFileSync(dest, "utf8"), "precious", "a failed request must not truncate the destination");
  } finally {
    await b.close();
  }
});

test("重试耗尽:句柄在在途写落定之后才关闭,慢写不会撞上已关闭的 fd", async () => {
  // 每次都掐断 → 用完 2 次尝试后终态失败;写延迟 150ms 保证失败时有一块还在途
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers.range ?? null);
    res.writeHead(requests.length === 1 ? 200 : 206, {
      "content-length": String(DATA.length - (requests.length === 1 ? 0 : 100_000)),
      ...(requests.length > 1 ? { "content-range": `bytes 100000-${DATA.length - 1}/${DATA.length}` } : {}),
      "accept-ranges": "bytes",
      etag: ETAG,
    });
    res.write(DATA.subarray(0, 100_000), () => res.socket.destroy());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const s3 = new S3Client({
    region: "us-east-1", endpoint: `http://127.0.0.1:${port}`, forcePathStyle: true,
    credentials: { accessKeyId: "t", secretAccessKey: "t" }, maxAttempts: 1,
  });
  let closedAt = null, lastWriteDoneAt = null;
  const fh = fakeHandle({ step: 1 << 20, delayMs: 150 });
  const origWrite = fh.write.bind(fh), origClose = fh.close.bind(fh);
  fh.write = async (...a) => { const r = await origWrite(...a); lastWriteDoneAt = Date.now(); return r; };
  fh.close = async () => { closedAt = Date.now(); return origClose(); };
  try {
    await assert.rejects(
      downloadToFile(s3, "bucket", "dump", "/dev/null", { maxAttempts: 2, openFile: async () => fh })
    );
    assert.ok(closedAt !== null, "handle must be closed on terminal failure");
    assert.ok(lastWriteDoneAt !== null && lastWriteDoneAt <= closedAt, "close must come after the last in-flight write settled");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
