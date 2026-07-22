/**
 * Supabase Root 2021 CA —— 打包进引擎,用于对用户 Supabase 源库连接做 verify-full。
 *
 * 为什么必须自带:Supabase pooler(Supavisor)的证书由 Supabase 自签 CA 签发
 * (链:*.pooler.supabase.com ← Supabase Intermediate 2021 CA ← Supabase Root 2021 CA),
 * **不在系统 CA 信任库里**——直接 rejectUnauthorized:true 会报 SELF_SIGNED_CERT_IN_CHAIN
 * (2026-07-20 真机实测)。把这个自签根作为 ca 传入,node-pg / libpq(pg_dump)即可完成
 * verify-full(验签 + 验通配主机名 *.pooler.supabase.com)。所有 Supabase 项目共用这一张根,
 * 有效期至 2031-04(过期前需更新)。
 *
 * 只对**用户 Supabase 源库**连接使用(backup 探查 / pg_dump / estimate / 预检);演练用的
 * 本地 Docker 沙箱、restore 的任意目标库不适用,勿套用。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SUPABASE_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`;

/** node-pg 的 ssl 配置:验签(用打包的 Supabase 根 CA)+ 验主机名(rejectUnauthorized)。 */
export const SUPABASE_SSL = { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true } as const;

let caFilePath: string | null = null;
/**
 * 把打包的 CA 写到临时文件并返回路径:pg_dump(libpq)的 sslrootcert 只认文件路径,不认字符串。
 * 缓存,进程内只写一次;内容是公开 CA(非密),mode 0600 足矣。
 */
export function supabaseCaFile(): string {
  // 缓存的文件可能被系统 tmp 清理删掉;长驻 worker 若一直返回失效路径,之后**每次**
  // pg_dump 都会失败直到重启。发现不存在就重建。
  if (caFilePath && !existsSync(caFilePath)) caFilePath = null;
  if (!caFilePath) {
    // 私有随机目录(mkdtemp 建的是 0700、属主为本进程):固定的 /tmp 路径在多用户机器上
    // 可被他人预置符号链接,或**替换成伪造 CA** —— 那我们的 pg_dump 就会去信任攻击者的
    // 证书,等于自己开了 MITM 的门。
    const dir = mkdtempSync(join(tmpdir(), "backupdrill-ca-"));
    const p = join(dir, "supabase-root-ca.pem");
    writeFileSync(p, SUPABASE_ROOT_CA, { mode: 0o600 });
    caFilePath = p;
    // 长驻进程(worker)整个生命周期都要用它,退出时再尽力清掉,避免反复起停堆积
    process.once("exit", () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败无所谓,内容是公开 CA */
      }
    });
  }
  return caFilePath;
}

/** 所有会影响 TLS 行为的连接串参数——必须全部剥掉,否则会盖过我们显式传的 ssl 配置。 */
const SSL_QUERY_PARAMS = [
  "sslmode",
  "ssl",
  "requiressl", // 老式开关
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslcrl",
  "sslcrldir",
  "sslpassword",
  "sslcertmode",
  "sslcompression",
  "sslsni",
  "sslnegotiation",
  "ssl_min_protocol_version",
  "ssl_max_protocol_version",
  // PG18:把 TLS 会话密钥写到文件 —— 留着它,"强制加密"就是句空话(流量可被解密)
  "sslkeylogfile",
  "uselibpqcompat",
  // GSS 会在 TLS 之前协商,带 GSS 的 libpq 构建可能先走 GSS 再谈 TLS;下面统一置 disable
  "gssencmode",
];

/**
 * 手工摘除查询参数——**不能**用 URLSearchParams:一旦碰它,URL 会按 form-urlencoded
 * 重新序列化整个查询串,把 `%20` 写成 `+`(2026-07-22 实测)。而 libpq 把 `+` 当字面量,
 * 于是合法的 `?options=-c%20statement_timeout%3D0` 会被改成 `-c+statement_timeout=0`
 * 让 pg_dump 直接失败。这里逐段过滤、原样保留其余片段的编码。
 */
