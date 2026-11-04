import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { promisify } from "node:util";
import type { BackupConfig } from "./config.js";
import { s3SnapshotStore, type DumpUpload, type SnapshotStore, type SnapshotWriter } from "./snapshot-store.js";
import { MANIFEST_SCHEMA_VERSION } from "./manifest.js";
import type { AuthSection, BucketAttrs, ExtensionInfo, Manifest, TableStat } from "./manifest.js";
import {
  AUTH_DUMP_MAX_BYTES,
  authDumpArgs,
  exportSharedSnapshot,
  inspectAuth,
  authInSchemas,
  manualAuthObjects,
  redactValues,
  type AuthMode,
  type SharedSnapshot,
} from "./auth-backup.js";
import { syncStorage } from "./storage.js";
import { inspectBucketAttrs } from "./storage-catalog.js";
import { projectRefOf, refFromStorageEndpoint, assertNoHostOverride } from "./restore-engine.js";
import { log } from "./log.js";
import { TOOL_VERSION } from "./version.js";
import { parsePgDumpMajor } from "./pgbin.js";
import { relationBytes } from "./estimate.js";
import { captureIdentifiedGrants, grantsHeldThroughout, type IdentifiedGrants } from "./grants.js";

// 解析函数搬到了 pgbin(演练与恢复都要读 pg_restore 版本,放这里会成环);保留旧出口
export { parsePgDumpMajor };
import { dumpUrlFor, connectPg, isSupabaseHost } from "./supabase-ca.js";
import { credentialSafeDbArgs, libpqChildEnv, urlSslModeOf } from "./restore-engine.js";

const execFileAsync = promisify(execFile);

function majorOf(serverVersionNum: number): number {
  // server_version_num: 150004 → 15,  170002 → 17
  return Math.floor(serverVersionNum / 10000);
}


async function pgDumpVersion(bin: string): Promise<{ raw: string; major: number }> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"]);
    const raw = stdout.trim();
    const major = parsePgDumpMajor(raw);
    if (major === null) throw new Error(`Unrecognized pg_dump version string: ${raw}`);
    return { raw, major };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `pg_dump not found (looked for "${bin}"). Install the PostgreSQL client ` +
          `matching your server's major version, or set BACKUPDRILL_PG_DUMP to its path.`
      );
    }
    throw error;
  }
}

interface DbFacts {
  serverVersion: string;
  serverVersionNum: number;
  tables: TableStat[];
  extensions: ExtensionInfo[];
  /** 要转储的表的磁盘占用;量不出来时为 null(只影响分片大小,不影响备份本身) */
  relationBytes: number | null;
}

async function inspectDatabase(
  databaseUrl: string,
  schemas: string[]
): Promise<DbFacts> {
  // Supabase 主机 → 用打包的根 CA 做 verify-full(pooler 证书自签、不在系统信任库);
  // 非 Supabase(本 CLI 不限制目标)→ 保持默认,别把开源用户挡在门外
  const client = await connectPg(databaseUrl);
  try {
    const version = await client.query<{ server_version: string }>(
      "show server_version"
    );
    const versionNum = await client.query<{ server_version_num: string }>(
      "show server_version_num"
    );
    // 只统计将被 dump 的 schema,manifest 才与转储内容一致。
    // 口径 = pg_class relkind in ('r','p','m'):普通表 + 分区父表 + 物化视图,
    // 与 pg_dump 实际转储的关系集合一致,且必须与 drill 校验端(verifyRestored)
    // 用同一查询——两端口径不同曾导致含 matview 的库演练必然误报 FAIL。
    // 行数估算仍取 n_live_tup(planner 统计);分区父表本身不存行,天然为 0。
    const tables = await client.query<{
      schema: string;
      name: string;
      estimated_rows: string;
    }>(
      `select n.nspname as schema, c.relname as name,
              coalesce(s.n_live_tup, 0) as estimated_rows
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_stat_all_tables s on s.relid = c.oid
        where c.relkind in ('r', 'p', 'm')
          and n.nspname = any($1::text[])
        order by 1, 2`,
      [schemas]
    );
    // 非内置扩展清单(排除必装的 plpgsql):--schema 转储不含 CREATE EXTENSION,
    // 演练沙箱要靠它在恢复前把扩展类型(如 vector)装回来
    const extensions = await client.query<ExtensionInfo>(
      `select e.extname as name, e.extversion as version, n.nspname as schema
         from pg_extension e
         join pg_namespace n on n.oid = e.extnamespace
        where e.extname <> 'plpgsql'
        order by e.extname`
    );
    // 量体积失败不该让备份失败:分片退回保底值,200 GiB 以内的转储照常上传
    let measuredBytes: number | null = null;
    try {
      measuredBytes = await relationBytes(client, schemas);
    } catch (error) {
      log.warn(
        `Could not measure database size (${(error as Error).message}); ` +
          `uploading with the baseline part size, which fits a dump of up to 200 GiB.`
      );
    }
    return {
      serverVersion: version.rows[0].server_version,
      serverVersionNum: Number(versionNum.rows[0].server_version_num),
      tables: tables.rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        estimatedRows: Number(r.estimated_rows),
      })),
      extensions: extensions.rows,
      relationBytes: measuredBytes,
    };
  } finally {
    await client.end();
  }
}

