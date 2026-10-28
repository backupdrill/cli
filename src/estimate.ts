import type { Client } from "pg";
import type { BackupConfig } from "./config.js";
import { measureStorage } from "./storage.js";
import { log } from "./log.js";
import { connectPg } from "./supabase-ca.js";

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
  // 付费计划看 spendCap。字段名沿用 hardCap,语义是"超额不可计费、只会被限"
  hardCap: boolean;
  // Supabase 只有 Pro 有 Spend Cap(默认开,开着时超额不计费、持续超额会被限);Team 没有,超额直接计费
  // (2026-10-29 核 Supabase 文档 Control your costs)。不填按有 Spend Cap 处理,与 2.7.1 及以前一致
  spendCap?: boolean;
}

// 超出这个月度成本就该提醒用户"备份的 egress 账单快赶上订阅费了"
const SUBSCRIPTION_FLOOR_USD = 19;

const GB = 1024 * 1024 * 1024;

/**
 * 要转储的 schema 里所有表的磁盘占用。pg_total_relation_size 含索引+TOAST,是 egress
 * 上界(真实转储经压缩、不含索引,更小)。备份也拿它估转储体积来定分片大小。
 * 直接传 relid 而不是按名字转 regclass:统计视图读出来之后表被并发删掉,
 * 按名字转会报错,按 oid 查只会得到 NULL。
 */
export async function relationBytes(client: Client, schemas: string[]): Promise<number> {
  const res = await client.query<{ bytes: string }>(
    `select coalesce(sum(pg_total_relation_size(relid)), 0)::bigint as bytes
       from pg_stat_user_tables
      where schemaname = any($1::text[])`,
    [schemas]
  );
  return Number(res.rows[0].bytes);
}

async function measureDbBytes(
  databaseUrl: string,
  schemas: string[]
): Promise<number> {
  const client = await connectPg(databaseUrl);
  try {
    return await relationBytes(client, schemas);
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

/** 付费计划超出 egress 额度时会怎样:Pro 看 Spend Cap(默认开,不计费但可能被限),Team 没有 Spend Cap、直接计费 */
export function overageNote(pricing: EgressPricing): string {
  if (pricing.spendCap === false) {
    return (
      `${pricing.planLabel} has no Spend Cap: egress past the ${pricing.includedGb} GB ` +
      `quota is billed at $${pricing.pricePerGb}/GB, so the numbers above are what you'd pay.`
    );
  }
  // 开着 Spend Cap 超额不是立刻断:Supabase 先发邮件、给宽限期,持续超额才限制整个组织的项目;
  // 宽限期用过一次后,几个账期内再超就没有新的宽限期(文档 Exceeding Quotas + Fair Use Policy,2026-10-29 核)
  return (
    "Spend Cap is ON by default on Pro. Going past the " +
    `${pricing.includedGb} GB egress quota with it on isn't billed: Supabase emails ` +
    "your billing address, starts a grace period (none if you went over recently), " +
    "then restricts your organization's " +
    "projects if usage stays over (your app, not just the backup). Turn Spend Cap OFF " +
    "to be billed for the overage instead, and the numbers above are what you'd pay."
  );
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
    log.warn(overageNote(pricing));
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
