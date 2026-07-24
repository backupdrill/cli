// RECOVERY.md 落桶(恢复闭环 PRD §5.9.2.1):每次备份把一份自包含恢复手册写进快照前缀。
// 设计约束:
//  - 自包含:即使 BackupDrill 服务与域名全部消失,凭这份文件 + 标准 PostgreSQL 工具
//    也能完成数据库恢复——这是 BYO bucket 独立性承诺的收尾。
//  - 零秘密:输入类型只收非秘密字段(对象键、桶名、端点、清单统计),函数签名上
//    就不给凭据留入口;测试钉住内容与 manifest 一致。
//  - 诚实边界:未覆盖项(Auth/秘密值/Edge Functions/平台配置)必须写明,
//    不把部分恢复表述成完整项目恢复(PRD §2.2 禁用表述)。
import type { Manifest } from "./manifest.js";

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

/** POSIX 安全的 shell 值引用:项目名/前缀里合法的空格与元字符不得拆散或改写命令。 */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9._/:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
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

  // 2.0 形态:凭据只经环境变量(argv 对全机器可见);写入需要键入目标 ref 确认。
  // DB-only 快照不出现 Storage 凭据与旗标——不为用不上的能力索要宽权限 key
  const cliRestoreCommand = [
    `export BACKUPDRILL_TARGET_DATABASE_URL="<target-session-pooler-url>"`,
    ...(storage ? [`export BACKUPDRILL_TARGET_SERVICE_ROLE_KEY="<target-service-role-key>"`] : []),
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
- **Machine-readable inventory**: \`${base}/manifest.json\`

## Not covered — plan for these separately

Supabase **Auth users/sessions, secret values, Edge Function code and most
platform settings are NOT in this snapshot**. After restoring, reconfigure them
by hand. This is a database + Storage snapshot, not a full project image.

## Restore the database (into an EMPTY project)

1. Create a **fresh** Supabase project (never restore onto the source project),
   and use its **Session Pooler** connection string.
2. Install the required extensions first (the dump references their types):

\`\`\`sql
${extensionSql}
\`\`\`

3. Download \`${manifest.dump.key}\` from this bucket, then verify it:

\`\`\`bash
shasum -a 256 dump.pgcustom   # must print ${manifest.dump.sha256}
\`\`\`

4. Restore — **without \`--clean\`**, into the empty target. Keep the password out
   of the URL and out of shell history via \`PGPASSWORD\`:

\`\`\`bash
export PGPASSWORD="<target-database-password>"
pg_restore --no-owner --no-privileges \\
  --dbname "postgresql://postgres.<target-ref>@<target-pooler-host>:5432/postgres" dump.pgcustom
\`\`\`

One error is expected and harmless: \`schema "public" already exists\` (the
target always has it). Do **not** use \`--clean\` against a Supabase project —
dropping and recreating \`public\` silently wipes Supabase's default grants for
\`anon\`/\`authenticated\`, and the restored API answers 401.

## Restore Storage files

Files live at \`${base}/storage/<original-bucket>/<original-key>\` in this
bucket. Recreate each bucket in the target project, then re-upload the files
${storage?.buckets ? "(bucket attributes — public flag, size and MIME limits — are recorded in manifest.json under `storage.buckets`)" : "(bucket attributes were not captured for this snapshot; recreate buckets with the settings you know)"}.

## Easiest path — the BackupDrill CLI

\`\`\`bash
npm install -g backupdrill
${cliRestoreCommand}
\`\`\`

Add \`--dry-run\` first to preview every check without writing anything.
The CLI verifies the archive checksum, refuses non-empty targets, installs the
extensions, restores through the same engine the weekly drills use, verifies
table counts and row presence afterwards, then rebuilds buckets, uploads the
Storage files back and reconciles every one against the target.

More: https://backupdrill.com/docs/restore
`;
}
