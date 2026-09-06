import { Client } from "pg";
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

export function isSupabaseHost(databaseUrl: string): boolean {
  const host = effectiveHost(databaseUrl);
  return host !== null && SUPABASE_HOST.test(host);
}

/** pg_dump 用:Supabase 主机才改写成 verify-full;其它原样透传。 */
/**
 * 把连接目标写死在连接串里:端口缺省 5432、库名缺省 postgres、并去掉**空的** options 参数。
 * 为什么:node-pg 与 libpq 对"URL 里没写的字段"各自回退到环境变量(PGPORT / PGDATABASE /
 * PGOPTIONS…)。子进程环境已剔除 PG*,而 Node 侧的预检客户端仍会读——两边可能连到不同的
 * 库/端口,空目标检查看的是一个库、pg_restore 写的是另一个(交叉审查)。Node 客户端与
 * pg_dump/pg_restore 都用规范化后的串,谁也不再依赖环境变量补字段。
 * 空的 `?options=` 会让 pg 的 val() 回退读 PGOPTIONS,同样去掉;非空 options 是用户显式意图,
 * 保留(pooler 主机上任何 options 已被 assertNoHostOverride 拒绝)。
 * 解析不了的串原样返回:上游守卫(assertNoHostOverride / assertSafeDatabaseUrl)负责拒绝。
 */
