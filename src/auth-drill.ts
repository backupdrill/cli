import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import type { Manifest } from "./manifest.js";
import { manualAuthObjects, restorableAuthObjects } from "./auth-backup.js";
import { parseForeignKeys } from "./dump-sql.js";
import { addForeignKeys, type OrphanedForeignKey } from "./orphaned-foreign-keys.js";
import { resolvePgRestoreBin } from "./pgbin.js";
import { credentialSafeDbArgs, pgRestoreOutput, spawnPgRestore } from "./restore-engine.js";
import pg from "pg";
import { attachPgErrorGuard, connectPg, pgConnectOptions } from "./supabase-ca.js";
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
  /** 没验证到的部分,例如触发器还响应模拟注册之外的事件 */
  notes?: string[];
  /** 模拟注册:ran=false 时说明为什么没跑 */
  signup?: { ran: boolean; ok?: boolean; detail?: string };
}

export interface AuthDumpForDrill {
  /** 下载到本地的 auth.dump;下载失败时为空,error 说明原因 */
  path?: string;
  error?: string;
}

// 报告会发给用户、进运营者告警,**一律不放报错原文**:触发器能在任何错误码下抛出自定义消息、
// 伪造对象名字段,里面可以是任意数据,靠脱敏堵不干净。只给 SQLSTATE 映射出的固定说法和 SQLSTATE 本身
const SQLSTATE_TEXT: Record<string, string> = {
  "42501": "permission denied",
  "42P01": "a table doesn't exist",
  "42883": "a function doesn't exist",
  "42703": "a column doesn't exist",
  "3F000": "a schema doesn't exist",
  "42P07": "a table already exists",
  "42710": "an object already exists",
  "23503": "a foreign key was violated",
  "23505": "a unique constraint was violated",
  "23502": "a not-null constraint was violated",
  "23514": "a check constraint was violated",
  "42804": "a data type didn't match",
  "55P03": "a lock wait timed out",
  "57014": "a statement timed out or was cancelled",
  "40P01": "a deadlock",
  P0001: "an exception was raised",
};

