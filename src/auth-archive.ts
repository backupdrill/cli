import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeflate, createInflate } from "node:zlib";

/**
 * 2.11.1 起:auth.dump 上传前,把 auth.users 里待处理的认证状态抹掉(找回密码、邮箱确认、改邮箱改手机、
 * 重新认证的 token,以及它们的发送时间和待改成的新邮箱/手机号)。
 *
 * 为什么在备份时就抹:这些 token 在源项目上还没过期时,GoTrue 的 /verify 收 token_hash,拿到桶的人
 * 可以直接用它在**源项目**上重置密码、确认邮箱。恢复时(CLEAR_PENDING_AUTH_SQL)本来就会清空,
 * 所以留在备份里没有任何用处,只有风险。2.10 / 2.11.0 写的旧归档仍靠恢复端那一句清空。
 *
 * 为什么改归档而不是改 pg_dump:pg_dump 没有"导出时把某几列换掉"的办法;另起一份数据(COPY 查询结果)
 * 又会让 auth.dump 不再是一份 pg_restore 能直接读的归档,RECOVERY.md 的手工步骤、演练、恢复都得跟着改。
 * 所以 pg_dump 的参数一个不动(源库上的负载、锁、快照都和以前一样),只在它的输出流进桶之前,
 * 改写 auth.users 那一段 COPY 数据;目录、其余数据段逐字节不变。sha256 和字节数按改写后的内容算,
 * 和桶里的文件一致。
 *
 * 只认 pg_dump 在管道上写出的 custom 格式(目录里不带数据偏移),归档版本 1.12–1.16(PostgreSQL 10–17 的
 * pg_dump;18 仍是 1.16)。认不出的一律报错:Auth 这一节记失败,绝不把没抹干净的归档当成功上传。
 */

/**
 * 要抹的列 → 抹成的 COPY 文本值。和恢复端 CLEAR_PENDING_AUTH_SQL 逐列一致(测试里对齐检查):
 * token 和待改的新邮箱/手机号写空串(GoTrue 读这些列时不接受 NULL),确认状态写 0,发送时间写 NULL。
 * 某个 GoTrue 版本里没有的列就跳过。
 */
export const PENDING_AUTH_COPY_VALUES: ReadonlyArray<readonly [column: string, copyValue: string]> = [
  ["confirmation_token", ""],
  ["recovery_token", ""],
  ["email_change_token_new", ""],
  ["email_change_token_current", ""],
  ["phone_change_token", ""],
  ["reauthentication_token", ""],
  ["email_change", ""],
  ["phone_change", ""],
  ["email_change_confirm_status", "0"],
  ["confirmation_sent_at", "\\N"],
  ["recovery_sent_at", "\\N"],
  ["email_change_sent_at", "\\N"],
  ["phone_change_sent_at", "\\N"],
  ["reauthentication_sent_at", "\\N"],
];

// pg_backup_archiver.h 里的版本号:MAKE_ARCHIVE_VERSION(major, minor, rev)
const archiveVersion = (major: number, minor: number, rev: number) => (major * 256 + minor) * 256 + rev;
const K_VERS_1_12 = archiveVersion(1, 12, 0);
const K_VERS_1_14 = archiveVersion(1, 14, 0);
const K_VERS_1_15 = archiveVersion(1, 15, 0);
const K_VERS_1_16 = archiveVersion(1, 16, 0);
const K_VERS_MAX_KNOWN = archiveVersion(1, 16, 255);
const ARCH_CUSTOM = 1;
const BLK_DATA = 1;
const K_OFFSET_POS_NOT_SET = 1;
const K_OFFSET_POS_SET = 2;
// pg_compress_algorithm(1.15 起头部里存算法;之前存压缩级别,0 = 不压缩,其余都是 zlib)
const COMPRESSION_NONE = 0;
const COMPRESSION_GZIP = 1;

class ArchiveError extends Error {}

/** 从异步迭代器按字节数取数据的读取器;只在需要拼接时才拷贝 */
class ByteReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buffered < n && !this.ended) {
      const next = await this.source.next();
      if (next.done) this.ended = true;
      else if (next.value.length) {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
    return this.buffered >= n;
  }

  async atEnd(): Promise<boolean> {
    return !(await this.fill(1));
  }