function stripSslParams(databaseUrl: string): string {
  const q = databaseUrl.indexOf("?");
  if (q === -1) return databaseUrl;
  const base = databaseUrl.slice(0, q);
  const pairs = databaseUrl
    .slice(q + 1)
    .split("&")
    .filter((pair) => pair !== "");

  const keyOf = (pair: string): string => {
    const raw = pair.split("=")[0] ?? "";
    try {
      return decodeURIComponent(raw).toLowerCase();
    } catch {
      return raw.toLowerCase(); // 编码坏了就按原文比对
    }
  };
  const valueOf = (pair: string): string => pair.slice((pair.split("=")[0] ?? "").length + 1);

  // 两端都是"最后一个 host 生效"。若最后一个是**空值**,实际目标回落到 authority ——
  // 这时必须删掉**所有** host 条目:只删空的那条,会把前面的 host=other 留给 libpq,
  // 造成探查连 authority、pg_dump 连 other 的分裂。
  const hostValues = pairs.filter((p) => keyOf(p) === "host").map(valueOf);
  const dropAllHosts = hostValues.length > 0 && hostValues[hostValues.length - 1] === "";

  const kept = pairs.filter((pair) => {
    const key = keyOf(pair);
    if (SSL_QUERY_PARAMS.includes(key)) return false;
    if (key === "host" && dropAllHosts) return false;
    return true;
  });
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

/**
 * 把连接串强制改写成 verify-full + 我们的 CA(给 pg_dump 用)。剥掉用户自带的所有 ssl* 参数
 * ——libpq 里 URL 参数优先级高于环境变量,残留的 sslmode=require 会盖掉我们的 verify-full。
 */
export function forceVerifyFull(databaseUrl: string, caPath: string): string {
  const stripped = stripSslParams(databaseUrl);
  const sep = stripped.includes("?") ? "&" : "?";
  // gssencmode=disable:带 GSS 的 libpq 构建会在 TLS 之前尝试 GSS 协商,可能在用上我们的
  // CA 之前就失败;我们从不用 Kerberos,显式关掉让行为跨构建确定。
  return `${stripped}${sep}sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}&gssencmode=disable`;
}

/**
 * 按主机名决定是否启用 Supabase verify-full。
 *
 * 关键:本 CLI 是公开工具,**不限制**连接串必须是 Supabase(那道校验只在产品侧的
 * shared/endpoints.ts)。若无条件套 Supabase CA,指向自建 Supabase / 其它 Postgres 的
 * 用户会直接 TLS 失败——对开源工具是回归。因此只在目标确实是 Supabase 主机时启用;
 * 其余情形返回 undefined,保持 pg 的默认行为(由连接串自身的 sslmode 决定)。
 */
const SUPABASE_HOST = /\.supabase\.(co|com|net)$/;

/**
 * 真正会被连接的主机。两个坑:
 *  - libpq/pg 允许 `?host=` 覆盖 authority 里的主机 → 必须按实际目标判定,否则会出现
 *    "给 A 套了 B 的 CA"(证书必然不匹配)或"真连 Supabase 却没套 CA"。
 *  - DNS 末尾根点(`...supabase.com.`)是合法写法,不归一化会把合法 Supabase 主机漏判成外部库。
 */
const EMPTY_AUTHORITY_HOST = "backupdrill-empty-authority.invalid";

/**
 * 按 node-pg 的宽容度解析连接串。WHATWG URL **拒绝空 authority**
 * (`postgresql://u:p@/db?host=…`),但 node-pg 接受并连到 host= 指定的主机
 * ——直接 try/catch 判 null 会把这种串当成外部库放行,于是 `sslmode=disable`
 * 原样保留、真连 Supabase 却走明文(2026-07-22 审查抓到)。
 * 这里给空 authority 塞个占位主机让它可解析,并记住 authority 实为空。
 */
function parseLikePg(databaseUrl: string): { url: URL; authorityHost: string } | null {
  try {
    const url = new URL(databaseUrl);
    return { url, authorityHost: url.hostname };
  } catch {
    /* 可能正是 node-pg 允许、WHATWG 拒绝的空 authority */
  }
  const m = databaseUrl.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/);
  if (!m) return null;
  const [, scheme, authority, rest] = m;
  // 只处理"空 authority"或"有用户名但无主机(以 @ 结尾)"这两种
  if (authority !== "" && !authority.endsWith("@")) return null;
  try {
    return { url: new URL(`${scheme}${authority}${EMPTY_AUTHORITY_HOST}${rest}`), authorityHost: "" };
  } catch {
    return null;
  }
}

