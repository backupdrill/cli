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
  prefix: string;
  projectName: string;
}

function quoteSqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function renderRecoveryDoc(manifest: Manifest, ctx: RecoveryDocContext): string {
  const base = manifest.dump.key.replace(/\/dump\.pgcustom$/, "");
  const db = manifest.database;
  const extensions = db.extensions ?? [];
  const storage = manifest.storage;
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

  const extensionSql = extensions.length
    ? extensions
        .map(
          (e) =>
            `create schema if not exists ${quoteSqlIdent(e.schema)};\n` +
            `create extension if not exists ${quoteSqlIdent(e.name)} schema ${quoteSqlIdent(e.schema)} cascade;`
        )
        .join("\n")
    : "-- (this snapshot records no extensions)";

  const cliRestoreCommand = [
    `backupdrill restore \\`,
    `  --snapshot ${ctx.snapshot} \\`,
    `  --bucket ${ctx.bucket} \\`,
    ...(ctx.endpoint ? [`  --endpoint ${ctx.endpoint} \\`] : []),
    `  --prefix ${ctx.prefix} \\`,
    `  --project-name ${ctx.projectName} \\`,
    `  --target-database-url "<target-session-pooler-url>"`,
  ].join("\n");

  return `# BackupDrill recovery runbook — ${ctx.projectName} @ ${ctx.snapshot}

This file was written next to the snapshot it describes and is **self-contained**:
even if BackupDrill (the service and the website) is unreachable, everything below
works with standard PostgreSQL tools against this bucket alone.

## What this snapshot contains

- **Database dump**: \`${manifest.dump.key}\`
  (pg_dump custom format, ${mb(manifest.dump.bytes)} MB, sha256 \`${manifest.dump.sha256}\`)
  - schemas: ${db.schemas.join(", ")} — ${db.tableCount} tables, ~${db.estimatedRowTotal.toLocaleString("en-US")} rows at backup time
  - source PostgreSQL ${db.serverVersion}; restore with pg_restore of the same or newer major
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

4. Restore — **without \`--clean\`**, into the empty target:

\`\`\`bash
pg_restore --no-owner --no-privileges \\
  --dbname "<target-session-pooler-url>" dump.pgcustom
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

The CLI verifies the archive checksum, refuses non-empty targets, installs the
extensions, restores through the same engine the weekly drills use, verifies
table counts and row presence afterwards, and downloads Storage files locally.

More: https://backupdrill.com/docs/restore
`;
}
