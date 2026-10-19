// Healthchecks.io 式 ping:开始/成功/失败三个端点、同一个 rid、失败原因不带连接信息,
// 以及最要紧的一条——ping 出任何问题都不能让备份/演练失败或卡住。
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPinger, scrubForPing, sensitiveValuesOf } from "../dist/ping.js";
import { resolvePingUrl } from "../dist/config.js";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// 一个假的 Healthchecks:记下每个请求;behavior 决定怎么回
let server;
let base;
let requests = [];
let behavior = () => 200;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body, ua: req.headers["user-agent"] });
      const answer = behavior(requests.length);
      if (answer === "hang") return; // 不回,逼出超时
      // 数字 = 状态码;字符串 = 200 加这段正文(Healthchecks.io 的 "OK (not found)" 那种)
      const status = typeof answer === "number" ? answer : 200;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(typeof answer === "string" ? answer : status === 200 ? "OK" : "nope");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  requests = [];
  behavior = () => 200;
});

// 警告走 stderr:截下来断言,也免得测试输出里一片 "!"
function captureWarnings() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  return { lines, restore: () => (console.error = original) };
}

const FAST = { timeoutMs: 300, attempts: 2, retryDelayMs: 10 };
const UUID = "5bf66975-d4c7-4bf5-bcc8-b8d8a82ea278";

test("start 和 success 打到 /start 和本身,带同一个 rid", async () => {
  const ping = createPinger(`${base}/${UUID}`, FAST);
  await ping.start();
  await ping.success("backup complete, 3 tables");
  assert.deepEqual(requests.map((r) => r.path), [`/${UUID}/start`, `/${UUID}`]);
  const [start, success] = requests;
  assert.match(start.query.get("rid"), /^[0-9a-f-]{36}$/);
  assert.equal(start.query.get("rid"), success.query.get("rid"));
  assert.equal(success.method, "POST");
  assert.equal(success.body, "backup complete, 3 tables");
  assert.match(success.ua, /^backupdrill\//);
});

test("fail 打到 /fail,请求体是抹过连接信息的原因", async () => {
  const ping = createPinger(`${base}/${UUID}`, FAST);
  await ping.fail(
    'connection to server at "aws-0-eu-central-1.pooler.supabase.com" (3.65.151.229), port 5432 failed: ' +
      'password authentication failed for user "postgres.abcdefghijklmnopqrst" (s3cretPw!)',
    ["s3cretPw!"]
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, `/${UUID}/fail`);
  const body = requests[0].body;
  assert.match(body, /password authentication failed/);
  for (const leak of ["s3cretPw!", "pooler.supabase.com", "3.65.151.229", "abcdefghijklmnopqrst"]) {
    assert.ok(!body.includes(leak), `fail body leaks ${leak}: ${body}`);
  }
});

test("slug 网址上的 ?create=1 留着,后缀落在问号前面", async () => {
  const ping = createPinger(`${base}/ping/my-key/nightly-backup/?create=1`, FAST);
  await ping.start();
  assert.equal(requests[0].path, "/ping/my-key/nightly-backup/start");
  assert.equal(requests[0].query.get("create"), "1");
  assert.ok(requests[0].query.get("rid"));
});

test("5xx 重试,4xx 不重试,都只打警告不抛错", async () => {
  behavior = (n) => (n === 1 ? 503 : 200);
  await createPinger(`${base}/${UUID}`, FAST).start();
  assert.equal(requests.length, 2, "503 之后应该重试一次");

  requests = [];
  behavior = () => 404;
  const warn = captureWarnings();
  try {
    await createPinger(`${base}/${UUID}`, FAST).start();
  } finally {
    warn.restore();
  }
  assert.equal(requests.length, 1, "404 重试也没用");
  assert.match(warn.lines.join("\n"), /Could not send the start ping \(HTTP 404\)/);
  assert.ok(!warn.lines.join("\n").includes(UUID), "警告里不该出现 ping 网址");
});

test("200 但正文是 OK (not found) / OK (rate limited):没记上,要警告,不重试", async () => {
  for (const answer of ["OK (not found)", "OK (rate limited)"]) {
    requests = [];
    behavior = () => answer;
    const warn = captureWarnings();
    try {
      await createPinger(`${base}/${UUID}`, FAST).success("x");
    } finally {
      warn.restore();
    }
    assert.equal(requests.length, 1, `${answer} 不该重试`);
    assert.ok(warn.lines.join("\n").includes(`Healthchecks answered "${answer}"`), warn.lines.join("\n"));
  }
  // 自动建检查时回 201 Created,算成功
  requests = [];
  behavior = () => 201;
  const warn = captureWarnings();
  try {
    await createPinger(`${base}/${UUID}`, FAST).start();
  } finally {
    warn.restore();
  }
  assert.equal(warn.lines.length, 0);
});

test("网址带用户名密码:不发 ping,警告里也不复述它", async () => {
  const warn = captureWarnings();
  try {
    await createPinger(`http://hcuser:hcPassw0rd@127.0.0.1:${new URL(base).port}/${UUID}`, FAST).start();
  } finally {
    warn.restore();
  }
  assert.equal(requests.length, 0);
  const text = warn.lines.join("\n");
  assert.match(text, /contains a username or password/);
  assert.ok(!text.includes("hcPassw0rd") && !text.includes(UUID), text);
});

test("服务不回话时按超时放弃,不会卡住", async () => {
  behavior = () => "hang";
  const warn = captureWarnings();
  const started = Date.now();
  try {
    await createPinger(`${base}/${UUID}`, { timeoutMs: 200, attempts: 2, retryDelayMs: 10 }).success("x");
  } finally {
    warn.restore();
  }
  assert.ok(Date.now() - started < 3000, "超时后应该很快放弃");
  assert.match(warn.lines.join("\n"), /no response within/);
});

test("连不上、网址不对、没配网址:都不抛错", async () => {
  const warn = captureWarnings();
  try {
    await createPinger("http://127.0.0.1:1/x", FAST).fail("boom");
    await createPinger("not a url", FAST).start();
    await createPinger("ftp://example.com/x", FAST).start();
    await createPinger(undefined, FAST).start();
    await createPinger("", FAST).fail("boom");
  } finally {
    warn.restore();
  }
  assert.equal(requests.length, 0);
  assert.equal(warn.lines.filter((l) => /not a valid http\(s\) URL/.test(l)).length, 2);
});

test("scrubForPing:按值抹,再按形状兜底", () => {
  const out = scrubForPing(
    "Unexpected token in JSON: {\"databaseUrl\": \"postgresql://postgres:hunter22@db.abcdefghijklmnop.supabase.co:5432/postgres\" " +
      "endpoint https://acct.r2.cloudflarestorage.com bucket key AKIAEXAMPLEKEY at 2600:1f18:abcd::1 " +
      "while reading backupdrill.config.json at 03:00:00",
    ["AKIAEXAMPLEKEY"]
  );
  for (const leak of ["hunter22", "abcdefghijklmnop", "cloudflarestorage", "AKIAEXAMPLEKEY", "2600:1f18"]) {
    assert.ok(!out.includes(leak), `still contains ${leak}: ${out}`);
  }
  assert.match(out, /backupdrill\.config\.json/, "文件名不该被当成主机名抹掉");
  assert.match(out, /03:00:00/, "时间不该被当成 IPv6 抹掉");
});

test("sensitiveValuesOf 收集连接串的密码、主机、项目 ref 和各处密钥", () => {
  const values = sensitiveValuesOf(
    {
      databaseUrl: "postgresql://postgres.abcdefghijklmnopqrst:p%40ss@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
      projectName: "x",
      schemas: ["public"],
      storage: { region: "auto", bucket: "b", accessKeyId: "KEYID123", secretAccessKey: "SECRET123", prefix: "p", forcePathStyle: true },
    },
    undefined
  );
  for (const v of ["p@ss", "p%40ss", "aws-0-us-east-1.pooler.supabase.com", "abcdefghijklmnopqrst", "KEYID123", "SECRET123"]) {
    assert.ok(values.includes(v), `missing ${v}`);
  }
  assert.ok(!values.includes("postgres"), "用户名 postgres 不该进列表");
});

// ── 网址从哪来:flag > 环境变量 > 配置文件,空串算没配 ──────────────────────

let dir;
let savedEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backupdrill-ping-test-"));
  savedEnv = process.env.BACKUPDRILL_PING_URL;
  delete process.env.BACKUPDRILL_PING_URL;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.BACKUPDRILL_PING_URL;
  else process.env.BACKUPDRILL_PING_URL = savedEnv;
});

