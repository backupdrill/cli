// 库入口:把引擎函数暴露给下游复用(产品 worker 直接 import 这些,而不是重写)。
// CLI(bin)是这套引擎的薄封装;worker 在其外加调度、凭据托管、告警、报告。
export { runBackup } from "./backup.js";
// verify-full:只导出**原子** API。刻意不导出裸 SUPABASE_SSL —— 它一旦和 connectionString
// 搭配使用,URL 里的 sslmode=disable 又会把它覆盖掉,等于把这次修掉的绕过再放回去。
export { SUPABASE_ROOT_CA, pgConnectOptions, PG_CLIENT_OPTIONS, normalizeConnectionTarget } from "./supabase-ca.js";
export { runDrill, drillDump } from "./drill.js";
export { runRestore, restoreStatus, finishRestore } from "./restore.js";
export { fileRestoreRecords, restoreRecordKey } from "./restore-record.js";
export type { RestoreRecord, RestoreRecordStore, RestorePhase } from "./restore-record.js";
// RECOVERY.md 的授权那一步和 Auth 用户那几段:worker 的 Drive 版手册和这里的 S3 版用同一份
export { recoveryGrantsSql } from "./grants.js";
export { authRecoveryText } from "./recovery-doc.js";
export type { AuthRecoveryText, RecoveryDocPlace } from "./recovery-doc.js";
// 身份判定三件套对外导出:托管 worker 用它们与 app 侧 shared 的副本做同规则回归(交叉审查)
export { projectRefOf, assertNoHostOverride, libpqChildEnv } from "./restore-engine.js";
export { sameDatabaseTarget } from "./restore.js";
export { runEstimate, project } from "./estimate.js";
export { loadConfig, requireBucket } from "./config.js";
export {
  targetClient,
  resolveSnapshot,
  getObjectText,
  downloadToFile,
  hashObject,
} from "./snapshots.js";
// 快照位置接口:备份、演练、恢复都可以传入自己的实现(托管 worker 的 Google Drive 目标)
export { s3SnapshotStore } from "./snapshot-store.js";
export type {
  SnapshotStore,
  SnapshotWriter,
  SnapshotReader,
  DumpUpload,
  StorageFilesLocation,
} from "./snapshot-store.js";

export type {
  BackupConfig,
  LoadedBackupConfig,
  StorageConfig,
  SupabaseStorageConfig,
} from "./config.js";
export type {
  AuthPolicyInfo,
  AuthSection,
  AuthTriggerInfo,
  BucketAttrs,
  ExtensionInfo,
  Manifest,
  StorageFile,
  TableStat,
} from "./manifest.js";
// 2.10.0:Auth 用户备份。库调用方在 BackupConfig.auth 里显式传值才打开(不传 = 关闭,备份与之前一致)
export type { AuthMode } from "./auth-backup.js";
export type { GrantedObject, GrantRestore } from "./grants.js";
export type { DrillReport, DrillCheck, DrillSupervision, DrillPhase } from "./drill.js";
export type { AuthDrillReport } from "./auth-drill.js";
export type { OrphanedForeignKey } from "./orphaned-foreign-keys.js";
export type { RestoreResult, RestoreAuthResult, RestoreStatus } from "./restore.js";
export type { EgressPricing, EgressProjection } from "./estimate.js";
