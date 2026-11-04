import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import type { Manifest } from "./manifest.js";
import { manualAuthObjects, redactValues, restorableAuthObjects } from "./auth-backup.js";
import { parseForeignKeys } from "./dump-sql.js";
import { addForeignKeys, type OrphanedForeignKey } from "./orphaned-foreign-keys.js";
import { resolvePgRestoreBin } from "./pgbin.js";
import { credentialSafeDbArgs, pgRestoreOutput, spawnPgRestore } from "./restore-engine.js";
import { connectPg } from "./supabase-ca.js";
import { interrupted } from "./interrupt.js";

/**
 * 演练里的 Auth 校验(2.10.0 起,附加模式)。
 *
 * 在演练照旧做完、通过与否已经定下之后,在同一个沙箱里:把 auth.dump 的两张表建出来、灌数据,
 * 补上之前因为沙箱没有 auth 表而跳过的外键,建可以自动恢复的触发器,再以 GoTrue 的身份模拟一次注册。
 * 结果只写进报告的 auth 一节,**不改变演练结论**,自己出错也只记在这一节里——上线初期先观察,
 * 是否计入结论由以后决定(PRD 增补 §0.1 第 5 条)。
 */
export interface AuthDrillReport {
  /** verified:全部对上;problems:有对不上的地方(见 summary);not_checked:这次没能检查 */
  status: "verified" | "problems" | "not_checked";
  /** 一句给人看的结论 */
  summary: string;
  users?: number;
  identities?: number;
  /** 指向 auth 表的外键:建成的条数、源库本来就有孤儿行(建成 NOT VALID)的、建不出来的 */
  foreignKeys?: { created: number; orphaned: OrphanedForeignKey[]; failed: string[] };
  triggers?: { created: string[]; failed: string[] };
  /** 不会自动恢复、要人手处理的对象 */
  manual?: string[];
  /** 模拟注册:ran=false 时说明为什么没跑 */
  signup?: { ran: boolean; ok?: boolean; detail?: string };
}

export interface AuthDumpForDrill {
  /** 下载到本地的 auth.dump;下载失败时为空,error 说明原因 */
  path?: string;
  error?: string;
}

// 报告会发给用户、进运营者告警,报错文字一律不带可能是数据的东西。
// PostgreSQL 的报错按 SQLSTATE 分:下面这些类别的主消息里只有对象名(表、列、约束、函数、角色),
// 留着方便排查;其余(触发器里 RAISE 的、数据格式错误之类,消息里可能带着行里的值)只给 SQLSTATE。
const SAFE_SQLSTATES = new Set([
  "42501", // 权限不足
  "42P01", "42883", "42703", "42704", "3F000", // 表、函数、列、对象、schema 不存在
  "42P07", "42710", // 已存在
  "23503", "23505", "23502", "23514", // 外键、唯一、非空、CHECK 约束
  "42804", "42846", // 类型不匹配
  "55P03", "57014", "40P01", // 锁超时、语句超时/取消、死锁
]);

function safeError(error: unknown): string {
  const e = error as { code?: string; message?: string };
  // 先对整行脱敏再截短:反过来会把一个被截成半截的引号值漏过去
  const firstLine = redactValues(String(e?.message ?? error).split("\n")[0]).slice(0, 300);
  if (typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) {
    return SAFE_SQLSTATES.has(e.code) ? `${firstLine} (SQLSTATE ${e.code})` : `SQLSTATE ${e.code}`;
  }
  return firstLine;
}

/** pg_restore 的 stderr 是一段文字,拿不到 SQLSTATE:只归成几类,不带原文 */
function safeRestoreError(code: number | null, stderr: string): string {
  const categories: Array<[RegExp, string]> = [
    [/already exists/i, "an object it creates already exists"],
    [/does not exist/i, "something it refers to doesn't exist"],
    [/permission denied|must be owner/i, "permission denied"],
    [/violates/i, "a constraint was violated"],
    [/no space left|out of memory|could not extend file/i, "the sandbox ran out of resources"],
  ];
  const category = categories.find(([re]) => re.test(stderr))?.[1];
  return `${category ? `${category} ` : ""}(pg_restore exited with code ${code})`;
}
async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// pg_restore -l 的条目行:"<id>; <oid> <oid> <类型> <schema> <名字> <属主>"
const tocType = (line: string): string | null => /^\d+; \d+ \d+ (.+)$/.exec(line)?.[1] ?? null;

