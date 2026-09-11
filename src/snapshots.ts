import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Writable, type Readable } from "node:stream";
import { log } from "./log.js";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import type { BackupConfig } from "./config.js";

/** 读备份桶(用户自己的桶)的 S3 客户端。drill/restore 共用。 */
export function targetClient(config: BackupConfig): S3Client {
  return new S3Client({
    region: config.storage.region,
    endpoint: config.storage.endpoint,
    forcePathStyle: config.storage.forcePathStyle,
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
  });
}

/** 定位快照:显式指定,否则取字典序最大(时间戳格式天然可排序)。返回带尾斜杠的前缀。 */
export async function resolveSnapshot(
  s3: S3Client,
  config: BackupConfig,
  explicit?: string
): Promise<string> {
  const root = `${config.storage.prefix}/${config.projectName}/`;
  if (explicit) return `${root}${explicit}/`;

  const prefixes: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.storage.bucket,
        Prefix: root,
        Delimiter: "/",
        ContinuationToken: token,
      })
    );
    for (const cp of res.CommonPrefixes ?? []) {
      if (cp.Prefix) prefixes.push(cp.Prefix);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  if (!prefixes.length) {
    throw new Error(
      `No snapshots found under s3://${config.storage.bucket}/${root}. Run a backup first.`
    );
  }
  prefixes.sort();
  return prefixes[prefixes.length - 1];
}

export async function getObjectText(
  s3: S3Client,
  bucket: string,
  key: string
): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body!.transformToString();
}

/** 下载对象到本地文件,顺带算 sha256(验证读回的归档没被损坏)。 */
export const DOWNLOAD_MAX_ATTEMPTS = 8;
const DOWNLOAD_BACKOFF_MS = 1000;
const DOWNLOAD_BACKOFF_CAP_MS = 30_000;

/**
 * 下载流半路断掉时值不值得从断点续传。SDK 自己的重试只管"请求建立"那一下;
 * `send()` 一旦返回、body 流开始,后面任何断连都直接落到 pipeline 的 reject 上。
 * 对端主动关连接(Node 报 "aborted")、连接重置、超时、5xx/429 都是重试对象;
 * 4xx(404 NoSuchKey、416 越界、403)是事实,重试只会得到同样的答案。
 */
