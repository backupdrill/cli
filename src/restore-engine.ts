// 统一数据库恢复引擎(恢复闭环 PRD §5.2):drill 沙箱与真实 Supabase 目标共用同一条
// pg_restore 路径与错误分类,同一快照不得在演练与真实恢复中得出不同结论。
//
// R0 spike 的三条实证直接塑造了这里的形状:
//  1. 裸退出码在真实目标上永远不干净 → 成功判定 = 零未分类错误(版本化 allowlist);
//  2. 不用 --clean:与"只允许空目标"(D5)冲突、制造伪错,且在真实 Supabase 上
//     DROP/CREATE public 会抹掉 anon/authenticated 的默认授权(--no-privileges 转储
//     不会带回来),恢复出的 API 直接 401;
//  3. dump 自带 CREATE SCHEMA,而目标(新容器或 Supabase)恒有同名 schema →
//     pre-data 阶段的 schema "already exists" 是两类目标共同的预期冲突。
import { spawn } from "node:child_process";
import type { ExtensionInfo } from "./manifest.js";
import { resolvePgRestoreBin } from "./pgbin.js";
import { dumpUrlFor, connectPg } from "./supabase-ca.js";

export type RestoreTargetKind = "sandbox" | "supabase";

/** 主机名规范化:先按驱动语义百分号解码(pg-connection-string / libpq 都会解码主机名,
 * `supabase%2Ecom` 在驱动眼里就是 supabase.com),再剥掉合法的 DNS 根点(db.x.supabase.co. ≡
 * db.x.supabase.co)。身份比较不规范化 = 一个尾点或一个 %2E 就能绕过同源阻断(交叉审查)。 */
/**
 * 连接串任何位置解码后出现 NUL(或原文里的 %00)都视为启动包字段注入:驱动把 NUL 当字段分隔符,
 * 后面的内容(user=… / options=reference=…)会成为额外的启动参数,连接目标与身份判定脱节。
 * 合法连接串不存在 NUL,整串一刀切,不再逐字段追(交叉审查:query 值里的 NUL 同样能注入)。
 */
export function containsNul(connString: string): boolean {
  if (/%00/i.test(connString)) return true;
  try {
    return decodeURIComponent(connString).includes("\0");
  } catch {
    return connString.includes("\0");
  }
}

/** Supavisor 集群别名语法:用户名里出现字面量小写 `.cluster.`(handler_helpers.ex),之后全是别名。 */
export function isClusterAliasUsername(username: string): boolean {
  return username.includes(".cluster.");
}

export function normalizeHost(hostname: string): string {
  let decoded = hostname;
  try {
    decoded = decodeURIComponent(hostname);
  } catch {
    // 非法百分号序列:驱动同样解不开,按原样比较
  }
  return decoded.replace(/\.$/, "").toLowerCase();
}

/**
 * 从连接串提取 Supabase 项目 ref(纯函数):直连主机 `db.<ref>.supabase.co` 或
 * pooler 用户名 `<role>.<ref>`:Supavisor 在**最后一个点**切分租户(handler_helpers.ex),角色名
 * 可以含大写、连字符甚至点,所以角色段不做限制、只认最后一段 ref;并且必须是 Supabase pooler
 * 主机——同样形状的用户名落在别的主机上不是 Supabase 租户身份(交叉审查)。
 * 放在引擎层:备份端(写 manifest.sourceProjectRef)
 * 与恢复端(同源阻断)共用同一个身份判定。非 Supabase 形态返回 null。
 */
export function projectRefOf(connString: string): string | null {
  if (containsNul(connString)) return null;
  try {
    const url = new URL(connString);
    const direct = normalizeHost(url.hostname).match(/^db\.([a-z0-9]{16,})\.supabase\.co$/);
    if (direct) return direct[1];
    // 用户名必须先解码再匹配:URL 解析器保留百分号编码,而 pg/libpq 会解码——
    // postgres%2Eref 在驱动眼里就是 postgres.ref,不解码 = 身份判定可被编码绕过
    // [\s\S] 而不是 .:Postgres 加引号的角色名可含换行,`.` 不匹配行终止符会让这类角色身份判定失效。
    // 解码后含 NUL 一律不认:启动包用 NUL 分隔字段,`postgres%00options%00reference=…%00x.<ref>`
    // 在驱动/Supavisor 眼里是 user=postgres 外加一个 options 字段,身份判定看到的 ref 是假的(交叉审查)
    const username = decodeURIComponent(url.username);
    // `<user>.cluster.<alias>` 是 Supavisor 的保留语法(只认小写 `.cluster.`,别名可含点):
    // 别名经成员关系解析到真正的项目,不是 ref,认不出就不猜;连接本身由 assertNoHostOverride 拒绝
    if (isClusterAliasUsername(username)) return null;
    const pooled = username.match(/^[\s\S]+\.([a-z0-9]{16,})$/);
    if (pooled && /\.pooler\.supabase\.com$/.test(normalizeHost(url.hostname))) return pooled[1];
    return null;
  } catch {
    return null;
  }
}