const SIGNUP_USER_ID = "00000000-0000-4000-8000-00000000d211";
const SIGNUP_EMAIL = "drill-signup@backupdrill.invalid";

/** 给 NOT NULL 又没有默认值的列造一个合法的值;造不出来返回 null(就不模拟了) */
function syntheticValue(type: string, column: string): string | null {
  if (column === "id" || column === "user_id") return `'${SIGNUP_USER_ID}'::uuid`;
  if (column === "email") return `'${SIGNUP_EMAIL}'`;
  if (column === "provider") return "'email'";
  if (column === "provider_id") return `'${SIGNUP_USER_ID}'`;
  if (column === "identity_data") return `jsonb_build_object('sub', '${SIGNUP_USER_ID}', 'email', '${SIGNUP_EMAIL}')`;
  if (/^uuid$/.test(type)) return "'00000000-0000-4000-8000-000000000001'::uuid";
  if (/^(text|character varying|character)\b/.test(type)) return "'drill'";
  if (/^jsonb?$/.test(type)) return "'{}'";
  if (/^boolean$/.test(type)) return "false";
  if (/^(timestamp|date)/.test(type)) return "now()";
  if (/^(smallint|integer|bigint|numeric|real|double precision)/.test(type)) return "0";
  return null;
}

async function insertStatement(client: Client, table: "users" | "identities"): Promise<string | null> {
  const cols = await client.query<{ name: string; type: string; required: boolean }>(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
            (a.attnotnull and not a.atthasdef and a.attgenerated = '') as required
       from pg_attribute a
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
    [`auth.${table}`]
  );
  // 一次正常注册会写的几列总带上;再补齐所有必填列
  const wanted = new Set(
    table === "users"
      ? ["id", "email", "raw_user_meta_data", "raw_app_meta_data", "aud", "role"]
      : ["user_id", "provider", "provider_id", "identity_data"]
  );
  const names: string[] = [];
  const values: string[] = [];
  for (const c of cols.rows) {
    if (!c.required && !wanted.has(c.name)) continue;
    let value = syntheticValue(c.type, c.name);
    if (c.name === "aud" || c.name === "role") value = "'authenticated'";
    if (value === null) {
      if (c.required) return null;
      continue;
    }
    names.push(`"${c.name.replace(/"/g, '""')}"`);
    values.push(value);
  }
  return `insert into auth.${table} (${names.join(", ")}) values (${values.join(", ")})`;
}