function isRetryableDownloadError(error: unknown): boolean {
  const e = error as {
    code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = e.$metadata?.httpStatusCode;
  if (status !== undefined) return status >= 500 || status === 429;
  if (["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "EAI_AGAIN"].includes(e.code ?? "")) {
    return true;
  }
  return /aborted|socket hang up|premature close|short body/i.test(e.message ?? "");
}

class NonRetryableDownloadError extends Error {}

/** 最小的文件句柄接口:downloadToFile 只用这两样。测试可以注入假句柄(短写、慢写)。 */
export interface WritableHandle {
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}

/**
 * 把一整块写进 position 起的位置,**写满为止**。Node 的 `FileHandle.write` 合约允许一次只写
 * 一部分(返回 bytesWritten),按整块计数会让校验和给一份少了字节的文件盖章(交叉审查
 * 2026-09-12 故障注入:写进 3 字节、报了 8 字节、校验和照样"通过")。
 * 返回真正落盘的字节数;中途抛错时把已确认的字节数挂在错误上,调用方据此对齐哈希与起点。
 */
export async function writeFully(fh: WritableHandle, chunk: Buffer, position: number): Promise<number> {
  let done = 0;
  while (done < chunk.length) {
    let bytesWritten: number;
    try {
      ({ bytesWritten } = await fh.write(chunk, done, chunk.length - done, position + done));
    } catch (error) {
      throw Object.assign(error as Error, { confirmedBytes: done });
    }
    if (bytesWritten <= 0) {
      throw Object.assign(new Error(`write returned ${bytesWritten} bytes at position ${position + done}`), {
        confirmedBytes: done,
      });
    }
    done += bytesWritten;
  }
  return done;
}

/**
 * 断点续传下载(2026-09-12):一个 12 GB 的 dump 走一条 HTTPS 流要 50 分钟,对端(用户的桶)
 * 在第 10 分钟关掉连接,整次演练就没了 —— 而且此前没有任何续传:一次事故、两封 FAILED
 * 邮件。这里按 HTTP Range 续传,三条铁律:
 *  1. 续传起点 = **已确认写进 fd 的字节数**,不是流过管道的字节数。pipeline 出错时 Writable
 *     缓冲区里的块会丢,按"流过多少"续传会在文件里留下一个洞;所以自写 Writable,
 *     `fh.write` 返回之后才计数、才哈希,哈希与磁盘内容永远一致;
 *  2. 续传请求必须拿到 206:对端不认 Range 就会把整个对象再发一遍,追加上去就是脏文件,
 *     这种情况直接失败,绝不"看起来成功";
 *  3. ETag 变了 = 对象在下载中途被替换,两半拼不成一份,直接失败。
 * 重试 8 次,退避 1s→30s;每次续传写一行日志(worker 的 journal 能看到断在哪、续在哪)。
 */
export async function downloadToFile(
  s3: S3Client,
  bucket: string,
  key: string,
  dest: string,
  opts: { maxAttempts?: number; openFile?: (path: string) => Promise<WritableHandle> } = {}
): Promise<{ bytes: number; sha256: string }> {
  const maxAttempts = opts.maxAttempts ?? DOWNLOAD_MAX_ATTEMPTS;
  const hash = createHash("sha256");
  const openFile = opts.openFile ?? ((path: string) => open(path, "w"));
  // 目标文件推迟到首个响应到手后再打开(交叉审查 2026-09-12):"w" 会先截断,404/403 这种
  // 请求都没成的失败不该顺手毁掉调用方路径上已有的文件。
  let fh: WritableHandle | null = null;
  let written = 0; // 已落盘 = 已哈希 = 续传起点
  let total: number | null = null;
  let etag: string | undefined;
  // 上一块的写还在途时 pipeline 就可能 reject(源先断)。重试前必须等它落定,否则 Range 用的
  // 是过期的 written,写完成后 written 又往前走,续传起点与磁盘错位(交叉审查 2026-09-12)。
  let inFlight: Promise<void> = Promise.resolve();
  try {
    for (let attempt = 1; ; attempt++) {
      await inFlight.catch(() => {});
      const from = written; // 本次请求的起点在发请求前冻结,后面的判断都用它
      try {
        const res = await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            ...(from > 0 ? { Range: `bytes=${from}-` } : {}),
          })
        );
        const body = res.Body as Readable;
        const status = res.$metadata.httpStatusCode;
        if (from > 0 && status !== 206) {
          body.destroy();
          throw new NonRetryableDownloadError(
            `resume rejected: expected 206 Partial Content from byte ${from}, got ${status} — refusing to append`
          );
        }
        if (etag === undefined) {
          etag = res.ETag;
        } else if (res.ETag !== undefined && res.ETag !== etag) {
          body.destroy();
          throw new NonRetryableDownloadError(
            `object changed during download (ETag ${etag} → ${res.ETag}) — halves would not match`
          );
        }
        if (total === null && typeof res.ContentLength === "number") total = res.ContentLength;
        if (fh === null) fh = await openFile(dest);
        const handle = fh;

        const sink = new Writable({
          write(chunk: Buffer, _enc, cb) {
            inFlight = writeFully(handle, chunk, written).then(
              (n) => {
                hash.update(chunk.subarray(0, n));
                written += n;
                cb();
              },
              (err: Error & { confirmedBytes?: number }) => {
                // 半块落盘也要如实计入:哈希与起点永远等于磁盘上真有的字节
                const n = err.confirmedBytes ?? 0;
                if (n > 0) {
                  hash.update(chunk.subarray(0, n));
                  written += n;
                }
                cb(err);
              }
            );
          },
        });
        await pipeline(body, sink);
        await inFlight.catch(() => {});
        if (total !== null && written !== total) {
          // 流"正常"结束但字节不够:对端掐断时 Node 有时不报错只是提前 end
          throw new Error(`short body: got ${written} of ${total} bytes`);
        }
        return { bytes: written, sha256: hash.digest("hex") };
      } catch (error) {
        if (
          error instanceof NonRetryableDownloadError ||
          !isRetryableDownloadError(error) ||
          attempt >= maxAttempts
        ) {
          throw error;
        }
        const wait = Math.min(DOWNLOAD_BACKOFF_MS * 2 ** (attempt - 1), DOWNLOAD_BACKOFF_CAP_MS);
        const reason = ((error as Error).message ?? String(error)).split("\n")[0];
        log.step(
          `Download interrupted at ${(written / 1048576).toFixed(0)} MB (${reason}); ` +
            `resuming from byte ${written} in ${wait / 1000}s (attempt ${attempt + 1}/${maxAttempts})…`
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  } finally {
    // 终态失败时上一块的写可能还在途:先让它落定再关句柄,别让慢写撞上已关闭的 fd
    await inFlight.catch(() => {});
    if (fh !== null) await fh.close();
  }
}

/** 只算对象校验和、不落盘(Storage 文件完整性校验用,省内存/磁盘)。 */
export async function hashObject(
  s3: S3Client,
  bucket: string,
  key: string
): Promise<{ bytes: number; sha256: string }> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of res.Body as Readable) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest("hex") };
}