  /** 正好 n 个字节;不够就是归档被截断了 */
  async read(n: number): Promise<Buffer> {
    // 空字符串(长度 0)在目录里很常见;缓冲恰好读空时也不能去碰不存在的第一块
    if (n === 0) return Buffer.alloc(0);
    if (!(await this.fill(n))) throw new ArchiveError("the archive ended early");
    const head = this.chunks[0];
    if (head.length >= n) {
      this.chunks[0] = head.subarray(n);
      if (!this.chunks[0].length) this.chunks.shift();
      this.buffered -= n;
      return head.subarray(0, n);
    }
    const all = Buffer.concat(this.chunks);
    this.chunks = all.length > n ? [all.subarray(n)] : [];
    this.buffered -= n;
    return all.subarray(0, n);
  }

  /** 至多 n 个字节、至少 1 个,不拼接:大块数据按到手的大小往下传 */
  async readUpTo(n: number): Promise<Buffer> {
    if (!(await this.fill(1))) throw new ArchiveError("the archive ended early");
    const head = this.chunks[0];
    if (head.length <= n) {
      this.chunks.shift();
      this.buffered -= head.length;
      return head;
    }
    this.chunks[0] = head.subarray(n);
    this.buffered -= n;
    return head.subarray(0, n);
  }
}

/** pg_dump 的整数:1 字节符号 + intSize 字节小端 */
function decodeInt(raw: Buffer): number {
  let value = 0;
  for (let i = raw.length - 1; i >= 1; i--) value = value * 256 + raw[i];
  return raw[0] ? -value : value;
}

function encodeInt(value: number, intSize: number): Buffer {
  const out = Buffer.alloc(1 + intSize);
  let rest = value;
  for (let i = 1; i <= intSize; i++) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  if (rest) throw new ArchiveError("a data chunk is too large for this archive");
  return out;
}

/** COPY auth.users (a, b, "c") FROM stdin; → 列名(去掉引号) */
export function copyColumns(copyStmt: string): string[] {
  const m = /^COPY\s+\S+\s+\(([\s\S]*)\)\s+FROM\s+stdin;\s*$/i.exec(copyStmt.trim());
  if (!m) throw new ArchiveError("the COPY statement of auth.users isn't in the expected form");
  const columns: string[] = [];
  const re = /\s*(?:"((?:[^"]|"")*)"|([^\s,"]+))\s*(,|$)/y;
  let match: RegExpExecArray | null;
  let at = 0;
  const list = m[1];
  while (at < list.length && (match = re.exec(list))) {
    columns.push(match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2]);
    at = re.lastIndex;
    if (match[3] === "") break;
  }
  if (at !== list.length || !columns.length) throw new ArchiveError("the column list of auth.users couldn't be read");
  return columns;
}

/**
 * 逐字段改写 COPY 文本:按制表符和换行切字段,要抹的那几列换掉,其余字节原样往下传。COPY 文本格式里数据中的
 * 制表符和换行都转义成 \t、\n,所以按原始字节 0x09 / 0x0A 切是安全的(服务端编码都兼容 ASCII)。
 *
 * 不按整行缓冲:一行可以非常大(metadata 很长、又压缩得很好时,解压出来的一行能远超内存)。逐块扫一遍,
 * 要抹的字段直接丢、其余直接写出,占用的内存只和一块输入一样大,和行多长无关。
 * 字段数和列数对不上就报错,不猜(已经写出去的半行随这次上传一起作废)。
 */
