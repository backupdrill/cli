/**
 * manifest.json —— 每次快照的自描述清单。
 * 云版演练靠它做校验(表数量、行数对比、体积异常告警);开源侧至少让用户能核对
 * "这次到底备了什么、有多大、校验和是多少"。
 */
// "表"的口径 = pg_class relkind in ('r','p','m'):普通表 + 分区父表 + 物化视图。
// 备份统计端与演练校验端必须共用这一口径,否则含 matview/分区的库会误报。
export interface TableStat {
  schema: string;
  name: string;
  // 来自 n_live_tup:是估算值(planner 统计),不是精确 count(*);分区父表恒为 0。
  // 对"体积/行数骤降"这类异常检测足够;需要精确值时云版会在演练里重新计数。
  estimatedRows: number;
}

/**
 * 源库安装的非内置扩展(pg_extension,排除必装的 plpgsql)。
 * --schema=public 的转储不含 CREATE EXTENSION,但表定义会引用扩展类型
 * (如 extensions.vector)——沙箱恢复前必须按这份清单把扩展装进**同名 schema**,
 * dump 里的限定名才解析得到(Supabase 惯例装在 "extensions" schema)。
 */
export interface ExtensionInfo {
  name: string;
  version: string;
  schema: string;
}

/**
 * manifest.json 的格式版本。**这是留在客户桶里、可能躺很多年的持久产物**——将来改结构时,
 * 读取端要靠它分支判断,而不是去猜 toolVersion。
 *
 * 约定:
 *  - 缺失该字段的 manifest = 版本 1(1.0 之前写出的旧快照)
 *  - 读取端遇到**更高**的版本必须明确报错,而不是按旧结构硬解析出错误结果
 *    ——对备份工具来说,"旧程序静默误读新归档"是最不能接受的失败方式。
 */
export const MANIFEST_SCHEMA_VERSION = 1;

export interface Manifest {
  // 旧快照(1.0 之前)没有此字段 → 语义上等同 1
  schemaVersion?: number;
  tool: "backupdrill-cli";
  toolVersion: string;
  createdAt: string; // ISO8601
  projectName: string;
  database: {
    serverVersion: string;
    pgDumpVersion: string;
    schemas: string[]; // 实际被 dump 的 schema(默认仅 public)
    tableCount: number;
    estimatedRowTotal: number;
    tables: TableStat[];
    // 可选 = 向后兼容:0.1.1 及更早的 manifest 没有这个字段,演练行为保持原样
    extensions?: ExtensionInfo[];
  };
  dump: {
    key: string; // 桶内对象键
    format: "custom"; // pg_dump -Fc
    bytes: number;
    sha256: string;
  };
  // Storage 文件清单:每个文件的桶/键/大小/校验和(PRD US-2 要求"文件清单+校验和")
  storage: null | {
    fileCount: number;
    totalBytes: number;
    files: StorageFile[];
  };
}

export interface StorageFile {
  bucket: string;
  key: string;
  bytes: number;
  sha256: string;
}


/**
 * 解析桶里的 manifest.json,并做**向前兼容**校验:比本程序更新的格式一律拒绝,
 * 明确告诉用户升级,绝不按旧结构硬解析(那会静默产出错误的演练/恢复结果)。
 */
export function parseManifest(json: string): Manifest {
  let parsed: Manifest;
  try {
    parsed = JSON.parse(json) as Manifest;
  } catch (error) {
    throw new Error(`manifest.json is not valid JSON: ${(error as Error).message}`);
  }
  const version = parsed.schemaVersion ?? 1; // 缺失 = 1.0 之前的旧快照
  if (!Number.isFinite(version) || version > MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `This snapshot's manifest uses schema version ${String(parsed.schemaVersion)}, but this ` +
        `BackupDrill understands up to ${MANIFEST_SCHEMA_VERSION}. Upgrade the CLI ` +
        `(npm i -g backupdrill@latest) to read it.`
    );
  }
  return parsed;
}
