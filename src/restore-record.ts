/**
 * 带 Auth 的恢复的记录(PRD 增补 §5.2 第 2、3、4 步):事务号在写 COMMIT 之前存下来,连同目标是谁、哪份快照、
 * 做到了哪一步。协调程序崩溃、连接在提交时断掉,事后 `restore --status` 能拿它问出提交了没有;
 * 提交之后的步骤(补授权、补外键)没做完,`restore --finish` 照它接着做。
 *
 * CLI 存在本机文件里(fileRestoreRecords);托管恢复由 worker 提供自己的实现,存进恢复任务记录。
 * 记录里没有任何秘密:不存密码、不存连接串原文。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TargetIdentity } from "./auth-restore.js";
import { projectRefOf } from "./restore-engine.js";

export type RestorePhase =
  /** 事务开着,COMMIT 的结果还没确认 */
  | "transaction"
  /** 已提交,提交之后的步骤(补授权、补外键)还没做完 */
  | "committed"
  /** 授权已补,外键还没加完 */
  | "grants"
  /** 全部做完 */
  | "done"
  /** 事务回滚了,目标上什么都没留下 */
  | "rolled_back";

export interface RestoreRecord {
  version: 1;
  snapshot: string;
  projectName: string;
  /**
   * 那份快照的 dump 的 sha256:--finish 只接着做同一份快照。快照名只是时间戳,
   * 别的项目、别的桶里可能有同名的快照,拿它补授权会改错目标上的权限
   */
  dumpSha256: string;
  /**
   * 整份 manifest.json 的 sha256:--finish 补的授权、要的 schema 都来自 manifest,dump 没变而 manifest 被改过
   * 也不能接着做
   */
  manifestSha256: string;
  /** 给人看的目标说明(ref 或 主机/库名),不含密码 */
  target: string;
  identity: TargetIdentity;
  xid: string;
  phase: RestorePhase;
  startedAt: string;
  updatedAt: string;
}

export interface RestoreRecordStore {
  load(key: string): Promise<RestoreRecord | null>;
  save(key: string, record: RestoreRecord): Promise<void>;
}

/**
 * 一个目标对应一条记录。Supabase 项目按 ref 认(直连和连接池两种连接串是同一个目标),其余按主机、端口、库名、用户;
 * 只存哈希,文件名里不出现主机名
 */
export function restoreRecordKey(connString: string): string {
  const url = new URL(connString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
  const ref = projectRefOf(connString);
  const identity = ref
    ? `supabase:${ref}/${database}`
    : `${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}?user=${decodeURIComponent(url.username)}`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

/** 给人看的目标说明:ref 或 主机:端口/库名。不带用户名和密码 */
export function describeTarget(connString: string): string {
  const url = new URL(connString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
  const ref = projectRefOf(connString);
  return ref ? `Supabase project ${ref} (database ${database})` : `${url.hostname}:${url.port || "5432"}/${database}`;
}

/** 本机文件:<目录>/<key>.json,只有当前用户可读写。先写临时文件再改名,写到一半崩溃不会留下坏文件 */
export function fileRestoreRecords(dir = process.env.BACKUPDRILL_STATE_DIR || join(homedir(), ".backupdrill", "restores")): RestoreRecordStore {
  return {
    async load(key) {
      try {
        const parsed = JSON.parse(await readFile(join(dir, `${key}.json`), "utf8")) as RestoreRecord;
        return parsed?.version === 1 && typeof parsed.xid === "string" && typeof parsed.dumpSha256 === "string" && typeof parsed.manifestSha256 === "string"
          ? parsed
          : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error(`the restore record couldn't be read (${(error as Error).message})`);
      }
    },
    async save(key, record) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${key}.json`);
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, file);
    },
  };
}
