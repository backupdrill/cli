/**
 * 带 Auth 的恢复(2.10.0,PRD 增补 §5.2):Auth 用户、identities、应用数据、用户的触发器在**同一个事务**里写进目标。
 *
 * 为什么要这样:应用表上指向 auth.users 的外键(profiles.id → auth.users)要求用户先在。分两次写,
 * 后一次失败就会留下半截目标;一个事务写完,失败了目标原样不动,修好原因直接重跑。
 *
 * 事务只由这里(协调程序)控制:起一个 psql 会话,先写 BEGIN,再把各段 SQL 依次喂进去——其中几段由
 * `pg_restore -f -` 生成,不带 --single-transaction 时它们没有自己的 BEGIN/COMMIT。**只有每个生成进程都
 * 0 退出、psql 一句没错时才写 COMMIT**;否则不写,psql 会话一结束服务端就回滚整个事务。不用
 * `psql --single-transaction`:它在输入结束时照样提交,生成端中途失败也会被当成正常结束。
 *
 * 写 COMMIT 之后 psql 没报"已提交"(进程被杀、连接断了),就拿事务号问目标 pg_xact_status,不靠猜。
 * 引擎在任何情况下都不自动删目标里的数据。
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthSection, ExtensionInfo, Manifest } from "./manifest.js";
import { connectCancellable, manualAuthObjects, plainSchemaName, restorableAuthObjects } from "./auth-backup.js";
import { describeSqlstate } from "./auth-drill.js";
import { parseGeneratedColumns, parseTableColumns } from "./dump-sql.js";
import { localToolVersion, resolvePgRestoreBin, resolvePsqlBin } from "./pgbin.js";
import {
  afterCommit,
  credentialSafeDbArgs,
  firstRestoreError,
  libpqChildEnv,
  pgRestoreOutput,
  prepareMainRestore,
  quoteIdent,
  urlSslModeOf,
  userObjectCountSql,
  type GrantsToRestore,
} from "./restore-engine.js";
import { connectPg, dumpUrlFor, isSupabaseHost } from "./supabase-ca.js";
import { interrupted, stopOnInterrupt } from "./interrupt.js";

/**
 * 恢复后要清掉的待处理认证状态,和 GoTrue 的 ClearAllPendingTokens 对齐:备份时发出去的找回密码、邮箱确认、
 * 改邮箱改手机的链接和验证码,在新项目上一律作废。RECOVERY.md 的手工步骤用同一句
 */
export const CLEAR_PENDING_AUTH_SQL =
  "update auth.users set confirmation_token = '', recovery_token = '', email_change_token_new = '', " +
  "email_change_token_current = '', phone_change_token = '', reauthentication_token = '', " +
  "email_change = '', phone_change = '', email_change_confirm_status = 0, confirmation_sent_at = null, " +
  "recovery_sent_at = null, email_change_sent_at = null, phone_change_sent_at = null, reauthentication_sent_at = null;";

/** 恢复互斥锁的键(pg_advisory_xact_lock):固定值,只给 BackupDrill 的恢复用。两次恢复写同一个目标时后一个排队 */
const RESTORE_LOCK_KEY = "7352063019441103";

// pg_restore -l 的条目行:"<id>; <oid> <oid> <类型> <schema> <名字> <属主>"
const tocType = (line: string): string | null => /^\d+; \d+ \d+ (.+)$/.exec(line)?.[1] ?? null;

/** auth.dump 里恢复要用的东西:两段数据的目录行、要补建的触发器、数据段的列 */
export interface AuthArchive {
  path: string;
  usersData: string;
  identitiesData: string;
  triggers: Array<{ name: string; entry: string }>;
  /** 数据段里的列和类型(建表语句的列减去生成列,pg_dump 不导出生成列) */
  columns: Record<"users" | "identities", Array<{ name: string; type: string }>>;
}