function effectiveHost(databaseUrl: string): string | null {
  const parsed = parseLikePg(databaseUrl);
  if (!parsed) return null; // 实在解析不了就别自作主张套 CA
  const { url, authorityHost } = parsed;
  // 必须**与 node-pg 的解析语义逐字对齐**(2026-07-22 实测):
  //   - 重复的 host= 取**最后一个**(URLSearchParams.get 取第一个,会判错)
  //   - host= 为**空值**时回落到 authority 主机(当成"没写")
  // 判错的后果不是小事:真连 Supabase 却被当成外部库 → 不剥 sslmode=disable → 明文。
  // query 里的 host= 已被 URLSearchParams 解码;authority 主机名 WHATWG URL **不解码**,
  // 而 node-pg 会解码(实测 `supabase%2Ecom` → `supabase.com` 并真的连上去)。不解码就会
  // 把合法 Supabase 主机判成外部库 → 保留 sslmode=disable → 明文。坏转义按原文处理。
  let decodedAuthority = authorityHost;
  try {
    decodedAuthority = decodeURIComponent(authorityHost);
  } catch {
    /* 转义损坏:按原文比对,宁可判成外部库也不误套 CA */
  }
  const all = url.searchParams.getAll("host");
  const last = all.length ? all[all.length - 1] : "";
  const host = (last !== "" ? last : decodedAuthority).toLowerCase().replace(/\.$/, "");
  return host || null;
}

function isSupabaseHost(databaseUrl: string): boolean {
  const host = effectiveHost(databaseUrl);
  return host !== null && SUPABASE_HOST.test(host);
}

/** pg_dump 用:Supabase 主机才改写成 verify-full;其它原样透传。 */
export function dumpUrlFor(databaseUrl: string): string {
  return isSupabaseHost(databaseUrl)
    ? forceVerifyFull(databaseUrl, supabaseCaFile())
    : databaseUrl;
}

/**
 * node-pg 连接选项:把"剥离连接串里的 SSL 参数"与"套上打包 CA"做成**原子**的一步。
 *
 * 为什么必须一起做(2026-07-22 实测,pg 8.22):连接串里的 SSL 参数**会覆盖**显式传的
 * `ssl` 选项——`?sslmode=disable` / `?ssl=0` 会让我们的 CA 被整个丢弃、退化成不加密,
 * `?ssl=true` 则加密但不带我们的 CA。而 sslmode 在产品的参数黑名单里是**放行**的(为兼容
 * 存量连接串),所以不剥就等于强制 verify-full 可被用户参数静默绕过。
 *
 * 非 Supabase 主机(本 CLI 不限制目标)原样返回:不剥、不套,尊重用户自己的 sslmode。
 */
export function pgConnectOptions(databaseUrl: string): {
  connectionString: string;
  ssl?: typeof SUPABASE_SSL;
} {
  if (!isSupabaseHost(databaseUrl)) return { connectionString: databaseUrl };
  return { connectionString: stripSslParams(databaseUrl), ssl: SUPABASE_SSL };
}
