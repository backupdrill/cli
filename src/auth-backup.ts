import pg from "pg";
import { attachPgErrorGuard, pgConnectOptions } from "./supabase-ca.js";
import type { AuthSection, AuthTriggerInfo, AuthPolicyInfo } from "./manifest.js";
import { PENDING_AUTH_COPY_VALUES } from "./auth-archive.js";

/**
 * Supabase Auth 用户(auth.users + auth.identities)的备份。
 *
 * 只备这两张表:用户 ID、邮箱、密码哈希、metadata、登录方式。sessions、refresh token、MFA 因子、
 * SSO 配置一律不备——恢复到新项目后用户重新登录一次即可,MFA 因子可能用旧项目的密钥加密过,
 * 带过去反而可能把用户锁在外面。2.11.1 起 auth.users 里待处理的找回密码、邮箱确认等 token 在上传前就抹掉
 * (见 auth-archive.ts),pg_dump 的参数不变。
 *
 * 不打扰现有备份是硬约束:
 *  - "off"(库调用的默认值)时,备份命令、上传的文件、manifest 与没有这个功能时逐字节一致。
 *  - 主 dump 的参数永远不动;Auth 一侧任何失败都不影响主 dump。
 *  - 默认开启("default")时,读不到、不支持、出错都只记进 manifest、打警告,不让备份失败;
 *    只有调用方显式要求("on")时,出错才算失败。
 */
export type AuthMode = "off" | "default" | "on";

export const AUTH_TABLES = ["users", "identities"] as const;

/** auth.dump 的技术上限:对应数百万用户或巨大的 metadata。超过就跳过,不拖慢和撑爆演练与恢复 */
export const AUTH_DUMP_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 把一个 pg_dump 的 --schema 模式转成正则。只解析最简单、两边规则一定一致的写法:
 *  - 双引号外:普通字符(字母折成小写、数字、_、$)和 * 任意串、? 任意一个字符;
 *  - 双引号内:按字面、保留大小写,"" 表示一个双引号。
 * 其余写法(方括号、括号、|、+、{}、^、反斜杠,以及"库.schema"的点)走的是 PostgreSQL 自己的正则,
 * 和 JavaScript 不完全一样(例如 [[:alpha:]] 这类字符类),一律返回 null,调用方按"可能包含"处理。
 */
function schemaPatternRegex(pattern: string): RegExp | null {
  let re = "";
  let quoted = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '"') {
      if (quoted && pattern[i + 1] === '"') {
        re += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (quoted) {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "$") re += "\\$";
    else if (/[A-Za-z0-9_]/.test(ch)) re += ch.toLowerCase();
    else return null;
  }
  return new RegExp(`^(?:${re})$`);
}

/**
 * schemas 配置和 Auth 备份的关系。单独的 Auth 备份只在每一项都是普通 schema 名字时才做:
 * 模式写法(通配、正则、"库.schema")由 PostgreSQL 自己解析,我们在这里算不准它最终选中哪些 schema,
 * 也就没法可靠地判断"会不会重复导出"和"恢复时目标里哪些 schema 该是空的"——干脆不做。
 *  - "yes":明写了 auth(主 dump 里已经有),或某个模式确定匹配得到 auth(例如 "*");
 *  - "maybe":有模式写法,而又不能确定它包含 auth;
 *  - "no":全是普通名字,且没有 auth。
 */
export function authInSchemas(schemas: string[]): "yes" | "maybe" | "no" {
  let maybe = false;
  for (const pattern of schemas) {
    const plain = plainSchemaName(pattern);
    if (plain === "auth") return "yes";
    if (plain !== null) continue;
    if (schemaPatternRegex(pattern)?.test("auth")) return "yes";
    maybe = true;
  }
  return maybe ? "maybe" : "no";
}

/**
 * 普通 schema 名字:不加引号、只有字母数字和下划线,按 pg_dump 的规则折成小写。其余一律返回 null,
 * 按模式写法处理(不另备 Auth)。名字会进 RECOVERY.md 里给人复制的 SQL 和 shell,只收这种最朴素的,
 * 加引号的名字(可以含换行、引号、$$)不给任何拼接出错的机会
 */
