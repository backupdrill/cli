import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { S3Client } from "@aws-sdk/client-s3";
import type { BackupConfig } from "./config.js";
import { parseManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import {
  targetClient,
  resolveSnapshot,
  getObjectText,
  downloadToFile,
  hashObject,
} from "./snapshots.js";
import {
  SANDBOX_MANAGED_ERROR,
  classifyBlocks,
  finalizePass,
  installExtensions,
  restoreDatabaseArtifact,
} from "./restore-engine.js";
import { pgConnectOptions } from "./supabase-ca.js";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

// Storage 校验默认抽样上限(避免每次演练重下全部文件产生大量 egress);超限如实记录
const STORAGE_SAMPLE_CAP = 100;

/**
 * 无放回随机抽样:部分 Fisher-Yates,只洗出前 n 位(O(n) 次交换,不必全 shuffle)。
 * 此前恒取 manifest 顺序的前 CAP 个 → 超过 CAP 的项目里排序靠后的文件永远不被校验;
 * 随机抽样让每次演练覆盖不同子集,损坏的文件长期必然被抽中。
 * 随机源用 Math.random 足够:演练是一次性进程,无可复现性要求——校验失败的文件名
 * 会原样列进报告,定位问题不依赖重放同一批样本。
 */
export function sampleStorageFiles<T>(files: T[], n: number): T[] {
  if (files.length <= n) return files;
  const pool = [...files];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export interface DrillCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface DrillReport {
  snapshot: string;
  pass: boolean;
  checks: DrillCheck[];
  restoreSeconds: number;
  restoredTableCount: number;
  restoredRowTotal: number;
  /** --keep 且演练失败时:被保留的沙箱(供排查/脚本消费);其余情况不存在 */
  keptSandbox?: { containerId: string; connString: string };
}

// ── 临时 Postgres 容器编排 ──────────────────────────────────────────

interface Ephemeral {
  containerId: string;
  port: string;
  connString: string;
}

/**
 * 沙箱镜像选择:alpine 镜像只带 contrib 扩展,装不了 pgvector——含 vector 列的
 * 备份在裸镜像里恢复必然硬崩("type vector does not exist")。manifest 记录了
 * vector 时换用 pgvector 官方镜像(同 major),其余维持轻量 alpine。
 */
function sandboxImage(manifest: Manifest): string {
  const major = parseInt(manifest.database.serverVersion, 10);
  const hasVector = (manifest.database.extensions ?? []).some((e) => e.name === "vector");
  return hasVector ? `pgvector/pgvector:pg${major}` : `postgres:${major}-alpine`;
}

async function startEphemeralPostgres(image: string): Promise<Ephemeral> {
  log.step(`Starting ephemeral ${image}…`);
  const { stdout } = await execFileAsync("docker", [
    "run",
    "-d",
    "--rm",
    "-e",
    "POSTGRES_PASSWORD=drill",
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    "127.0.0.1:0:5432", // 随机主机端口,避免撞端口
    image,
  ]);
  const containerId = stdout.trim();

  try {
    const portOut = await execFileAsync("docker", [
      "port",
      containerId,
      "5432/tcp",
    ]);
    // 形如 "127.0.0.1:54321"
    const port = portOut.stdout.trim().split(":").pop()!.trim();
    const connString = `postgresql://postgres:drill@127.0.0.1:${port}/postgres`;

    // 等就绪(容器内 pg_isready),最多 ~30s。
    // 必须 -h 127.0.0.1 强制走 TCP:官方镜像 initdb 阶段先起一个只听 unix socket 的临时
    // 服务跑初始化,默认(socket)检查在该阶段就通过,pg_restore 随后连 TCP 正撞上
    // 临时服务停止/正式服务重启的窗口 → "server closed the connection unexpectedly"。
    // 阶段一不听 TCP,所以 TCP 检查首次通过 = 正式服务已就绪。
    for (let i = 0; i < 60; i++) {
      try {
        await execFileAsync("docker", [
          "exec",
          containerId,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
          "-q",
        ]);
        return { containerId, port, connString };
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error("ephemeral Postgres did not become ready within 30s");
  } catch (error) {
    await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => {});
    throw error;
  }
}

// installExtensions 已上移到统一引擎(restore-engine.ts):沙箱与真实恢复共用,
// 唯一差异是调用方对"装不上"的裁决——沙箱记录后继续,真实目标阻断。

/** post-data 第二遍恢复的结果:用户对象失败 vs Supabase 托管对象的沙箱预期跳过。 */
interface PostDataResult {
  supabaseSkipped: number;
  failures: string[];
}

// 只有这些特征说明恢复失败源于沙箱缺扩展(限定类型/schema 解析不到、扩展装不上)。
// 真实 Supabase 项目的 manifest 几乎必然含沙箱装不上的托管扩展(pg_graphql 等),
// 若不按特征过滤,任何硬失败(归档损坏、OOM…)都会被误归因到沙箱。
const MISSING_EXTENSION_ERROR =
  /type "[^"]+" does not exist|schema "[^"]+" does not exist|extension "[^"]+" is not available/i;

/** 兼容层:历史签名保留,分类逻辑的单一权威在统一引擎(restore-engine.ts)。 */
export function classifyPostDataErrors(stderr: string): PostDataResult {
  const classified = classifyBlocks(stderr, SANDBOX_MANAGED_ERROR);
  return { supabaseSkipped: classified.expectedSkips, failures: classified.failures };
}

/** 兼容层:见 restore-engine.ts finalizePass(非零退出且零错误块 = 通用失败)。 */
export function postDataResult(code: number | null, stderr: string): PostDataResult {
  const classified = finalizePass(code, stderr, classifyBlocks(stderr, SANDBOX_MANAGED_ERROR));
  return { supabaseSkipped: classified.expectedSkips, failures: classified.failures };
}

/**
 * 沙箱恢复 = 统一引擎(target: "sandbox")。pre-data 失败按硬失败抛出——数据回不来
 * = 演练失败,且错误文本要供缺扩展归因(MISSING_EXTENSION_ERROR)使用;post-data
 * 的托管对象跳过如实返回。pre-data 的 schema 冲突跳过(dump 自带 CREATE SCHEMA,
 * 容器恒有 public)是非事件,不计入报告。
 */
async function pgRestore(dumpPath: string, connString: string): Promise<PostDataResult> {
  const result = await restoreDatabaseArtifact({ dumpPath, connString, target: "sandbox" });
  if (result.preData.failures.length) {
    throw new Error(`pg_restore failed: ${result.preData.failures.join(" | ")}`);
  }
  return {
    supabaseSkipped: result.postData.expectedSkips,
    failures: result.postData.failures,
  };
}

// ── 校验 ────────────────────────────────────────────────────────────

/** 导出:真实恢复(restore.ts)复用同一套表级验证——两条路径对同一快照必须同一结论。 */
export async function verifyRestored(
  connString: string,
  manifest: Manifest
): Promise<{ checks: DrillCheck[]; tableCount: number; rowTotal: number }> {
  // pgConnectOptions:真实 Supabase 目标(restore 复用本函数)需要打包根 CA;
  // 沙箱的 docker 连接串非 Supabase 主机,原样透传,行为不变
  const client = new Client(pgConnectOptions(connString));
  await client.connect();
  try {
    const schemas = manifest.database.schemas;
    // 口径必须与 manifest 统计端(backup.ts inspectDatabase)完全一致:
    // pg_class relkind in ('r','p','m')。此前这里用 pg_tables(不含 matview),
    // manifest 用 pg_stat_user_tables(含 matview)——任何有 matview 的库
    // 演练必然误报"表数不符 + 缺表"。
    const tablesRes = await client.query<{
      schema: string;
      name: string;
      kind: string;
      populated: boolean;
    }>(
      `select n.nspname as schema, c.relname as name,
              c.relkind as kind, c.relispopulated as populated
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'm')
          and n.nspname = any($1::text[])
        order by 1, 2`,
      [schemas]
    );
    const restoredTables = tablesRes.rows;

    // 逐表精确计数(演练要证明数据真回来了,估算值不够)
    const counts = new Map<string, number>();
    const unpopulatedMatviews = new Set<string>();
    let rowTotal = 0;
    for (const t of restoredTables) {
      const key = `${t.schema}.${t.name}`;
      // 未填充的 matview 无法 count(*)(Postgres 直接报错)。它要么备份时就没数据
      // (dump 里本来就没有 REFRESH),要么 REFRESH 在 post-data 阶段失败——后者已由
      // post-data 检查如实记录,这里按 0 行处理即可。
      if (t.kind === "m" && !t.populated) {
        counts.set(key, 0);
        unpopulatedMatviews.add(key);
        continue;
      }
      const c = await client.query<{ n: string }>(
        `select count(*)::bigint as n from "${t.schema}"."${t.name}"`
      );
      const n = Number(c.rows[0].n);
      counts.set(key, n);
      // 分区父表的 count(*) 是子分区行的总和,子分区又各自计一次;
      // rowTotal 只累计叶子关系,避免翻倍。
      if (t.kind !== "p") rowTotal += n;
    }

    const checks: DrillCheck[] = [];

    // 1. 表数量一致
    checks.push({
      name: "table count",
      pass: restoredTables.length === manifest.database.tableCount,
      detail: `restored ${restoredTables.length}, manifest ${manifest.database.tableCount}`,
    });

    // 2. manifest 里的每张表都还原出来了
    const restoredSet = new Set(counts.keys());
    const missing = manifest.database.tables.filter(
      (t) => !restoredSet.has(`${t.schema}.${t.name}`)
    );
    checks.push({
      name: "no missing tables",
      pass: missing.length === 0,
      detail:
        missing.length === 0
          ? "all manifest tables present"
          : `missing: ${missing.map((t) => `${t.schema}.${t.name}`).join(", ")}`,
    });

    // 3. 备份时有数据的表,还原后不能是空的(最阴险的"备了半个库"故障)。
    // 未填充的 matview 豁免:REFRESH 失败已由 post-data 检查裁决(用户对象失败
    // = 演练失败,Supabase 托管依赖 = 预期跳过),这里再报一次会把环境预期
    // 误标成备份损坏。
    const emptied = manifest.database.tables.filter(
      (t) =>
        t.estimatedRows > 0 &&
        !unpopulatedMatviews.has(`${t.schema}.${t.name}`) &&
        (counts.get(`${t.schema}.${t.name}`) ?? 0) === 0
    );
    checks.push({
      name: "populated tables came back",
      pass: emptied.length === 0,
      detail:
        emptied.length === 0
          ? "no populated table restored empty"
          : `restored empty despite manifest rows: ${emptied
              .map((t) => `${t.schema}.${t.name}`)
              .join(", ")}`,
    });

    return { checks, tableCount: restoredTables.length, rowTotal };
  } finally {
    await client.end();
  }
}

/**
 * Storage 完整性校验:从备份桶重新读回文件、比对 manifest 里记录的 sha256,
 * 证明备份的文件副本真实存在且未损坏。文件多时抽样(默认上限),避免大量 egress。
 */
async function verifyStorage(
  s3: S3Client,
  config: BackupConfig,
  manifest: Manifest,
  verifyAll: boolean
): Promise<DrillCheck> {
  const files = manifest.storage!.files;
  const sample = verifyAll ? files : sampleStorageFiles(files, STORAGE_SAMPLE_CAP);
  // 备份写入时的键:<snapshot base>/storage/<bucket>/<key>,base 从 dump.key 反推
  const base = manifest.dump.key.replace(/\/dump\.pgcustom$/, "");
  const mismatches: string[] = [];
  for (const f of sample) {
    const objectKey = `${base}/storage/${f.bucket}/${f.key}`;
    try {
      const { sha256 } = await hashObject(s3, config.storage.bucket, objectKey);
      if (sha256 !== f.sha256) mismatches.push(`${f.bucket}/${f.key}`);
    } catch {
      mismatches.push(`${f.bucket}/${f.key} (unreadable)`);
    }
  }
  // 抽样时如实说明这是随机样本(N of M);全量(--verify-all-files 或文件数 ≤ 上限)说 all
  const scope =
    sample.length === files.length
      ? `all ${files.length} files`
      : `random sample of ${sample.length} of ${files.length} files`;
  return {
    name: "storage file integrity",
    pass: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? `${scope} match their manifest checksums`
        : `${mismatches.length} failed in ${scope}: ${mismatches.slice(0, 5).join(", ")}`,
  };
}

// ── 应用自检钩子(语义层)────────────────────────────────────────────

// 挂死的 smoke test 不能永远挡住沙箱销毁;10 分钟对"冒烟"级检查绰绰有余
export const APP_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 语义层钩子:结构检查全绿后、销毁沙箱前,把沙箱连接串经 BACKUPDRILL_SANDBOX_URL
 * 交给用户命令执行,校验数据/业务不变量(判据只存在于应用侧,引擎不解释命令输出,
 * 只裁决退出码:0 = pass)。注意这不是 RLS 行为测试:连接身份是沙箱超级用户
 * (绕过 RLS),且引用 Supabase 托管角色的策略在恢复时已被归类跳过。
 * 子进程输出定向到 stderr:stdout 是 CLI 的机器可读 JSON 通道,不能被污染。
 * 红线:托管 worker 绝不能把用户输入传到这里(任意代码执行);此钩子只属于
 * 用户在自己机器上运行的 CLI(见 PRD §1.4 演练后应用自检钩子)。
 */
export function runAppCheck(
  command: string,
  connString: string,
  timeoutMs = APP_CHECK_TIMEOUT_MS
): Promise<DrillCheck> {
  const started = Date.now();
  return new Promise((resolve) => {
    const proc = spawn(command, {
      shell: true,
      stdio: ["ignore", 2, 2],
      env: { ...process.env, BACKUPDRILL_SANDBOX_URL: connString },
      // 独立进程组:超时必须杀整棵进程树。只杀 shell 的话,npm/测试运行器这类
      // 孙进程会在沙箱销毁后继续跑(xreview 抓出的资源泄漏)。
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid!, "SIGKILL"); // 负 pid = 杀整个进程组
      } catch {
        proc.kill("SIGKILL");
      }
    }, timeoutMs);
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        name: "app checks",
        pass: false,
        detail: `command failed to start: ${error.message}`,
      });
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      if (timedOut) {
        resolve({
          name: "app checks",
          pass: false,
          detail: `timed out after ${timeoutMs / 1000}s — process tree killed`,
        });
        return;
      }
      if (signal) {
        resolve({
          name: "app checks",
          pass: false,
          detail: `terminated by ${signal} after ${seconds}s`,
        });
        return;
      }
      resolve({
        name: "app checks",
        pass: code === 0,
        detail:
          code === 0
            ? `command exited 0 in ${seconds}s`
            : `command exited ${code} after ${seconds}s`,
      });
    });
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────