test("resolvePingUrl 的优先级和空串", async () => {
  const configPath = join(dir, "backupdrill.config.json");
  writeFileSync(configPath, JSON.stringify({ pingUrl: "https://hc.example/file" }));
  assert.equal(await resolvePingUrl({ configPath }), "https://hc.example/file");
  process.env.BACKUPDRILL_PING_URL = "https://hc.example/env";
  assert.equal(await resolvePingUrl({ configPath }), "https://hc.example/env");
  assert.equal(await resolvePingUrl({ flag: " https://hc.example/flag ", configPath }), "https://hc.example/flag");
  // Actions 里没设的 secret 展开成空串:当没配,往下一层找
  process.env.BACKUPDRILL_PING_URL = "";
  assert.equal(await resolvePingUrl({ configPath }), "https://hc.example/file");
  // 配置文件坏了不在这里报错(loadConfig 会报),只是拿不到文件里的网址
  writeFileSync(configPath, "{ not json");
  assert.equal(await resolvePingUrl({ configPath }), undefined);
  // 合法但不是对象的 JSON(null)也不能让这里抛错,否则 /start 和 /fail 都发不出去
  writeFileSync(configPath, "null");
  assert.equal(await resolvePingUrl({ configPath }), undefined);
  assert.equal(await resolvePingUrl({ configPath: join(dir, "missing.json") }), undefined);
  process.env.BACKUPDRILL_PING_URL = "https://hc.example/env";
  assert.equal(await resolvePingUrl({ configPath }), "https://hc.example/env");
});