function copyLineScrubber(columns: string[], replace: Map<number, Buffer>): Transform {
  // 第一列要抹的话就认不出 "\." 结束标记(它的字节被丢了);auth.users 的第一列从来不是 token
  if (replace.has(0)) throw new ArchiveError("the first column of auth.users is unexpectedly one to clear");
  let field = 0; // 当前行里的第几个字段
  let skipping = false; // 当前字段要抹:它的字节不写出
  let lineLength = 0; // 当前行到目前为止的字节数(只用来认结束标记,到 3 就不再数)
  let lineHead = 0; // 当前行的头两个字节
  // pg_dump 在数据末尾写 "\." 再跟几个空行;结束标记之后不是数据,原样照抄
  let afterEndMarker = false;
  const fieldCountError = (fields: number) =>
    new ArchiveError(`a row of auth.users has ${fields} fields, but the COPY statement lists ${columns.length} columns`);
  const scan = (chunk: Buffer, out: Buffer[]): void => {
    let start = 0; // 下一个还没写出的字节
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (b !== 0x09 && b !== 0x0a) {
        if (lineLength < 3) {
          if (lineLength < 2) lineHead = lineHead * 256 + b;
          lineLength++;
        }
        continue;
      }
      if (skipping) {
        out.push(replace.get(field)!);
        start = i; // 分隔符本身照常写出
        skipping = false;
      }
      if (b === 0x09) {
        field++;
        lineLength = 3; // 有制表符就不可能是结束标记
        if (field >= columns.length) throw fieldCountError(field + 1);
      } else {
        const endMarker = field === 0 && lineLength === 2 && lineHead === 0x5c2e;
        if (!endMarker && field !== columns.length - 1) throw fieldCountError(field + 1);
        field = 0;
        lineLength = 0;
        lineHead = 0;
        if (endMarker) {
          afterEndMarker = true;
          out.push(chunk.subarray(start));
          return;
        }
      }
      if (replace.has(field)) {
        out.push(chunk.subarray(start, i + 1));
        start = i + 1;
        skipping = true;
      }
    }
    if (!skipping) out.push(chunk.subarray(start));
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (afterEndMarker) return callback(null, chunk);
      try {
        const out: Buffer[] = [];
        scan(chunk, out);
        callback(null, out.length === 1 ? out[0] : Buffer.concat(out));
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      // 最后一行没有换行结尾(pg_dump 不会这样写):照样核对字段数、补上要抹的值
      if (!afterEndMarker && (lineLength > 0 || field > 0)) {
        if (field !== columns.length - 1) return callback(fieldCountError(field + 1));
        if (skipping) return callback(null, replace.get(field));
      }
      callback();
    },
  });
}

/**
 * 把 pg_dump 输出的 auth.dump 流改写成抹掉待处理 token 的版本。返回的流出错 = 没能抹干净,调用方必须当失败处理。
 * 只读输入、只写输出,不碰数据库。
 */