/**
 * 演练核心:把一份本地 dump 恢复进临时 Postgres 并对照 manifest 校验,然后销毁容器。
 * 与 S3 解耦,便于离线测试。`preChecks` 用于把下载阶段的校验(如归档校验和)带进报告。
 */
export async function drillDump(
  dumpPath: string,
  manifest: Manifest,
  snapshot: string,
  preChecks: DrillCheck[] = [],
  opts: { appCheckCommand?: string; keepSandboxOnFailure?: boolean } = {}
): Promise<DrillReport> {
  // 空/纯空白命令 = 危险的假配置(CI 里变量没展开的典型形态):跑了会以 exit 0
  // 假通过,忽略会让用户以为检查在跑。拒绝,且要在起沙箱之前拒绝。
  const appCheckCommand = opts.appCheckCommand?.trim();
  if (opts.appCheckCommand !== undefined && !appCheckCommand) {
    throw new Error(
      "--check-cmd is empty (did an env var fail to expand?) — refusing to report a check that would never run"
    );
  }

  const checks: DrillCheck[] = [...preChecks];
  const pg = await startEphemeralPostgres(sandboxImage(manifest));
  let pass = false; // 异常路径视为失败,供 finally 决定 --keep 是否保留沙箱
  try {
    // 旧 manifest(≤0.1.1)没有 extensions 字段 → 不装任何扩展,行为与从前一致
    const extensions = manifest.database.extensions ?? [];
    const unavailable = await installExtensions(pg.connString, extensions);
    if (extensions.length) {
      // 装不上 ≠ 演练失败:扩展本体不在 public 转储里,没丢任何已备份的数据;
      // 若恢复真的需要它,下面的 pgRestore 会失败并给出分类错误
      checks.push({
        name: "sandbox extensions",
        pass: true,
        detail: unavailable.length
          ? `installed ${extensions.length - unavailable.length}/${extensions.length}; ` +
            `sandbox image cannot install: ${unavailable.join(", ")}`
          : `installed ${extensions.map((e) => e.name).join(", ")}`,
      });
    }

    const started = Date.now();
    log.step("Restoring into ephemeral Postgres…");
    let postData: PostDataResult;
    try {
      postData = await pgRestore(dumpPath, pg.connString);
    } catch (error) {
      // 沙箱装不上扩展 + 错误特征命中"缺类型/schema/扩展" → 假设式归因到沙箱环境
      // (不对备份健康下断言);其余失败与扩展无关,必须原样抛出
      const message = (error as Error).message;
      if (unavailable.length && MISSING_EXTENSION_ERROR.test(message)) {
        throw new Error(
          `restore failed; likely because the drill sandbox cannot install ` +
            `extension(s) ${unavailable.join(", ")}. Original error: ${message}`
        );
      }
      throw error;
    }
    const restoreSeconds = Math.round((Date.now() - started) / 100) / 10;
    checks.push({ name: "pg_restore", pass: true, detail: `completed in ${restoreSeconds}s` });
    // 用户自己的 post-data 对象(索引/约束/触发器)必须全部恢复;Supabase 托管对象
    // 的沙箱预期跳过如实写进报告(演练不假装它们恢复了)。
    checks.push({
      name: "post-data objects",
      pass: postData.failures.length === 0,
      detail:
        postData.failures.length > 0
          ? `${postData.failures.length} failed: ${postData.failures[0]}`
          : postData.supabaseSkipped > 0
            ? `user objects restored; ${postData.supabaseSkipped} Supabase-managed object(s) skipped (auth schema/roles do not exist in the drill sandbox)`
            : "all post-data objects restored",
    });

    const verify = await verifyRestored(pg.connString, manifest);
    checks.push(...verify.checks);

    // 语义层钩子:只在结构层全绿时才跑——结构已失败时再跑应用检查,只会把
    // 一次失败报成两层失败,误导排查方向。没配置则不跑、报告里不出现该行。
    if (appCheckCommand && checks.every((c) => c.pass)) {
      log.step("Running app checks…");
      checks.push(await runAppCheck(appCheckCommand, pg.connString));
    }

    pass = checks.every((c) => c.pass);
    const report: DrillReport = {
      snapshot,
      pass,
      checks,
      restoreSeconds,
      restoredTableCount: verify.tableCount,
      restoredRowTotal: verify.rowTotal,
    };
    if (opts.keepSandboxOnFailure && !pass) {
      // 写进报告让 --keep 可被脚本消费(拿连接串排查),不只靠人眼看日志
      report.keptSandbox = { containerId: pg.containerId, connString: pg.connString };
    }
    return report;
  } catch (error) {
    // 异常路径(恢复/校验抛出)没有报告对象可挂 keptSandbox;把沙箱坐标并入
    // 错误信息,让脚本和人都拿得到被保留容器的清理线索
    if (opts.keepSandboxOnFailure) {
      (error as Error).message +=
        ` [sandbox kept: ${pg.connString} — remove with: docker rm -f ${pg.containerId.slice(0, 12)}]`;
    }
    throw error;
  } finally {
    if (opts.keepSandboxOnFailure && !pass) {
      // --rm 容器不 docker rm 就一直活着;用户排查完 stop/rm 时 --rm 自动清理
      log.warn(
        `--keep: sandbox left running for inspection — ${pg.connString} ` +
          `(remove with: docker rm -f ${pg.containerId.slice(0, 12)})`
      );
    } else {
      log.step("Tearing down ephemeral Postgres…");
      await execFileAsync("docker", ["rm", "-f", pg.containerId]).catch(() => {});
    }
  }
}