/** 从 Supabase Storage S3 端点(https://<ref>.storage.supabase.co/…)提取项目 ref。 */
export function refFromStorageEndpoint(endpoint: string): string | null {
  try {
    const match = normalizeHost(new URL(endpoint).hostname).match(/^([a-z0-9]{16,})\.(?:storage\.)?supabase\.co$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export interface ClassifiedPass {
  /** allowlist 命中数(环境预期/托管冲突)——如实入报告,不算失败 */
  expectedSkips: number;
  /** 真失败(压缩到 200 字符的错误块) */
  failures: string[];
}

export interface EngineResult {
  preData: ClassifiedPass;
  postData: ClassifiedPass;
  ok: boolean;
}

export function spawnPgRestore(
  bin: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    // 不透传原始 spawn Error:node 会把 spawnargs(含 --dbname 连接串=凭据)挂在
    // 异常对象上,顺着 reject 流进日志/Sentry。只保留启动失败的事实与 bin 名。
    proc.on("error", (error) =>
      reject(new Error(`${bin} failed to start: ${(error as NodeJS.ErrnoException).code ?? error.message}`))
    );
    proc.on("close", (code) => resolve({ code, stderr }));
  });
}

// 演练沙箱是裸 Postgres,Supabase 托管的 schema/角色必然缺席。post-data 里
// 引用它们的失败是"环境预期",不是备份坏了;其余失败才是演练要抓的。
// 真实 Supabase 目标不适用:角色/托管 schema 恒在,post-data 全严格。
export const SANDBOX_MANAGED_ERROR =
  /schema "(auth|storage|realtime|vault|extensions|graphql[a-z_]*)" does not exist|role "(authenticated|anon|service_role|supabase_[a-z_]+)" does not exist|\bauth\.uid\b|\bauth\.jwt\b/i;

// pre-data 唯一的预期冲突(见文件头注 3)。目标空门/新容器保证没有其他冲突源,
// 任何别的 "already exists" 都是真冲突,必须失败。
export const SCHEMA_EXISTS_ERROR = /schema "[^"]+" already exists/i;

const NEVER_MATCH = /(?!)/;

/**
 * 把 pg_restore 的 stderr 拆成单个错误块并按 allowlist 分类。
 * 只对 ERROR 原因行分类,不看 "Command was:" 之后的语句文本——否则一个恰好
 * 引用 auth.uid 的用户对象因"损坏/语法错误"失败时,会被误判成预期跳过。
 */
export function classifyBlocks(stderr: string, allow: RegExp): ClassifiedPass {
  const blocks = stderr
    .split(/(?=pg_restore: error:)/)
    .filter((b) => /pg_restore: error:/.test(b));
  let expectedSkips = 0;
  const failures: string[] = [];
  for (const block of blocks) {
    const cause = block.split(/Command was:/i)[0];
    if (allow.test(cause)) {
      expectedSkips += 1;
    } else {
      failures.push(block.replace(/\s+/g, " ").trim().slice(0, 200));
    }
  }
  return { expectedSkips, failures };
}

/**
 * 一遍恢复的最终裁决,两条独立规则:
 * 1. 被信号杀死(code=null)**无条件失败**——即使 stderr 里已有被 allowlist 解释的
 *    错误块。真实目标恒有一个预期 schema 跳过,若跳过能抵扣信号死亡,中途被 OOM/kill
 *    的半截恢复就会被报成功(评审第 7 轮抓出的假成功路径)。
 * 2. 非零退出且零错误块(归档器致命错、非英文 locale…)同样不能谎报成功。
 *    非零退出但每个错误都已分类 = pg_restore 对被忽略错误的正常退出形态,通过。
 */
export function finalizePass(
  code: number | null,
  stderr: string,
  classified: ClassifiedPass
): ClassifiedPass {
  const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 200) || "(no stderr)";
  if (code === null) {
    return {
      ...classified,
      failures: [...classified.failures, `pg_restore was killed by a signal: ${detail}`],
    };
  }
  if (code !== 0 && classified.expectedSkips === 0 && classified.failures.length === 0) {
    return { ...classified, failures: [`pg_restore exited with code ${code}: ${detail}`] };
  }
  return classified;
}