export function normalizeConnectionTarget(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return databaseUrl;
  }
  // 空 authority 形态(postgresql:///db?host=…):URL 解析得到空主机,node-pg 却能接受——这类串由
  // dumpUrlFor 的主机识别与 assertNoHostOverride 的 ?host= 拒绝各自处理,这里不碰、不猜
  if (!url.hostname) return databaseUrl;
  if (!url.port) url.port = "5432";
  // 没有用户名就没有可钉死的身份与缺省库名(libpq 退回操作系统用户、node-postgres 退回 PGUSER/
  // PGDATABASE 环境变量,两边立刻分叉):直接拒绝,连接串必须自带用户名
  if (!url.username) {
    throw new Error("connection string must include a user name (postgresql://user:password@host:port/database).");
  }
  // 库名缺省 = 用户名:这是 libpq 与 node-postgres 共同的语义(两者都在 dbname 缺失时回退到
  // user),写死它只是不让环境变量 PGDATABASE 插进来,不改变既有连接串的目标(交叉审查:
  // 曾错写成 postgres,会让 postgresql://app:pw@host 这类外部库串静默换库)。
  // 路径里的百分号编码两个客户端解法不同:libpq 全部解码,node-postgres(pg-connection-string)
  // 用 decodeURI——保留字(/ ? # : @ & = + $ , ;)的编码不解。所以缺省库名用**解码后的用户名**
  // 写进路径,让 URL 只对需要的字符做编码,再逐一验证两种解法得到同一个库名;做不到就要求显式库名。
  if (!url.pathname || url.pathname === "/") {
    let user: string;
    try {
      user = decodeURIComponent(url.username);
    } catch {
      throw new Error("connection string user name has invalid percent-encoding.");
    }
    const explicit = "connection string omits the database name and the user name cannot serve as the default — add /<database> after the host.";
    // / 破坏路径结构,? # 会被编成保留字序列(两边解法分叉),% 本身有歧义,控制字符不进路径
    if (/[/?#%\u0000-\u001f\u007f]/.test(user) || user === "") throw new Error(explicit);
    url.pathname = `/${user}`;
    const encoded = url.pathname.slice(1);
    let libpqView: string;
    let nodeView: string;
    try {
      libpqView = decodeURIComponent(encoded);
      nodeView = decodeURI(encoded);
    } catch {
      throw new Error(explicit);
    }
    if (libpqView !== user || nodeView !== user) throw new Error(explicit);
  }
  // options 参数按"最后一个生效"的驱动语义处理(pg-connection-string 与 libpq 对重复参数都取最后
  // 一个):最后一个 options 为空 → 整组 options 全部剔除(空值会让 pg 回退读 PGOPTIONS;只删空的
  // 那份会让更早的非空 options 复活,改变语义——交叉审查);最后一个非空 → 原样保留整组。
  // 按原文操作、不经 URLSearchParams 重新序列化,否则其它参数值里的 %20 会被改写成 +
  // (pg 解成空格、libpq 按字面 + 处理,两边密码就对不上)。
  if (url.search) {
    // 空片段(?&x=1)与无 = 的裸键(?options&…)Node 能容忍、libpq 报 "missing key/value separator":
    // 一律清掉,两边看到同一份 query。键按**大小写敏感**比对:驱动的键是大小写敏感的
    // (OPTIONS 对 pg 是另一个键、对 libpq 是非法关键字),按不敏感归组会把合法的小写 options 一起删掉。
    const pairs = url.search.slice(1).split("&").filter((pair) => pair !== "");
    const keyOf = (pair: string): string => {
      const eq = pair.indexOf("=");
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      try {
        return decodeURIComponent(rawKey);
      } catch {
        return rawKey; // 编码坏了按原文比对
      }
    };
    const valueOf = (pair: string): string => {
      const eq = pair.indexOf("=");
      return eq === -1 ? "" : pair.slice(eq + 1);
    };
    const optionPairs = pairs.filter((pair) => keyOf(pair) === "options");
    const lastIsEmpty = optionPairs.length > 0 && valueOf(optionPairs[optionPairs.length - 1]) === "";
    // 其它键的裸形态(?sslmode=disable&sslmode)两边语义对不上:Node 取最后一个(空 → 回退环境变量),
    // libpq 直接报错;静默删掉会让更早的值(这里是 disable = 明文)复活。不猜,拒绝(交叉审查)。
    const bareOther = pairs.find((pair) => !pair.includes("=") && keyOf(pair) !== "options");
    if (bareOther !== undefined) {
      throw new Error(
        `connection string parameter "${keyOf(bareOther)}" has no value — remove it or give it a value.`
      );
    }
    // 空的 sslmode(?sslmode=)两边对不上:libpq 报 invalid sslmode value,Node 回退环境变量——拒绝。
    // 只管 sslmode:空 host= 等已有各自的既定处理(stripSslParams / forceVerifyFull 那套),不在这里动
    if (pairs.some((pair) => keyOf(pair) === "sslmode" && pair.includes("=") && valueOf(pair) === "")) {
      throw new Error('connection string parameter "sslmode" is empty — remove it or give it a value.');
    }
    const kept = pairs.filter((pair) => {
      // options 组:最后一个为空/裸 → 整组删;否则只留带 = 的(裸的已被后面的值取代,libpq 会报错)
      if (keyOf(pair) === "options") return !lastIsEmpty && pair.includes("=");
      return true;
    });
    url.search = kept.length ? `?${kept.join("&")}` : "";
  }
  return url.toString();
}

export function dumpUrlFor(databaseUrl: string): string {
  const normalized = normalizeConnectionTarget(databaseUrl);
  return isSupabaseHost(normalized)
    ? forceVerifyFull(normalized, supabaseCaFile())
    : normalized;
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
/**
 * Supabase 主机的 pg Client 显式带 startup `options`。为什么:node-postgres 只在 config.options
 * 为假值时才读环境变量 PGOPTIONS,而 Supavisor 会从 options 里解析 `reference=<ref>` 并让它优先于
 * 用户名里的租户——继承的 PGOPTIONS 能把连接悄悄路由到别的项目(交叉审查)。给一个无害的真值就把
 * 环境变量挡在门外(Supavisor 与直连 Postgres 都实测接受);顺带在 pg_stat_activity 里能认出是谁在连。
 * 只对 Supabase 主机做:租户覆盖只存在于 Supavisor,而 PgBouncer 这类中间件默认拒绝陌生的启动参数
 * (unsupported startup parameter: options),别给自带 Postgres 的用户制造回归。
 */
export const PG_CLIENT_OPTIONS = "-c application_name=backupdrill";

export function pgConnectOptions(databaseUrl: string): {
  connectionString: string;
  options?: string;
  ssl?: typeof SUPABASE_SSL;
} {
  // 与 dumpUrlFor 同一份规范化:Node 客户端与 libpq 子进程看到的目标必须逐字段一致
  const normalized = normalizeConnectionTarget(databaseUrl);
  if (!isSupabaseHost(normalized)) return { connectionString: normalized };
  return { connectionString: stripSslParams(normalized), options: PG_CLIENT_OPTIONS, ssl: SUPABASE_SSL };
}

/**
 * 给一个 pg Client 挂上 error 监听。**必须在 connect() 之前挂。**
 *
 * 为什么:node-postgres 在连接建立后被对端掐断(Supabase 抖动、项目被暂停、网络抖)时,
 * 除了让正在等的查询 reject,还会在 client 上 emit "error";EventEmitter 没有监听者的 "error"
 * 直接抛成 uncaughtException。本引擎跑在 BackupDrill worker 进程里,一个客户库断连就能杀掉
 * 整个 worker,连带打断其他客户正在跑的任务(2026-08-28 复盘)。挂上之后查询照常 reject、
 * 调用方的 try/finally 照常收尾,进程活着。只记一行日志:断连的原因会从 reject 的错误里报出来。
 */
export function attachPgErrorGuard(client: {
  on(event: "error", listener: (error: Error) => void): unknown;
}): void {
  client.on("error", (error) => {
    console.warn(`[pg] connection error after connect: ${error.message}`);
  });
}

/** 连接一个 Postgres:pgConnectOptions(TLS 口径)+ error 监听 + connect(),三步不可分开。 */
export async function connectPg(databaseUrl: string): Promise<Client> {
  const client = new Client(pgConnectOptions(databaseUrl));
  attachPgErrorGuard(client);
  await client.connect();
  return client;
}