export function plainSchemaName(pattern: string): string | null {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(pattern) ? pattern.toLowerCase() : null;
}

/** 默认模式用:确定会、或说不准,都算"可能已含 auth"——宁可少做,不碰现有备份 */
export function schemasMayIncludeAuth(schemas: string[]): boolean {
  return authInSchemas(schemas) !== "no";
}

/**
 * 连库,但能被 signal 随时打断:到点时直接断开连接,不管它还在连接池里排队、还是正在跑查询。
 * Auth 这两条连接都在主 dump 之前用,绝不能让它们占着连接、把数据库备份堵在后面。
 */
export async function connectCancellable(databaseUrl: string, signal?: AbortSignal): Promise<pg.Client> {
  if (signal?.aborted) throw new Error("stopped by the caller");
  // 握手最多 20 秒:连接池排队、网络卡住时不能一直挂着,更不能让 CLI 进程在备份做完后迟迟退不出去
  const client = new pg.Client({ ...pgConnectOptions(databaseUrl), connectionTimeoutMillis: 20_000 });
  attachPgErrorGuard(client);
  let connected = false;
  const onAbort = () => {
    const stream = (client as unknown as { connection?: { stream?: { destroy(error?: Error): void } } }).connection?.stream;
    if (!connected) {
      // 握手中途:带着错误销毁 socket,connect() 随之 reject。不能先调 end():它把 client 标成
      // "主动结束",node-pg 之后就不再回调 connect(),connect() 永远等不到结果
      stream?.destroy(new Error("stopped by the caller"));
      return;
    }
    // 连上之后:直接销毁 socket,进行中的查询随之 reject(end() 在握手后是优雅关闭,对方不回应就一直等)
    stream?.destroy();
    void client.end().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect();
    connected = true;
  } catch (error) {
    signal?.removeEventListener("abort", onAbort);
    throw error;
  }
  // 连上之后仍然听着:查询进行中被叫停也立刻断开;client 结束时把监听摘掉
  client.once("end", () => signal?.removeEventListener("abort", onAbort));
  // 服务端在等锁时察觉不到客户端已经走了,会一直占着连接等到锁超时。PG 14 起可以让它每秒查一次,
  // 断开后很快收手、把连接还回连接池;更老的服务端不认这个参数,忽略即可
  await client.query("set client_connection_check_interval = '1s'").catch(() => {});
  return client;
}

/** 引号个数是奇数 = 有一个没闭合(文字在值中间被截断了):从最后那个引号起到结尾都当成值 */
function closeDanglingQuote(text: string, quote: "'" | '"'): string {
  const count = text.split(quote).length - 1;
  if (count % 2 === 0) return text;
  return `${text.slice(0, text.lastIndexOf(quote))}${quote}…${quote}`;
}

/**
 * 报错文字里可能是用户数据的部分换成 "…":冒号后面引起来的值(例如 invalid input syntax for type uuid: "…")、
 * 单引号字面量、邮箱、UUID。表名、约束名这类标识符(relation "x"、constraint "y")留着,排查要用
 */
export function redactValues(text: string): string {
  return closeDanglingQuote(closeDanglingQuote(text, "'"), '"')
    .replace(/:\s*"(?:[^"]|"")*"/g, ': "…"')
    .replace(/'(?:[^']|'')*'/g, "'…'")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "…")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "…");
}

/** 共享快照:导出快照的连接 + 快照号。导出连接只需活到两份 pg_dump 都导入快照为止 */
export interface SharedSnapshot {
  id: string;
  /** 提交并关闭导出连接;重复调用无害 */
  release(): Promise<void>;
}

/**
 * 开一个 REPEATABLE READ 只读事务导出快照。主 dump、auth dump、统计都导入这一个快照,
 * 两份归档看到的是同一时刻的库(否则两次导出之间的注册、删号会让两份对不上)。
 * 失败就返回 null:调用方按今天的方式导出主 dump,只把 Auth 段标掉。
 */