async function readGrants(databaseUrl: string, schemas: string[]): Promise<IdentifiedGrants[]> {
  const client = await connectPg(databaseUrl);
  try {
    return await captureIdentifiedGrants(client, schemas);
  } finally {
    await client.end();
  }
}

/** 主 dump 的 pg_dump 参数。snapshotId 省略时与 2.10.0 之前逐字一致(Auth 关闭时就是这样) */
export function mainDumpArgs(schemas: string[], snapshotId?: string): string[] {
  return [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    ...(snapshotId ? [`--snapshot=${snapshotId}`] : []),
    ...schemas.map((s) => `--schema=${s}`),
  ];
}

class AuthDumpTooLarge extends Error {}

/** 等 p 最多 ms 毫秒(到点就不等了,p 仍在后台结束);谁先完成都会清掉计时器,不拖住进程退出 */
async function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    p.then(() => {}, () => {}),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))),
  ]);
  clearTimeout(timer);
}

/**
 * 流式跑 pg_dump,边写快照边算 sha256 与字节数。返回校验和与大小。
 * onFirstByte:pg_dump 先导入快照才会吐出第一个字节,调用方据此尽早释放导出快照的连接。
 * maxBytes:超过就中止(只用于 auth.dump)。
 */
async function streamPgDump(opts: {
  databaseUrl: string;
  pgDumpBin: string;
  args: string[];
  upload: (body: Readable) => DumpUpload;
  onFirstByte?: () => void;
  maxBytes?: number;
  signal?: AbortSignal;
  endOnlyOnSuccess?: boolean;
  /** 失败时等上传中止最多 5 秒(Auth 那些新路径用;主 dump 的老路径不传,照旧等到中止完成) */
  boundedCleanup?: boolean;
}): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (bytes === 0) opts.onFirstByte?.();
      hash.update(chunk);
      bytes += chunk.length;
      if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
        cb(new AuthDumpTooLarge(`archive is larger than ${opts.maxBytes} bytes`));
        return;
      }
      cb(null, chunk);
    },
  });
  // 中止、超限时会带错 destroy 这个流;上传一侧若没在读它,没人接的 error 事件会让整个进程崩掉。
  // 错误本身由下面 dumpDone / upload.done 的 Promise 报出来,这里只需要接住
  meter.on("error", () => {});

  // pg_dump(libpq):Supabase 主机才改写成 sslmode=verify-full + sslrootcert=<打包CA临时文件>
  // 凭据不进 argv(D6):argv 对同机任何进程的 `ps` 可见。与恢复路径同一个函数——
  // 先改写 SSL 再拆密码,密码经 PGPASSWORD 交给 libpq
  const { url: dumpDbUrl, env: credentialEnv } = credentialSafeDbArgs(dumpUrlFor(opts.databaseUrl));
  const dump = spawn(
    opts.pgDumpBin,
    [...opts.args, "--dbname", dumpDbUrl],
    // 环境剔除改写目标/身份的 PG* 变量:pg_dump 只认 --dbname 里的 URL(TLS 策略等保留)
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: libpqChildEnv(credentialEnv, process.env, {
        supabaseHost: isSupabaseHost(opts.databaseUrl),
        urlSslMode: urlSslModeOf(dumpDbUrl),
      }),
    }
  );
  // 调用方要求停下(例如主 dump 失败了、或 Auth 等太久):杀掉 pg_dump,并直接中止上传和数据流——
  // pg_dump 可能早已退出、卡住的是上传,只杀进程停不下来
  let upload: DumpUpload | null = null;
  const onAbort = () => {
    dump.kill("SIGKILL");
    meter.destroy(new Error("stopped by the caller"));
    void upload?.abort().catch(() => {});
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let stderr = "";
  dump.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  // endOnlyOnSuccess(auth.dump 用):pg_dump 成功退出才结束上传流,失败就带错中断,上传因此完不成——
  // 不在用户桶里留下一个空的或半截的 auth.dump。主 dump 不传这个选项,行为与之前一致
  dump.stdout.pipe(meter, { end: !opts.endOnlyOnSuccess });
  if (opts.endOnlyOnSuccess) {
    dump.on("close", (code) => {
      if (code === 0) meter.end();
      else meter.destroy(new Error(`pg_dump exited with code ${code}`));
    });
  }

  const dumpDone = new Promise<void>((resolve, reject) => {
    dump.on("error", reject); // 启动失败(如 ENOENT)
    dump.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pg_dump exited with code ${code}: ${stderr.trim()}`))
    );
  });

  // 失败双向联动:dump 失败要中止上传(绝不把半截转储当成功);上传失败也必须
  // 杀掉 pg_dump —— 否则上传侧停止消费后,背压会让 pg_dump 永远阻塞在 stdout
  // 写入上,调用方(worker 的串行队列)随之永久挂起。Promise.all 会订阅两侧,
  // 先失败的一方抛出后,另一方稍后的 rejection 也已被视为 handled。
  // 开始上传也放进 try:实现可能在建上传时就同步抛错,那时 pg_dump 已经在跑,同样要杀掉。
  // 调用方要求停下时立刻以失败收场,不等 pg_dump 和上传各自收尾——卡住的可能正是它们之一。
  // 没传 signal(主 dump)时这个 Promise 永不 settle,行为与之前一致
  const stopped = new Promise<never>((_, reject) => {
    if (opts.signal?.aborted) reject(new Error("stopped by the caller"));
    opts.signal?.addEventListener("abort", () => reject(new Error("stopped by the caller")), { once: true });
  });
  stopped.catch(() => {});
  try {
    upload = opts.upload(meter);
    const finished = Promise.all([dumpDone, upload.done]);
    finished.catch(() => {}); // 被叫停后它可能才失败,不能变成没人接的 rejection
    await Promise.race([finished, stopped]);
  } catch (error) {
    dumpDone.catch(() => {}); // 没走到 Promise.all 时,被杀的 pg_dump 的退出也得有人接住
    dump.kill("SIGKILL");
    meter.destroy();
    // 被叫停时中止上传但不等它(可能正卡在那)。可叫停的调用(Auth、共享快照那次)自己失败时,
    // 等中止最多 5 秒——中止本身也可能卡住,不能让调用方跟着卡。主 dump 的老路径照旧等中止完成
    if (opts.signal?.aborted) void upload?.abort().catch(() => {});
    else if (opts.signal || opts.boundedCleanup) await waitAtMost(upload?.abort() ?? Promise.resolve(), 5000);
    else await upload?.abort().catch(() => {});
    // 超限时先失败的往往是上传那一侧(流被 meter 报错中断),原因统一报成超限
    if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
      throw new AuthDumpTooLarge(`archive is larger than ${opts.maxBytes} bytes`);
    }
    throw error;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }

  return { bytes, sha256: hash.digest("hex") };
}

type ReadableAuth = Extract<Awaited<ReturnType<typeof inspectAuth>>, { readable: true }>;

/**
 * Auth 一侧的两个时限(导出供测试调短,产品里不改):
 *  - waitAfterMainMs:主 dump 完成后还肯等 Auth 导出多久
 *  - prepareDeadlineMs:主 dump 开始前,导出快照 + 统计最多花多久(连接、锁、查询都算在内)
 */
export const AUTH_TIMEOUTS = {
  waitAfterMainMs: 10 * 60 * 1000,
  prepareDeadlineMs: 2 * 60 * 1000,
  /**
   * 两份 dump 一起启动后,主 dump 最迟多久要吐出第一个字节。连接池会排队的环境里(例如名额只有两个),
   * 导出快照的连接和 Auth dump 可能占满名额、让主 dump 一直排在后面——到点就放掉 Auth 这两条连接,
   * 把名额让给主 dump(它若还没导入快照,稍后会在写出任何东西之前失败,再按今天的方式重导)
   */
  mainStartGraceMs: 60 * 1000,
};

/** 做不了 Auth 备份时记什么:默认开启记 skipped(不算失败);显式要求记 failed */
function authNotDone(mode: AuthMode, reason: string): AuthSection {
  return mode === "on" ? { status: "failed", reason } : { status: "skipped", reason };
}

const AUTH_SKIP_TEXT: Record<string, string> = {
  no_permission:
    "the backup role can't read every row of auth.users and auth.identities (it needs BYPASSRLS or superuser, plus read access)",
  no_auth_schema: "this database has no Supabase auth schema",
  unsupported_destination: "this backup destination can't hold the Auth archive yet",
  schemas_include_auth: "your schema list includes auth, so the Auth users are in the database dump",
  schemas_not_plain:
    "your schema list uses a pattern or a quoted name, so the Auth users aren't backed up separately " +
    "(they are in the database dump only if one of those patterns matches auth)",
  too_large: "the Auth archive is larger than 2 GiB",
  snapshot_unavailable: "a consistent snapshot for the Auth export couldn't be set up",
};

/** 报错只留第一行、截短:pg_dump / 上传的错误不该把大段原文(更不能是行值)带进 manifest 和告警 */
function shortReason(error: unknown): string {
  return redactValues(String((error as Error)?.message ?? error).split("\n")[0]).slice(0, 300);
}

type AuthPlan =
  | { kind: "none" }
  | { kind: "settled"; section: AuthSection }
  | { kind: "dump"; shared: SharedSnapshot; inspection: ReadableAuth; key: string; upload: (body: Readable) => DumpUpload };

/**
 * 决定这次要不要、能不能另外备 Auth。任何"不能"都在这里落成 skipped/failed,不抛错——
 * 主 dump 永远不因 Auth 受影响。返回 dump 时,共享快照已经导出,调用方负责释放。
 */
async function planAuth(config: BackupConfig, writer: SnapshotWriter, mode: AuthMode): Promise<AuthPlan> {
  if (mode === "off") return { kind: "none" };
  // schemas 已经(可能)把 auth 带进主 dump:今天怎样以后还怎样,不另备一份。
  // 确定包含 → skipped(数据就在主 dump 里);说不准 → 默认模式也 skipped,显式要求时记 failed,
  // 不能在 Auth 用户可能哪份归档都不在的情况下报成功
  const inSchemas = authInSchemas(config.schemas);
  if (inSchemas === "yes") {
    return { kind: "settled", section: { status: "skipped", reason: "schemas_include_auth" } };
  }
  if (inSchemas === "maybe") {
    return { kind: "settled", section: authNotDone(mode, "schemas_not_plain") };
  }
  if (!writer.uploadAuthDump || !writer.authDumpKey) {
    return { kind: "settled", section: authNotDone(mode, "unsupported_destination") };
  }
  // 导出快照和统计都发生在主 dump 之前,必须有总时限:连接池满时新连接会一直排队,
  // 不能让数据库备份陪着等。到点就按"快照不可用"放弃,并立刻断开 Auth 的两条连接
  // (不管它们还在排队还是在跑查询),把连接让给主 dump
  const stop = new AbortController();
  const prepared = prepareAuthDump(config, writer, mode, stop.signal);
  prepared.catch(() => {});
  let deadline: NodeJS.Timeout | undefined;
  const timedOut = new Promise<AuthPlan>((resolve) => {
    deadline = setTimeout(() => {
      stop.abort();
      void prepared.then((late) => (late.kind === "dump" ? late.shared.release() : undefined)).catch(() => {});
      resolve({ kind: "settled", section: authNotDone(mode, "snapshot_unavailable") });
    }, AUTH_TIMEOUTS.prepareDeadlineMs);
  });
  const plan = await Promise.race([prepared, timedOut]);
  clearTimeout(deadline);
  return plan;
}

async function prepareAuthDump(
  config: BackupConfig,
  writer: SnapshotWriter,
  mode: AuthMode,
  signal: AbortSignal
): Promise<AuthPlan> {
  const shared = await exportSharedSnapshot(config.databaseUrl, signal);
  if (!shared) return { kind: "settled", section: authNotDone(mode, "snapshot_unavailable") };
  let inspection: Awaited<ReturnType<typeof inspectAuth>>;
  try {
    inspection = await inspectAuth(config.databaseUrl, shared.id, signal);
  } catch (error) {
    await shared.release();
    // 导入快照失败(经连接池时最可能)按"快照不可用"跳过;其余是统计查询本身出错
    const section = /snapshot/i.test(shortReason(error))
      ? authNotDone(mode, "snapshot_unavailable")
      : ({ status: "failed", reason: `could not inspect the Auth tables: ${shortReason(error)}` } as AuthSection);
    return { kind: "settled", section };
  }
  if (!inspection.readable) {
    await shared.release();
    return { kind: "settled", section: authNotDone(mode, inspection.reason) };
  }
  const uploadAuthDump = writer.uploadAuthDump!.bind(writer);
  return { kind: "dump", shared, inspection, key: writer.authDumpKey!, upload: (body) => uploadAuthDump(body) };
}

/**
 * 主 dump 和 auth dump 并行,都导入同一个共享快照。两份都吐出第一个字节(= 都已导入快照)后
 * 立刻释放导出快照的连接,所以它只占几秒,和主 dump 多大无关。
 * Auth 一侧失败只影响 Auth 段;主 dump 因导入快照失败而一个字节都没写出时,按今天的方式重导一次。
 */
async function dumpWithAuth(
  config: BackupConfig,
  writer: SnapshotWriter,
  pgDumpBin: string,
  relationBytes: number | null,
  mode: AuthMode,
  plan: Extract<AuthPlan, { kind: "dump" }>
): Promise<{ main: { bytes: number; sha256: string }; auth: AuthSection }> {
  const { shared, inspection } = plan;
  let mainStarted = false;
  let markMainStarted!: () => void;
  let markAuthStarted!: () => void;
  const mainStartedP = new Promise<void>((resolve) => (markMainStarted = resolve));
  const authStartedP = new Promise<void>((resolve) => (markAuthStarted = resolve));
  void Promise.all([mainStartedP, authStartedP]).then(() => shared.release());

  const authAbort = new AbortController();
  const authRun = streamPgDump({
    databaseUrl: config.databaseUrl,
    pgDumpBin,
    args: authDumpArgs(shared.id),
    upload: plan.upload,
    onFirstByte: () => markAuthStarted(),
    maxBytes: AUTH_DUMP_MAX_BYTES,
    signal: authAbort.signal,
    endOnlyOnSuccess: true,
  }).then(
    (result) => ({ ok: true as const, ...result }),
    (error: unknown) => ({ ok: false as const, error })
  );
  void authRun.finally(() => markAuthStarted());

  // 看门狗:主 dump 迟迟没开始,就是被 Auth 的连接挤住了,先让路(见 AUTH_TIMEOUTS.mainStartGraceMs)
  const mainStartWatchdog = setTimeout(() => {
    if (mainStarted) return;
    log.warn("The database dump hasn't started yet; stopping the Auth export to free its connections.");
    authAbort.abort();
    void shared.release();
  }, AUTH_TIMEOUTS.mainStartGraceMs);

  let main: { bytes: number; sha256: string };
  try {
    main = await streamPgDump({
      databaseUrl: config.databaseUrl,
      pgDumpBin,
      args: mainDumpArgs(config.schemas, shared.id),
      upload: (body) => writer.uploadDump(body, relationBytes),
      onFirstByte: () => {
        mainStarted = true;
        clearTimeout(mainStartWatchdog);
        markMainStarted();
      },
      // 这一次可能因导入快照失败而重来,重来写的是同一个键:失败的这次绝不能"正常结束"上传——
      // 否则它那份空的 PutObject 可能晚于重来的那份完成,把好的备份盖掉
      endOnlyOnSuccess: true,
      boundedCleanup: true,
    });
  } catch (error) {
    clearTimeout(mainStartWatchdog);
    markMainStarted();
    authAbort.abort();
    // 收尾都有上限:Auth 那边的清理(或者释放快照连接)就算卡住,也不能挡住下面的回退重导
    await waitAtMost(authRun, 5000);
    await waitAtMost(shared.release(), 5000);
    // 主 dump 一个字节都没写出就失败了(导入快照失败、连接名额被 Auth 的两条连接占满……原因不限):
    // Auth 的连接上面已经全部放掉,Auth 这次不做,主 dump 按今天的方式重导一次。
    // 重导再失败,就是今天也会失败的情况,照常报错
    if (!mainStarted) {
      log.warn(`The database dump couldn't start alongside the Auth export (${shortReason(error)}); dumping it the usual way.`);
      const plain = await plainDumpAfterAuthReleased(config, writer, pgDumpBin, relationBytes);
      return { main: plain, auth: authNotDone(mode, "snapshot_unavailable") };
    }
    throw error;
  }

  clearTimeout(mainStartWatchdog);
  // 主 dump 已经完成:Auth 两张表通常几秒就导完。万一那边卡住,最多再等这么久就放弃,
  // 不能让整份备份(以及 worker 的串行队列)陪着它挂住。到点就立刻判失败往下走,
  // 不再等 authRun 收尾——卡住的可能正是它
  let authTimer: NodeJS.Timeout | undefined;
  const authResult = await Promise.race([
    authRun,
    new Promise<Awaited<typeof authRun>>((resolve) => {
      authTimer = setTimeout(() => {
        authAbort.abort();
        resolve({ ok: false, error: new Error(`timed out ${Math.round(AUTH_TIMEOUTS.waitAfterMainMs / 1000)}s after the main dump`) });
      }, AUTH_TIMEOUTS.waitAfterMainMs);
    }),
  ]);
  clearTimeout(authTimer);
  await waitAtMost(shared.release(), 5000);
  if (!authResult.ok) {
    const auth =
      authResult.error instanceof AuthDumpTooLarge
        ? authNotDone(mode, "too_large")
        : ({ status: "failed", reason: `Auth archive not written: ${shortReason(authResult.error)}` } as AuthSection);
    return { main, auth };
  }
  return {
    main,
    auth: {
      status: "included",
      dump: { key: plan.key, format: "custom", bytes: authResult.bytes, sha256: authResult.sha256 },
      rows: { users: inspection.users, identities: inspection.identities },
      passwordHashes: inspection.passwordHashes,
      anonymousUsers: inspection.anonymousUsers,
      ssoUsers: inspection.ssoUsers,
      mfaUsers: inspection.mfaUsers,
      triggers: inspection.triggers,
      policies: inspection.policies,
      grants: inspection.grants,
    },
  };
}