/** 读 auth.dump 的目录和两张表的建表语句。不碰目标 */
export async function readAuthArchive(path: string, manifest: Manifest, workDir: string): Promise<AuthArchive> {
  const auth = manifest.auth!;
  const bin = resolvePgRestoreBin();
  const listing = await pgRestoreOutput(bin, ["--list", path]);
  if (listing.code !== 0) {
    throw new Error(`the Auth archive couldn't be read (pg_restore --list exited with code ${listing.code})`);
  }
  const entries = listing.stdout.split("\n").filter((line) => /^\d+;/.test(line));
  const only = (prefix: string, what: string): string => {
    const found = entries.filter((line) => (tocType(line) ?? "").startsWith(prefix));
    if (found.length !== 1) throw new Error(`the Auth archive doesn't have ${what}`);
    return found[0];
  };
  const usersData = only("TABLE DATA auth users ", "the data of auth.users");
  const identitiesData = only("TABLE DATA auth identities ", "the data of auth.identities");
  const tablesList = join(workDir, "auth-tables.list");
  await writeFile(
    tablesList,
    [only("TABLE auth users ", "the definition of auth.users"), only("TABLE auth identities ", "the definition of auth.identities")].join("\n") + "\n"
  );
  const ddl = await pgRestoreOutput(bin, ["-f", "-", `--use-list=${tablesList}`, path]);
  if (ddl.code !== 0) throw new Error(`the Auth archive couldn't be read (pg_restore exited with code ${ddl.code})`);
  const types = parseTableColumns(ddl.stdout);
  const generated = parseGeneratedColumns(ddl.stdout);
  const dataColumns = (table: "users" | "identities") => {
    const all = types.get(`auth\u0000${table}`);
    if (!all?.size) throw new Error(`the Auth archive's definition of auth.${table} couldn't be read`);
    const skip = generated.get(`auth\u0000${table}`) ?? new Set<string>();
    return [...all].filter(([name]) => !skip.has(name)).map(([name, type]) => ({ name, type }));
  };
  // 规则同 RECOVERY.md 和演练:只补建平时启用、名字普通、依赖都在备份里的触发器(restorableAuthObjects)
  const triggers = restorableAuthObjects({ triggers: auth.triggers!, policies: auth.policies! }, manifest.database.schemas).triggers.map(
    (t) => {
      const entry = entries.find((line) => (tocType(line) ?? "").startsWith(`TRIGGER auth ${t.table} ${t.name} `));
      if (!entry) throw new Error(`the Auth archive doesn't have the trigger ${t.name} that the snapshot lists`);
      return { name: t.name, entry };
    }
  );
  return { path, usersData, identitiesData, triggers, columns: { users: dataColumns("users"), identities: dataColumns("identities") } };
}

/**
 * 只读预检(dry-run 和正式执行共用):目标得是一个新项目的 Auth——两张表在、没有用户、没有用户自己的触发器和策略,
 * 列能装下备份的数据。返回拦下的原因,空数组 = 能恢复
 */
