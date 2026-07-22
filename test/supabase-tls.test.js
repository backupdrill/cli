import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { pgConnectOptions, dumpUrlFor, SUPABASE_ROOT_CA } from "../dist/supabase-ca.js";

const { Client } = pg;
const SUPA = "postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
// Supabase Root 2021 CA 的 SHA-256 指纹(2026-07-22 从真实 pooler 证书链取得,有效期至 2031-04)
const SUPABASE_ROOT_CA_FP256 =
  "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";
const OTHER = "postgresql://u:p@db.mycompany.com:5432/mydb";

/** 取 pg 实际生效的 ssl 配置(连接串与显式选项合并后的结果)。 */
function effectiveSsl(url) {
  return new Client(pgConnectOptions(url)).connectionParameters.ssl;
}

// 2026-07-22 实测:连接串里的 SSL 参数会**覆盖**显式 ssl 选项 —— ?sslmode=disable 曾让
// 打包 CA 被整个丢弃、退化成明文。sslmode 在产品黑名单里是放行的,所以这是可被用户
// 参数静默绕过的真实降级路径。以下用例把它钉死。
const BYPASS_ATTEMPTS = [
  "?sslmode=disable",
  "?sslmode=no-verify",
  "?sslmode=require",
  "?sslmode=verify-full",
  "?ssl=0",
  "?ssl=true",
  "?sslnegotiation=direct",
  "?uselibpqcompat=true&sslmode=require",
];

test("Supabase 主机:无论连接串带什么 SSL 参数,都必须落到带 CA 的 verify-full", () => {
  for (const q of ["", ...BYPASS_ATTEMPTS]) {
    const ssl = effectiveSsl(SUPA + q);
    assert.equal(typeof ssl, "object", `${q || "(无参数)"}: ssl 应是对象而非 ${ssl}`);
    assert.equal(ssl.rejectUnauthorized, true, `${q || "(无参数)"}: 必须校验证书`);
    assert.equal(ssl.ca, SUPABASE_ROOT_CA, `${q || "(无参数)"}: 必须用打包的 Supabase 根 CA`);
  }
});

test("Supabase 主机:连接串里的 SSL 参数被剥干净(不留下能覆盖的残留)", () => {
  const { connectionString } = pgConnectOptions(`${SUPA}?sslmode=disable&ssl=0&application_name=bd`);
  assert.ok(!/sslmode|ssl=/.test(connectionString), `残留 SSL 参数: ${connectionString}`);
  // 非 SSL 的无害参数要保留,别误伤
  assert.match(connectionString, /application_name=bd/);
});

test("非 Supabase 主机:不套 CA、连接串原样(本 CLI 不限制目标,尊重用户自己的 sslmode)", () => {
  const url = `${OTHER}?sslmode=require`;
  const opts = pgConnectOptions(url);
  assert.equal(opts.ssl, undefined);
  assert.equal(opts.connectionString, url);
  assert.equal(dumpUrlFor(url), url, "pg_dump 连接串也应原样透传");
});

test("pg_dump 连接串:Supabase 主机改写成 verify-full + 打包 CA,且剥掉用户的 ssl 参数", () => {
  const out = dumpUrlFor(`${SUPA}?sslmode=disable`);
  assert.match(out, /sslmode=verify-full/);
  assert.match(out, /sslrootcert=/);
  assert.ok(!/sslmode=disable/.test(out), "用户的 sslmode=disable 必须被剥掉");
});

test("末尾 DNS 根点的合法 Supabase 主机不能漏判(否则静默不套 CA)", () => {
  const ssl = effectiveSsl("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com.:5432/postgres");
  assert.equal(typeof ssl, "object");
  assert.equal(ssl.ca, SUPABASE_ROOT_CA);
});

test("?host= 覆盖真实目标时,按实际连接目标判定", () => {
  // authority 是外部库、实际连 Supabase → 应套 CA
  assert.equal(
    effectiveSsl("postgresql://u:p@db.mycompany.com:5432/db?host=aws-0-us-east-1.pooler.supabase.com").ca,
    SUPABASE_ROOT_CA
  );
  // authority 像 Supabase、实际连别处 → 不该套 Supabase CA(否则证书必然不匹配)
  assert.equal(
    pgConnectOptions("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/db?host=db.mycompany.com").ssl,
    undefined
  );
});

