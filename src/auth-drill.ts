import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import type { Manifest } from "./manifest.js";
import { manualAuthObjects, restorableAuthObjects } from "./auth-backup.js";
import { parseForeignKeys } from "./dump-sql.js";
import { addForeignKeys, type OrphanedForeignKey } from "./orphaned-foreign-keys.js";
import { resolvePgRestoreBin } from "./pgbin.js";
import { credentialSafeDbArgs, pgRestoreOutput, spawnPgRestore } from "./restore-engine.js";
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

// 只取 pg_restore / PostgreSQL 报错的第一行:后面的 DETAIL / CONTEXT 可能带着行里的值(邮箱、ID),
// 不能进报告和告警
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /error/i.test(l)) ?? text.split("\n")[0]
  ).slice(0, 300);
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
  const client = new Client({ connectionString: sandboxConnString });
  await client.connect();
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
      return { status: "problems", summary: `Auth archive couldn't be listed: ${firstLine(listing.stderr)}` };
    }
    const entries = listing.stdout.split("\n").filter((l) => /^\d+;/.test(l));
    const tablesList = join(work, "auth-tables.list");
    await writeFile(
      tablesList,
      entries.filter((l) => !/^(TRIGGER|POLICY) /.test(tocType(l) ?? "")).join("\n") + "\n"
    );
    const restored = await spawnPgRestore(
      bin,
      ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", `--use-list=${tablesList}`, "--dbname", url, authDump.path],
      env
    );
    if (restored.code !== 0) {
      return { status: "problems", summary: `the Auth tables couldn't be restored: ${firstLine(restored.stderr)}` };
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
        const existing = new Set(
          (
            await client.query<{ name: string }>(
              "select conname as name from pg_constraint where contype = 'f' and confrelid in ('auth.users'::regclass, 'auth.identities'::regclass)"
            )
          ).rows.map((r) => r.name)
        );
        const missing = intoAuth.filter((fk) => !existing.has(fk.constraint));
        if (missing.length) {
          // addForeignKeys 会改这条连接的会话设置(search_path 等),给它单独一条
          const fkClient = new Client({ connectionString: sandboxConnString });
          await fkClient.connect();
          try {
            const added = await addForeignKeys(fkClient, missing, { allow: /(?!)/, stopOnError: false });
            foreignKeys = {
              created: missing.length - added.failures.length,
              orphaned: added.orphaned,
              failed: added.failures.map(firstLine),
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
      else triggers.failed.push(`${t.name}: ${firstLine(made.stderr)}`);
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
          signup = { ran: true, ok: true };
        } catch (error) {
          const e = error as Error & { where?: string };
          // 只有错在触发器里才算触发器的问题;造的测试行本身不合表结构,算没模拟成
          signup = /PL\/pgSQL function|SQL function|trigger/i.test(e.where ?? "")
            ? { ran: true, ok: false, detail: `a new sign-up would fail: ${firstLine(e.message)}` }
            : { ran: false, detail: `couldn't simulate a sign-up: ${firstLine(e.message)}` };
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

/** 演练里调用:任何异常都收进报告,绝不让演练因为 Auth 这一节抛错 */
export async function authDrillSection(
  sandboxConnString: string,
  manifest: Manifest,
  mainDumpPath: string,
  authDump: AuthDumpForDrill | undefined
): Promise<AuthDrillReport | undefined> {
  if (manifest.auth?.status !== "included") return undefined;
  if (interrupted()) return undefined;
  try {
    return await runAuthDrill(sandboxConnString, manifest, mainDumpPath, authDump ?? { error: "not downloaded" });
  } catch (error) {
    return { status: "not_checked", summary: `the Auth check couldn't run: ${firstLine((error as Error).message)}` };
  }
}
