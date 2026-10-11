// 插件附带的定时备份工作流必须转发 CLI 认的每一个备份设置:漏一个就会静默改行为
// (交叉审查:本地 public,audit 的备份,搬进工作流后只剩 public,快照前缀也变了)。
// 设置名直接从源码里收集,CLI 以后新加的设置没进工作流,这里就会失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath 而不是 .pathname:路径里有空格时 .pathname 会留着 %20,读文件就 ENOENT
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = join(ROOT, "plugin/skills/supabase-backup/assets/scheduled-backup.yml");

// 不属于 `backup` 的设置:恢复目标、演练沙箱、Storage 回传阈值;pg_dump 路径由前一步写进 $GITHUB_ENV
const NOT_BACKUP_SETTINGS = new Set([
  "BACKUPDRILL_TARGET_DATABASE_URL",
  "BACKUPDRILL_TARGET_SERVICE_ROLE_KEY",
  "BACKUPDRILL_PG_RESTORE",
  "BACKUPDRILL_SANDBOX_URL",
  "BACKUPDRILL_TUS_THRESHOLD",
  "BACKUPDRILL_PG_DUMP",
]);

function settingsTheCliReads() {
  const names = new Set();
  for (const file of readdirSync(join(ROOT, "src"))) {
    if (!file.endsWith(".ts")) continue;
    for (const match of readFileSync(join(ROOT, "src", file), "utf8").matchAll(/BACKUPDRILL_[A-Z0-9_]+/g)) {
      names.add(match[0]);
    }
  }
  return [...names].filter((name) => !NOT_BACKUP_SETTINGS.has(name)).sort();
}

test("定时备份工作流转发 CLI 认的每一个备份设置", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const missing = settingsTheCliReads().filter(
    (name) => !workflow.includes(`${name}: \${{ secrets.${name} }}`)
  );
  assert.deepEqual(missing, [], `scheduled-backup.yml does not forward: ${missing.join(", ")}`);
});

test("工作流里 pg_dump 路径由单独一步写进 $GITHUB_ENV", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /BACKUPDRILL_PG_DUMP=\/usr\/lib\/postgresql\/17\/bin\/pg_dump" >> "\$GITHUB_ENV"/);
});
