// 真跑 CLI 的成功和"跑完了但没通过"两条路:backup 成功发 success、ping 服务挂了退出码照样是 0,
// drill 校验没过发 /fail。桶用一个内存里的假 S3(只实现这两条路用到的 PUT / GET / ListObjectsV2);
// backup 还要一个真 Postgres,没有 Docker 或 pg_dump 就跳过这两条,和 drill.test.js 一样。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const x = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const BUCKET = "outcomes";
const UUID = "0a9b8c7d-1111-4222-8333-944455556666";

// 顶层 await 必须放在注册任何 test 之前:否则第一条测试跑完、后面的还没注册时,
// 运行器会以为没有测试了,先跑 after() 把假服务关掉,后面那条就连不上(实际踩过)
async function available(cmd, args) {
  try {
    await x(cmd, args);
    return true;
  } catch {
    return false;
  }
}
const pgDump = process.env.BACKUPDRILL_PG_DUMP || "pg_dump";
const canRun = (await available("docker", ["version"])) && (await available(pgDump, ["--version"]));

// ── 假 S3:对象存在 Map 里 ─────────────────────────────────────────────────

const objects = new Map();
let s3;
let s3Endpoint;

function listXml(prefix, delimiter) {
  const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  const common = new Set();
  const contents = [];
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    const cut = delimiter ? rest.indexOf(delimiter) : -1;
    if (cut >= 0) common.add(prefix + rest.slice(0, cut + 1));
    else contents.push(key);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    `<Name>${BUCKET}</Name><Prefix>${prefix}</Prefix><KeyCount>${common.size + contents.length}</KeyCount>` +
    `<MaxKeys>1000</MaxKeys><Delimiter>${delimiter ?? ""}</Delimiter><IsTruncated>false</IsTruncated>` +
    contents.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k).length}</Size></Contents>`).join("") +
    [...common].map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("") +
    "</ListBucketResult>"
  );
}

// ── 假 Healthchecks:记下每个 ping ─────────────────────────────────────────

let hc;
let hcBase;
let pings = [];

before(async () => {
  s3 = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const key = decodeURIComponent(url.pathname.replace(`/${BUCKET}/`, ""));
      if (req.method === "PUT") {
        objects.set(key, Buffer.concat(chunks)); // 内容不回读(SDK 可能用 aws-chunked 编码),只要收下
        res.writeHead(200, { ETag: '"put"' });
        return res.end();
      }
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(listXml(url.searchParams.get("prefix") ?? "", url.searchParams.get("delimiter")));
      }
      if (req.method === "GET" && objects.has(key)) {
        const body = objects.get(key);
        res.writeHead(200, { ETag: '"get"', "content-length": body.length });
        return res.end(body);
      }
      res.writeHead(404, { "content-type": "application/xml" });
      res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
    });
  });
  await new Promise((r) => s3.listen(0, "127.0.0.1", r));
  s3Endpoint = `http://127.0.0.1:${s3.address().port}`;

  hc = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      pings.push({ path: new URL(req.url, "http://x").pathname, body });
      res.end("OK");
    });
  });
  await new Promise((r) => hc.listen(0, "127.0.0.1", r));
  hcBase = `http://127.0.0.1:${hc.address().port}`;
});