test("CA 临时文件:私有 0700 目录 + 0600 普通文件 + 内容与打包 CA 逐字一致", async () => {
  const { supabaseCaFile } = await import("../dist/supabase-ca.js");
  const { lstatSync, readFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const p = supabaseCaFile();

  // 只比对路径形状挡不住"本地替换 CA → MITM"的回归,必须查实际类型/权限/内容
  const dir = lstatSync(dirname(p));
  assert.ok(dir.isDirectory(), "CA 应放在真实目录里(非符号链接)");
  const file = lstatSync(p);
  assert.ok(file.isFile(), "CA 必须是普通文件(不能是符号链接)");
  // 权限位是 POSIX 概念;包未声明 OS 限制,Windows 上不断言(否则测试假失败)
  if (process.platform !== "win32") {
    assert.equal(dir.mode & 0o777, 0o700, "目录权限必须是 0700,别人不得写入");
    assert.equal(file.mode & 0o777, 0o600, "文件权限必须是 0600");
  }
  assert.equal(readFileSync(p, "utf8"), SUPABASE_ROOT_CA, "内容必须是打包的根 CA,不能被替换");
  // 与同一来源自比是重言式:换掉提交的信任锚,两边一起变、测试照样绿。独立钉住指纹。
  const { X509Certificate } = await import("node:crypto");
  assert.equal(
    new X509Certificate(readFileSync(p, "utf8")).fingerprint256,
    SUPABASE_ROOT_CA_FP256,
    "信任锚被换了 —— 要么是误改,要么是信错了签发方"
  );
});

// 与 node-pg 的 host 解析语义逐字对齐(2026-07-22 实测);判错 = 真连 Supabase 却走明文
test("host= 为空值时回落到 authority(不能因此漏判成外部库)", () => {
  const ssl = effectiveSsl(`${SUPA}?host=&sslmode=disable`);
  assert.equal(typeof ssl, "object", "空 host 应回落到 authority → 仍是 Supabase");
  assert.equal(ssl.ca, SUPABASE_ROOT_CA);
  const { connectionString } = pgConnectOptions(`${SUPA}?host=&sslmode=disable`);
  assert.ok(!/sslmode=disable/.test(connectionString), "必须剥掉 sslmode=disable");
});

test("重复 host= 取最后一个(与 pg 一致)", () => {
  const supaLast = `postgresql://u:p@db.evil.com:5432/db?host=db.evil.com&host=aws-0-us-east-1.pooler.supabase.com`;
  assert.equal(effectiveSsl(supaLast).ca, SUPABASE_ROOT_CA, "最后一个是 Supabase → 应套 CA");

  const evilLast = `postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/db?host=aws-0-us-east-1.pooler.supabase.com&host=db.evil.com`;
  assert.equal(pgConnectOptions(evilLast).ssl, undefined, "最后一个不是 Supabase → 不该套 Supabase CA");
});

// libpq 把 `+` 当字面量,而 URL 序列化会把 %20 写成 + —— 曾因此把合法的 ?options=
// 改坏、让 pg_dump 直接失败(2026-07-22 实测)。这两条守住"只摘 SSL 参数、其余原样"。
test("剥离 SSL 参数时,其余参数的百分号编码必须原样保留(%20 不能变成 +)", () => {
  const url = `${SUPA}?options=-c%20statement_timeout%3D0&sslmode=disable&application_name=bd`;
  const { connectionString } = pgConnectOptions(url);
  assert.match(connectionString, /options=-c%20statement_timeout%3D0/, `实际: ${connectionString}`);
  assert.ok(!connectionString.includes("+"), "不得出现 form-urlencoded 的 +");
  assert.ok(!/sslmode/.test(connectionString), "SSL 参数仍要被剥掉");
  assert.match(connectionString, /application_name=bd/);
});

test("pg_dump 连接串同样保留 %20,并追加 verify-full + CA 路径", async () => {
  const out = dumpUrlFor(`${SUPA}?options=-c%20statement_timeout%3D0`);
  assert.match(out, /options=-c%20statement_timeout%3D0/);
  assert.match(out, /sslmode=verify-full/);
  // 从实际临时路径推导期望值,别硬编码 %2F(Windows 路径不是 / 开头)
  const { supabaseCaFile } = await import("../dist/supabase-ca.js");
  assert.ok(out.includes(`sslrootcert=${encodeURIComponent(supabaseCaFile())}`), `实际: ${out}`);
});

test("空 host= 被删掉(node-pg 回落 authority,libpq 却会连本地 socket)", () => {
  const { connectionString } = pgConnectOptions(`${SUPA}?host=&application_name=bd`);
  assert.ok(!/host=/.test(connectionString), `空 host 必须删掉: ${connectionString}`);
  assert.match(connectionString, /application_name=bd/);
});

test("最后一个 host 为空时,所有 host 条目都要删掉(否则 pg_dump 会连到 host=other)", () => {
  const { connectionString } = pgConnectOptions(`${SUPA}?host=db.other.com&host=&application_name=bd`);
  assert.ok(!/host=/.test(connectionString), `残留 host 会让两端目标分裂: ${connectionString}`);
  assert.match(connectionString, /application_name=bd/);
});

test("libpq 的全部 SSL/传输开关都会被剥掉(含会泄密的 sslkeylogfile)", () => {
  const hostile =
    `${SUPA}?sslkeylogfile=%2Ftmp%2Fleak.log&sslcompression=1&sslsni=0&sslcertmode=disable` +
    `&ssl_min_protocol_version=TLSv1&gssencmode=require&requiressl=0`;
  const { connectionString } = pgConnectOptions(hostile);
  for (const k of ["sslkeylogfile", "sslcompression", "sslsni", "sslcertmode", "ssl_min_protocol_version", "gssencmode", "requiressl"]) {
    assert.ok(!connectionString.includes(k), `${k} 必须被剥掉: ${connectionString}`);
  }
});

test("pg_dump 串显式关闭 GSS 协商(跨 libpq 构建行为确定)", () => {
  assert.match(dumpUrlFor(`${SUPA}?gssencmode=require`), /gssencmode=disable/);
});

// WHATWG URL 拒绝空 authority,node-pg 却接受并连到 host= 指定的主机。若因解析失败
// 判成"外部库",sslmode=disable 会原样保留 → 真连 Supabase 却走明文(2026-07-22 抓到)。
const SUPA_HOST = "aws-0-us-east-1.pooler.supabase.com";

test("空 authority 连接串(node-pg 接受、URL 拒绝)仍须识别为 Supabase 并强制 verify-full", () => {
  for (const url of [
    `postgresql://user:pw@/postgres?host=${SUPA_HOST}&sslmode=disable`,
    `postgresql:///postgres?host=${SUPA_HOST}&sslmode=disable`,
  ]) {
    const { connectionString, ssl } = pgConnectOptions(url);
    assert.equal(typeof ssl, "object", `${url}: 必须套 CA`);
    assert.equal(ssl.ca, SUPABASE_ROOT_CA);
    assert.ok(!/sslmode=disable/.test(connectionString), `${url}: sslmode=disable 必须剥掉`);
    const dumped = dumpUrlFor(url);
    assert.match(dumped, /sslmode=verify-full/, `${url}: pg_dump 串也要 verify-full`);
    assert.ok(!/sslmode=disable/.test(dumped));
  }
});

test("空 authority 且指向外部库时,仍然不套 Supabase CA", () => {
  const url = "postgresql://user:pw@/db?host=db.mycompany.com&sslmode=require";
  const opts = pgConnectOptions(url);
  assert.equal(opts.ssl, undefined);
  assert.equal(opts.connectionString, url, "外部库连接串应原样透传");
});

// node-pg 会对 authority 主机名做百分号解码(实测 supabase%2Ecom → supabase.com 并真连),
// WHATWG URL 不解码。不跟着解码就会把合法 Supabase 判成外部库 → 保留 sslmode=disable → 明文。
test("百分号编码的主机名必须按 node-pg 的方式解码后判定", () => {
  const url = `postgresql://user:pw@aws-0-us-east-1.pooler.supabase%2Ecom:5432/postgres?sslmode=disable`;
  const { connectionString, ssl } = pgConnectOptions(url);
  assert.equal(typeof ssl, "object", "编码主机名仍是 Supabase,必须套 CA");
  assert.equal(ssl.ca, SUPABASE_ROOT_CA);
  assert.ok(!/sslmode=disable/.test(connectionString), "sslmode=disable 必须剥掉");
});

test("CA 文件被外部删除后能自愈重建(长驻 worker 不至于之后每次 dump 都失败)", async () => {
  const { supabaseCaFile } = await import("../dist/supabase-ca.js");
  const { rmSync, existsSync, readFileSync } = await import("node:fs");
  const first = supabaseCaFile();
  rmSync(first, { force: true });
  assert.ok(!existsSync(first), "前置条件:文件已被删除");
  const second = supabaseCaFile();
  assert.ok(existsSync(second), "应重建出可用的 CA 文件");
  assert.equal(readFileSync(second, "utf8"), SUPABASE_ROOT_CA);
});