export async function authRestorePreflight(targetUrl: string, archive: AuthArchive): Promise<string[]> {
  const client = await connectPg(targetUrl);
  try {
    // 和 pg_dump 一样在空 search_path 下取类型名:非系统类型都带 schema,两边才比得上
    await client.query("select set_config('search_path', '', false)");
    const tables = await client.query<{ users: string | null; identities: string | null }>(
      "select to_regclass('auth.users')::text as users, to_regclass('auth.identities')::text as identities"
    );
    if (!tables.rows[0].users || !tables.rows[0].identities) {
      return [
        "the target has no Supabase Auth tables (auth.users, auth.identities): restore into a Supabase project, " +
          "or pass --skip-auth to restore the database without the Auth users",
      ];
    }
    const problems: string[] = [];
    const users = Number((await client.query<{ n: string }>("select count(*) as n from auth.users")).rows[0].n);
    if (users > 0) {
      problems.push(
        `the target already has ${users.toLocaleString("en-US")} Auth user(s), and restore writes Auth users only into a ` +
          "new project. If you copied the users there yourself, pass --skip-auth to restore the database alone"
      );
    }
    const objects = await client.query<{ triggers: string; policies: string }>(
      `select (select count(*) from pg_trigger
                where tgrelid in ('auth.users'::regclass, 'auth.identities'::regclass) and not tgisinternal) as triggers,
              (select count(*) from pg_policy
                where polrelid in ('auth.users'::regclass, 'auth.identities'::regclass)) as policies`
    );
    const triggerCount = Number(objects.rows[0].triggers);
    const policyCount = Number(objects.rows[0].policies);
    if (triggerCount || policyCount) {
      problems.push(
        `the target's Auth tables already have ${triggerCount} trigger(s) and ${policyCount} policy(ies) that aren't ` +
          "Supabase's own, so it isn't a new project: restore into a new one"
      );
    }
    // 结构兼容只看真正写进去的列。不做任何静默转换:对不上就拦下、说清是哪一列
    for (const table of ["users", "identities"] as const) {
      const onTarget = await client.query<{ name: string; type: string; generated: boolean; required: boolean }>(
        `select attname as name, format_type(atttypid, atttypmod) as type, attgenerated <> '' as generated,
                (attnotnull and not atthasdef and attidentity = '' and attgenerated = '') as required
           from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped`,
        [`auth.${table}`]
      );
      const target = new Map(onTarget.rows.map((row) => [row.name, row]));
      const fromBackup = new Set(archive.columns[table].map((column) => column.name));
      for (const column of archive.columns[table]) {
        const there = target.get(column.name);
        const name = `auth.${table}.${column.name}`;
        if (!there) problems.push(`${name} is in the backup but not on the target`);
        else if (there.generated) problems.push(`${name} is a generated column on the target, so the backed-up values can't go into it`);
        else if (there.type !== column.type) problems.push(`${name} is ${column.type} in the backup but ${there.type} on the target`);
      }
      for (const row of onTarget.rows) {
        if (row.required && !fromBackup.has(row.name)) {
          problems.push(`auth.${table}.${row.name} on the target is required and has no default, and the backup has no values for it`);
        }
      }
    }
    return problems;
  } finally {
    await client.end();
  }
}

/**
 * 主 dump 里的大对象。pg_restore 输出 SQL 时会在它们前后自己写 BEGIN; / COMMIT;,混进这个事务就会提前提交。
 * 有的话这条路不能走,由调用方拦下。备份端的主 dump 总带 --schema,pg_dump 这时默认不导出大对象,
 * 所以正常的快照里不会有:这是兜底,防的是别处来的归档
 */
export async function largeObjectEntries(dumpPath: string): Promise<number> {
  const listing = await pgRestoreOutput(resolvePgRestoreBin(), ["--list", dumpPath]);
  if (listing.code !== 0) throw new Error(`pg_restore --list exited with code ${listing.code}`);
  return listing.stdout.split("\n").filter((line) => /^(BLOB|BLOBS|BLOB METADATA|LARGE OBJECT) /.test(tocType(line) ?? "")).length;
}

/**
 * pg_restore 从这些小版本起在 SQL 输出开头写 `\restrict <随机密钥>`:psql 读到它就进入受限模式,在对应的
 * \unrestrict 之前不执行任何元命令。归档内容(对象名、注释……)里混进来的 `\!` 之类因此不会在本机执行
 * (CVE-2025-8714,2025-08 的修复版本)。18 起全部带
 */
const RESTRICT_SINCE: Record<number, number> = { 13: 22, 14: 19, 15: 14, 16: 10, 17: 6 };

export function emitsRestrict([major, minor]: [number, number]): boolean {
  return major >= 18 || (RESTRICT_SINCE[major] !== undefined && minor >= RESTRICT_SINCE[major]);
}

/**
 * psql 要能安全地执行 pg_restore 写出来的 SQL:pg_restore 得是带 \restrict 的版本,psql 和它同一个客户端包、
 * 不比它旧(旧 psql 不认识 \restrict)。返回拦下的原因,null = 可以
 */
export async function psqlProblem(): Promise<string | null> {
  const psql = await localToolVersion(resolvePsqlBin());
  if (!psql) {
    return "psql wasn't found; it comes with pg_restore in the PostgreSQL client package (or set BACKUPDRILL_PSQL)";
  }
  const pgRestore = await localToolVersion(resolvePgRestoreBin());
  if (!pgRestore) return "the pg_restore version couldn't be read";
  if (!emitsRestrict(pgRestore)) {
    return (
      `pg_restore ${pgRestore.join(".")} is too old to protect psql from commands carried in an archive ` +
      "(needs 17.6, 16.10, 15.14, 14.19, 13.22 or newer); update the PostgreSQL client"
    );
  }
  if (psql[0] < pgRestore[0] || (psql[0] === pgRestore[0] && psql[1] < pgRestore[1])) {
    return `psql ${psql.join(".")} is older than pg_restore ${pgRestore.join(".")}; install a psql from the same client package`;
  }
  return null;
}

