#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { runBackup } from "./backup.js";
import { log } from "./log.js";

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
      log.ok(
        `Backup complete — ${manifest.database.tableCount} tables, ` +
          `${(manifest.dump.bytes / 1024 / 1024).toFixed(1)} MB.`
      );
      // stdout 输出机器可读结果,便于在 CI / GitHub Action 里消费
      process.stdout.write(JSON.stringify({ ok: true, manifest }) + "\n");
    } catch (error) {
      log.error((error as Error).message);
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((error) => {
  log.error((error as Error).message);
  process.exitCode = 1;
});