export async function runAuthDrill(
  sandboxConnString: string,
  manifest: Manifest,
  mainDumpPath: string,
  authDump: AuthDumpForDrill
): Promise<AuthDrillReport> {
  const auth = manifest.auth!;
  if (authDump.error || !authDump.path) {
    return { status: "not_checked", summary: `Auth archive couldn't be read: ${authDump.error ?? "not downloaded"}` };
  }
  const sha = await sha256Of(authDump.path);
  if (sha !== auth.dump!.sha256) {
    return {
      status: "problems",
      summary: `Auth archive sha256 mismatch — got ${sha.slice(0, 12)}…, manifest ${auth.dump!.sha256.slice(0, 12)}…`,
    };
  }

  const bin = resolvePgRestoreBin();
  const { url, env } = credentialSafeDbArgs(sandboxConnString);
  const work = await mkdtemp(join(tmpdir(), "backupdrill-auth-drill-"));
  // connectPg 挂好了错误监听:沙箱连接被掐断时不会把整个进程(托管 worker)带走
  const client = await connectPg(sandboxConnString);
  // 每条语句都有上限(整段另有总时限,见 authDrillSection)
  await client.query("set statement_timeout = '5min'; set lock_timeout = '1min'");
  try {
    // ── 1. 两张表:结构、数据、约束、索引;触发器和策略留到外键之后 ──
    // 新项目里这两张表的属主是平台的 supabase_auth_admin,GoTrue 也用它注册用户:沙箱里照建
    await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
        create role supabase_auth_admin nologin;
      end if; end $$;
      create schema if not exists auth;
      grant usage on schema auth to supabase_auth_admin`);
    const listing = await pgRestoreOutput(bin, ["--list", authDump.path]);
    if (listing.code !== 0) {
      return { status: "problems", summary: `Auth archive couldn't be listed: ${safeRestoreError(listing.code, listing.stderr)}` };
    }
    const entries = listing.stdout.split("\n").filter((l) => /^\d+;/.test(l));
    const tablesList = join(work, "auth-tables.list");
    await writeFile(
      tablesList,
      // 触发器、策略和它们的注释都留到后面(注释先于对象执行会让整个恢复中止);注释不影响功能,干脆不建
      entries.filter((l) => !/^(TRIGGER|POLICY) |^COMMENT \S+ (TRIGGER|POLICY) /.test(tocType(l) ?? "")).join("\n") + "\n"
    );
    const restored = await spawnPgRestore(
      bin,
      ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", `--use-list=${tablesList}`, "--dbname", url, authDump.path],
      env
    );
    if (restored.code !== 0) {
      return { status: "problems", summary: `the Auth tables couldn't be restored: ${safeRestoreError(restored.code, restored.stderr)}` };
    }
    const counts = await client.query<{ users: string; identities: string }>(
      "select (select count(*) from auth.users) as users, (select count(*) from auth.identities) as identities"
    );
    const users = Number(counts.rows[0].users);
    const identities = Number(counts.rows[0].identities);
    const problems: string[] = [];
    if (users !== auth.rows!.users || identities !== auth.rows!.identities) {
      problems.push(
        `restored ${users} users / ${identities} identities, but the backup counted ${auth.rows!.users} / ${auth.rows!.identities}`
      );
    }

    // ── 2. 之前因为沙箱没有 auth 表而跳过的外键:现在补上 ──
    const mainListing = await pgRestoreOutput(bin, ["--list", mainDumpPath]);
    let foreignKeys: AuthDrillReport["foreignKeys"] = { created: 0, orphaned: [], failed: [] };
    if (mainListing.code === 0) {
      const fkEntries = mainListing.stdout.split("\n").filter((l) => /^FK CONSTRAINT /.test(tocType(l) ?? ""));
      if (fkEntries.length) {
        const fkList = join(work, "fks.list");
        await writeFile(fkList, fkEntries.join("\n") + "\n");
        const ddl = await pgRestoreOutput(bin, ["-f", "-", `--use-list=${fkList}`, mainDumpPath]);
        const intoAuth = parseForeignKeys(ddl.stdout).filter(
          (fk) => fk.references.schema === "auth" && (fk.references.name === "users" || fk.references.name === "identities")
        );
        // 已经建上的(例如转储自己带了 auth)不再重复
        // 约束名只在同一张表内唯一:按"schema.表.约束名"判断是否已经建上
        const existing = new Set(
          (
            await client.query<{ key: string }>(
              `select n.nspname || '.' || c.relname || '.' || con.conname as key
                 from pg_constraint con
                 join pg_class c on c.oid = con.conrelid
                 join pg_namespace n on n.oid = c.relnamespace
                where con.contype = 'f' and con.confrelid in ('auth.users'::regclass, 'auth.identities'::regclass)`
            )
          ).rows.map((r) => r.key)
        );
        const missing = intoAuth.filter((fk) => !existing.has(`${fk.table.schema}.${fk.table.name}.${fk.constraint}`));
        if (missing.length) {
          // addForeignKeys 会改这条连接的会话设置(search_path 等),给它单独一条
          const fkClient = await connectPg(sandboxConnString);
          try {
            const added = await addForeignKeys(fkClient, missing, { allow: /(?!)/, stopOnError: false });
            foreignKeys = {
              created: missing.length - added.failures.length,
              orphaned: added.orphaned,
              // 只留"哪条外键、在哪张表上",消息本身不进报告
              failed: added.failures.map((f) => f.split(": ")[0]),
            };
          } finally {
            await fkClient.end().catch(() => {});
          }
        }
      }
    }
    if (foreignKeys.failed.length) problems.push(`${foreignKeys.failed.length} foreign key(s) into the Auth tables couldn't be created`);

    // ── 3. 可以自动恢复的触发器(规则同真实恢复,见 restorableAuthObjects) ──
    const restorable = restorableAuthObjects({ triggers: auth.triggers!, policies: auth.policies! }, manifest.database.schemas);
    const manual = manualAuthObjects({ triggers: auth.triggers!, policies: auth.policies! }, manifest.database.schemas);
    const triggers: NonNullable<AuthDrillReport["triggers"]> = { created: [], failed: [] };
    for (const t of restorable.triggers) {
      // 名字都是普通标识符(restorableAuthObjects 保证),按前缀匹配不会认错
      const entry = entries.find((l) => (tocType(l) ?? "").startsWith(`TRIGGER auth ${t.table} ${t.name} `));
      if (!entry) {
        triggers.failed.push(`${t.name}: not found in the Auth archive`);
        continue;
      }
      const list = join(work, `trigger-${t.name}.list`);
      await writeFile(list, entry + "\n");
      const made = await spawnPgRestore(bin, ["--no-owner", "--no-privileges", "--exit-on-error", `--use-list=${list}`, "--dbname", url, authDump.path], env);
      if (made.code === 0) triggers.created.push(t.name);
      else triggers.failed.push(`${t.name}: ${safeRestoreError(made.code, made.stderr)}`);
    }
    if (triggers.failed.length) problems.push(`${triggers.failed.length} trigger(s) on the Auth tables couldn't be recreated`);

    // ── 4. 以 GoTrue 的身份(supabase_auth_admin,非超级用户)模拟一次邮箱注册,事后回滚 ──
    let signup: NonNullable<AuthDrillReport["signup"]> = { ran: false, detail: "no triggers of your own on the Auth tables" };
    if (triggers.created.length) {
      await client.query("alter table auth.users owner to supabase_auth_admin; alter table auth.identities owner to supabase_auth_admin");
      const userInsert = await insertStatement(client, "users");
      const identityInsert = await insertStatement(client, "identities");
      if (!userInsert || !identityInsert) {
        signup = { ran: false, detail: "couldn't build a test sign-up for this Auth table layout" };
      } else {
        await client.query("begin");
        try {
          await client.query("set local role supabase_auth_admin");
          await client.query(userInsert);
          await client.query(identityInsert);
          // 延迟检查的约束和约束触发器平时在提交时才跑:这里立刻跑完,才算这次注册真的能成
          await client.query("set constraints all immediate");
          signup = { ran: true, ok: true };
        } catch (error) {
          const e = error as Error & { where?: string; code?: string };
          // 只有错在触发器里才算触发器的问题;造的测试行本身不合表结构,算没模拟成
          signup = /PL\/pgSQL function|SQL function|trigger/i.test(e.where ?? "") || e.code === "23503" || e.code === "23505"
            ? { ran: true, ok: false, detail: `a new sign-up would fail: ${safeError(e)}` }
            : { ran: false, detail: `couldn't simulate a sign-up: ${safeError(e)}` };
        } finally {
          await client.query("rollback").catch(() => {});
        }
      }
      if (signup.ran && !signup.ok) problems.push(signup.detail!);
    }

    const parts = [
      `${users.toLocaleString("en-US")} users restored (${identities.toLocaleString("en-US")} identities)`,
      foreignKeys.created ? `${foreignKeys.created} foreign key(s) into the Auth tables created` : "",
      foreignKeys.orphaned.length ? `${foreignKeys.orphaned.length} of them with rows that have no user at the source` : "",
      triggers.created.length ? `${triggers.created.length} trigger(s) recreated` : "",
      signup.ran && signup.ok ? "a test sign-up worked" : "",
      manual.length ? `${manual.length} object(s) need recreating by hand` : "",
    ].filter(Boolean);
    return {
      status: problems.length ? "problems" : "verified",
      summary: problems.length ? `${problems.join("; ")}. ${parts.join("; ")}` : parts.join("; "),
      users,
      identities,
      foreignKeys,
      triggers,
      ...(manual.length ? { manual } : {}),
      signup,
    };
  } finally {
    await client.end().catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Auth 这一节最多花多久(下载等待 + 恢复两张表 + 外键 + 触发器 + 模拟注册);到点记 not_checked */
export const AUTH_DRILL_LIMITS = { totalMs: 15 * 60 * 1000 };

/**
 * 演练里调用:任何异常、超时都收进报告,绝不让演练因为 Auth 这一节抛错或拖住。
 * authDump 是个 Promise:下载和正式演练同时进行,这里才等它。到点就不等了,沙箱随后照常销毁,
 * 还在跑的 pg_restore 跟着断开
 */
export async function authDrillSection(
  sandboxConnString: string,
  manifest: Manifest,
  mainDumpPath: string,
  authDump: Promise<AuthDumpForDrill> | undefined
): Promise<AuthDrillReport | undefined> {
  if (manifest.auth?.status !== "included" || !authDump) return undefined;
  if (interrupted()) return undefined;
  const work = (async () => runAuthDrill(sandboxConnString, manifest, mainDumpPath, await authDump))();
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<AuthDrillReport>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "not_checked", summary: `the Auth check didn't finish within ${AUTH_DRILL_LIMITS.totalMs / 60000} minutes` }),
          AUTH_DRILL_LIMITS.totalMs
        );
      }),
    ]);
  } catch (error) {
    return { status: "not_checked", summary: `the Auth check couldn't run: ${safeError(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
