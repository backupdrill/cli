// RECOVERY.md 落桶(恢复闭环 PRD §5.9.2.1):每次备份把一份自包含恢复手册写进快照前缀。
// 设计约束:
//  - 自包含:即使 BackupDrill 服务与域名全部消失,凭这份文件 + 标准 PostgreSQL 工具
//    也能完成数据库恢复——这是 BYO bucket 独立性承诺的收尾。
//  - 零秘密:输入类型只收非秘密字段(对象键、桶名、端点、清单统计),函数签名上
//    就不给凭据留入口;测试钉住内容与 manifest 一致。
//  - 诚实边界:未覆盖项(Auth/秘密值/Edge Functions/平台配置)必须写明,
//    不把部分恢复表述成完整项目恢复(PRD §2.2 禁用表述)。
import type { Manifest } from "./manifest.js";
import { recoveryGrantsSql } from "./grants.js";
import { plainSchemaName, restorableAuthObjects } from "./auth-backup.js";
import { authRestoreNotes, CLEAR_PENDING_AUTH_SQL } from "./auth-restore.js";

/** 生成手册所需的非秘密快照坐标。刻意不收连接串/密钥类型——签名即防线。 */
export interface RecoveryDocContext {
  snapshot: string; // 快照时间戳目录名
  bucket: string;
  endpoint?: string; // S3 兼容端点(R2/B2 需要;AWS 可省)
  region?: string; // 无原始配置可依时,签名区域错了 AWS/B2 直接失败
  prefix: string;
  projectName: string;
}

function quoteSqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const ereEscape = (s: string) => s.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");

const AUTH_NOT_INCLUDED_TEXT: Record<string, string> = {
  no_permission: "the backup role couldn't read every row of the Auth tables",
  no_auth_schema: "the source database has no Supabase auth schema",
  unsupported_destination: "this destination couldn't hold the Auth archive",
  schemas_include_auth: "the auth schema is part of the database dump",
  schemas_not_plain:
    "the schema list used a pattern or a quoted name; the Auth users are in the database dump only if one of those patterns matched auth",
  too_large: "the Auth archive was larger than 2 GiB",
  snapshot_unavailable: "a consistent snapshot for the Auth export couldn't be set up",
};

/** POSIX 安全的 shell 值引用:项目名/前缀里合法的空格与元字符不得拆散或改写命令。 */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9._/:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 手册里的归档在哪。bucket = S3 兼容桶,写完整对象键;folder = 托管 worker 的 Google Drive 目标,
 * 手册就放在归档旁边,写文件名,name 是下载那一步说的"从哪里下"(如 "Google Drive folder")
 */
export type RecoveryDocPlace = { kind: "bucket" } | { kind: "folder"; name: string };

export interface AuthRecoveryText {
  /** "What this snapshot contains" 里 Auth 那一行(带换行);manifest 没有 auth 段时为空串 */
  contentsLine: string;
  /** 只有 Auth 为 included 的快照才有:替换"Not covered"整段和恢复的第 3、4 步 */
  included: { notCovered: string; restoreSteps: string } | null;
}

/**
 * RECOVERY.md 里和 Auth 用户有关的段落(2.10.0 起)。S3 版(renderRecoveryDoc)和托管 worker 的
 * Google Drive 版共用这一份:单事务恢复脚本里的空目标检查、清理待处理链接、行数核对,两边不能各写各的。
 * 没有 auth 字段的快照:contentsLine 为空、included 为 null,手册和 2.10.0 之前一样
 */