function safeError(error: unknown): string {
  // 只用 SQLSTATE:触发器能用 RAISE ... USING 伪造 TABLE / COLUMN / CONSTRAINT 这些字段,它们同样不可信
  const code = (error as { code?: string })?.code;
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return "an unexpected error";
  return `${SQLSTATE_TEXT[code] ?? "an error"} (SQLSTATE ${code})`;
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
  // 和 GoTrue 一次邮箱注册写进去的一样:触发器常按 provider 分支,或者读这些元数据
  if (column === "raw_app_meta_data") return `jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'))`;
  if (column === "raw_user_meta_data") {
    return `jsonb_build_object('sub', '${SIGNUP_USER_ID}', 'email', '${SIGNUP_EMAIL}', 'email_verified', false, 'phone_verified', false)`;
  }
  if (column === "created_at" || column === "updated_at") return "now()";
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
      ? ["id", "email", "raw_user_meta_data", "raw_app_meta_data", "aud", "role", "created_at", "updated_at"]
      : ["user_id", "provider", "provider_id", "identity_data", "created_at", "updated_at"]
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
  authDump: AuthDumpForDrill,
  signal?: AbortSignal
): Promise<AuthDrillReport> {
  const auth = manifest.auth!;
  // 这一节的所有会话都带上 application_name,超时时 authDrillSection 只终止它们
  sandboxConnString = taggedUrl(sandboxConnString);
  // 超时后不再开始任何新的一步(新连接、pg_restore、下一阶段):已经在跑的由 authDrillSection 终止
  const stopIfCancelled = () => {
    if (signal?.aborted) throw new Error("the Auth check was stopped");
  };
  if (authDump.error || !authDump.path) {
    return { status: "not_checked", summary: authDump.error ?? "the Auth archive couldn't be downloaded" };
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
  stopIfCancelled();
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
    stopIfCancelled();
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
    stopIfCancelled();
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
    stopIfCancelled();
    const mainListing = await pgRestoreOutput(bin, ["--list", mainDumpPath]);
    let foreignKeys: AuthDrillReport["foreignKeys"] = { created: 0, orphaned: [], failed: [] };
    if (mainListing.code !== 0) problems.push("the database archive couldn't be listed, so its foreign keys into the Auth tables weren't checked");
    if (mainListing.code === 0) {
      const fkEntries = mainListing.stdout.split("\n").filter((l) => /^FK CONSTRAINT /.test(tocType(l) ?? ""));
      if (fkEntries.length) {
        const fkList = join(work, "fks.list");
        await writeFile(fkList, fkEntries.join("\n") + "\n");
        stopIfCancelled();
        const ddl = await pgRestoreOutput(bin, ["-f", "-", `--use-list=${fkList}`, mainDumpPath]);
        const parsed = ddl.code === 0 ? parseForeignKeys(ddl.stdout) : [];
        // 读不全外键定义(命令失败,或有定义没解析出来)时不能说"全部对上":把没能检查的条数记下来
        if (parsed.length !== fkEntries.length) {
          problems.push(`${fkEntries.length - parsed.length} foreign key definition(s) couldn't be read, so they weren't checked`);
        }
        const intoAuth = parsed.filter(
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
          stopIfCancelled();
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
      stopIfCancelled();
      const made = await spawnPgRestore(bin, ["--no-owner", "--no-privileges", "--exit-on-error", `--use-list=${list}`, "--dbname", url, authDump.path], env);
      if (made.code === 0) triggers.created.push(t.name);
      else triggers.failed.push(`${t.name}: ${safeRestoreError(made.code, made.stderr)}`);
    }
    if (triggers.failed.length) problems.push(`${triggers.failed.length} trigger(s) on the Auth tables couldn't be recreated`);
    // 模拟注册只是 INSERT:同样响应 UPDATE / DELETE / TRUNCATE 的触发器,那些事件没验证到,明说
    const notes: string[] = [];
    if (triggers.created.length) {
      const events = await client.query<{ name: string; table: string; tgtype: number }>(
        `select t.tgname as name, c.relname as table, t.tgtype::int as tgtype
           from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where c.oid in ('auth.users'::regclass, 'auth.identities'::regclass) and t.tgname = any($1::text[])`,
        [triggers.created]
      );
      for (const e of events.rows) {
        const other = [
          e.tgtype & 8 ? "DELETE" : "",
          e.tgtype & 16 ? "UPDATE" : "",
          e.tgtype & 32 ? "TRUNCATE" : "",
        ].filter(Boolean);
        if (other.length) notes.push(`trigger ${e.name} on auth.${e.table} also fires on ${other.join(", ")}, which the test sign-up doesn't exercise`);
      }
    }

    stopIfCancelled();
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
          const triggerPath =
            /PL\/pgSQL function|SQL function|trigger/i.test(e.where ?? "") ||
            ["23503", "23505", "42501", "42883", "42P01", "42703", "3F000", "P0001"].includes(e.code ?? "");
          signup = triggerPath
            ? { ran: true, ok: false, detail: `a new sign-up would fail: ${safeError(e)}` }
            : { ran: false, detail: `couldn't simulate a sign-up: ${safeError(e)}` };
        } finally {
          await client.query("rollback").catch(() => {});
        }
      }
      if (signup.ran && !signup.ok) problems.push(signup.detail!);
      // 有要验证的触发器,却没能模拟成注册:不能报"全部对上"
      if (!signup.ran) problems.push(`the test sign-up couldn't run (${signup.detail})`);
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
      ...(notes.length ? { notes } : {}),
      signup,
    };
  } finally {
    await client.end().catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Auth 这一节在沙箱里开的每个会话(查询连接、pg_restore)都带这个名字,超时时只终止它们 */
const AUTH_DRILL_APP_NAME = "backupdrill-auth-drill";

function taggedUrl(connString: string): string {
  const url = new URL(connString);
  url.searchParams.set("application_name", AUTH_DRILL_APP_NAME);
  return url.toString();
}

/** 终止 Auth 这一节在沙箱里开的会话(按 application_name 认):它的 pg_restore 和查询随之结束,别人的会话不动 */
async function stopAuthSessions(sandboxConnString: string): Promise<void> {
  try {
    // 自带连接超时:沙箱没有回应时,这条清理连接也不能挂住进程
    const client = new pg.Client({ ...pgConnectOptions(sandboxConnString), connectionTimeoutMillis: 10_000 });
    attachPgErrorGuard(client);
    await client.connect();
    try {
      await client.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()",
        [AUTH_DRILL_APP_NAME]
      );
    } finally {
      await client.end().catch(() => {});
    }
  } catch {
    // 沙箱可能已经不在了:那就没什么要停的
  }
}

async function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  let t: NodeJS.Timeout | undefined;
  await Promise.race([p.then(() => {}, () => {}), new Promise<void>((resolve) => (t = setTimeout(resolve, ms)))]);
  clearTimeout(t);
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
  authDump: Promise<AuthDumpForDrill> | undefined,
  stopDownload?: () => void
): Promise<AuthDrillReport | undefined> {
  if (manifest.auth?.status !== "included" || !authDump) return undefined;
  if (interrupted()) return undefined;
  const cancel = new AbortController();
  const work = (async () => runAuthDrill(sandboxConnString, manifest, mainDumpPath, await authDump, cancel.signal))();
  work.catch(() => {});
  const timedOut: AuthDrillReport = {
    status: "not_checked",
    summary: `the Auth check didn't finish within ${AUTH_DRILL_LIMITS.totalMs / 60000} minutes`,
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<AuthDrillReport>((resolve) => {
        timer = setTimeout(() => {
          // 超时结果立刻返回,收尾放到后台、自带时限,绝不让演练等它:
          //  - 不再开始任何新的一步(cancel);
          //  - 下载停掉;
          //  - 这一节在沙箱里开的会话全部终止,正在跑的 pg_restore 随之退出——--keep 留下的沙箱不会再被改动
          cancel.abort();
          stopDownload?.();
          void waitAtMost(stopAuthSessions(sandboxConnString), 10_000);
          resolve(timedOut);
        }, AUTH_DRILL_LIMITS.totalMs);
      }),
    ]);
  } catch (error) {
    return { status: "not_checked", summary: `the Auth check couldn't run: ${safeError(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