export function scrubPendingAuthTokens(input: Readable): Readable {
  const out = new PassThrough();
  const write = async (buf: Buffer): Promise<void> => {
    if (!buf.length) return;
    if (out.destroyed) throw new ArchiveError("stopped");
    if (out.write(buf)) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        out.off("drain", onDrain);
        out.off("close", onClose);
      };
      const onDrain = () => (done(), resolve());
      const onClose = () => (done(), reject(new ArchiveError("stopped")));
      out.once("drain", onDrain);
      out.once("close", onClose);
    });
  };
  void (async () => {
    const reader = new ByteReader(input[Symbol.asyncIterator]());
    // 头部和目录原样照抄:读到多少写多少
    const take = async (n: number): Promise<Buffer> => {
      const buf = await reader.read(n);
      await write(buf);
      return buf;
    };
    const magic = await take(5);
    if (magic.toString("latin1") !== "PGDMP") throw new ArchiveError("the Auth archive isn't a pg_dump custom-format archive");
    const [vmaj, vmin] = await take(2);
    const vrev = vmaj > 1 || (vmaj === 1 && vmin > 0) ? (await take(1))[0] : 0;
    const version = archiveVersion(vmaj, vmin, vrev);
    if (version < K_VERS_1_12 || version > K_VERS_MAX_KNOWN) {
      throw new ArchiveError(`pg_dump wrote archive version ${vmaj}.${vmin}.${vrev}, which this CLI can't clear pending Auth tokens from`);
    }
    const intSize = (await take(1))[0];
    const offSize = (await take(1))[0];
    if (intSize < 1 || intSize > 8 || offSize < 1 || offSize > 16) throw new ArchiveError("the archive header is malformed");
    const readInt = async () => decodeInt(await take(1 + intSize));
    const readStr = async (): Promise<string | null> => {
      const length = await readInt();
      if (length < 0) return null;
      return (await take(length)).toString("utf8");
    };
    if ((await take(1))[0] !== ARCH_CUSTOM) throw new ArchiveError("the Auth archive isn't in custom format");
    let compression: number;
    if (version >= K_VERS_1_15) compression = (await take(1))[0];
    else compression = (await readInt()) === 0 ? COMPRESSION_NONE : COMPRESSION_GZIP;
    if (compression !== COMPRESSION_NONE && compression !== COMPRESSION_GZIP) {
      throw new ArchiveError("the Auth archive uses a compression method this CLI can't rewrite");
    }
    for (let i = 0; i < 7; i++) await readInt(); // 创建时间(秒、分、时、日、月、年、夏令时)
    await readStr(); // 库名
    await readStr(); // 服务端版本
    await readStr(); // pg_dump 版本

    const tocCount = await readInt();
    // 目录里声明了有数据的条目:每一条都要在后面见到它的数据段,少一段就是归档不完整
    const withData = new Set<number>();
    let target: { dumpId: number; columns: string[] } | null = null;
    for (let i = 0; i < tocCount; i++) {
      const dumpId = await readInt();
      await readInt(); // hadDumper
      await readStr(); // tableoid
      await readStr(); // oid
      const tag = await readStr();
      const desc = await readStr();
      await readInt(); // section
      await readStr(); // defn
      await readStr(); // dropStmt
      const copyStmt = await readStr();
      const namespace = await readStr();
      await readStr(); // tablespace
      if (version >= K_VERS_1_14) await readStr(); // tableam
      if (version >= K_VERS_1_16) await readInt(); // relkind
      await readStr(); // owner
      await readStr(); // 旧的 WITH OIDS 标记
      while ((await readStr()) !== null); // 依赖,以 NULL 结尾
      const offsetFlag = (await take(1))[0];
      await take(offSize);
      if (offsetFlag === K_OFFSET_POS_NOT_SET) withData.add(dumpId);
      // 改写会改变数据段的长度:目录里记着数据偏移的归档(写进可寻址文件的)不能这样改。管道上写出的不会记
      if (offsetFlag === K_OFFSET_POS_SET) throw new ArchiveError("the Auth archive records data offsets, which this CLI can't rewrite");
      if (desc === "TABLE DATA" && namespace === "auth" && tag === "users") {
        if (target) throw new ArchiveError("the Auth archive has the data of auth.users twice");
        target = { dumpId, columns: copyColumns(copyStmt ?? "") };
      }
    }
    if (!target) throw new ArchiveError("the Auth archive has no data entry for auth.users");
    const replace = new Map<number, Buffer>();
    for (const [column, value] of PENDING_AUTH_COPY_VALUES) {
      const index = target.columns.indexOf(column);
      if (index !== -1) replace.set(index, Buffer.from(value));
    }

    // 数据段:每段 = 类型字节 + dumpId + 若干 [长度, 数据] 块,长度 0 结束
    let scrubbed = false;
    while (!(await reader.atEnd())) {
      if ((await take(1))[0] !== BLK_DATA) throw new ArchiveError("the Auth archive has a data block of an unexpected type");
      const dumpId = await readInt();
      if (!withData.delete(dumpId)) throw new ArchiveError("the Auth archive has a data block the TOC doesn't declare, or one twice");
      if (dumpId !== target.dumpId) {
        for (let length = await readInt(); length !== 0; length = await readInt()) {
          if (length < 0) throw new ArchiveError("the archive has a malformed data chunk");
          for (let left = length; left > 0; ) {
            const piece = await reader.readUpTo(left);
            await write(piece);
            left -= piece.length;
          }
        }
        continue;
      }
      if (scrubbed) throw new ArchiveError("the Auth archive has the data of auth.users twice");
      scrubbed = true;
      // 原来的数据块不照抄,逐块读出来解压(按头部的压缩方式)、改写、再压缩,写成新的数据块
      async function* payload(): AsyncGenerator<Buffer> {
        for (let length = decodeInt(await reader.read(1 + intSize)); length !== 0; length = decodeInt(await reader.read(1 + intSize))) {
          if (length < 0) throw new ArchiveError("the archive has a malformed data chunk");
          for (let left = length; left > 0; ) {
            const piece = await reader.readUpTo(left);
            yield piece;
            left -= piece.length;
          }
        }
      }
      const emitChunks = async (source: AsyncIterable<Buffer>) => {
        for await (const piece of source) {
          if (!piece.length) continue;
          await write(encodeInt(piece.length, intSize));
          await write(piece);
        }
      };
      if (compression === COMPRESSION_GZIP) {
        await pipeline(Readable.from(payload()), createInflate(), copyLineScrubber(target.columns, replace), createDeflate(), emitChunks);
      } else {
        await pipeline(Readable.from(payload()), copyLineScrubber(target.columns, replace), emitChunks);
      }
      await write(encodeInt(0, intSize));
    }
    if (!scrubbed) throw new ArchiveError("the Auth archive has no data block for auth.users");
    if (withData.size) throw new ArchiveError("the Auth archive ended before all of its data blocks");
    out.end();
  })().catch((error: unknown) => {
    out.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  return out;
}
