import { Client } from "pg";
import type { BackupConfig } from "./config.js";
import { measureStorage } from "./storage.js";
import { log } from "./log.js";

/**
 * Supabase egress 定价(2026-07-10 经核实,来源见 README「Egress & cost」)。
 * 单价 = 超出计划包含额度后的每 GB 价;included = 各计划每月包含的 egress。
 * 备份 = 把数据拉出 Supabase = egress,计入用户账单。这是 PRD §4.3 的上线否决项:
 * 让用户"我们帮你算过账"而不是收到意外账单。
 */
export interface EgressPricing {
  pricePerGb: number; // 超额单价 $/GB(uncached)
  includedGb: number; // 该计划每月包含的 uncached egress 额度 GB
  planLabel: string;
  // Free = 永不计费:超额走 Fair Use 流程(通知 → 宽限期 → 限制),持续超额跑不通;
  // Pro/Team 视 Spend Cap 而定。字段名沿用 hardCap,语义是"超额不可计费、只会被限"
  hardCap: boolean;
}

// 超出这个月度成本就该提醒用户"备份的 egress 账单快赶上订阅费了"
const SUBSCRIPTION_FLOOR_USD = 19;

const GB = 1024 * 1024 * 1024;

async function measureDbBytes(
  databaseUrl: string,
  schemas: string[]
): Promise<number> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // pg_total_relation_size 含索引+TOAST,是 egress 上界(真实转储经压缩、不含索引,更小)
    const res = await client.query<{ bytes: string }>(
      `select coalesce(
                sum(pg_total_relation_size(format('%I.%I', schemaname, relname)::regclass)),
                0
              )::bigint as bytes
         from pg_stat_user_tables
        where schemaname = any($1::text[])`,
      [schemas]
    );
    return Number(res.rows[0].bytes);
  } finally {
    await client.end();
  }
}

export interface EgressProjection {
  dbBytes: number;
  storageBytes: number;
  perRunGb: number;
  rows: Array<{
    frequency: string;
    runsPerMonth: number;
    monthlyEgressGb: number;
    overageGb: number;
    monthlyCost: number;
  }>;
}

export function project(
  dbBytes: number,
  storageBytes: number,
  pricing: EgressPricing
): EgressProjection {
  const perRunGb = (dbBytes + storageBytes) / GB;
  const frequencies: Array<[string, number]> = [
    ["weekly", 52 / 12], // ≈4.33 次/月
    ["daily", 30],
  ];
  const rows = frequencies.map(([frequency, runsPerMonth]) => {
    const monthlyEgressGb = perRunGb * runsPerMonth;
    // 保守:假设备份是该项目唯一 egress 来源;真实还要叠加应用自身流量
    const overageGb = Math.max(0, monthlyEgressGb - pricing.includedGb);
    return {
      frequency,
      runsPerMonth: Math.round(runsPerMonth * 10) / 10,
      monthlyEgressGb: Math.round(monthlyEgressGb * 10) / 10,
      overageGb: Math.round(overageGb * 10) / 10,
      monthlyCost: Math.round(overageGb * pricing.pricePerGb * 100) / 100,
    };
  });
  return { dbBytes, storageBytes, perRunGb, rows };
}

export async function runEstimate(
  config: BackupConfig,
  pricing: EgressPricing
): Promise<EgressProjection> {
  log.step("Measuring database size…");
  const dbBytes = await measureDbBytes(config.databaseUrl, config.schemas);
  log.ok(`Database (schema ${config.schemas.join(", ")}): ${(dbBytes / GB).toFixed(2)} GB (upper bound)`);

  let storageBytes = 0;
  if (config.supabaseStorage) {
    log.step("Measuring Storage size (listing only, no download)…");
    const m = await measureStorage(config.supabaseStorage);
    storageBytes = m.totalBytes;
    log.ok(`Storage: ${m.fileCount} files, ${(storageBytes / GB).toFixed(2)} GB`);
  }

  const projection = project(dbBytes, storageBytes, pricing);

  console.error("");
  console.error(
    `  Egress per backup:  ~${projection.perRunGb.toFixed(2)} GB ` +
      `(DB dump is smaller after compression; Storage is exact)`
  );
  console.error(
    `  Plan: ${pricing.planLabel} — ${pricing.includedGb} GB egress included, ` +
      `then $${pricing.pricePerGb}/GB`
  );
  console.error("");
  console.error("  Frequency   Runs/month   Monthly egress   Overage   Est. cost/month");
  console.error("  ─────────   ──────────   ──────────────   ───────   ───────────────");
  for (const r of projection.rows) {
    console.error(
      `  ${r.frequency.padEnd(9)}   ${String(r.runsPerMonth).padStart(10)}   ` +
        `${(r.monthlyEgressGb + " GB").padStart(14)}   ` +
        `${(r.overageGb + " GB").padStart(7)}   ` +
        `$${r.monthlyCost.toFixed(2)}`
    );
  }
  console.error("");
  console.error(
    "  Note: assumes backups are this project's only egress. Your app's own " +
      "traffic\n  adds to the total. This is an upper bound — check manifest.json " +
      "after a\n  real run for the actual bytes transferred."
  );

  // 守护提示:egress 是把双刃剑,两种失败模式都要点破
  const daily = projection.rows.find((r) => r.frequency === "daily");
  const weekly = projection.rows.find((r) => r.frequency === "weekly");
  console.error("");
  if (pricing.hardCap) {
    // Free:超额不计费,走 Fair Use 通知 → 宽限期 → 限制;持续超额的大备份在 Free 跑不通
    if (daily && daily.overageGb > 0) {
      log.warn(
        `${pricing.planLabel} plan egress is never billed, but exceeding the included ` +
          `${pricing.includedGb} GB/month starts Supabase's Fair Use process: a ` +
          `notification, then a grace period, then egress restrictions. Daily backups ` +
          `(~${daily.monthlyEgressGb} GB/month) would keep you permanently over the ` +
          `line — sustained large backups are not viable on Free. ` +
          `Use weekly at most, or upgrade to Pro.`
      );
    }
  } else {
    // Pro/Team:Spend Cap 决定是"限流"还是"账单"
    log.warn(
      "Spend Cap is ON by default on Pro/Team. If a backup pushes you past the " +
        `${pricing.includedGb} GB egress quota, Supabase throttles your project's ` +
        "egress for the rest of the month (your app's traffic too), and the backup " +
        "fails. Turn Spend Cap OFF to allow billed overage instead — then the " +
        "numbers above are what you'd pay."
    );
    const worst = daily?.monthlyCost ?? 0;
    if (worst >= SUBSCRIPTION_FLOOR_USD) {
      log.warn(
        `At daily frequency the egress overage alone (~$${worst.toFixed(0)}/month) is ` +
          `in the range of a paid backup subscription. Consider weekly ` +
          `(~$${(weekly?.monthlyCost ?? 0).toFixed(0)}/month overage) or a smaller scope.`
      );
    }
  }

  return projection;
}