// ── 端到端:真跑 CLI ───────────────────────────────────────────────────────

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      // 只给这次需要的变量:开发者 shell 里的 BACKUPDRILL_* 不能混进来
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const UNREACHABLE_DB = "postgresql://postgres.abcdefghijklmnopqrst:Sup3rSecretPw@127.0.0.1:1/postgres";
const BUCKET_ENV = {
  BACKUPDRILL_S3_BUCKET: "my-backups",
  BACKUPDRILL_S3_ACCESS_KEY_ID: "AKIATESTKEYID",
  BACKUPDRILL_S3_SECRET_ACCESS_KEY: "TestSecretAccessKey123",
};

test("backup 连不上库:先 /start 再 /fail,原因里没有密码、主机、ref、密钥", async () => {
  const result = await runCli(["backup"], {
    BACKUPDRILL_PING_URL: `${base}/${UUID}`,
    BACKUPDRILL_DATABASE_URL: UNREACHABLE_DB,
    ...BUCKET_ENV,
  });
  assert.equal(result.code, 1);
  assert.deepEqual(requests.map((r) => r.path), [`/${UUID}/start`, `/${UUID}/fail`]);
  const body = requests[1].body;
  assert.match(body, /backup failed/);
  for (const leak of ["Sup3rSecretPw", "127.0.0.1", "abcdefghijklmnopqrst", "AKIATESTKEYID", "TestSecretAccessKey123"]) {
    assert.ok(!body.includes(leak), `fail body leaks ${leak}: ${body}`);
  }
});

test("配置不全也报 /fail(网址来自 --ping-url)", async () => {
  const result = await runCli(["backup", "--ping-url", `${base}/${UUID}`], {});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing required config/);
  assert.deepEqual(requests.map((r) => r.path), [`/${UUID}/start`, `/${UUID}/fail`]);
  assert.match(requests[1].body, /Missing required config/);
});

test("配置文件不是合法 JSON:/fail 里不带文件原文(原文里可能就是密钥)", async () => {
  writeFileSync(join(dir, "backupdrill.config.json"), '{"storage":{"secretAccessKey":FAKESECRETKEY123}}');
  const result = await runCli(["backup"], { BACKUPDRILL_PING_URL: `${base}/${UUID}` });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Could not read config file/);
  assert.deepEqual(requests.map((r) => r.path), [`/${UUID}/start`, `/${UUID}/fail`]);
  assert.match(requests[1].body, /Could not read config file backupdrill\.config\.json\. The job's log has the details\./);
  assert.ok(!requests[1].body.includes("FAKESECRET"), requests[1].body);
});

test("库和 Storage 指向不同项目:两个项目 ref 都不进 /fail", async () => {
  const result = await runCli(["backup"], {
    BACKUPDRILL_PING_URL: `${base}/${UUID}`,
    BACKUPDRILL_DATABASE_URL: "postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
    BACKUPDRILL_SUPABASE_STORAGE_ENDPOINT: "https://bbbbbbbbbbbbbbbbbbbb.storage.supabase.co/storage/v1/s3",
    BACKUPDRILL_SUPABASE_STORAGE_REGION: "us-east-1",
    BACKUPDRILL_SUPABASE_STORAGE_ACCESS_KEY_ID: "storagekeyid",
    BACKUPDRILL_SUPABASE_STORAGE_SECRET_ACCESS_KEY: "storagesecret",
    ...BUCKET_ENV,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /database points at Supabase project/);
  const body = requests[1].body;
  assert.match(body, /database points at Supabase project/);
  for (const leak of ["aaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb"]) {
    assert.ok(!body.includes(leak), `fail body leaks ${leak}: ${body}`);
  }
});

test("ping 服务挂了:backup 的结果和报错跟没配 ping 时一样,只多警告", async () => {
  const env = { BACKUPDRILL_DATABASE_URL: UNREACHABLE_DB, ...BUCKET_ENV };
  const plain = await runCli(["backup"], env);
  const pinged = await runCli(["backup"], { ...env, BACKUPDRILL_PING_URL: "http://127.0.0.1:1/dead" });
  assert.equal(pinged.code, plain.code);
  assert.equal(pinged.stdout, plain.stdout);
  const strip = (s) => s.split("\n").filter((l) => !/ping/.test(l)).join("\n");
  assert.equal(strip(pinged.stderr), strip(plain.stderr));
  assert.match(pinged.stderr, /Could not send the start ping/);
  assert.match(pinged.stderr, /Could not send the fail ping/);
});

test("drill 读不到桶:/start 再 /fail", async () => {
  const result = await runCli(["drill"], {
    BACKUPDRILL_PING_URL: `${base}/${UUID}`,
    BACKUPDRILL_S3_ENDPOINT: "http://127.0.0.1:1",
    BACKUPDRILL_S3_REGION: "us-east-1",
    ...BUCKET_ENV,
  });
  assert.equal(result.code, 1);
  assert.deepEqual(requests.map((r) => r.path), [`/${UUID}/start`, `/${UUID}/fail`]);
  assert.match(requests[1].body, /drill failed/);
  assert.ok(!requests[1].body.includes("127.0.0.1"));
});