/** 标识符转义(内嵌引号翻倍)。导出:任何把目录里读到的名字拼进 SQL 的地方都必须用它。 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 恢复前把 manifest 记录的扩展装进目标(--schema 转储不含 CREATE EXTENSION)。
 * 必须装进与源库相同的 schema:dump 里的类型是限定名(如 extensions.vector)。
 * 装不上的扩展如实收集返回,由调用方按目标类型裁决:沙箱记录后继续(托管扩展
 * 本就装不上,public 转储通常不引用),真实目标应当阻断(用户能在 dashboard 开启)。
 */
export async function installExtensions(
  connString: string,
  extensions: ExtensionInfo[]
): Promise<string[]> {
  if (!extensions.length) return [];
  // pgConnectOptions:Supabase 主机自动带打包根 CA(node-pg 把 require 按 verify-full
  // 处理,裸 Client 对 pooler 必报 self-signed chain);沙箱等非 Supabase 目标原样透传
  const client = await connectPg(connString);
  const unavailable: string[] = [];
  try {
    for (const ext of extensions) {
      try {
        await client.query(`create schema if not exists ${quoteIdent(ext.schema)}`);
        // CASCADE 自动带上依赖扩展,免受 manifest 里的安装顺序摆布
        await client.query(
          `create extension if not exists ${quoteIdent(ext.name)} schema ${quoteIdent(ext.schema)} cascade`
        );
      } catch {
        unavailable.push(ext.name);
      }
    }
  } finally {
    await client.end();
  }
  return unavailable;
}

/**
 * 两遍恢复(真实首演炸出的设计,现为 drill 与真实恢复共用):
 * 1. pre-data+data —— 表结构 + 数据。除 schema 冲突(预期)外任何错误都是硬失败。
 * 2. post-data —— 用户自己的索引/约束/触发器必须恢复成功;allowlist 按目标类型:
 *    沙箱豁免 Supabase 托管对象引用,真实 Supabase 目标零豁免。
 */
/**
 * 凭据不进 argv(D6 同源要求):连接串里的密码对 `ps` 全程可见——拆出来经
 * PGPASSWORD 环境变量传给 libpq,argv 里的 URL 不再携带。解析不了的连接串
 * 原样透传(libpq 自己适配的形态,不在这里破坏)。
 */
export function credentialSafeDbArgs(connString: string): { url: string; env: NodeJS.ProcessEnv } {
  let url: URL;
  try {
    url = new URL(connString);
  } catch {
    // 非 URL(libpq keyword)形态拆不了密码——含内联密码的一律拒绝,不赌
    if (/\bpassword\s*=/i.test(connString)) {
      throw new Error(
        "keyword-style connection strings with an inline password are not accepted — " +
          "use the URL form; the password is moved into PGPASSWORD automatically"
      );
    }
    return { url: connString, env: {} };
  }
  let password = "";
  if (url.password) {
    try {
      password = decodeURIComponent(url.password);
    } catch {
      // 编码坏了不许 fail-open(评审第 13 轮):原样放行 = 密码整段留在 argv
      throw new Error(
        "the connection string password contains malformed percent-encoding — " +
          "fix the URL; refusing to pass it through argv"
      );
    }
    url.password = "";
  }
  // ?password= 同样不许进 argv(libpq 认它)。剥参按**解码后的键名**匹配
  // (pass%77ord= 也是 password=,评审第 15 轮),不用 URLSearchParams.delete:
  // 它会重序列化其余参数(%20 变 +),libpq 按字面处理,options 之类会被改坏
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (rawQuery) {
    const kept: string[] = [];
    const queryPasswords: string[] = [];
    for (const part of rawQuery.split("&")) {
      const eq = part.indexOf("=");
      const rawKey = eq === -1 ? part : part.slice(0, eq);
      let key: string;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, "%20"));
      } catch {
        key = rawKey;
      }
      if (/^password$/i.test(key)) {
        const rawValue = eq === -1 ? "" : part.slice(eq + 1);
        try {
          const value = decodeURIComponent(rawValue.replace(/\+/g, "%20"));
          if (value) queryPasswords.push(value);
        } catch {
          throw new Error(
            "the connection string ?password= value contains malformed percent-encoding — " +
              "fix the URL; refusing to pass it through argv"
          );
        }
      } else {
        kept.push(part);
      }
    }
    if (queryPasswords.length) {
      // authority 与查询、以及重复查询项之间不一致:libpq 的取值优先级和我们的猜测
      // 可能不同,预检用 A 通过、pg_restore 用 B 失败的分叉不可接受——直接拒绝
      const distinct = new Set(password ? [password, ...queryPasswords] : queryPasswords);
      if (distinct.size > 1) {
        throw new Error(
          "the connection string carries two different passwords (authority/?password=) — remove one"
        );
      }
      password = [...distinct][0];
      url.search = kept.length ? `?${kept.join("&")}` : "";
    }
  }
  return { url: url.toString(), env: password ? { PGPASSWORD: password } : {} };
}