/** 演练一份快照:从桶里下载→drillDump(含 Storage 校验)→报告。 */
export async function runDrill(
  config: BackupConfig,
  opts: {
    snapshot?: string;
    verifyAllFiles?: boolean;
    /** CLI 专用。红线:托管 worker 绝不能传入(在 worker 上执行用户命令 = RCE)。 */
    appCheckCommand?: string;
    keepSandboxOnFailure?: boolean;
  } = {}
): Promise<DrillReport> {
  const s3 = targetClient(config);
  const snapshotPrefix = await resolveSnapshot(s3, config, opts.snapshot);
  const snapshot = snapshotPrefix.replace(/\/$/, "").split("/").pop()!;
  log.step(`Drilling snapshot ${snapshot}`);

  const manifest = parseManifest(
    await getObjectText(s3, config.storage.bucket, `${snapshotPrefix}manifest.json`)
  );

  const workdir = await mkdtemp(join(tmpdir(), "backupdrill-"));
  const dumpPath = join(workdir, "dump.pgcustom");
  try {
    log.step("Downloading dump…");
    const { sha256: sha } = await downloadToFile(
      s3,
      config.storage.bucket,
      manifest.dump.key,
      dumpPath
    );
    const integrityPass = sha === manifest.dump.sha256;
    const preChecks: DrillCheck[] = [
      {
        name: "archive integrity",
        pass: integrityPass,
        detail: integrityPass
          ? `sha256 matches (${sha.slice(0, 12)}…)`
          : `sha256 MISMATCH — got ${sha.slice(0, 12)}…, manifest ${manifest.dump.sha256.slice(0, 12)}…`,
      },
    ];
    // 归档校验和不符 = 演练已经 FAIL,继续恢复只会产生误导性失败;短路如实报告
    if (!integrityPass) {
      return {
        snapshot,
        pass: false,
        checks: preChecks,
        restoreSeconds: 0,
        restoredTableCount: 0,
        restoredRowTotal: 0,
      };
    }

    // Storage 文件完整性(备份含 Storage 时才校验)
    if (manifest.storage && manifest.storage.files.length) {
      log.step("Verifying Storage files…");
      preChecks.push(
        await verifyStorage(s3, config, manifest, opts.verifyAllFiles ?? false)
      );
    }

    return await drillDump(dumpPath, manifest, snapshot, preChecks, {
      appCheckCommand: opts.appCheckCommand,
      keepSandboxOnFailure: opts.keepSandboxOnFailure,
    });
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
