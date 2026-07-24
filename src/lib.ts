// 库入口:把引擎函数暴露给下游复用(产品 worker 直接 import 这些,而不是重写)。
// CLI(bin)是这套引擎的薄封装;worker 在其外加调度、凭据托管、告警、报告。
export { runBackup } from "./backup.js";
// verify-full:只导出**原子** API。刻意不导出裸 SUPABASE_SSL —— 它一旦和 connectionString
// 搭配使用,URL 里的 sslmode=disable 又会把它覆盖掉,等于把这次修掉的绕过再放回去。
export { SUPABASE_ROOT_CA, pgConnectOptions } from "./supabase-ca.js";
export { runDrill, drillDump } from "./drill.js";
export { runRestore } from "./restore.js";
export { runEstimate, project } from "./estimate.js";
export { loadConfig } from "./config.js";
export {
  targetClient,
  resolveSnapshot,
  getObjectText,
  downloadToFile,
  hashObject,
} from "./snapshots.js";

export type {
  BackupConfig,
  StorageConfig,
  SupabaseStorageConfig,
} from "./config.js";
export type { BucketAttrs, ExtensionInfo, Manifest, StorageFile, TableStat } from "./manifest.js";
export type { DrillReport, DrillCheck } from "./drill.js";
export type { RestoreResult } from "./restore.js";
export type { EgressPricing, EgressProjection } from "./estimate.js";