export function authRecoveryText(manifest: Manifest, place: RecoveryDocPlace): AuthRecoveryText {
  const db = manifest.database;
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  // 只有 included 的快照带 auth.dump
  const auth = manifest.auth?.status === "included" ? manifest.auth : null;
  const dumpFile = place.kind === "bucket" ? manifest.dump.key : "dump.pgcustom";
  const authFile = place.kind === "bucket" ? (auth?.dump?.key ?? "auth.dump") : "auth.dump";
  const authListing = place.kind === "bucket" ? `\`${authFile}\`` : "`auth.dump` in this folder";
  const container = place.kind === "bucket" ? "bucket" : place.name;
  const authLine = auth
    ? `- **Supabase Auth users**: ${authListing}
  (pg_dump custom format, ${mb(auth.dump!.bytes)} MB, sha256 \`${auth.dump!.sha256}\`) — ${auth.rows!.users.toLocaleString("en-US")} users, ${auth.rows!.identities.toLocaleString("en-US")} sign-in identities
`
    : manifest.auth
      ? `- **Supabase Auth users**: not in this snapshot (${AUTH_NOT_INCLUDED_TEXT[manifest.auth.reason ?? ""] ?? manifest.auth.reason ?? "not captured"})
`
      : "";
  // 空目标检查用的 schema 列表(SQL 字符串字面量,单引号按 SQL 规则加倍)
  // 含 Auth 的快照里 schemas 全是普通名字(见 authInSchemas),按 pg_dump 的规则规范化后逐个比较
  // plainSchemaName 只放行 [a-z0-9_],拼进 SQL 字面量是安全的;万一出现别的(不该发生),整项不放进去
  const schemaListSql = db.schemas
    .map((name) => plainSchemaName(name))
    .filter((name): name is string => name !== null)
    .map((name) => `'${name}'`)
    .join(", ");
  // 自动补建的只有 restorableAuthObjects 认可的触发器(名字都是普通标识符,拼进命令也安全);
  // 其余写进下面的手工步骤
  const restorable = auth ? restorableAuthObjects({ triggers: auth.triggers!, policies: auth.policies! }, db.schemas) : null;
  const authObjects = restorable ? restorable.triggers.map((t) => `TRIGGER auth ${t.table} ${t.name}`) : [];
  const authObjectsGrep = authObjects.map((o) => ereEscape(o)).join("|");
  const authNotes = auth
    ? (() => {
        const { notes, manual } = authRestoreNotes(auth, db.schemas);
        return [
          ...notes.map((note) => `- ${note}`),
          ...manual.map(
            (note) => `- The ${note}. Its definition is in \`auth.dump\` (\`pg_restore --section=post-data -f - auth.dump\`).`
          ),
        ];
      })()
    : [];

  if (!auth) return { contentsLine: authLine, included: null };
  const notCovered = `Supabase **Auth sessions and MFA factors, Auth settings (sign-in providers,
SMTP, redirect URLs, email templates), secret values, Edge Function code and most
platform settings are NOT in this snapshot**. After restoring, reconfigure them
by hand; everyone signs in once more. The Auth users themselves (IDs, emails,
password hashes, sign-in identities) are in this snapshot and are restored in
step 4 below, together with the database.
${authNotes.length ? `\n${authNotes.join("\n")}\n` : ""}`;
  const restoreSteps = `3. Download \`${dumpFile}\` and \`${authFile}\` from this
   ${container}, then verify them:

\`\`\`bash
shasum -a 256 dump.pgcustom   # must print ${manifest.dump.sha256}
shasum -a 256 auth.dump       # must print ${auth.dump!.sha256}
\`\`\`

4. Restore the Auth users and the database **in one transaction**, so any error
   leaves the target exactly as it was and you can simply run it again. First turn
   both archives into one SQL file; go on only if the last line prints
   \`restore.sql is complete\` (a half-written file would otherwise be committed):

\`\`\`bash
(
  set -euo pipefail
  pg_restore -l dump.pgcustom > database.full.list
  grep -Ev '^[0-9]+; [0-9]+ [0-9]+ SCHEMA - public ' database.full.list > database.list
${authObjects.length ? `  pg_restore -l auth.dump > auth.full.list
  grep -E '^[0-9]+; [0-9]+ [0-9]+ (${authObjectsGrep}) ' auth.full.list > auth-objects.list
  test "$(wc -l < auth-objects.list)" -eq ${authObjects.length}
` : ""}  {
    cat <<'SQL'
lock table auth.users, auth.identities in share row exclusive mode;
do $bd$ begin
  if exists (select 1 from auth.users) then
    raise exception 'auth.users is not empty: restore only into a new project';
  end if;
  if exists (select 1 from pg_trigger
              where tgrelid in ('auth.users'::regclass, 'auth.identities'::regclass) and not tgisinternal)
     or exists (select 1 from pg_policy where polrelid in ('auth.users'::regclass, 'auth.identities'::regclass)) then
    raise exception 'the Auth tables already have triggers or policies: restore only into a new project';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = any (array[${schemaListSql}]) and c.relkind in ('r', 'p', 'v', 'm', 'f')
                and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')) then
    raise exception 'the target already has tables in the restored schemas: restore only into a new project';
  end if;
end $bd$;
SQL
    pg_restore --data-only --no-owner --no-privileges -n auth -t users -f - auth.dump
    pg_restore --data-only --no-owner --no-privileges -n auth -t identities -f - auth.dump
    cat <<'SQL'
${CLEAR_PENDING_AUTH_SQL}
do $bd$ begin
  if (select count(*) from auth.users) <> ${auth.rows!.users} or (select count(*) from auth.identities) <> ${auth.rows!.identities} then
    raise exception 'the Auth row counts differ from this snapshot';
  end if;
end $bd$;
SQL
    pg_restore --no-owner --no-privileges -L database.list -f - dump.pgcustom
${authObjects.length ? `    pg_restore --no-owner --no-privileges -L auth-objects.list -f - auth.dump
` : ""}  } > restore.sql
  echo "restore.sql is complete"
)
\`\`\`

   Then run it against the empty target. pg_restore 17 and newer write
   \`SET transaction_timeout\`, which PostgreSQL 16 and older reject, so restore into
   a PostgreSQL 17+ project (new Supabase projects are) or generate the file with a
   pg_restore matching the target. Enter the password at a hidden prompt so it never
   touches the URL, argv, or shell history:

\`\`\`bash
read -rs PGPASSWORD && export PGPASSWORD   # hidden prompt
psql -X --single-transaction -v ON_ERROR_STOP=1 \\
  --dbname "postgresql://postgres.<target-ref>@<target-pooler-host>:5432/postgres" -f restore.sql
unset PGPASSWORD
\`\`\`

The script stops if the target already has Auth users, triggers or policies on the
Auth tables, or tables in the restored schemas, so it never merges into an
existing project. The Auth users go in first, so foreign keys into
\`auth.users\` resolve, and their count is checked against this snapshot. Links
and codes for password resets, email confirmations and email or phone changes
that were pending at backup time are cleared. ${
        authObjects.length
          ? "Your triggers on the Auth tables are recreated at the end."
          : "There are no triggers of your own on the Auth tables to recreate."
      } Do **not** use \`--clean\` against a Supabase project: it drops and
recreates \`public\`, and the grants Supabase put on it go with it.
`;
  return { contentsLine: authLine, included: { notCovered, restoreSteps } };
}