/**
 * pg_restore -f - 的输出开头:第一条不是注释、不是空行的行必须是 `\restrict <密钥>`。还没读到完整的那一行时
 * 返回 "more"。不是它就不交给 psql:没有受限模式,归档内容里的元命令会被执行
 */
export function restrictHeader(text: string): "ok" | "missing" | "more" {
  const lines = text.split("\n");
  lines.pop(); // 最后一段可能还没读完
  for (const line of lines) {
    if (line === "" || line.startsWith("--")) continue;
    return /^\\restrict [A-Za-z0-9]+$/.test(line) ? "ok" : "missing";
  }
  return "more";
}

type Stage = "lock" | "recheck" | "extensions" | "auth-data" | "auth-check" | "database" | "triggers" | "commit" | "committed";

const STAGE_TEXT: Record<Stage, string> = {
  lock: "locking the target's Auth tables",
  recheck: "checking the target is still empty",
  extensions: "installing extensions",
  "auth-data": "writing the Auth users",
  "auth-check": "checking the Auth users",
  database: "restoring the database",
  triggers: "recreating your triggers on the Auth tables",
  commit: "committing",
  committed: "committing",
};

const STAGE_MARK = "backupdrill-stage:";
const XID_MARK = "backupdrill-xid:";

/** psql 默认格式的第一条错误:主消息 + DETAIL/HINT。不带 CONTEXT(COPY 出错时那里是整行数据) */
export function firstPsqlError(stderr: string): string {
  const lines = stderr.split("\n");
  const at = lines.findIndex((line) => /\bERROR:/.test(line));
  if (at < 0) return stderr.trim().replace(/\s+/g, " ").slice(0, 300) || "(no error output)";
  const details: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^(DETAIL|HINT):/.test(line)) details.push(line.replace(/\s+/g, " ").trim());
    else if (/^(psql:|ERROR:|FATAL:)/.test(line)) break;
  }
  return [lines[at].replace(/^.*?\bERROR:\s+/, "").trim(), ...details].join(" ");
}

/**
 * 写过 COMMIT、却没看到 psql 确认时,用事务号问目标:提交了、回滚了,还是说不清。
 * 还在进行中(原会话还没收尾)就等一会儿再问;等不到、连不上、事务号查不了,都是"说不清",不猜
 */
