// 测试用的内存假桶:真 SDK(path-style)走真 HTTP 打进来。只实现 exporter 和 drill --record
// 用到的四样:ListObjectsV2(带 delimiter 和分页)、GetObject(带 If-None-Match)、PutObject、
// 以及按需注入的故障。文件名不带 .test,node --test test/*.test.js 不会把它当测试跑。
import http from "node:http";
import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";

const xmlEscape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * opts.pageSize:每页最多多少条(CommonPrefixes + Contents 合计),用来测分页。
 * 返回 { s3, endpoint, objects, requests, fail, close }:
 *  - objects:Map<key, Buffer>,测试直接往里放对象
 *  - requests:每个请求的 { method, key, query, ifNoneMatch }
 *  - fail(fn):fn(req) 返回 { status, code } 时按它回错误;返回 "hang" 时不回应
 */
export async function startFakeS3({ bucket = "backups", pageSize = 1000 } = {}) {
  const objects = new Map();
  const requests = [];
  let failWith = null;
  const etagOf = (body) => `"${createHash("md5").update(body).digest("hex")}"`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const [, reqBucket, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    const record = {
      method: req.method,
      key,
      query: Object.fromEntries(url.searchParams),
      ifNoneMatch: req.headers["if-none-match"] ?? null,
    };
    requests.push(record);

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const injected = failWith?.(record);
      if (injected === "hang") return; // 不回应,等客户端自己放弃
      if (injected) {
        res.writeHead(injected.status, { "content-type": "application/xml", ...(injected.headers ?? {}) });
        res.end(`<Error><Code>${injected.code}</Code><Message>${injected.code}</Message></Error>`);
        return;
      }
      if (reqBucket !== bucket) {
        res.writeHead(404, { "content-type": "application/xml" });
        res.end("<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>");
        return;
      }

      if (req.method === "GET" && !key && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const delimiter = url.searchParams.get("delimiter");
        const start = Number(url.searchParams.get("continuation-token") ?? 0);
        const entries = new Map(); // 排好序的 CommonPrefixes 和 Contents
        for (const k of [...objects.keys()].sort()) {
          if (!k.startsWith(prefix)) continue;
          const tail = k.slice(prefix.length);
          const cut = delimiter ? tail.indexOf(delimiter) : -1;
          if (cut >= 0) entries.set(prefix + tail.slice(0, cut + 1), "prefix");
          else entries.set(k, "object");
        }
        const all = [...entries.entries()];
        const page = all.slice(start, start + pageSize);
        const truncated = start + pageSize < all.length;
        const body =
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
          `<Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
          `<MaxKeys>${pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : "") +
          page
            .map(([k, kind]) =>
              kind === "prefix"
                ? `<CommonPrefixes><Prefix>${xmlEscape(k)}</Prefix></CommonPrefixes>`
                : `<Contents><Key>${xmlEscape(k)}</Key><Size>${objects.get(k).length}</Size></Contents>`
            )
            .join("") +
          `</ListBucketResult>`;
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(body);
        return;
      }

      if (req.method === "GET" && key) {
        const body = objects.get(key);
        if (!body) {
          res.writeHead(404, { "content-type": "application/xml" });
          res.end("<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>");
          return;
        }
        const etag = etagOf(body);
        if (record.ifNoneMatch === etag) {
          res.writeHead(304, { etag });
          res.end();
          return;
        }
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(body.length),
          etag,
        });
        res.end(body);
        return;
      }

      if (req.method === "PUT" && key) {
        const body = Buffer.concat(chunks);
        objects.set(key, body);
        res.writeHead(200, { etag: etagOf(body) });
        res.end();
        return;
      }

      res.writeHead(400, { "content-type": "application/xml" });
      res.end("<Error><Code>BadRequest</Code><Message>not implemented in fake</Message></Error>");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const s3 = new S3Client({
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
  });
  return {
    s3,
    endpoint,
    bucket,
    objects,
    requests,
    fail(fn) {
      failWith = fn;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** 一份能过 parseManifest 的 manifest,overrides 覆盖顶层字段 */
export function manifestJson({ snapshot, createdAt, dumpBytes = 4096, storage = null, rows = 500 }) {
  return JSON.stringify({
    schemaVersion: 2,
    tool: "backupdrill-cli",
    toolVersion: "2.4.0",
    createdAt,
    projectName: "my-app",
    database: {
      serverVersion: "17.2",
      pgDumpVersion: "pg_dump (PostgreSQL) 17.2",
      schemas: ["public"],
      tableCount: 2,
      estimatedRowTotal: rows,
      tables: [
        { schema: "public", name: "orders", estimatedRows: rows - 20 },
        { schema: "public", name: "users", estimatedRows: 20 },
      ],
    },
    dump: {
      key: `backupdrill/my-app/${snapshot}/dump.pgcustom`,
      format: "custom",
      bytes: dumpBytes,
      sha256: "0".repeat(64),
    },
    storage,
  });
}