export async function exportSharedSnapshot(databaseUrl: string, signal?: AbortSignal): Promise<SharedSnapshot | null> {
  let client: pg.Client | null = null;
  try {
    client = await connectCancellable(databaseUrl, signal);
    // 兜底:进程卡住时也不让这个空闲事务一直挂着(正常情况几秒内就释放);语句本身也不许久等
    await client.query("set idle_in_transaction_session_timeout = '10min'");
    await client.query("set statement_timeout = '30s'");
    await client.query("begin isolation level repeatable read read only");
    const res = await client.query<{ id: string }>("select pg_export_snapshot() as id");
    const id = res.rows[0]?.id;
    if (!id) throw new Error("pg_export_snapshot returned nothing");
    const held = client;
    let released = false;
    return {
      id,
      async release() {
        if (released) return;
        released = true;
        await held.query("commit").catch(() => {});
        await held.end().catch(() => {});
      },
    };
  } catch {
    await client?.end().catch(() => {});
    return null;
  }
}

/** 统计结果:只读,和两份 dump 同一个快照 */
export type AuthInspection =
  | { readable: false; reason: "no_auth_schema" | "no_permission" }
  | {
      readable: true;
      users: number;
      identities: number;
      passwordHashes: AuthSection["passwordHashes"];
      anonymousUsers: number;
      ssoUsers: number;
      mfaUsers: number | null;
      triggers: AuthTriggerInfo[];
      policies: AuthPolicyInfo[];
      grants: Array<{ table: string; grantee: string; privilege: string }>;
      /** 抹掉待处理 token 之后会被 auth.users 上的约束拒绝的地方(见 pendingTokenConflicts);空 = 可以抹 */
      scrubConflicts: string[];
    };

// Supabase 平台自己的 schema。触发器函数或策略引用的函数在这些 schema 里时算平台对象
const PLATFORM_SCHEMAS = [
  "auth", "storage", "realtime", "extensions", "supabase_functions", "graphql", "graphql_public",
  "net", "pgsodium", "pgsodium_masks", "vault", "pg_catalog", "information_schema",
];

/**
 * 在另一个连接里导入共享快照做统计。统计出错只影响这个连接,导出快照的事务和主 dump 不受牵连。
 * 能不能读到全部行要先确认:auth.users 开着 RLS,角色既不是超级用户、又没有 BYPASSRLS 时,
 * pg_dump 照样"成功",导出的却是空表——看着干净,其实什么都没备上。
 */
