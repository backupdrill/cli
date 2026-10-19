import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { requireBucket, type BackupConfig } from "./config.js";
import { isTimeout, withDeadline } from "./deadline.js";
import type { DrillReport } from "./drill.js";
import { log } from "./log.js";
import { targetClient } from "./snapshots.js";
import { TOOL_VERSION } from "./version.js";

/**
 * `drill --record` 写进桶里的演练结论。`exporter` 只读桶,演练结果不落桶它就无从得知。
 *
 * 每次演练写一个新对象,从不覆盖:
 *   <prefix>/<project>.drills/<结束时间>-<passed|failed>.json
 * 为什么不是一份可覆盖的"最近一次":两次演练重叠时,先结束的那次可能后写进桶,把更新的
 * "没通过"盖成更早的"通过",失败告警就没了;先读后写也挡不住(不是原子的),而各家
 * S3 兼容存储对条件写入的支持参差不齐。每次一个对象,"哪次最新"留给读的一方按名字判断,
 * 写入顺序就无所谓了。
 *
 * 为什么放在 <project>.drills/,和快照目录并排而不是在它里面:resolveSnapshot(包括已经发出去的
 * 旧版本)按字典序取 <project>/ 下最大的目录当最新快照,里面多一个 drills/ 会被当成快照。
 *
 * 文件名本身带着结束时间和结论,exporter 列一下目录就知道最近一次和最近一次通过是哪个;
 * 只为了恢复用时才读一次通过的那份。只记结论,不记检查明细:失败明细里可能有 pg_restore
 * 回显的表数据,而桶的读权限可能比演练日志给得更宽(exporter 只要只读 key)。
 */

/** 版本规则同 manifest:缺省不接受,更高的版本明确报错让用户升级,不按旧结构硬读。 */
export const DRILL_RECORD_SCHEMA_VERSION = 1;

export interface DrillRecord {
  schemaVersion: number;
  tool: "backupdrill-cli";
  toolVersion: string;
  /** 演练结束的时间(ISO8601),与文件名里的时间相同 */
  finishedAt: string;
  pass: boolean;
  /** 演练的快照名;演练在选定快照之前就失败了(没装 Docker、桶里没有快照)时没有 */
  snapshot?: string;
  /** 恢复用时,只有通过的演练才记:没通过时这个数可能只是半程,拿来估恢复时间会误导 */
  restoreSeconds?: number;
}

/** 演练记录所在的"目录",带尾斜杠 */
export function drillRecordsPrefix(config: BackupConfig): string {
  const storage = requireBucket(config);
  return `${storage.prefix}/${config.projectName}.drills/`;
}

/** 时间戳写法同快照目录名(把 ISO 里的 : 和 . 换成 -),定长,按名字排序就是按时间排序 */
const RECORD_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(passed|failed)\.json$/;

export function drillRecordName(record: Pick<DrillRecord, "finishedAt" | "pass">): string {
  return `${record.finishedAt.replace(/[:.]/g, "-")}-${record.pass ? "passed" : "failed"}.json`;
}

/** 从文件名读出结束时间(毫秒)和结论;不是记录文件的名字返回 null */
export function parseDrillRecordName(name: string): { finishedAt: number; pass: boolean } | null {
  const m = RECORD_NAME.exec(name);
  if (!m) return null;
  const finishedAt = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(finishedAt) ? { finishedAt, pass: m[6] === "passed" } : null;
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

/** 写一个新对象,返回它的 key。不读桶:只需要写权限 */
export async function writeDrillRecord(
  s3: S3Client,
  config: BackupConfig,
  record: DrillRecord,
  abortSignal?: AbortSignal
): Promise<string> {
  const key = drillRecordsPrefix(config) + drillRecordName(record);
  await s3.send(
    new PutObjectCommand({
      Bucket: requireBucket(config).bucket,
      Key: key,
      Body: JSON.stringify(record, null, 2),
      ContentType: "application/json",
    }),
    { abortSignal }
  );
  return key;
}

/** 记一笔最多等这么久:桶接了请求却不回应时,演练不能卡在这里,后面还要退出、发监控 ping */
const RECORD_TIMEOUT_MS = 30_000;

/**
 * CLI 的 `drill --record`:写不进去只警告,演练本身的结论和退出码不变。
 * 常见原因是给演练配的是只读 key;这种情况下 exporter 的演练时间会一直不动,告警规则会发现。
 */
export async function recordDrillOutcome(
  config: BackupConfig,
  report: DrillReport | null,
  s3: S3Client = targetClient(config),
  timeoutMs: number = RECORD_TIMEOUT_MS
): Promise<void> {
  const record = buildDrillRecord(report, new Date());
  try {
    const key = await withDeadline((signal) => writeDrillRecord(s3, config, record, signal), timeoutMs);
    log.ok(`Drill result recorded → s3://${requireBucket(config).bucket}/${key}`);
  } catch (error) {
    const reason = isTimeout(error)
      ? `no answer from the bucket within ${timeoutMs / 1000}s`
      : (error as Error).message;
    log.warn(
      `Could not record the drill result (${reason}). ` +
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
