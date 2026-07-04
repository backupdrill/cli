import { readFile } from "node:fs/promises";

/**
 * 目标对象存储(S3 兼容:AWS S3 / Cloudflare R2 / Backblaze B2 / Supabase Storage 的 S3 端点均可)。
 * 凭据永远来自用户自己的环境 —— CLI 不托管任何密钥,这是"数据不落我们盘"叙事在开源侧的兑现。
 */
export interface StorageConfig {
  endpoint?: string; // R2/B2/自建需要;AWS S3 可省
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string; // 备份在桶内的前缀,如 "backupdrill"
  forcePathStyle: boolean; // R2/MinIO 通常需要 true
}

export interface BackupConfig {
  databaseUrl: string; // Supabase Session Pooler 连接串
  projectName: string; // 用于 manifest 与对象键的可读名
  // 默认只备 public(用户数据):平台托管 schema(auth/storage/realtime/vault)
  // 既超出最小权限 backup_reader 角色的读取范围,还原进新项目也会与平台冲突。
  schemas: string[];
  storage: StorageConfig;
}

interface RawConfig {
  databaseUrl?: string;
  projectName?: string;
  schemas?: string[];
  storage?: Partial<StorageConfig>;
}

function fromEnv(): RawConfig {
  const env = process.env;
  const storage: Partial<StorageConfig> = {};
  if (env.BACKUPDRILL_S3_ENDPOINT) storage.endpoint = env.BACKUPDRILL_S3_ENDPOINT;
  if (env.BACKUPDRILL_S3_REGION) storage.region = env.BACKUPDRILL_S3_REGION;
  if (env.BACKUPDRILL_S3_BUCKET) storage.bucket = env.BACKUPDRILL_S3_BUCKET;
  if (env.BACKUPDRILL_S3_ACCESS_KEY_ID)
    storage.accessKeyId = env.BACKUPDRILL_S3_ACCESS_KEY_ID;
  if (env.BACKUPDRILL_S3_SECRET_ACCESS_KEY)
    storage.secretAccessKey = env.BACKUPDRILL_S3_SECRET_ACCESS_KEY;
  if (env.BACKUPDRILL_S3_PREFIX) storage.prefix = env.BACKUPDRILL_S3_PREFIX;
  if (env.BACKUPDRILL_S3_FORCE_PATH_STYLE)
    storage.forcePathStyle = env.BACKUPDRILL_S3_FORCE_PATH_STYLE === "true";
  return {
    databaseUrl: env.BACKUPDRILL_DATABASE_URL || env.DATABASE_URL,
    projectName: env.BACKUPDRILL_PROJECT_NAME,
    schemas: env.BACKUPDRILL_SCHEMAS
      ? env.BACKUPDRILL_SCHEMAS.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    storage,
  };
}

async function fromFile(path: string): Promise<RawConfig> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RawConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read config file ${path}: ${(error as Error).message}`);
  }
}

/** 合并优先级:显式 flag > 环境变量 > 配置文件。 */
export async function loadConfig(opts: {
  configPath: string;
  overrides: RawConfig;
}): Promise<BackupConfig> {
  const file = await fromFile(opts.configPath);
  const env = fromEnv();
  const o = opts.overrides;

  const databaseUrl = o.databaseUrl ?? env.databaseUrl ?? file.databaseUrl;
  const projectName =
    o.projectName ?? env.projectName ?? file.projectName ?? "supabase";
  const schemas =
    o.schemas ?? env.schemas ?? file.schemas ?? ["public"];
  const storage: Partial<StorageConfig> = {
    ...file.storage,
    ...env.storage,
    ...o.storage,
  };

  const missing: string[] = [];
  if (!databaseUrl) missing.push("databaseUrl (BACKUPDRILL_DATABASE_URL)");
  if (!storage.bucket) missing.push("storage.bucket (BACKUPDRILL_S3_BUCKET)");
  if (!storage.accessKeyId)
    missing.push("storage.accessKeyId (BACKUPDRILL_S3_ACCESS_KEY_ID)");
  if (!storage.secretAccessKey)
    missing.push("storage.secretAccessKey (BACKUPDRILL_S3_SECRET_ACCESS_KEY)");
  if (missing.length) {
    throw new Error(
      `Missing required config:\n  - ${missing.join(
        "\n  - "
      )}\nSet them via env vars, a config file (--config), or flags. See README.`
    );
  }

  return {
    databaseUrl: databaseUrl!,
    projectName,
    schemas: schemas.length ? schemas : ["public"],
    storage: {
      endpoint: storage.endpoint,
      region: storage.region ?? "auto",
      bucket: storage.bucket!,
      accessKeyId: storage.accessKeyId!,
      secretAccessKey: storage.secretAccessKey!,
      prefix: storage.prefix ?? "backupdrill",
      // R2/自建默认 path-style 更省心;显式给了就尊重
      forcePathStyle: storage.forcePathStyle ?? Boolean(storage.endpoint),
    },
  };
}