export function renderRecoveryDoc(manifest: Manifest, ctx: RecoveryDocContext): string {
  const base = manifest.dump.key.replace(/\/dump\.pgcustom$/, "");
  const db = manifest.database;
  const extensions = db.extensions ?? [];
  const storage = manifest.storage;
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  // 归档格式跟随 dump 工具版本(允许比服务端新):pg_restore 必须 ≥ 两者较大值,
  // 只按服务端版本指引会让 PG17 的 pg_restore 读不了 PG18 pg_dump 写的归档。
  // 解析口径与 backup.ts parsePgDumpMajor 一致(不 import:backup → recovery-doc 会成环)
  const dumpToolMajor =
    db.pgDumpVersion.match(/\(PostgreSQL\)\s+(\d+)/)?.[1] ??
    db.pgDumpVersion.match(/(\d+)(?:\.\d+)+/)?.[1];
  const requiredRestoreMajor = Math.max(
    Number(dumpToolMajor ?? 0),
    parseInt(db.serverVersion, 10) || 0
  );

  const extensionSql = extensions.length
    ? extensions
        .map(
          (e) =>
            `create schema if not exists ${quoteSqlIdent(e.schema)};\n` +
            `create extension if not exists ${quoteSqlIdent(e.name)} schema ${quoteSqlIdent(e.schema)} cascade;`
        )
        .join("\n")
    : "-- (this snapshot records no extensions)";

  // Auth 用户(2.10.0 起):没有 auth 字段的快照,下面用到的三段都和以前一样
  const authText = authRecoveryText(manifest, { kind: "bucket" });
  const auth = authText.included;

  // 2.0 形态:凭据只经环境变量(argv 对全机器可见);写入需要键入目标 ref 确认。
  // DB-only 快照不出现 Storage 凭据与旗标——不为用不上的能力索要宽权限 key
  const cliRestoreCommand = [
    `read -rs BACKUPDRILL_TARGET_DATABASE_URL && export BACKUPDRILL_TARGET_DATABASE_URL   # hidden prompt`,
    ...(storage
      ? [`read -rs BACKUPDRILL_TARGET_SERVICE_ROLE_KEY && export BACKUPDRILL_TARGET_SERVICE_ROLE_KEY`]
      : []),
    `backupdrill restore \\`,
    `  --snapshot ${shellQuote(ctx.snapshot)} \\`,
    `  --bucket ${shellQuote(ctx.bucket)} \\`,
    ...(ctx.endpoint ? [`  --endpoint ${shellQuote(ctx.endpoint)} \\`] : []),
    ...(ctx.region ? [`  --region ${shellQuote(ctx.region)} \\`] : []),
    `  --prefix ${shellQuote(ctx.prefix)} \\`,
    `  --project-name ${shellQuote(ctx.projectName)} \\`,
    `  --database \\`,
    ...(storage ? [`  --target-supabase-url https://<target-ref>.supabase.co \\`] : []),
    `  --confirm-target <target-ref>`,
  ].join("\n");

  // 没有 Auth 的快照:以下两段与 2.10.0 之前逐字一致
  const notCovered = auth
    ? auth.notCovered
    : `Supabase **Auth users/sessions, secret values, Edge Function code and most
platform settings are NOT in this snapshot**. After restoring, reconfigure them
by hand. This is a database + Storage snapshot, not a full project image.
${
  db.schemas.includes("auth")
    ? ""
    : `
If a table in this snapshot has a foreign key into \`auth.users\` (a \`profiles.id\`
that references it, for example), copy the Auth users into the new project
**before** restoring, or that foreign key can't be created and the restore fails.
\`backupdrill restore --dry-run\` checks those keys against the new project and reports
the rows that have no user, plus any key it couldn't check.
Triggers on \`auth.users\` aren't in this snapshot either; recreate them afterwards.
`
}`;

  const restoreSteps = auth
    ? auth.restoreSteps
    : `3. Download \`${manifest.dump.key}\` from this bucket, then verify it:

\`\`\`bash
shasum -a 256 dump.pgcustom   # must print ${manifest.dump.sha256}
\`\`\`

4. Restore — **without \`--clean\`**, into the empty target. Enter the password at
   a hidden prompt so it never touches the URL, argv, or shell history:

\`\`\`bash
read -rs PGPASSWORD && export PGPASSWORD   # hidden prompt
pg_restore --no-owner --no-privileges \\
  --dbname "postgresql://postgres.<target-ref>@<target-pooler-host>:5432/postgres" dump.pgcustom
unset PGPASSWORD
\`\`\`

One error is expected and harmless: \`schema "public" already exists\` (the
target always has it). A foreign key error mentioning \`auth.users\` means the
Auth users were not copied in first (see "Not covered" above). Do **not** use \`--clean\` against a Supabase project:
it drops and recreates \`public\`, and the grants Supabase put on it go with it.
`;

  const cliSection = auth
    ? `## The BackupDrill CLI

\`backupdrill restore\` 2.10.0 and newer does step 4 for you: the Auth users and the
database go in one transaction, and it checks the target before writing anything.
It needs \`psql\` from the same PostgreSQL client package as \`pg_restore\`.

\`\`\`bash
npm install -g backupdrill
${cliRestoreCommand}
\`\`\`

Add \`--dry-run\` first to preview every check without writing anything. (Skip the
\`read\` lines to have the CLI prompt you itself; \`unset\` the variables afterwards.)
If it's interrupted while committing, run \`backupdrill restore --status\` with the same
\`BACKUPDRILL_TARGET_DATABASE_URL\` on the same machine: it says whether the restore
committed. If it did and the grants or foreign keys after the commit didn't finish,
\`backupdrill restore --finish --confirm-target <target-ref>\` with the same settings
does them. \`--skip-auth\` restores the database without the Auth users.

`
    : `## Easiest path — the BackupDrill CLI

\`\`\`bash
npm install -g backupdrill
${cliRestoreCommand}
\`\`\`

Add \`--dry-run\` first to preview every check without writing anything. (Skip the
\`read\` lines to have the CLI prompt you itself; \`unset\` both variables afterwards.)
The CLI verifies the archive checksum, refuses non-empty targets, checks that rows
referenced outside the snapshot (such as \`auth.users\`) are on the target, installs
the extensions, restores the database in a single transaction through the same
engine the weekly drills use (an SQL error rolls it back and the extensions stay
installed; if the connection drops while it commits, check the target before
retrying), sets the grants above, verifies table counts and row presence afterwards, then rebuilds buckets, uploads the
Storage files back and reconciles every one against the target.

`;

  return `# BackupDrill recovery runbook — ${ctx.projectName} @ ${ctx.snapshot}

This file was written next to the snapshot it describes and is **self-contained**:
even if BackupDrill (the service and the website) is unreachable, everything below
works with standard PostgreSQL tools against this bucket alone.

## What this snapshot contains

- **Database dump**: \`${manifest.dump.key}\`
  (pg_dump custom format, ${mb(manifest.dump.bytes)} MB, sha256 \`${manifest.dump.sha256}\`)
  - schemas: ${db.schemas.join(", ")} — ${db.tableCount} tables, ~${db.estimatedRowTotal.toLocaleString("en-US")} rows at backup time
  - source PostgreSQL ${db.serverVersion}, archive written by ${db.pgDumpVersion} — restore with pg_restore ${requiredRestoreMajor} or newer (the archive format follows the dump tool, not the server)
${
  extensions.length
    ? `  - extensions required: ${extensions.map((e) => `${e.name} (schema "${e.schema}")`).join(", ")}`
    : "  - no extensions recorded"
}
- **Storage files**: ${
    storage
      ? `${storage.fileCount} files, ${mb(storage.totalBytes)} MB under \`${base}/storage/<bucket>/<key>\` — per-file sha256 in manifest.json`
      : "none (database-only snapshot)"
  }