after(async () => {
  for (const server of [s3, hc]) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

function runCli(args, env) {
  const cwd = mkdtempSync(join(tmpdir(), "backupdrill-outcomes-"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      // 只给这次需要的变量:开发者 shell 里的 BACKUPDRILL_* 不能混进来
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NO_COLOR: "1",
        ...(process.env.BACKUPDRILL_PG_DUMP ? { BACKUPDRILL_PG_DUMP: process.env.BACKUPDRILL_PG_DUMP } : {}),
        BACKUPDRILL_S3_ENDPOINT: s3Endpoint,
        BACKUPDRILL_S3_REGION: "us-east-1",
        BACKUPDRILL_S3_BUCKET: BUCKET,
        BACKUPDRILL_S3_ACCESS_KEY_ID: "outcomeskey",
        BACKUPDRILL_S3_SECRET_ACCESS_KEY: "outcomessecret",
        BACKUPDRILL_PROJECT_NAME: "outcomes",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      rmSync(cwd, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

test("drill 跑完但没通过(dump 校验和不符):退出码 1,发 /start 再 /fail,列出没过的检查", async () => {
  objects.clear();
  pings = [];
  const snapshot = "2026-10-19T03-00-00-000Z";
  const base = `backupdrill/outcomes/${snapshot}`;
  const dump = Buffer.from("not the dump the manifest describes");
  const manifest = {
    schemaVersion: 1,
    tool: "backupdrill-cli",
    toolVersion: "2.5.0",
    createdAt: "2026-10-19T03:00:00.000Z",
    projectName: "outcomes",
    database: {
      serverVersion: "17.6",
      pgDumpVersion: "pg_dump (PostgreSQL) 17.6",
      schemas: ["public"],
      tableCount: 0,
      estimatedRowTotal: 0,
      tables: [],
    },
    dump: {
      key: `${base}/dump.pgcustom`,
      format: "custom",
      bytes: dump.length,
      sha256: createHash("sha256").update("the real dump").digest("hex"),
    },
    storage: null,
  };
  objects.set(`${base}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
  objects.set(`${base}/dump.pgcustom`, dump);

  const result = await runCli(["drill"], { BACKUPDRILL_PING_URL: `${hcBase}/${UUID}` });
  assert.equal(result.code, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).ok, false);
  assert.deepEqual(pings.map((p) => p.path), [`/${UUID}/start`, `/${UUID}/fail`]);
  assert.match(pings[1].body, /drill failed, snapshot 2026-10-19T03-00-00-000Z/);
  assert.match(pings[1].body, /archive integrity: sha256 MISMATCH/);
});

// ── 需要真 Postgres 的两条 ───────────────────────────────────────────────

async function withPostgres(fn) {
  const { stdout } = await x("docker", [
    "run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=outcomes", "-p", "127.0.0.1:0:5432", "postgres:17-alpine",
  ]);
  const id = stdout.trim();
  try {
    const port = (await x("docker", ["port", id, "5432/tcp"])).stdout.trim().split(":").pop().trim();
    for (let i = 0; i < 60; i++) {
      try {
        // -h 强制 TCP:镜像初始化阶段的临时服务只听 socket,不加会过早报就绪
        await x("docker", ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-q"]);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await x("docker", [
      "exec", id, "psql", "-h", "127.0.0.1", "-U", "postgres", "-q", "-c",
      "create table public.orders(id serial primary key, total int); " +
        "insert into public.orders(total) select g from generate_series(1, 50) g; analyze public.orders;",
    ]);
    await fn(`postgresql://postgres:outcomes@127.0.0.1:${port}/postgres`);
  } finally {
    await x("docker", ["rm", "-f", id]).catch(() => {});
  }
}

test(
  "backup 成功:发 /start 再 success;ping 服务挂了时退出码照样是 0、stdout 照样 ok",
  { skip: canRun ? false : "requires Docker + pg_dump" },
  async () => {
    await withPostgres(async (databaseUrl) => {
      objects.clear();
      pings = [];
      const ok = await runCli(["backup"], {
        BACKUPDRILL_DATABASE_URL: databaseUrl,
        BACKUPDRILL_PING_URL: `${hcBase}/${UUID}`,
      });
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal(JSON.parse(ok.stdout.trim()).ok, true);
      assert.deepEqual(pings.map((p) => p.path), [`/${UUID}/start`, `/${UUID}`]);
      assert.match(pings[1].body, /backup complete, 1 tables \(database only\), snapshot \d{4}-\d{2}-\d{2}T/);
      assert.ok(!pings[1].body.includes("outcomes@"), "连接串不该进 ping");

      const unmonitored = await runCli(["backup"], {
        BACKUPDRILL_DATABASE_URL: databaseUrl,
        BACKUPDRILL_PING_URL: "http://127.0.0.1:1/dead",
      });
      assert.equal(unmonitored.code, 0, unmonitored.stderr);
      assert.equal(JSON.parse(unmonitored.stdout.trim()).ok, true);
      assert.match(unmonitored.stderr, /Could not send the start ping/);
      assert.match(unmonitored.stderr, /Could not send the success ping/);
      assert.match(unmonitored.stderr, /Backup complete/);
    });
  }
);