export async function transactionOutcome(
  connString: string,
  xid: string,
  opts: { waitMs?: number; pollMs?: number; graceMs?: number } = {}
): Promise<"committed" | "rolled_back" | "unknown"> {
  const { waitMs = 30_000, pollMs = 1000, graceMs = 15_000 } = opts;
  const deadline = Date.now() + waitMs;
  // 连接和每次查询都算在一个硬时限里:提交之后网络出问题时,这里不能一直挂着。到点直接断开连接
  const giveUp = AbortSignal.timeout(waitMs + graceMs);
  try {
    const client = await connectCancellable(connString, giveUp);
    try {
      for (;;) {
        const res = await client.query<{ status: string | null }>("select pg_xact_status($1::xid8) as status", [xid]);
        const status = res.rows[0].status;
        if (status === "committed") return "committed";
        if (status === "aborted") return "rolled_back";
        if (status !== "in progress" || Date.now() >= deadline || giveUp.aborted) return "unknown";
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    } finally {
      await client.end().catch(() => {});
    }
  } catch {
    return "unknown";
  }
}

export interface AuthRestoreRun {
  /** committed:快照里的东西都在目标上了;rolled_back:目标上什么都没留下;unknown:查不清 */
  transaction: "committed" | "rolled_back" | "unknown";
  /** 没提交(或查不清)的原因;提交后的步骤出错写在 afterCommit 里 */
  failure?: string;
  xid?: string;
  afterCommit?: Awaited<ReturnType<typeof afterCommit>>;
  /** 补建了的触发器 */
  triggers: string[];
}

/** 两个 Auth 表名在 tableKey 里的写法:指向它们的外键和备份里的外键一样,提交后再加 */
const AUTH_TABLE_KEYS = ["auth\u0000users", "auth\u0000identities"];

export async function restoreWithAuth(opts: {
  dumpPath: string;
  archive: AuthArchive;
  connString: string;
  auth: AuthSection;
  schemas: string[];
  grants: GrantsToRestore;
  listDir: string;
  /**
   * manifest 记着的扩展:装在这个事务里(锁内重查之后),恢复失败时随事务一起回滚,重跑时目标是干净的。
   * 调用方事先在一个回滚掉的事务里确认过它们装得上
   */
  extensions?: ExtensionInfo[];
  /** 拿到事务号之后、写 COMMIT 之前调用:调用方据此记下"这次恢复对应哪个事务" */
  onTransactionId?: (xid: string) => Promise<void> | void;
}): Promise<AuthRestoreRun> {
  const pgRestore = resolvePgRestoreBin();
  const extensions = opts.extensions ?? [];
  const prepared = await prepareMainRestore(pgRestore, opts.dumpPath, opts.connString, opts.listDir, {
    alsoFullyDumped: AUTH_TABLE_KEYS,
    schemasCreatedFirst: extensions.map((ext) => ext.schema),
  });
  if (!prepared.ok) return { transaction: "rolled_back", failure: prepared.failure, triggers: [] };
  const listFile = async (name: string, lines: string[]) => {
    const file = join(opts.listDir, name);
    await writeFile(file, lines.join("\n") + "\n");
    return file;
  };
  const usersList = await listFile("auth-users.list", [opts.archive.usersData]);
  const identitiesList = await listFile("auth-identities.list", [opts.archive.identitiesData]);
  const triggersList = opts.archive.triggers.length
    ? await listFile("auth-triggers.list", opts.archive.triggers.map((t) => t.entry))
    : null;

  // 连接方式和 pg_restore 直连目标时完全一样:TLS 校验、密码只走环境变量
  const { url, env } = credentialSafeDbArgs(dumpUrlFor(opts.connString));
  const childEnv = libpqChildEnv(env, process.env, { supabaseHost: isSupabaseHost(opts.connString), urlSslMode: urlSslModeOf(url) });
  if (interrupted()) return { transaction: "rolled_back", failure: "interrupted before anything was written", triggers: [] };
  // -X 不读用户的 psqlrc(它能改掉错误处理、把数据回显到终端);-A -t 只输出值,标记行原样可读
  const psql = spawn(resolvePsqlBin(), ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "--dbname", url], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  const forgetPsql = stopOnInterrupt(psql);

  let stage: Stage | null = null;
  let xid: string | undefined;
  let stderr = "";
  let pending = "";
  let resolveXid!: (value: string | undefined) => void;
  const xidSeen = new Promise<string | undefined>((resolve) => (resolveXid = resolve));
  psql.stdout.setEncoding("utf8");
  psql.stdout.on("data", (chunk: string) => {
    pending += chunk;
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.startsWith(STAGE_MARK)) stage = line.slice(STAGE_MARK.length) as Stage;
      else if (line.startsWith(XID_MARK)) resolveXid((xid = line.slice(XID_MARK.length).trim()));
    }
    // 没有换行的超长输出不会是我们的标记,别让它占着内存
    if (pending.length > 1_000_000) pending = "";
  });
  psql.stderr.setEncoding("utf8");
  psql.stderr.on("data", (chunk: string) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  let spawnError: string | undefined;
  let psqlGone = false;
  const exited = new Promise<number | null>((resolve) => {
    psql.on("error", (error) => {
      // 不透传原始 Error:node 会把 spawnargs(含连接串)挂在上面
      spawnError = `psql failed to start: ${(error as NodeJS.ErrnoException).code ?? error.message}`;
      resolve(null);
    });
    psql.on("close", (code) => resolve(code));
  }).then((code) => {
    psqlGone = true;
    resolveXid(undefined);
    return code;
  });
  // psql 因为语句出错先退出时,往它的 stdin 写会 EPIPE:由 psqlGone 处理,不让它变成未处理的异常
  psql.stdin.on("error", () => {});

  const send = async (data: string | Buffer): Promise<boolean> => {
    if (psqlGone || psql.stdin.destroyed) return false;
    if (!psql.stdin.write(data)) await Promise.race([once(psql.stdin, "drain").catch(() => {}), exited]);
    return !psqlGone;
  };
  /** 把一个 pg_restore -f - 的输出整段喂给 psql。返回生成端的失败原因;psql 先退出了返回 null(由 psql 的报错说明) */
  const generate = async (list: string, archivePath: string, what: string): Promise<string | null> => {
    if (interrupted()) return "interrupted";
    const gen = spawn(pgRestore, ["--no-owner", "--no-privileges", "-f", "-", `--use-list=${list}`, archivePath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: libpqChildEnv(),
    });
    const forget = stopOnInterrupt(gen);
    let genStderr = "";
    gen.stderr.setEncoding("utf8");
    gen.stderr.on("data", (chunk: string) => {
      if (genStderr.length < 64 * 1024) genStderr += chunk;
    });
    const closed = new Promise<number | null>((resolve) => {
      gen.on("error", () => resolve(-1));
      gen.on("close", (code) => resolve(code));
    });
    void exited.then(() => gen.kill("SIGTERM"));
    // 开头确认是 \restrict 之前一个字节都不交给 psql
    let head: Buffer | null = Buffer.alloc(0);
    let unrestricted = false;
    try {
      for await (const chunk of gen.stdout) {
        let data = chunk as Buffer;
        if (head) {
          head = Buffer.concat([head, data]);
          const verdict = restrictHeader(head.toString("utf8"));
          if (verdict === "more" && head.length < 64 * 1024) continue;
          if (verdict !== "ok") {
            unrestricted = true;
            break;
          }
          data = head;
          head = null;
        }
        if (!(await send(data))) break;
      }
    } catch {
      // 读生成端的输出出错:按它的退出码判
    }
    gen.kill("SIGTERM");
    const code = await closed;
    forget();
    if (unrestricted || (head && head.length > 0)) {
      return `pg_restore's output for ${what} didn't start with \\restrict, so it wasn't passed to psql (without it, psql would run commands carried in the archive)`;
    }
    if (psqlGone) return null;
    if (code === 0) return null;
    return `pg_restore stopped while writing out ${what} (${code === null ? "killed by a signal" : `exit code ${code}`}): ${firstRestoreError(genStderr)}`;
  };

  // 带 Auth 的快照里 schemas 全是普通名字(备份端 authInSchemas 保证),按 pg_dump 的规则规范化后才是真正的 schema 名;
  // plainSchemaName 只放行 [a-z0-9_],拼进 SQL 字面量是安全的
  const schemaNames = opts.schemas.map((name) => plainSchemaName(name)).filter((name): name is string => name !== null);
  const schemaArray = `array[${schemaNames.map((name) => `'${name}'`).join(", ")}]::text[]`;
  let commitSent = false;
  let failure: string | null = null;
  const run = async (): Promise<void> => {
    // 1. 开事务、加锁、锁内重查目标还是空的,再取事务号
    const prelude = [
      "\\set VERBOSITY default",
      `\\echo ${STAGE_MARK}lock`,
      "begin isolation level read committed;",
      "set local lock_timeout = '60s';",
      `select pg_advisory_xact_lock(${RESTORE_LOCK_KEY});`,
      "lock table auth.users, auth.identities in share row exclusive mode;",
      `\\echo ${STAGE_MARK}recheck`,
      "set standard_conforming_strings = on;",
      "do $bd$ begin",
      "  if exists (select 1 from auth.users) then",
      "    raise exception 'auth.users is no longer empty (someone signed up after the checks): restore only into a new project';",
      "  end if;",
      "  if exists (select 1 from pg_trigger where tgrelid in ('auth.users'::regclass, 'auth.identities'::regclass) and not tgisinternal)",
      "     or exists (select 1 from pg_policy where polrelid in ('auth.users'::regclass, 'auth.identities'::regclass)) then",
      "    raise exception 'the Auth tables now have triggers or policies of their own: restore only into a new project';",
      "  end if;",
      `  if (${userObjectCountSql(schemaArray)}) > 0 then`,
      "    raise exception 'the target now has objects in the restored schemas (another restore may have run): restore only into a new project';",
      "  end if;",
      "end $bd$;",
      `select '${XID_MARK}' || pg_current_xact_id();`,
      "",
    ].join("\n");
    if (!(await send(prelude))) return;
    const id = await xidSeen;
    if (!id) return;
    await opts.onTransactionId?.(id);

    // 扩展装在事务里、重查之后:重查看不到这次要装的东西(带配置表的扩展不会把自己拦下),失败时一起回滚
    if (extensions.length) {
      const install = extensions.flatMap((ext) => [
        `create schema if not exists ${quoteIdent(ext.schema)};`,
        // CASCADE 自动带上依赖扩展,免受 manifest 里的安装顺序摆布
        `create extension if not exists ${quoteIdent(ext.name)} schema ${quoteIdent(ext.schema)} cascade;`,
      ]);
      if (!(await send(["", `\\echo ${STAGE_MARK}extensions`, ...install, ""].join("\n")))) return;
    }

    // 2. Auth 用户和 identities(先 users,identities 的外键指向它),清掉待处理的认证状态。
    //    这一段的报错只留 SQLSTATE:PostgreSQL 的报错会带出错行的值(邮箱、metadata)
    if (!(await send(`\n\\echo ${STAGE_MARK}auth-data\n\\set VERBOSITY sqlstate\n`))) return;
    if ((failure = await generate(usersList, opts.archive.path, "the Auth users"))) return;
    if ((failure = await generate(identitiesList, opts.archive.path, "the Auth identities"))) return;
    if (!(await send(`\n${CLEAR_PENDING_AUTH_SQL}\n`))) return;
    // 3. 行数和快照一致,每条 identity 都有它的用户
    const check = [
      "",
      `\\echo ${STAGE_MARK}auth-check`,
      "\\set VERBOSITY default",
      "do $bd$ begin",
      `  if (select count(*) from auth.users) <> ${opts.auth.rows!.users} or (select count(*) from auth.identities) <> ${opts.auth.rows!.identities} then`,
      "    raise exception 'the Auth row counts on the target differ from this snapshot';",
      "  end if;",
      "  if exists (select 1 from auth.identities i where not exists (select 1 from auth.users u where u.id = i.user_id)) then",
      "    raise exception 'some Auth identities have no user';",
      "  end if;",
      "end $bd$;",
      `\\echo ${STAGE_MARK}database`,
      "",
    ].join("\n");
    if (!(await send(check))) return;
    // 4. 应用 schema 和数据
    if ((failure = await generate(prepared.listFile, opts.dumpPath, "the database"))) return;
    // 5. 用户挂在 Auth 表上的触发器
    if (triggersList) {
      if (!(await send(`\n\\echo ${STAGE_MARK}triggers\n`))) return;
      if ((failure = await generate(triggersList, opts.archive.path, "your triggers on the Auth tables"))) return;
    }
    // 6. 前面全部成功才提交
    if (!(await send(`\n\\echo ${STAGE_MARK}commit\n`))) return;
    commitSent = true;
    await send(`commit;\n\\echo ${STAGE_MARK}committed\n`);
  };

  try {
    await run();
  } catch (error) {
    failure = `the restore stopped: ${(error as Error).message}`;
  }
  if (failure || !commitSent) {
    // 没写 COMMIT:停掉 psql,会话一断服务端就回滚
    psql.kill("SIGTERM");
  }
  psql.stdin.end();
  const code = await exited;
  forgetPsql();

  // 没写 COMMIT:一定没提交(这条 SQL 流里没有别的 COMMIT,见 largeObjectEntries)。
  // psql 执行完 COMMIT 才会打印 committed 标记,标记在、psql 0 退出就是提交了;写了 COMMIT 却没等到确认
  // (进程被杀、连接断了),才拿事务号问目标
  const transaction: AuthRestoreRun["transaction"] = !commitSent || !xid
    ? "rolled_back"
    : (stage as Stage | null) === "committed" && code === 0
      ? "committed"
      : await transactionOutcome(opts.connString, xid);

  if (transaction !== "committed") {
    const psqlSays =
      stage === "auth-data"
        ? // 只给 SQLSTATE 的固定说法,不带报错原文
          describeSqlstate(/\bERROR:\s+([0-9A-Z]{5})\b/.exec(stderr)?.[1])
        : /\bERROR:/.test(stderr)
          ? firstPsqlError(stderr)
          : commitSent
            ? `the connection ended before the commit was confirmed (psql exited with ${code === null ? "a signal" : `code ${code}`})`
            : `psql exited with ${code === null ? "a signal" : `code ${code}`}${stderr.trim() ? `: ${firstPsqlError(stderr)}` : ""}`;
    const why =
      spawnError ??
      failure ??
      (interrupted() ? "interrupted" : `${stage ? STAGE_TEXT[stage] : "connecting to the target"} failed: ${psqlSays}`);
    return { transaction, failure: why, xid, triggers: [] };
  }
  const after = await afterCommit(opts.connString, opts.grants, prepared.deferred);
  return { transaction, xid, afterCommit: after, triggers: opts.archive.triggers.map((t) => t.name) };
}

