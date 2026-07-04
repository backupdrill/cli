/**
 * manifest.json —— 每次快照的自描述清单。
 * 云版演练靠它做校验(表数量、行数对比、体积异常告警);开源侧至少让用户能核对
 * "这次到底备了什么、有多大、校验和是多少"。
 */
export interface TableStat {
  schema: string;
  name: string;
  // 来自 pg_stat_user_tables.n_live_tup:是估算值(planner 统计),不是精确 count(*)。
  // 对"体积/行数骤降"这类异常检测足够;需要精确值时云版会在演练里重新计数。
  estimatedRows: number;
}

export interface Manifest {
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
  };
  dump: {
    key: string; // 桶内对象键
    format: "custom"; // pg_dump -Fc
    bytes: number;
    sha256: string;
  };
  // 下一里程碑:Storage 文件同步后在此登记文件清单与校验和
  storage: null | {
    fileCount: number;
    totalBytes: number;
  };
}
