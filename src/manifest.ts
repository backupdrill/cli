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
  // ---- 以下为验证升级包预留字段(恢复闭环 PRD §5.1.2 / §0.1 D3):随 v2 一并定稿
  // 以免二次升版,但本期不生成。只存聚合结果,绝不落抽样行原始值或 PII。
  primaryKeyColumns?: string[];
  exactRows?: number;
  sampleHash?: string;
  sampleAlgorithm?: string;
  freshnessColumn?: string;
  freshnessValue?: string;
}

/**
 * 源 bucket 的可恢复属性(v2,读自源库 storage.buckets——S3 兼容端点拿不到这些)。
 * 值为 null = 源端就没设置;字段整体缺失 = 当次备份没捕获到(如 storage schema 无读权限),
 * 恢复端遇缺失须如实标 "not captured",不得猜测(PRD §5.1.3)。
 */
export interface BucketAttrs {
  name: string;
  public: boolean | null;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
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
 *
 * 版本史:
 *  - 1:初始格式。
 *  - 2(恢复闭环 PRD §5.1):storage 增加 buckets 属性清单(public/大小/MIME 限制),
 *    files 增加 contentType/cacheControl/metadata 等恢复所需元数据;tables 预留
 *    验证升级字段(本期不生成)。全部为**可加字段**——v2 读取端兼容 v1 快照。
 */
export const MANIFEST_SCHEMA_VERSION = 2;

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
    // v2:恢复端重建 bucket 用(含空 bucket)。v1 快照无此字段 → 恢复端标 not captured
    buckets?: BucketAttrs[];
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
  // ---- v2:恢复文件访问行为所需的非秘密元数据(读自源库 storage.objects,
  // 与文件拷贝分属两次读取,极端并发写下可能有漂移)。缺失 = 未捕获,恢复端不猜测。
  contentType?: string;
  cacheControl?: string;
  contentEncoding?: string;
  // 用户自定义 metadata(storage.objects.user_metadata)。恢复经 x-metadata 头回写
  // (spike 1 已验证可保真);只存原样 JSON,不解释内容。
  metadata?: Record<string, unknown>;
  lastModified?: string;
}


/** 结构断言失败时的统一出错口径:说清哪个字段坏了,让"桶里的 manifest 被篡改/截断"可定位。 */
function malformed(what: string): never {
  throw new Error(`manifest.json is malformed: ${what}`);
}

/**
 * 演练/恢复实际依赖的字段做结构校验(手写而非 JSON Schema 依赖:CLI 保持零校验库依赖,
 * 校验面 = 恢复代码真正会解引用的路径,新增可选字段不在此列——它们缺失是合法的 v1 形态)。
 * 半截上传、被篡改或非本工具写的 JSON 要在这里被拦下,而不是在 pg_restore 中途炸开。
 */
/** 可选字段:缺席合法(v1 形态),在场就必须是期望类型——错型值会驱动恢复端做错事。 */
function optionalString(value: unknown, what: string): void {
  if (value !== undefined && typeof value !== "string") malformed(what);
}