/**
 * 没提交(或查不清)时给用户的那句话。结果只由事务本身说了算(没写 COMMIT,或 pg_xact_status 的回答),
 * 不去数目标里有什么来推断:查不清就如实说查不清,并给出能查清的那条语句
 */
export function authRestoreFailureMessage(run: AuthRestoreRun): string {
  if (run.transaction === "rolled_back") {
    return (
      `database restore failed: ${run.failure}. It ran in one transaction and was rolled back, so nothing from the ` +
      "snapshot (Auth users included) is on the target and you can run restore again on the same project once the cause is fixed."
    );
  }
  return (
    `database restore failed: ${run.failure}. The restore sent COMMIT but couldn't confirm whether the target committed it, ` +
    "so the Auth users and the database are either all there or not there at all. Check before doing anything else" +
    (run.xid ? `: \`select pg_xact_status('${run.xid}'::xid8);\` on the target says committed or aborted.` : ".") +
    " If it committed, the grants and the foreign keys added after the commit are still missing."
  );
}

/**
 * 恢复报告里关于 Auth 的说明(和 RECOVERY.md 同一套说法):哪些用户恢复后登录会受影响、哪些东西要手工补
 */
export function authRestoreNotes(auth: AuthSection, schemas: string[]): { notes: string[]; manual: string[] } {
  const apiGrants = (auth.grants ?? []).filter((g) => ["anon", "authenticated", "service_role", "PUBLIC"].includes(g.grantee));
  const notes = [
    auth.passwordHashes!.encrypted > 0
      ? `${auth.passwordHashes!.encrypted} user(s) have password hashes encrypted with the old project's key; they can't sign in with their old password on a new project and need a password reset.`
      : "",
    auth.passwordHashes!.unrecognized > 0
      ? `${auth.passwordHashes!.unrecognized} user(s) have password hashes in a format BackupDrill doesn't recognize; whether they can sign in with their old password on a new project is unknown. Be ready to send them a password reset.`
      : "",
    auth.ssoUsers! > 0
      ? `${auth.ssoUsers} SSO user(s): their accounts are restored, but SSO providers aren't in this snapshot. Recreating a provider gives it a new ID, so these users may not land on their old accounts.`
      : "",
    auth.anonymousUsers! > 0
      ? `${auth.anonymousUsers} anonymous user(s): restored, but an anonymous user can only sign in with the session they had, and sessions aren't in this snapshot.`
      : "",
    auth.mfaUsers
      ? `${auth.mfaUsers} user(s) had MFA. MFA factors aren't in this snapshot; those users sign in with one factor until they enroll again. Check what your app allows a user at \`aal1\`.`
      : "",
    apiGrants.length
      ? `At backup time the Auth tables had grants to API roles (${[
          ...new Set(apiGrants.map((g) => `${g.privilege} on auth.${g.table} to ${g.grantee}`)),
        ].join(", ")}). A new project sets its own grants on these tables; add back any you had added yourself.`
      : "",
  ].filter(Boolean);
  return { notes, manual: manualAuthObjects({ triggers: auth.triggers!, policies: auth.policies! }, schemas) };
}