/**
 * 共享快照那次失败后,按今天的方式重导主 dump。刚放掉的 Auth 连接在服务端要过一小会儿才真正退出,
 * 连接名额紧(角色或连接池上限)时立刻重连可能还会撞上"连接满了":这类错误稍等再试,最多三次。
 * 每次都只在 pg_dump 成功时才结束上传——失败那次的空上传绝不能晚到、盖掉成功的那次。
 */
async function plainDumpAfterAuthReleased(
  config: BackupConfig,
  writer: SnapshotWriter,
  pgDumpBin: string,
  relationBytes: number | null
): Promise<{ bytes: number; sha256: string }> {
  const delays = [1000, 3000];
  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      return await streamPgDump({
        databaseUrl: config.databaseUrl,
        pgDumpBin,
        args: mainDumpArgs(config.schemas),
        upload: (body) => writer.uploadDump(body, relationBytes),
        onFirstByte: () => (started = true),
        endOnlyOnSuccess: true,
        boundedCleanup: true,
      });
    } catch (error) {
      const connectionsFull = /too many connections|remaining connection slots|connection limit/i.test(shortReason(error));
      if (started || !connectionsFull || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** 备份结束时把 Auth 段的结果说给人听;warn 的都是不影响数据库备份的事 */
function logAuthOutcome(auth: AuthSection, schemas: string[]): void {
  if (auth.status === "included") {
    log.ok(
      `Auth users backed up (${auth.rows!.users.toLocaleString("en-US")} users, ` +
        `${auth.rows!.identities.toLocaleString("en-US")} sign-in identities, ` +
        `${(auth.dump!.bytes / 1024 / 1024).toFixed(1)} MB)`
    );
    if (auth.passwordHashes!.unrecognized > 0) {
      log.warn(
        `${auth.passwordHashes!.unrecognized} password hash(es) are in a format BackupDrill doesn't recognize; ` +
          `whether those users can sign in with their old password after a restore is unknown.`
      );
    }
    if (auth.passwordHashes!.encrypted > 0) {
      log.warn(
        `${auth.passwordHashes!.encrypted} password hash(es) are encrypted with this project's key; ` +
          `after a restore into a new project those users can't sign in with their old password.`
      );
    }
    // 备份时只提示用户自己能补救的(把缺的 schema 加进备份);其余在 RECOVERY.md 和恢复报告里列成手工步骤
    for (const note of manualAuthObjects({ triggers: auth.triggers!, policies: auth.policies! }, schemas)) {
      if (note.includes("not in this backup")) log.warn(`The ${note}. Add that schema to the backup to keep it.`);
    }
    return;
  }
  const why = AUTH_SKIP_TEXT[auth.reason ?? ""] ?? auth.reason ?? "unknown reason";
  if (auth.status === "skipped") {
    // 不是 Supabase 库时这是正常情况,不该显得像个问题
    if (auth.reason === "no_auth_schema") log.step(`Auth users: skipped (${why}).`);
    else log.warn(`Auth users not backed up: ${why}. The database backup itself is complete.`);
  } else {
    log.warn(`Auth users backup failed: ${why}. The database backup itself is complete.`);
  }
}

export async function runBackup(
  config: BackupConfig,
  opts: {
    /** 快照写到哪;省略 = config.storage 指的 S3 兼容桶 */
    store?: SnapshotStore;
  } = {}
): Promise<Manifest> {
  // 源身份先于一切传输(评审第 12 轮):①连接串不许带 ?host=/user= 覆盖——否则
  // 快照记的 ref 与实际读取对象脱节,恢复端的同源保护随之失真;②库与 Storage
  // 跨项目 = 配置错误,全量 dump+同步之后才发现会白烧 egress 还留下半截快照前缀
  assertNoHostOverride(config.databaseUrl);
  const dbRef = projectRefOf(config.databaseUrl);
  const storageRef = config.supabaseStorage
    ? refFromStorageEndpoint(config.supabaseStorage.endpoint)
    : null;
  if (dbRef && storageRef && dbRef !== storageRef) {
    throw new Error(
      `database points at Supabase project "${dbRef}" but Storage at "${storageRef}" — ` +
        `one BackupDrill project backs up one Supabase project; fix the config before backing up.`
    );
  }
  const sourceProjectRef = dbRef ?? storageRef;

  const pgDumpBin = process.env.BACKUPDRILL_PG_DUMP || "pg_dump";

  log.step("Inspecting database…");
  const db = await inspectDatabase(config.databaseUrl, config.schemas);
  const serverMajor = majorOf(db.serverVersionNum);
  log.ok(
    `Postgres ${db.serverVersion} — schema(s) ${config.schemas.join(", ")}: ` +
      `${db.tables.length} tables, ` +
      `~${db.tables.reduce((n, t) => n + t.estimatedRows, 0).toLocaleString()} rows`
  );

  // pg_dump 主版本必须 ≥ 服务端,否则转储会失败或不完整(PRD §4.2)
  const pgd = await pgDumpVersion(pgDumpBin);
  if (pgd.major < serverMajor) {
    throw new Error(
      `pg_dump is v${pgd.major} but the server is v${serverMajor}. ` +
        `pg_dump must be >= the server major version. Install postgresql-client-${serverMajor} ` +
        `(or newer) and/or point BACKUPDRILL_PG_DUMP at it.`
    );
  }

  const store = opts.store ?? s3SnapshotStore(config);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const writer = await store.createSnapshot(timestamp);
  const storageFiles = writer.storageFiles;
  // 在转储之前拦下:目标放不了 Storage 文件却配了 Storage,转储完才发现等于白跑一遍
  if (config.supabaseStorage && !storageFiles) {
    throw new Error(
      "Storage file backup needs an S3-compatible bucket; this backup destination only holds the database."
    );
  }
  const dumpKey = writer.dumpKey;

  // 授权在转储前后各读一次,只记两次都有的(为什么见 grantsHeldThroughout)。
  // 哪次读不到都让备份失败,不留一份缺授权记录的快照:恢复端把"没有记录"当成 2.9.0 之前的旧快照,
  // 按 Supabase 以前的默认授权开放 public,会把源库关着的表打开
  const grantsBeforeDump = await readGrants(config.databaseUrl, config.schemas);

  // Auth 用户另备一份(2.10.0 起,见 auth-backup.ts)。库调用方没传 = 关闭,下面走的就是之前的那条路,
  // 参数、文件、manifest 都和之前一样。共享快照在转储前一刻才导出,尽量少占连接
  const authMode: AuthMode = config.auth ?? "off";
  const authPlan = await planAuth(config, writer, authMode);
  let auth: AuthSection | undefined = authPlan.kind === "settled" ? authPlan.section : undefined;

  log.step(`Dumping → ${writer.describe("dump.pgcustom")}`);
  let bytes: number;
  let sha256: string;
  if (authPlan.kind === "dump") {
    const result = await dumpWithAuth(config, writer, pgDumpBin, db.relationBytes, authMode, authPlan);
    ({ bytes, sha256 } = result.main);
    auth = result.auth;
  } else {
    ({ bytes, sha256 } = await streamPgDump({
      databaseUrl: config.databaseUrl,
      pgDumpBin,
      args: mainDumpArgs(config.schemas),
      upload: (body) => writer.uploadDump(body, db.relationBytes),
    }));
  }
  log.ok(`Database dumped (${(bytes / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…)`);
  if (auth) logAuthOutcome(auth, config.schemas);

  const grants = grantsHeldThroughout(grantsBeforeDump, await readGrants(config.databaseUrl, config.schemas));

  // Storage 文件同步(源配置存在才做;否则只备数据库)
  let storageResult: Manifest["storage"] = null;
  if (config.supabaseStorage && storageFiles) {
    log.step("Syncing Storage files…");
    const synced = await syncStorage(config.supabaseStorage, {
      client: storageFiles.s3,
      bucket: storageFiles.bucket,
      base: storageFiles.base, // syncStorage 内部会加 /storage/<bucket>/<key>
    });
    // v2 bucket 属性采集,通道 = 已有的只读库连接(per-file 元数据已随 GetObject
    // 响应在 syncStorage 内原子捕获)。失败只降级不报错:storage schema 读不到
    // (如收紧的 backup_reader 角色)时,manifest 缺 buckets 字段,恢复端把缺失
    // 如实标 not captured(PRD §5.1.3)。
    let bucketAttrs: BucketAttrs[] | undefined;
    try {
      bucketAttrs = await inspectBucketAttrs(config.databaseUrl, synced.buckets);
    } catch (error) {
      log.warn(
        `Bucket attributes not captured (${(error as Error).message}); ` +
          `this manifest will record them as absent — restore will say so instead of guessing.`
      );
    }
    storageResult = {
      ...(bucketAttrs ? { buckets: bucketAttrs } : {}),
      fileCount: synced.fileCount,
      totalBytes: synced.totalBytes,
      files: synced.files,
    };
    log.ok(
      `Storage synced (${synced.fileCount} files, ` +
        `${(synced.totalBytes / 1024 / 1024).toFixed(1)} MB)`
    );
  }

  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: "backupdrill-cli",
    toolVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    projectName: config.projectName,
    ...(sourceProjectRef ? { sourceProjectRef } : {}),
    database: {
      serverVersion: db.serverVersion,
      pgDumpVersion: pgd.raw,
      schemas: config.schemas,
      tableCount: db.tables.length,
      estimatedRowTotal: db.tables.reduce((n, t) => n + t.estimatedRows, 0),
      tables: db.tables,
      extensions: db.extensions,
      grants,
    },
    dump: { key: dumpKey, format: "custom", bytes, sha256 },
    // 关闭时不写这个字段:manifest 与之前逐字节一致
    ...(auth ? { auth } : {}),
    storage: storageResult,
  };

  // RECOVERY.md(PRD §5.9.2.1)先于 manifest 落桶:manifest 是快照的"完成标记"
  // (演练/恢复按它找快照)——先写手册再写标记,"快照完成"就蕴含"手册在场";
  // 手册写失败 = 备份失败(同桶同权限,与 manifest 自身的写入风险一致)。
  await writer.writeRecoveryDoc(manifest);
  log.ok(`Recovery runbook written → ${writer.describe("RECOVERY.md")}`);

  await writer.writeManifest(manifest);
  log.ok(`Manifest written → ${writer.describe("manifest.json")}`);

  return manifest;
}
