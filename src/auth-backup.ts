import type pg from "pg";
import { connectPg } from "./supabase-ca.js";
import type { AuthSection, AuthTriggerInfo, AuthPolicyInfo } from "./manifest.js";

/**
 * Supabase Auth 用户(auth.users + auth.identities)的备份。
 *
 * 只备这两张表:用户 ID、邮箱、密码哈希、metadata、登录方式。sessions、refresh token、MFA 因子、
 * SSO 配置一律不备——恢复到新项目后用户重新登录一次即可,MFA 因子可能用旧项目的密钥加密过,
 * 带过去反而可能把用户锁在外面。
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
 * 把一个 pg_dump 的 --schema 模式转成正则,规则照 psql 的模式写法(pg_dump 用的是同一套):
 *  - 双引号外:字母折成小写,* = 任意串,? = 任意一个字符,$ 按字面,其余正则字符保留正则含义;
 *  - 双引号内:按字面、保留大小写,"" 表示一个双引号;
 *  - 双引号外的 "." 是"库.schema"的分隔符——这种写法极少见,算不出就返回 null(调用方按"可能包含"处理)。
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
    if (ch === ".") return null;
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "$") re += "\\$";
    else re += ch.toLowerCase();
  }
  try {
    return new RegExp(`^(?:${re})$`);
  } catch {
    return null;
  }
}

/**
 * schemas 配置会不会已经把 auth 带进主 dump(明写了 auth,或者某个模式匹配得到 auth,例如 "*")。
 * 会的话今天就是这么备的;为了不改变它、也不重复导出,单独的 Auth 备份不做。
 * 算不清的模式按"会"处理:宁可少做,不碰现有备份。
 */
export function schemasMayIncludeAuth(schemas: string[]): boolean {
  return schemas.some((pattern) => {
    const re = schemaPatternRegex(pattern);
    return re === null || re.test("auth");
  });
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
export async function exportSharedSnapshot(databaseUrl: string): Promise<SharedSnapshot | null> {
  let client: pg.Client | null = null;
  try {
    client = await connectPg(databaseUrl);
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
export async function inspectAuth(databaseUrl: string, snapshotId: string): Promise<AuthInspection> {
  const client = await connectPg(databaseUrl);
  try {
    // 这些统计跑在主 dump 之前:auth 表上有别人的锁(例如正在跑的 Auth 迁移)时不能陪着等,
    // 超时就让 Auth 这次不备,主 dump 照常
    await client.query("set lock_timeout = '5s'");
    await client.query("set statement_timeout = '60s'");
    await client.query("begin isolation level repeatable read read only");
    // 快照号来自 pg_export_snapshot(),格式固定;仍按字面量转义,不拼裸值
    await client.query(`set transaction snapshot ${client.escapeLiteral(snapshotId)}`);

    const schema = await client.query<{ present: boolean }>(
      `select to_regclass('auth.users') is not null and to_regclass('auth.identities') is not null as present`
    );
    if (!schema.rows[0]?.present) return { readable: false, reason: "no_auth_schema" };

    const access = await client.query<{ ok: boolean }>(
      `select has_schema_privilege('auth', 'USAGE')
          and has_table_privilege('auth.users', 'SELECT')
          and has_table_privilege('auth.identities', 'SELECT')
          and (r.rolsuper or r.rolbypassrls
               or not exists (select 1 from pg_class c
                               where c.oid in ('auth.users'::regclass, 'auth.identities'::regclass)
                                 and c.relrowsecurity)) as ok
         from pg_roles r where r.rolname = current_user`
    );
    if (!access.rows[0]?.ok) return { readable: false, reason: "no_permission" };

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
    }>(
      `select c.relname as table, t.tgname as name, t.tgenabled::text as enabled,
              fn.nspname as function_schema, p.proname as function_name
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

    await client.query("commit");
    return {
      readable: true,
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
 * 触发器或策略依赖的函数不在这次备份的 schema 里(也不是平台 schema):恢复时建不出来。
 * 返回给人看的句子,备份时就提示,好让用户把那个 schema 加进备份。
 */
export function unbackedAuthDependencies(
  inspection: { triggers: AuthTriggerInfo[]; policies: AuthPolicyInfo[] },
  backedUpSchemas: string[]
): string[] {
  const covered = (schema: string) => backedUpSchemas.includes(schema) || PLATFORM_SCHEMAS.includes(schema);
  const notes: string[] = [];
  for (const t of inspection.triggers) {
    if (!covered(t.functionSchema)) {
      notes.push(
        `trigger ${t.name} on auth.${t.table} calls ${t.functionSchema}.${t.functionName}(), ` +
          `but schema ${t.functionSchema} is not in this backup — after a restore the trigger can't be created`
      );
    }
  }
  for (const p of inspection.policies) {
    const missing = p.functionSchemas.filter((s) => !covered(s));
    if (missing.length) {
      notes.push(
        `policy ${p.name} on auth.${p.table} uses functions in ${missing.join(", ")}, ` +
          `which ${missing.length === 1 ? "is" : "are"} not in this backup — after a restore the policy can't be created`
      );
    }
  }
  return notes;
}

/**
 * 恢复(含 RECOVERY.md 的手工步骤)要补建的 Auth 表对象。只建:
 *  - 源库里会触发的触发器(O 启用、A 总是);D 停用和 R 只在复制会话触发的在普通会话里本来就不起作用;
 *  - 依赖都在的对象:函数所在的 schema 在这次备份里(或是平台 schema)。
 * 依赖不在的建不出来——把它放进单事务恢复,会让整个恢复回滚。跳过它们,另行写进报告和手工步骤。
 */
export function restorableAuthObjects(
  auth: { triggers: AuthTriggerInfo[]; policies: AuthPolicyInfo[] },
  backedUpSchemas: string[]
): { triggers: AuthTriggerInfo[]; policies: AuthPolicyInfo[] } {
  const covered = (schema: string) => backedUpSchemas.includes(schema) || PLATFORM_SCHEMAS.includes(schema);
  return {
    triggers: auth.triggers.filter((t) => (t.enabled === "O" || t.enabled === "A") && covered(t.functionSchema)),
    policies: auth.policies.filter((p) => p.functionSchemas.every(covered)),
  };
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