function assertManifestShape(m: Manifest): void {
  const d = m.dump as unknown;
  if (typeof d !== "object" || d === null) malformed("dump section missing");
  const dump = m.dump;
  if (typeof dump.key !== "string" || !dump.key) malformed("dump.key");
  if (typeof dump.sha256 !== "string" || !dump.sha256) malformed("dump.sha256");
  if (typeof dump.bytes !== "number") malformed("dump.bytes");
  if (typeof m.database !== "object" || m.database === null) malformed("database section missing");
  if (!Array.isArray(m.database.schemas)) malformed("database.schemas");
  if (typeof m.database.tableCount !== "number") malformed("database.tableCount");
  if (!Array.isArray(m.database.tables)) malformed("database.tables");
  for (const t of m.database.tables) {
    if (typeof t?.schema !== "string" || typeof t?.name !== "string") malformed("database.tables[]");
    // estimatedRows 缺失/错型会让演练的"备份时非空的表恢复后不为空"检查静默失效
    // (undefined > 0 恒 false)——空表假 PASS 是最不能接受的失败方式
    if (typeof t.estimatedRows !== "number" || !Number.isFinite(t.estimatedRows) || t.estimatedRows < 0) {
      malformed("database.tables[].estimatedRows");
    }
  }
  // 写入端恒写 storage: null(DB-only)或对象——字段整体缺失只可能是截断/损坏,
  // 静默当成 DB-only 会跳过全部 Storage 验证与恢复
  if (m.storage === undefined) malformed("storage section missing (null means DB-only)");
  if (m.storage !== null) {
    if (typeof m.storage !== "object") malformed("storage section");
    if (typeof m.storage.fileCount !== "number" || typeof m.storage.totalBytes !== "number") {
      malformed("storage.fileCount/totalBytes");
    }
    if (!Array.isArray(m.storage.files)) malformed("storage.files");
    for (const f of m.storage.files) {
      if (typeof f?.bucket !== "string" || typeof f?.key !== "string") malformed("storage.files[]");
      if (typeof f.bytes !== "number" || typeof f.sha256 !== "string") malformed("storage.files[]");
      optionalString(f.contentType, "storage.files[].contentType");
      optionalString(f.cacheControl, "storage.files[].cacheControl");
      optionalString(f.contentEncoding, "storage.files[].contentEncoding");
      optionalString(f.lastModified, "storage.files[].lastModified");
      if (f.metadata !== undefined && (typeof f.metadata !== "object" || f.metadata === null || Array.isArray(f.metadata))) {
        malformed("storage.files[].metadata");
      }
    }
    if (m.storage.buckets !== undefined) {
      if (!Array.isArray(m.storage.buckets)) malformed("storage.buckets");
      for (const b of m.storage.buckets) {
        if (typeof b?.name !== "string" || !b.name) malformed("storage.buckets[]");
        if (b.public !== null && b.public !== undefined && typeof b.public !== "boolean") {
          malformed("storage.buckets[].public");
        }
        if (b.fileSizeLimit !== null && b.fileSizeLimit !== undefined && typeof b.fileSizeLimit !== "number") {
          malformed("storage.buckets[].fileSizeLimit");
        }
        if (
          b.allowedMimeTypes !== null &&
          b.allowedMimeTypes !== undefined &&
          !(Array.isArray(b.allowedMimeTypes) && b.allowedMimeTypes.every((v) => typeof v === "string"))
        ) {
          malformed("storage.buckets[].allowedMimeTypes");
        }
      }
    }
  }
}

/**
 * 解析桶里的 manifest.json,并做**向前兼容**校验:比本程序更新的格式一律拒绝,
 * 明确告诉用户升级,绝不按旧结构硬解析(那会静默产出错误的演练/恢复结果)。
 * 版本关之后再做结构校验(assertManifestShape)——两类失败要给出不同的处置指引。
 */
export function parseManifest(json: string): Manifest {
  let parsed: Manifest;
  try {
    parsed = JSON.parse(json) as Manifest;
  } catch (error) {
    throw new Error(`manifest.json is not valid JSON: ${(error as Error).message}`);
  }
  // 根检查必须先于一切属性访问:JSON 里合法的 null/数字/字符串会把裸 TypeError 抛给用户
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    malformed("root is not an object");
  }
  // 版本字段:缺失 = 1.0 之前的旧快照;在场必须是 ≥1 的整数——0/负数/小数/字符串
  // 都不是本工具写过的值,按坏 manifest 拒绝,不得混过前向兼容闸门
  const version = parsed.schemaVersion ?? 1;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    malformed(`schemaVersion ${JSON.stringify(parsed.schemaVersion)}`);
  }
  if (version > MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `This snapshot's manifest uses schema version ${String(parsed.schemaVersion)}, but this ` +
        `BackupDrill understands up to ${MANIFEST_SCHEMA_VERSION}. Upgrade the CLI ` +
        `(npm i -g backupdrill@latest) to read it.`
    );
  }
  assertManifestShape(parsed);
  return parsed;
}
