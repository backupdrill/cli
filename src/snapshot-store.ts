import type { Readable } from "node:stream";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { requireBucket, type BackupConfig } from "./config.js";
import type { Manifest } from "./manifest.js";
import { targetClient, resolveSnapshot, getObjectText, downloadToFile } from "./snapshots.js";
import { renderRecoveryDoc } from "./recovery-doc.js";
import { dumpPartSizeFor } from "./part-size.js";

/**
 * 快照放在哪里,对引擎来说只是这几个动作:建一份新快照往里写、打开一份已有快照往外读。
 * 备份、演练、恢复都只经这层读写快照。CLI 只用 S3 兼容桶(s3SnapshotStore);托管服务
 * 的 worker 可以传入自己的实现(Google Drive 目标,实现不进公开包)。
 */
export interface SnapshotStore {
  /** name = 快照名(备份开始时的 UTC 时间戳) */
  createSnapshot(name: string): Promise<SnapshotWriter>;
  /** name 省略 = 最新一份 */
  openSnapshot(name?: string): Promise<SnapshotReader>;
}

/** 快照里 Storage 文件的位置(<base>/storage/<bucket>/<key>)。只有 S3 兼容目标能放 Storage 文件。 */
export interface StorageFilesLocation {
  s3: S3Client;
  bucket: string;
  base: string;
}

export interface DumpUpload {
  /** 转储全部写完才 resolve;任何失败都 reject */
  done: Promise<void>;
  /** 中止写入,尽量不留下半截文件 */
  abort(): Promise<void>;
}

export interface SnapshotWriter {
  /** 记进 manifest.dump.key 的值 */
  readonly dumpKey: string;
  /** 这份快照能不能放 Storage 文件;不能时为 null */
  readonly storageFiles: StorageFilesLocation | null;
  /** 日志里显示的位置 */
  describe(file: string): string;
  /** relationBytes = 要转储的表的磁盘占用(量不出为 null),实现可据此决定分块 */
  uploadDump(body: Readable, relationBytes: number | null): DumpUpload;
  /** RECOVERY.md 写的是"从这个位置怎么恢复",所以由各实现自己渲染 */
  writeRecoveryDoc(manifest: Manifest): Promise<void>;
  /** manifest 是快照的"完成标记",调用方保证最后写 */
  writeManifest(manifest: Manifest): Promise<void>;
}

export interface SnapshotReader {
  readonly name: string;
  readManifest(): Promise<string>;
  /** 断点续传下载转储到本地文件,返回实际落盘的字节数与 sha256 */
  downloadDump(manifest: Manifest, dest: string): Promise<{ bytes: number; sha256: string }>;
  /** 这份快照的 Storage 文件从哪读;实现不支持 Storage 文件时为 null */
  storageFiles(manifest: Manifest): StorageFilesLocation | null;
}

/** 写入时的键都在 <prefix>/<projectName>/<快照名>/ 下;读取时 Storage 文件的 base 从 dump.key 反推。 */
function storageBaseOf(manifest: Manifest): string {
  return manifest.dump.key.replace(/\/dump\.pgcustom$/, "");
}

/** S3 兼容桶(S3 / R2 / B2 / Wasabi)。行为与抽出这层之前逐字一致。 */
export function s3SnapshotStore(config: BackupConfig): SnapshotStore {
  const storage = requireBucket(config);
  let client: S3Client | null = null;
  // 客户端推迟到第一次真正读写时才建:与抽层之前一致,配置错误先由前面的检查报出来
  const s3 = () => (client ??= targetClient(config));

  return {
    async createSnapshot(name) {
      const base = `${storage.prefix}/${config.projectName}/${name}`;
      const location = (file: string) => `s3://${storage.bucket}/${base}/${file}`;
      return {
        dumpKey: `${base}/dump.pgcustom`,
        storageFiles: { s3: s3(), bucket: storage.bucket, base },
        describe: location,
        uploadDump(body, relationBytes) {
          const upload = new Upload({
            client: s3(),
            partSize: dumpPartSizeFor(relationBytes),
            params: {
              Bucket: storage.bucket,
              Key: `${base}/dump.pgcustom`,
              Body: body,
              ContentType: "application/octet-stream",
            },
          });
          return {
            done: upload.done().then(() => {}),
            abort: () => upload.abort(),
          };
        },
        async writeRecoveryDoc(manifest) {
          await s3().send(
            new PutObjectCommand({
              Bucket: storage.bucket,
              Key: `${base}/RECOVERY.md`,
              Body: renderRecoveryDoc(manifest, {
                snapshot: name,
                bucket: storage.bucket,
                endpoint: storage.endpoint,
                region: storage.region,
                prefix: storage.prefix,
                projectName: config.projectName,
              }),
              ContentType: "text/markdown",
            })
          );
        },
        async writeManifest(manifest) {
          await s3().send(
            new PutObjectCommand({
              Bucket: storage.bucket,
              Key: `${base}/manifest.json`,
              Body: JSON.stringify(manifest, null, 2),
              ContentType: "application/json",
            })
          );
        },
      };
    },

    async openSnapshot(name) {
      const prefix = await resolveSnapshot(s3(), config, name);
      return {
        name: prefix.replace(/\/$/, "").split("/").pop()!,
        readManifest: () => getObjectText(s3(), storage.bucket, `${prefix}manifest.json`),
        downloadDump: (manifest, dest) => downloadToFile(s3(), storage.bucket, manifest.dump.key, dest),
        storageFiles: (manifest) => ({ s3: s3(), bucket: storage.bucket, base: storageBaseOf(manifest) }),
      };
    },
  };
}
