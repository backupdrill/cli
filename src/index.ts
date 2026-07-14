#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { runBackup } from "./backup.js";
import { runEstimate, type EgressPricing } from "./estimate.js";
import { runDrill } from "./drill.js";
import { runRestore } from "./restore.js";
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
  .description("Recover a snapshot: restore the database into a target and pull Storage files down")
  .option("-c, --config <path>", "path to a JSON config file", "backupdrill.config.json")
  .option("--target-database-url <url>", "connection string to restore the database INTO")
  .option("--storage-dir <path>", "local directory to write Storage files to")
  .option("--snapshot <timestamp>", "which snapshot to restore (default: latest)")
  .option("--bucket <name>", "bucket the backups live in")
  .option("--endpoint <url>", "S3-compatible endpoint (for R2/B2)")
  .option("--region <region>", "bucket region")
  .option("--prefix <prefix>", "key prefix inside the bucket (default: backupdrill)")
  .option("--project-name <name>", "project name used in the object key")
  .action(async (opts) => {
    try {
      const config = await loadConfig({
        configPath: opts.config,
        overrides: {
          projectName: opts.projectName,
          databaseUrl: "postgresql://unused", // restore 读桶,不连源库
          storage: {
            bucket: opts.bucket,
            endpoint: opts.endpoint,
            region: opts.region,
            prefix: opts.prefix,
          },
        },
      });
      const result = await runRestore(config, {
        targetDatabaseUrl: opts.targetDatabaseUrl,
        storageDir: opts.storageDir,
        snapshot: opts.snapshot,
      });
      log.ok(
        `Restore complete — snapshot ${result.snapshot}: ` +
          `database ${result.restoredToDatabase ? "restored" : "skipped"}, ` +
          `${result.storageFilesWritten} Storage files written` +
          (result.storageDir ? ` to ${result.storageDir}` : "")
      );
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
