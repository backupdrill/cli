#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { runBackup } from "./backup.js";
import { runEstimate, type EgressPricing } from "./estimate.js";
import { runDrill } from "./drill.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { runRestore, NO_SOURCE_DATABASE } from "./restore.js";

/** 隐藏式秘密输入(PRD §5.3.1):终端不回显;无 TTY(CI/脚本)时明确要求走环境变量。 */
async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${label} is required — set the environment variable (no TTY available for a prompt).`
    );
  }
  const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write(`${label} (hidden): `);
  try {
    const value = (await rl.question("")).trim();
    process.stderr.write("\n");
    if (!value) throw new Error(`${label} was empty.`);
    return value;
  } finally {
    rl.close();
  }
}
import { log } from "./log.js";
import { TOOL_VERSION } from "./version.js";

// Supabase egress 定价表(2026-07-10 核实,来源见 README「Egress & cost」)。
// 备份流量 100% 未缓存,故用 uncached 单价 $0.09/GB;included 用 uncached 额度。
// Free 永不计费:超额走 Fair Use 流程(通知 → 宽限期 → 限制),持续大备份不可行;
// Pro/Team 由 Spend Cap 决定超额限流还是计费。
const EGRESS_PRICING: Record<"free" | "pro" | "team", EgressPricing> = {
  free: { planLabel: "Free", includedGb: 5, pricePerGb: 0.09, hardCap: true },
  pro: { planLabel: "Pro", includedGb: 250, pricePerGb: 0.09, hardCap: false },
  team: { planLabel: "Team", includedGb: 250, pricePerGb: 0.09, hardCap: false },
};

const program = new Command();

program
  .name("backupdrill")
  .description(
    "Back up a Supabase project — Postgres database and Storage files — " +
      "to your own S3/R2/B2 bucket, with a checksummed manifest.\n\n" +
      "Want scheduling, restore drills, and alerts? → https://backupdrill.com"
  )
  .version(TOOL_VERSION);

program
  .command("backup")
  .description("Run a one-off backup to your own bucket")
  .option("-c, --config <path>", "path to a JSON config file", "backupdrill.config.json")
  .option("--database-url <url>", "Supabase Session Pooler connection string")
  .option("--project-name <name>", "readable name for this project (used in the object key)")
  .option(
    "--schema <name...>",
    "schema(s) to back up (default: public; platform schemas like auth/storage are excluded)"
  )
  .option("--bucket <name>", "target S3/R2/B2 bucket")
  .option("--endpoint <url>", "S3-compatible endpoint (required for R2/B2; omit for AWS S3)")
  .option("--region <region>", "bucket region (default: auto)")
  .option("--prefix <prefix>", "key prefix inside the bucket (default: backupdrill)")
  .action(async (opts) => {
    try {
      const config = await loadConfig({
        configPath: opts.config,
        overrides: {
          databaseUrl: opts.databaseUrl,
          projectName: opts.projectName,
          schemas: opts.schema,
          storage: {
            bucket: opts.bucket,
            endpoint: opts.endpoint,
            region: opts.region,
            prefix: opts.prefix,
          },
        },
      });
      const manifest = await runBackup(config);
      const storageNote = manifest.storage
        ? ` + ${manifest.storage.fileCount} Storage files`
        : " (database only)";
      log.ok(
        `Backup complete — ${manifest.database.tableCount} tables` +
          `${storageNote}.`
      );
      // stdout 输出机器可读结果,便于在 CI / GitHub Action 里消费
      process.stdout.write(JSON.stringify({ ok: true, manifest }) + "\n");
    } catch (error) {
      log.error((error as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("drill")
  .description(
    "Restore a snapshot into an ephemeral Postgres and prove it comes back (needs Docker)"
  )
  .option("-c, --config <path>", "path to a JSON config file", "backupdrill.config.json")
  .option("--snapshot <timestamp>", "which snapshot to drill (default: latest)")
  .option("--bucket <name>", "bucket the backups live in")
  .option("--endpoint <url>", "S3-compatible endpoint (for R2/B2)")
  .option("--region <region>", "bucket region")
  .option("--prefix <prefix>", "key prefix inside the bucket (default: backupdrill)")
  .option("--project-name <name>", "project name used in the object key")
  .option("--verify-all-files", "checksum every Storage file, not just a sample")
  .option(
    "--check-cmd <command>",
    "after structural checks pass, run your own smoke test against the restored sandbox " +
      "(connection string in BACKUPDRILL_SANDBOX_URL; exit 0 = pass, reported as 'app checks'). " +
      "Note: connects as the sandbox superuser, so RLS policies are NOT enforced — " +
      "verify data and business invariants here, not RLS behavior"
  )
  .option("--keep", "if the drill fails, keep the sandbox container running for inspection")
  .action(async (opts) => {
    try {
      if (opts.checkCmd !== undefined && !String(opts.checkCmd).trim()) {
        throw new Error(
          "--check-cmd is empty (did an env var fail to expand?) — refusing to run a drill " +
            "that would report a check that never executes"
        );
      }
      const config = await loadConfig({
        configPath: opts.config,
        overrides: {
          projectName: opts.projectName,
          // drill 只读桶,不连源库;给 databaseUrl 占位以通过校验
          databaseUrl: "postgresql://unused",
          storage: {
            bucket: opts.bucket,
            endpoint: opts.endpoint,
            region: opts.region,
            prefix: opts.prefix,
          },
        },
      });
      const report = await runDrill(config, {
        snapshot: opts.snapshot,
        verifyAllFiles: opts.verifyAllFiles,
        appCheckCommand: opts.checkCmd,
        keepSandboxOnFailure: opts.keep,
      });
      console.error("");
      for (const c of report.checks) {
        console.error(`  ${c.pass ? "✓" : "✗"} ${c.name} — ${c.detail}`);
      }
      console.error("");
      log[report.pass ? "ok" : "error"](
        `Drill ${report.pass ? "PASSED" : "FAILED"} — snapshot ${report.snapshot}, ` +
          `${report.restoredTableCount} tables / ${report.restoredRowTotal.toLocaleString()} rows ` +
          `restored in ${report.restoreSeconds}s`
      );
      process.stdout.write(JSON.stringify({ ok: report.pass, report }) + "\n");
      if (!report.pass) process.exitCode = 1;
    } catch (error) {
      log.error((error as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("restore")
  .description(
    "Recover a snapshot into a FRESH Supabase project: database via the drill-grade engine, " +
      "Storage files uploaded back (or downloaded locally). Start with --dry-run."
  )
  .option("-c, --config <path>", "path to a JSON config file", "backupdrill.config.json")
  .option(
    "--database",
    "restore the database — connection string via env BACKUPDRILL_TARGET_DATABASE_URL or a hidden prompt " +
      "(2.0: the credential-bearing --target-database-url flag was removed; argv is visible to every process)"
  )
  .option(
    "--target-supabase-url <url>",
    "target project URL (https://<ref>.supabase.co) to upload Storage files into; " +
      "service-role key via env BACKUPDRILL_TARGET_SERVICE_ROLE_KEY or a hidden prompt"
  )
  .option("--confirm-target <ref>", "type the TARGET project ref to confirm writing to it")
  .option("--dry-run", "run every read-only preflight check and write nothing")
  .option("--storage-dir <path>", "local directory to write Storage files to (when not uploading)")
  .option("--snapshot <timestamp>", "which snapshot to restore (default: latest)")
  .option("--bucket <name>", "bucket the backups live in")
  .option("--endpoint <url>", "S3-compatible endpoint (for R2/B2)")
  .option("--region <region>", "bucket region")
  .option("--prefix <prefix>", "key prefix inside the bucket (default: backupdrill)")
  .option("--project-name <name>", "project name used in the object key")
  .action(async (opts) => {
    try {
      // 源库连接串不再无条件屏蔽:配置/环境里有真实源时,runRestore 的同源阻断门
      // 要拿它比对;纯 flag 驱动(无任何源配置)才退回占位符
      const overrides = {
        projectName: opts.projectName,
        storage: {
          bucket: opts.bucket,
          endpoint: opts.endpoint,
          region: opts.region,
          prefix: opts.prefix,
        },
      };
      let config;
      try {
        config = await loadConfig({ configPath: opts.config, overrides });
      } catch (error) {
        if (!/databaseUrl/.test((error as Error).message)) throw error;
        config = await loadConfig({
          configPath: opts.config,
          overrides: { ...overrides, databaseUrl: NO_SOURCE_DATABASE },
        });
      }
      // 凭据形态(决策 D6,2.0 起):env 或隐藏式交互输入,绝不经 argv。
      // --database 只表达意图,秘密自身不上命令行
      let targetDatabaseUrl = process.env.BACKUPDRILL_TARGET_DATABASE_URL;
      if (opts.database && !targetDatabaseUrl) {
        targetDatabaseUrl = await promptSecret(
          "Target database connection string (BACKUPDRILL_TARGET_DATABASE_URL)"
        );
      }
      let targetServiceRoleKey = process.env.BACKUPDRILL_TARGET_SERVICE_ROLE_KEY;
      if (opts.targetSupabaseUrl && !targetServiceRoleKey) {
        targetServiceRoleKey = await promptSecret(
          "Target service-role key (BACKUPDRILL_TARGET_SERVICE_ROLE_KEY)"
        );
      }
      const result = await runRestore(config, {
        targetDatabaseUrl,
        targetSupabaseUrl: opts.targetSupabaseUrl,
        targetServiceRoleKey,
        confirmTarget: opts.confirmTarget,
        dryRun: opts.dryRun,
        storageDir: opts.storageDir,
        snapshot: opts.snapshot,
      });
      // stdout = 机器可读通道(人读日志全在 stderr):完整结构化结果供脚本/报告消费
      console.log(JSON.stringify(result));
      if (result.dryRun) return; // 预检自行打印结论;走到这里 = 零 blocker
      const failedChecks = (result.databaseChecks ?? []).filter((c) => !c.pass);
      const rec = result.storageSummary?.reconcile;
      const storageProblems =
        (result.storageSummary?.filesFailed.length ?? 0) +
        (result.storageSummary?.checksumSample.mismatched.length ?? 0) +
        (rec ? rec.missing.length + rec.sizeMismatched.length : 0);
      const summary =
        `snapshot ${result.snapshot}: ` +
        `database ${result.restoredToDatabase ? "restored" : "skipped"}, ` +
        `${result.storageFilesWritten} Storage files ${result.storageSummary ? "uploaded to target" : "written"}` +
        (result.storageDir ? ` to ${result.storageDir}` : "");
      if (failedChecks.length || storageProblems) {
        log.error(
          `Restore finished with issues (${failedChecks.length} failed check(s), ` +
            `${storageProblems} storage problem(s)) — ${summary}`
        );
        process.exitCode = 1;
      } else {
        log.ok(`Restore complete — ${summary}`);
      }
    } catch (error) {
      log.error((error as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("estimate")
  .description("Measure your DB + Storage size and project monthly Supabase egress cost")
  .option("-c, --config <path>", "path to a JSON config file", "backupdrill.config.json")
  .option("--database-url <url>", "Supabase Session Pooler connection string")
  .option("--schema <name...>", "schema(s) to measure (default: public)")
  .option("--plan <plan>", "your Supabase plan for the cost estimate: free | pro | team", "pro")
  .action(async (opts) => {
    try {
      const config = await loadConfig({
        configPath: opts.config,
        overrides: {
          databaseUrl: opts.databaseUrl,
          schemas: opts.schema,
          // estimate 不写数据,给目标桶占位以通过校验(仅用 databaseUrl + 源)
          storage: { bucket: "estimate", accessKeyId: "estimate", secretAccessKey: "estimate" },
        },
      });
      const pricing = EGRESS_PRICING[opts.plan as keyof typeof EGRESS_PRICING];
      if (!pricing) throw new Error(`Unknown plan "${opts.plan}". Use free | pro | team.`);
      await runEstimate(config, pricing);
    } catch (error) {
      log.error((error as Error).message);
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((error) => {
  log.error((error as Error).message);
  process.exitCode = 1;
});