/**
 * 拒绝连接串里的 host/hostaddr/user 查询覆盖:驱动会让它们改写实际连接目标/租户——
 * 身份判定(ref/主机)看的是 authority,读写却发生在别处。备份侧(源身份自记)与
 * 恢复侧(确认门/同源阻断)共用本检查。
 * Supabase pooler 主机上再拒绝**任何** `?options=`:Supavisor 从 options 里解析 `reference=<ref>`
 * 并让它优先于用户名里的租户段(handler_helpers.ex),而且会再解一次编码、认反斜杠转义——
 * 试图识别"哪种 options 值是租户覆盖"是在追它的解析器,`%2572eference` 这类双重编码就绕过了
 * (交叉审查)。pooler 串本来就不需要 options,整个参数一律拒绝;非 pooler 主机(普通 Postgres
 * 目标)的 options 没有租户语义,照常放行。
 */
export function assertNoHostOverride(connString: string): void {
  // 整串 NUL 检查放在 URL 解析之前:query 值、路径、任何位置的 NUL 都是启动包注入,
  // libpq 稍后也会拒,但驱动侧先发出的启动包已经到了 pooler——在任何连接之前就拒
  if (containsNul(connString)) {
    throw new Error("connection string contains a NUL byte — use a plain connection string.");
  }
  // 解析不了的连接串直接拒:曾经"放行让 pg 自己报错",但 pg 的解析器比 WHATWG URL 宽
  // (`postgresql://user@/db?host=…` 这类串 pg 接受、这里解析失败),放行 = 身份判定为空却照样连接
  // (交叉审查)。校验逻辑放在 try 外面——曾按文案里有没有 "override" 决定重抛,新理由一措辞不同就被吞。
  let url: URL;
  try {
    url = new URL(connString);
  } catch {
    throw new Error(
      "connection string could not be parsed as a URL — use a plain postgresql://user:password@host:port/database string."
    );
  }
  const params = url.searchParams;
  const isSupabasePooler = /\.pooler\.supabase\.com$/.test(normalizeHost(url.hostname));
  let username = url.username;
  try {
    username = decodeURIComponent(url.username);
  } catch {
    // 非法编码:驱动同样解不开,按原样看
  }
  // 集群别名连接:我们解析不出它真正路由到哪个项目,身份判定为空 → 同源/目标一致性都没法保证,
  // 在任何 I/O 之前拒绝,而不是让"null 身份"静默放行
  if (isSupabasePooler && isClusterAliasUsername(username)) {
    throw new Error(
      "connection string uses Supavisor's <user>.cluster.<alias> syntax — BackupDrill cannot resolve which project " +
        "the alias routes to, so identity checks cannot run. Use the project's own pooler string (<user>.<project-ref>)."
    );
  }
  for (const key of params.keys()) {
    if (/^(host|hostaddr|user)$/i.test(key)) {
      throw new Error(
        `connection string carries a ?${key}= override — the effective server/identity would ` +
          `differ from the URL authority that identity checks inspect. Use a plain connection string.`
      );
    }
    if (isSupabasePooler && /^options$/i.test(key)) {
      throw new Error(
        "connection string carries ?options= on a Supabase pooler host — the pooler reads a tenant override " +
          "(reference=…) from it, so identity checks could not trust the username. Remove ?options= entirely."
      );
    }
  }
}

export async function restoreDatabaseArtifact(opts: {
  dumpPath: string;
  connString: string;
  target: RestoreTargetKind;
}): Promise<EngineResult> {
  const bin = resolvePgRestoreBin();
  // TLS 全链路 verify-full(创始人承诺项):pg_restore 与 pg_dump 同一改写——
  // Supabase 主机强制 verify-full + 打包根 CA(libpq 的 require 不验证书,
  // 中间人可拿到连接与数据);沙箱/外部主机原样透传。先改写 SSL 再拆密码。
  const { url, env } = credentialSafeDbArgs(dumpUrlFor(opts.connString));
  const common = ["--no-owner", "--no-privileges", "--dbname", url, opts.dumpPath];

  const first = await spawnPgRestore(bin, ["--section=pre-data", "--section=data", ...common], env);
  const preData = finalizePass(
    first.code,
    first.stderr,
    classifyBlocks(first.stderr, SCHEMA_EXISTS_ERROR)
  );
  if (preData.failures.length) {
    return { preData, postData: { expectedSkips: 0, failures: [] }, ok: false };
  }

  const second = await spawnPgRestore(bin, ["--section=post-data", ...common], env);
  const postData = finalizePass(
    second.code,
    second.stderr,
    classifyBlocks(second.stderr, opts.target === "sandbox" ? SANDBOX_MANAGED_ERROR : NEVER_MATCH)
  );

  return { preData, postData, ok: postData.failures.length === 0 };
}
