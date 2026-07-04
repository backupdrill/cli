#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { runBackup } from "./backup.js";
import { runEstimate, type EgressPricing } from "./estimate.js";
import { log } from "./log.js";

// Supabase egress 定价表(2026-07-04 核实,来源见 README「Egress & cost」)。
// 备份流量 100% 未缓存,故用 uncached 单价 $0.09/GB;included 用 uncached 额度。
// Free 硬上限(超额即限流,不计费);Pro/Team 由 Spend Cap 决定超额限流还是计费。
const EGRESS_PRICING: Record<"free" | "pro" | "team", EgressPricing> = {
  free: { planLabel: "Free", includedGb: 5, pricePerGb: 0.09, hardCap: true },
  pro: { planLabel: "Pro", includedGb: 250, pricePerGb: 0.09, hardCap: false },
  team: { planLabel: "Team", includedGb: 250, pricePerGb: 0.09, hardCap: false },
};

const program = new Command();

program
  .name("backupdrill")
  .description(
    "Back up a Supabase project — Postgres database (and, soon, Storage files) — " +
      "to your own S3/R2/B2 bucket, with a checksummed manifest.\n\n" +
      "Want scheduling, restore drills, and alerts? → https://backupdrill.com"
  )
  .version(process.env.npm_package_version || "0.1.0");

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