${authText.contentsLine}- **Machine-readable inventory**: \`${base}/manifest.json\`

## Not covered — plan for these separately

${notCovered}
## Restore the database (into an EMPTY project)

1. Create a **fresh** Supabase project (never restore onto the source project),
   and use its **Session Pooler** connection string.
2. Install the required extensions first (the dump references their types):

\`\`\`sql
${extensionSql}
\`\`\`

${restoreSteps}
5. Set the grants for \`anon\`, \`authenticated\` and \`service_role\`. The dump
   carries none. With Supabase's new defaults, supabase-js requests to restored
   tables in \`public\` fail with \`42501 permission denied\` until you grant access. ${
     db.grants
       ? `Run this block in the SQL editor or psql. It first takes access away from
   these roles (and \`PUBLIC\`) on everything the restore created, then grants back
   what the source had at backup time (the same list is in manifest.json under
   \`database.grants\`). A grant whose object isn't in this restore is skipped with a warning:`
       : `This snapshot was taken before BackupDrill recorded grants. The statements below
   give the three roles Supabase's old default access to everything in \`public\`;
   afterwards, revoke it on any table you had kept private:`
   }

\`\`\`sql
${recoveryGrantsSql(db)}
\`\`\`

## Restore Storage files

Files live at \`${base}/storage/<original-bucket>/<original-key>\` in this
bucket. Recreate each bucket in the target project, then re-upload the files
${storage?.buckets ? "(bucket attributes — public flag, size and MIME limits — are recorded in manifest.json under `storage.buckets`)" : "(bucket attributes were not captured for this snapshot; recreate buckets with the settings you know)"}.

${cliSection}More: https://backupdrill.com/docs/restore
`;
}