export async function inspectAuth(
  databaseUrl: string,
  snapshotId: string,
  signal?: AbortSignal
): Promise<AuthInspection> {
  const client = await connectCancellable(databaseUrl, signal);
  try {
    // 这些统计跑在主 dump 之前:auth 表上有别人的锁(例如正在跑的 Auth 迁移)时不能陪着等,
    // 超时就让 Auth 这次不备,主 dump 照常
    await client.query("set lock_timeout = '5s'");
    await client.query("set statement_timeout = '60s'");
    await client.query("begin isolation level repeatable read read only");
    // 快照号来自 pg_export_snapshot(),格式固定;仍按字面量转义,不拼裸值
    await client.query(`set transaction snapshot ${client.escapeLiteral(snapshotId)}`);

    // 存在与权限都按 OID 从系统目录查:对 auth schema 没有 USAGE 的角色,按名字解析
    // (to_regclass、'auth.users'::regclass、has_table_privilege('auth.users', …))会直接报错,
    // 而这种情况该记"无权读取、跳过",不是"失败"
    const found = await client.query<{ tables: string; ok: boolean }>(
      `select count(*) as tables,
              coalesce(bool_and(has_schema_privilege(n.oid, 'USAGE')
                            and has_table_privilege(c.oid, 'SELECT')
                            and (r.rolsuper or r.rolbypassrls or not c.relrowsecurity)), false) as ok
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles r on r.rolname = current_user
        where n.nspname = 'auth' and c.relname in ('users', 'identities') and c.relkind in ('r', 'p')`
    );
    if (Number(found.rows[0]?.tables) !== 2) return { readable: false, reason: "no_auth_schema" };
    if (!found.rows[0]?.ok) return { readable: false, reason: "no_permission" };

    const counts = await client.query<{
      users: string; identities: string; none: string; portable: string; encrypted: string;
      unrecognized: string; anonymous: string; sso: string;
    }>(
      `select (select count(*) from auth.users) as users,
              (select count(*) from auth.identities) as identities,
              count(*) filter (where encrypted_password is null or encrypted_password = '') as none,
              count(*) filter (where encrypted_password ~ '^\\$2[abxy]?\\$'
                                  or encrypted_password ~ '^\\$argon2(id|i|d)\\$'
                                  or encrypted_password ~ '^\\$fbscrypt\\$') as portable,
              count(*) filter (where encrypted_password like '{%'
                                 and encrypted_password like '%"alg":"aes-gcm-hkdf"%') as encrypted,
              count(*) filter (where encrypted_password is not null and encrypted_password <> ''
                                 and not (encrypted_password ~ '^\\$2[abxy]?\\$'
                                       or encrypted_password ~ '^\\$argon2(id|i|d)\\$'
                                       or encrypted_password ~ '^\\$fbscrypt\\$')
                                 and not (encrypted_password like '{%'
                                      and encrypted_password like '%"alg":"aes-gcm-hkdf"%')) as unrecognized,
              count(*) filter (where coalesce((to_jsonb(u) ->> 'is_anonymous')::boolean, false)) as anonymous,
              count(*) filter (where coalesce((to_jsonb(u) ->> 'is_sso_user')::boolean, false)) as sso
         from auth.users u`
    );
    const c = counts.rows[0];

    // MFA 人数是可选统计:表不存在或没权限都不该让 Auth 段失败,出错回滚到保存点、记为未知
    let mfaUsers: number | null = null;
    await client.query("savepoint mfa");
    try {
      const mfa = await client.query<{ n: string }>(
        `select count(distinct user_id) as n from auth.mfa_factors where status::text = 'verified'`
      );
      mfaUsers = Number(mfa.rows[0].n);
      await client.query("release savepoint mfa");
    } catch {
      await client.query("rollback to savepoint mfa");
    }

    const triggers = await client.query<{
      table: string; name: string; enabled: string; function_schema: string; function_name: string;
      dependency_schemas: string[];
    }>(
      // dependency_schemas:触发器依赖的全部函数(触发函数本身 + WHEN 条件里调用的)所在 schema
      `select c.relname as table, t.tgname as name, t.tgenabled::text as enabled,
              fn.nspname as function_schema, p.proname as function_name,
              coalesce(array(
                select distinct dn.nspname::text
                  from pg_depend d
                  join pg_proc dp on dp.oid = d.refobjid and d.refclassid = 'pg_proc'::regclass
                  join pg_namespace dn on dn.oid = dp.pronamespace
                 where d.classid = 'pg_trigger'::regclass and d.objid = t.oid
                 order by 1), '{}'::text[]) as dependency_schemas
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_proc p on p.oid = t.tgfoid
         join pg_namespace fn on fn.oid = p.pronamespace
        where c.oid in ('auth.users'::regclass, 'auth.identities'::regclass)
          and not t.tgisinternal
        order by 1, 2`
    );
    const policies = await client.query<{ table: string; name: string; function_schemas: string[] }>(
      // 策略表达式里引用到的函数所在 schema(USING 与 WITH CHECK 都算),用来判断依赖在不在备份里
      `select c.relname as table, pol.polname as name,
              -- ::text:node-pg 只解析 text[],name[] 会原样返回成 "{a,b}" 字符串
              coalesce(array(
                select distinct n.nspname::text
                  from pg_depend d
                  join pg_proc p on p.oid = d.refobjid and d.refclassid = 'pg_proc'::regclass
                  join pg_namespace n on n.oid = p.pronamespace
                 where d.classid = 'pg_policy'::regclass and d.objid = pol.oid
                 order by 1), '{}'::text[]) as function_schemas
         from pg_policy pol
         join pg_class c on c.oid = pol.polrelid
        where c.oid in ('auth.users'::regclass, 'auth.identities'::regclass)
        order by 1, 2`
    );

    const grants = await client.query<{ table: string; grantee: string; privilege: string }>(
      `select c.relname as table,
              case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
              a.privilege_type as privilege
         from pg_class c, aclexplode(c.relacl) a
        where c.oid in ('auth.users'::regclass, 'auth.identities'::regclass)
        order by 1, 2, 3`
    );

    const scrubConflicts = await pendingTokenConflicts(client);

    await client.query("commit");
    return {
      readable: true,
      scrubConflicts,
      grants: grants.rows,
      users: Number(c.users),
      identities: Number(c.identities),
      passwordHashes: {
        none: Number(c.none),
        portable: Number(c.portable),
        encrypted: Number(c.encrypted),
        unrecognized: Number(c.unrecognized),
      },
      anonymousUsers: Number(c.anonymous),
      ssoUsers: Number(c.sso),
      mfaUsers,
      triggers: triggers.rows.map((t) => ({
        table: t.table,
        name: t.name,
        enabled: t.enabled as AuthTriggerInfo["enabled"],
        functionSchema: t.function_schema,
        functionName: t.function_name,
        dependencySchemas: t.dependency_schemas,
      })),
      policies: policies.rows.map((p) => ({
        table: p.table,
        name: p.name,
        functionSchemas: p.function_schemas.filter((s) => !PLATFORM_SCHEMAS.includes(s)),
      })),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * 2.11.1 起 auth.dump 里待处理的 token 被抹成空串、发送时间成 NULL、确认状态成 0(见 auth-archive.ts)。
 * 用户自己在 auth.users 上加的约束可能不接受这些值:例如 CHECK (recovery_token <> '')、发送时间 NOT NULL、
 * token 列上不带条件的唯一索引(所有行都成了 '',撞在一起)。原样的归档恢复得了、抹过的却恢复不了,
 * 这比不抹更糟,所以备份时就在同一个只读快照里查:把每一行换成抹过的样子,逐条套用会在 COPY 时检查的约束
 * (NOT NULL、CHECK、唯一索引),套不上就不写 auth.dump,Auth 这一节记失败、写明原因。
 * 精确判断不了的(域类型、排他约束、外键)一律按冲突处理。Supabase 自带的结构能过:
 * token 上的唯一索引带着 WHERE token !~ '^[0-9 ]*$',空串不在索引里;确认状态的 CHECK 是 0 到 2。
 * 只读:全是 select,跑在 inspectAuth 已经开着的 REPEATABLE READ READ ONLY 事务里,不另开连接。
 * 某一条检查自己出错(比如约束里调用了角色没权限的函数)也按冲突处理,宁可这次不备 Auth
 */
async function pendingTokenConflicts(client: pg.Client): Promise<string[]> {
  const columns = await client.query<{ attnum: number; name: string; type: string; notnull: boolean; domain: boolean }>(
    `select a.attnum, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
            t.typtype = 'd' as domain
       from pg_attribute a join pg_type t on t.oid = a.atttypid
      where a.attrelid = 'auth.users'::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum`
  );
  const blanked = new Map(PENDING_AUTH_COPY_VALUES);
  const touched = columns.rows.filter((c) => blanked.has(c.name));
  if (!touched.length) return [];
  const conflicts: string[] = [];
  for (const c of touched) {
    if (c.domain) conflicts.push(`column ${c.name} has a domain type`);
    if (c.notnull && blanked.get(c.name) === "\\N") conflicts.push(`column ${c.name} is NOT NULL`);
  }
  if (conflicts.length) return conflicts;
  const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const literal = (copyValue: string, type: string) =>
    copyValue === "\\N" ? `null::${type}` : `${client.escapeLiteral(copyValue)}::${type}`;
  // 每一行抹过之后的样子;生成列在 COPY 里没有,照原样带上(约束里也可能用到)
  const rows =
    `(select ${columns.rows
      .map((c) => (blanked.has(c.name) ? `${literal(blanked.get(c.name)!, c.type)} as ${ident(c.name)}` : ident(c.name)))
      .join(", ")} from auth.users) u`;
  const attnums = touched.map((c) => c.attnum);
  // 一条检查出错只算这一条冲突,不连累别的检查和外面的事务
  const holds = async (what: string, sql: string) => {
    await client.query("savepoint scrub_check");
    try {
      const r = await client.query<{ bad: boolean }>(sql);
      await client.query("release savepoint scrub_check");
      if (r.rows[0]?.bad) conflicts.push(what);
    } catch {
      await client.query("rollback to savepoint scrub_check");
      conflicts.push(`${what} (couldn't be checked)`);
    }
  };
  const constraints = await client.query<{ name: string; type: string; expr: string | null }>(
    `select conname as name, contype::text as type,
            case when contype = 'c' then pg_get_expr(conbin, conrelid) end as expr
       from pg_constraint
      where conrelid = 'auth.users'::regclass and conkey && $1::int2[] and contype in ('c', 'f', 'x')
      order by 1`,
    [attnums]
  );
  for (const k of constraints.rows) {
    if (k.type !== "c" || !k.expr) {
      conflicts.push(`${k.type === "f" ? "foreign key" : "exclusion constraint"} ${k.name}`);
      continue;
    }
    // CHECK 结果为 NULL 也算通过,和 Postgres 自己一样
    await holds(`check constraint ${k.name}`, `select exists (select 1 from ${rows} where not coalesce((${k.expr}), true)) as bad`);
  }
  // 唯一索引:键列、表达式或 WHERE 条件里用到了被抹的列。索引键和条件按定义原样套在抹过的行上找重复
  const indexes = await client.query<{ name: string; keys: string[]; pred: string | null; nulls_distinct: boolean }>(
    `select c.relname as name,
            array(select pg_get_indexdef(i.indexrelid, k, true) from generate_series(1, i.indnkeyatts) k) as keys,
            pg_get_expr(i.indpred, i.indrelid) as pred,
            not coalesce((to_jsonb(i) ->> 'indnullsnotdistinct')::boolean, false) as nulls_distinct
       from pg_index i join pg_class c on c.oid = i.indexrelid
      where i.indrelid = 'auth.users'::regclass and i.indisunique
        and (i.indkey::int2[] && $1::int2[]
             or exists (select 1 from pg_depend d
                         where d.classid = 'pg_class'::regclass and d.objid = i.indexrelid
                           and d.refobjid = i.indrelid and d.refobjsubid = any($1::int2[])))
      order by 1`,
    [attnums]
  );
  for (const ix of indexes.rows) {
    const where = [ix.pred ? `(${ix.pred})` : "true", ...(ix.nulls_distinct ? ix.keys.map((key) => `(${key}) is not null`) : [])];
    await holds(
      `unique index ${ix.name}`,
      `select exists (select 1 from ${rows} where ${where.join(" and ")} group by ${ix.keys.map((key) => `(${key})`).join(", ")} having count(*) > 1) as bad`
    );
  }
  return conflicts;
}

/**
 * schema 是否在这次备份里:按 pg_dump 读模式的规则匹配 schemas(含通配)。平台 schema 不算:
 * 用户自己建在 extensions 之类里的函数不在任何一份归档里,新项目里也没有。
 */
function schemaCovered(schema: string, backedUpSchemas: string[]): boolean {
  // 走到这里的 schemas 都是普通名字(带模式写法的根本不做 Auth 备份,见 authInSchemas)
  return backedUpSchemas.some((name) => plainSchemaName(name) === schema);
}

/** 触发器依赖的函数所在的全部 schema(触发函数 + WHEN 里调用的);旧记录没有 dependencySchemas 时只看触发函数 */
function triggerDependencies(t: AuthTriggerInfo): string[] {
  return [...new Set([t.functionSchema, ...(t.dependencySchemas ?? [])])];
}

// 自动补建的对象名只收普通标识符:名字会进 pg_restore -l 的筛选,也会出现在给人复制的命令里,
// 带引号、空格之类的名字一律交给手工步骤,杜绝任何拼接注入
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 恢复(含 RECOVERY.md 的手工步骤)自动补建的 Auth 表对象。只建同时满足下面几条的触发器:
 *  - 源库里是普通启用状态(O)。D 停用、R 只在复制会话触发的,在普通会话里本来就不起作用;
 *    A(总是触发)恢复时 pg_dump 会带一句 ENABLE ALWAYS,那需要表的属主身份,新项目里做不到。
 *  - 触发函数所在的 schema 在这次备份里(或是平台 schema),否则建不出来。
 *  - 名字是普通标识符。
 * 策略一律不自动建:CREATE POLICY 需要表的属主身份,新项目里 auth 两张表的属主是平台角色;
 * 放进单事务恢复里建不出来,会让整个恢复回滚。少了它们,这两张开着 RLS 的表对 API 角色一律拒绝,
 * 是收紧而不是放开。
 */
export function restorableAuthObjects(
  auth: { triggers: AuthTriggerInfo[]; policies: AuthPolicyInfo[] },
  backedUpSchemas: string[]
): { triggers: AuthTriggerInfo[] } {
  return {
    triggers: auth.triggers.filter(
      (t) =>
        t.enabled === "O" &&
        triggerDependencies(t).every((schema) => schemaCovered(schema, backedUpSchemas)) &&
        PLAIN_NAME.test(t.name)
    ),
  };
}

/**
 * 恢复时不会自动补建、需要人手处理的 Auth 表对象,写成给人看的句子。备份时提示一次(好让用户把缺的
 * schema 加进备份),RECOVERY.md 和恢复报告里列成手工步骤。
 */
export function manualAuthObjects(
  auth: { triggers: AuthTriggerInfo[]; policies: AuthPolicyInfo[] },
  backedUpSchemas: string[]
): string[] {
  const notes: string[] = [];
  for (const t of auth.triggers) {
    const on = `trigger ${JSON.stringify(t.name)} on auth.${t.table}`;
    if (t.enabled === "D" || t.enabled === "R") {
      notes.push(`${on} was ${t.enabled === "D" ? "disabled" : "replica-only"} at the source, so it isn't recreated`);
    } else if (triggerDependencies(t).some((schema) => !schemaCovered(schema, backedUpSchemas))) {
      const missing = triggerDependencies(t).filter((schema) => !schemaCovered(schema, backedUpSchemas));
      notes.push(
        `${on} calls ${t.functionSchema}.${t.functionName}()` +
          `${missing.length === 1 && missing[0] === t.functionSchema ? "" : ` and depends on functions in ${missing.join(", ")}`}, ` +
          `but ${missing.length === 1 ? `schema ${missing[0]} is` : `schemas ${missing.join(", ")} are`} not in this backup, ` +
          `so it can't be recreated until ${missing.length === 1 ? "that schema exists" : "those schemas exist"} on the target`
      );
    } else if (t.enabled === "A") {
      notes.push(`${on} fires in every session (ENABLE ALWAYS), which needs the table owner to set; recreate it by hand`);
    } else if (!PLAIN_NAME.test(t.name)) {
      notes.push(`${on} has a name that needs quoting; recreate it by hand`);
    }
  }
  for (const p of auth.policies) {
    const missing = p.functionSchemas.filter((s) => !schemaCovered(s, backedUpSchemas));
    notes.push(
      `policy ${JSON.stringify(p.name)} on auth.${p.table} isn't recreated automatically (creating a policy needs the table owner)` +
        (missing.length ? `; it also uses functions in ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in this backup` : "")
    );
  }
  return notes;
}

/** pg_dump 参数:只导两张表(结构 + 数据 + 它们上的索引、约束、触发器、策略),同一个共享快照 */
export function authDumpArgs(snapshotId: string): string[] {
  return [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    `--snapshot=${snapshotId}`,
    // 拿不到两张表的共享锁就别一直等(主 dump 的参数不加这个,保持原样)
    "--lock-wait-timeout=60s",
    ...AUTH_TABLES.map((t) => `--table=auth.${t}`),
  ];
}
