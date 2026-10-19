import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { requireBucket, type BackupConfig } from "./config.js";
import type { DrillReport } from "./drill.js";
import { log } from "./log.js";
import { targetClient } from "./snapshots.js";
import { TOOL_VERSION } from "./version.js";

/**
 * `drill --record` 写进桶里的演练结论。`exporter` 只读桶,演练结果不落桶它就无从得知。
 *
 * 放在 <prefix>/<project>/ 下的两个对象(不是目录):resolveSnapshot 只看 CommonPrefixes,
 * 这一层的对象不会被当成快照。
 *  - last-drill.json:最近一次演练,不论成败
 *  - last-passed-drill.json:最近一次通过的演练。分开存,最近一次失败时上一次通过的时间还在,
 *    而且两份都是整份覆盖,不用先读后改
 *
 * 只记结论,不记检查明细:失败明细里可能有 pg_restore 回显的表数据,而桶的读权限可能比
 * 演练日志给得更宽(exporter 只要只读 key)。
 */
export const LAST_DRILL_FILE = "last-drill.json";
export const LAST_PASSED_DRILL_FILE = "last-passed-drill.json";

/** 版本规则同 manifest:缺省不接受,更高的版本明确报错让用户升级,不按旧结构硬读。 */
export const DRILL_RECORD_SCHEMA_VERSION = 1;

export interface DrillRecord {
  schemaVersion: number;
  tool: "backupdrill-cli";
  toolVersion: string;
  /** 演练结束的时间(ISO8601) */
  finishedAt: string;
  pass: boolean;
  /** 演练的快照名;演练在选定快照之前就失败了(没装 Docker、桶里没有快照)时没有 */
  snapshot?: string;
  /** 恢复用时,只有通过的演练才记:没通过时这个数可能只是半程,拿来估恢复时间会误导 */
  restoreSeconds?: number;
}

export function drillRecordKey(config: BackupConfig, file: string): string {
  const storage = requireBucket(config);
  return `${storage.prefix}/${config.projectName}/${file}`;
}

/** report 为 null = 演练中途抛错、没有报告;这也算一次没通过的演练。 */
export function buildDrillRecord(report: DrillReport | null, finishedAt: Date): DrillRecord {
  return {
    schemaVersion: DRILL_RECORD_SCHEMA_VERSION,
    tool: "backupdrill-cli",
    toolVersion: TOOL_VERSION,
    finishedAt: finishedAt.toISOString(),
    pass: report?.pass === true,
    ...(report ? { snapshot: report.snapshot } : {}),
    ...(report?.pass ? { restoreSeconds: report.restoreSeconds } : {}),
  };
}

export async function writeDrillRecord(
  s3: S3Client,
  config: BackupConfig,
  record: DrillRecord
): Promise<void> {
  const bucket = requireBucket(config).bucket;
  const files = record.pass ? [LAST_DRILL_FILE, LAST_PASSED_DRILL_FILE] : [LAST_DRILL_FILE];
  for (const file of files) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: drillRecordKey(config, file),
        Body: JSON.stringify(record, null, 2),
        ContentType: "application/json",
      })
    );
  }
}

/**
 * CLI 的 `drill --record`:写不进去只警告,演练本身的结论和退出码不变。
 * 常见原因是给演练配的是只读 key;这种情况下 exporter 的演练时间会一直不动,告警规则会发现。
 */
export async function recordDrillOutcome(
  config: BackupConfig,
  report: DrillReport | null,
  s3: S3Client = targetClient(config)
): Promise<void> {
  const record = buildDrillRecord(report, new Date());
  try {
    await writeDrillRecord(s3, config, record);
    log.ok(`Drill result recorded → s3://${requireBucket(config).bucket}/${drillRecordKey(config, LAST_DRILL_FILE)}`);
  } catch (error) {
    log.warn(
      `Could not record the drill result (${(error as Error).message}). ` +
        `--record needs write access to the bucket. The drill's own result is unchanged.`
    );
  }
}

function malformed(file: string, what: string): never {
  throw new Error(`${file} is malformed: ${what}`);
}

/** 读桶里的演练记录。结构不对就报错:exporter 宁可报 up=0,也不报一个读错的结论。 */
export function parseDrillRecord(json: string, file: string): DrillRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    malformed(file, "root is not an object");
  }
  const r = parsed as Partial<DrillRecord>;
  if (typeof r.schemaVersion !== "number" || !Number.isInteger(r.schemaVersion) || r.schemaVersion < 1) {
    malformed(file, `schemaVersion ${JSON.stringify(r.schemaVersion)}`);
  }
  if (r.schemaVersion > DRILL_RECORD_SCHEMA_VERSION) {
    throw new Error(
      `${file} uses schema version ${r.schemaVersion}, but this BackupDrill understands up to ` +
        `${DRILL_RECORD_SCHEMA_VERSION}. Upgrade the CLI (npm i -g backupdrill@latest) to read it.`
    );
  }
  if (typeof r.finishedAt !== "string" || !Number.isFinite(Date.parse(r.finishedAt))) {
    malformed(file, "finishedAt");
  }
  if (typeof r.pass !== "boolean") malformed(file, "pass");
  if (r.snapshot !== undefined && typeof r.snapshot !== "string") malformed(file, "snapshot");
  if (
    r.restoreSeconds !== undefined &&
    (typeof r.restoreSeconds !== "number" || !Number.isFinite(r.restoreSeconds) || r.restoreSeconds < 0)
  ) {
    malformed(file, "restoreSeconds");
  }
  return r as DrillRecord;
}
