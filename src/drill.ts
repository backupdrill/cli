import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BackupConfig } from "./config.js";
import { parseManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import { hashObject } from "./snapshots.js";
import { s3SnapshotStore, type SnapshotStore, type StorageFilesLocation } from "./snapshot-store.js";
import {
  SANDBOX_MANAGED_ERROR,
  classifyBlocks,
  finalizePass,
  installExtensions,
  quoteIdent,
  restoreDatabaseArtifact,
  installSandboxShim,
  tableDataInDump,
  countRowsInDump,
} from "./restore-engine.js";
import { connectPg } from "./supabase-ca.js";
import { orphanedForeignKeysCheck, tableKey, type OrphanedForeignKey } from "./orphaned-foreign-keys.js";
import { grantsCheck, type GrantRestore, type GrantedObject } from "./grants.js";
import { localPgRestoreMajor, restoreToolBreaksOnTarget, sandboxMajorFor } from "./pgbin.js";
import { log } from "./log.js";
import { authDrillSection, type AuthDrillReport, type AuthDumpForDrill, type OfflineSandbox } from "./auth-drill.js";
import { onInterrupt, stopOnInterrupt, throwIfInterrupted } from "./interrupt.js";

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

/** @internal 托管 worker 专用钩子;事件不携带客户数据或凭据,不属于稳定 CLI 契约。 */
export type DrillPhase = "download" | "storage" | "sandbox" | "restore" | "verify" | "auth" | "cleanup";
export interface DrillSupervision {
  /** 仅 runDrill 使用:supervisor 独占的空临时目录,由 supervisor 清理。 */
  workdir: string;
  /** 每次尝试唯一;即使 docker run 被中断,supervisor 也能按名字清理。 */
  resourceName: string;
  /** 非 cleanup、非 auth 阶段抛错 = 主动中止并清理;上报失败应由调用方自行吞掉,回调须自带超时(托管 worker 另有进程级执行上限)。
   * cleanup 阶段同步/异步错误均忽略,最多等待 5 秒,绝不阻止 teardown。auth 阶段抛错只跳过 Auth 附加检查。 */
  observe: (event: { phase: DrillPhase; dumpBytes?: number }) => Promise<void>;
  /**
   * 2.10.0 起:supervisor 叫停 Auth 附加检查(比如磁盘吃紧)。这一节记 not_checked,演练结论不变——
   * 结论在 Auth 这一节之前就定了。"auth" 阶段的 observe 被拒绝同样只跳过这一节,不中止演练
   */
  authStop?: AbortSignal;
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
  /** inspect(2.11.1 起):进沙箱的 docker exec 命令 */
  keptSandbox?: { containerId: string; connString: string; inspect?: string };
  /** 源库自带孤儿行的外键:演练和真实恢复都把它们建成 NOT VALID,不算失败。没有时不出现 */
  orphanedForeignKeys?: OrphanedForeignKey[];
  /**
   * 2.10.0 起,快照带 Auth 用户时的附加校验(见 auth-drill.ts)。**不参与 pass 的判定**;
   * 快照不带 Auth 时不出现
   */
  auth?: AuthDrillReport;
}

// ── 临时 Postgres 容器编排 ──────────────────────────────────────────

interface Ephemeral {
  containerId: string;
  port: string;
  connString: string;
  /** 2.11.1:模拟注册之前把沙箱断了网(确认摘掉之后才记,之后不再接回),connString 从此连不上 */
  offline: boolean;
  /** pg_restore 并行路数,随调参一起按 Docker 的内存和 CPU 定(见 sandboxTuning) */
  restoreJobs: number;
  /** 删容器和数据卷;幂等,正常收尾和中断收尾共用 */
  teardown: () => Promise<void>;
  /** 注销中断清理(见 interrupt.ts);沙箱销毁或按 --keep 保留之后调用 */
  forgetInterruptCleanup: () => void;
}

/**
 * 沙箱镜像选择:alpine 镜像只带 contrib 扩展,装不了 pgvector——含 vector 列的
 * 备份在裸镜像里恢复必然硬崩("type vector does not exist")。manifest 记录了
 * vector 时换用 pgvector 官方镜像(同 major),其余维持轻量 alpine。major 由调用方给出
 * (sandboxMajorFor:源库与本机 pg_restore 取大者),不一定等于源库版本。
 */
function sandboxImage(manifest: Manifest, major: number): string {
  const hasVector = (manifest.database.extensions ?? []).some((e) => e.name === "vector");
  return hasVector ? `pgvector/pgvector:pg${major}` : `postgres:${major}-alpine`;
}

/**
 * 沙箱 Postgres 的调参(2026-09-12):沙箱一次性、跑完即毁,生产库绝不能开的选项这里全开。
 * 触因:105 表 / 12 GB dump 的演练跑了 2 小时,COPY 与建索引都在等 fsync、写整页 WAL、
 * 64 MB 的排序内存反复溢磁盘。关掉持久性保证不影响演练结论(我们验证的是"能不能恢复出来",
 * 不是"断电后还在不在"),但 COPY / 建索引通常快 2-5 倍,临时盘也少吃一半。
 * wal_level=minimal 要求 max_wal_senders=0。
 *
 * 内存相关的两项按**Docker 引擎能用的内存**推导,不写死:同一份 CLI 既跑在 8 GB 的 worker 上,
 * 也跑在用户自己的笔记本上。比例取 Postgres 官方的经验值(shared_buffers 1/4、
 * maintenance_work_mem 1/8),再夹在 [下限, 上限] 之间——下限保证 2 GB 小机器不比调参前差,
 * 上限是因为超过 2 GB 的 shared_buffers 对一次性恢复没有边际收益,白占主机内存。
 *
 * 为什么问 Docker 而不是 os.totalmem():Mac / Windows 上的 Docker Desktop 跑在一台内存独立
 * 配置的虚拟机里,宿主机 32 GB、虚拟机可能只有 2 GB;按宿主机算会把沙箱 Postgres 直接 OOM,
 * 一份好备份被误判成演练失败(交叉审查 2026-09-12 用 1 GiB 限额复现)。`docker info` 的
 * MemTotal 在 Linux 上就是宿主机内存,在 Docker Desktop 上是虚拟机内存,两边都是真正的预算。
 */
const MIB = 1024 * 1024;
function clampMib(bytes: number, minMib: number, maxMib: number): number {
  return Math.min(maxMib, Math.max(minMib, Math.floor(bytes / MIB)));
}

export interface SandboxTuning {
  settings: string[];
  /** docker --shm-size 的值;并行建索引走动态共享内存,要跟 maintenance_work_mem 一起长 */
  shmSize: string;
  /** pg_restore --jobs;1 = 单连接 */
  restoreJobs: number;
}

/** Docker 引擎可用内存(字节)和 CPU 数;问不到就返回 0,让 sandboxTuning 落到下限值、单连接,宁慢勿炸。 */
async function dockerResources(): Promise<{ memoryBytes: number; cpus: number }> {
  try {
    // 探测是可选的,绝不能卡住演练:守护进程假死时 5 秒后放弃,落到下限值继续跑
    const { stdout } = await execFileAsync("docker", ["info", "--format", "{{.MemTotal}} {{.NCPU}}"], {
      timeout: 5_000,
    });
    const [memoryBytes, cpus] = stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
    const positive = (value: number | undefined) => (value !== undefined && Number.isFinite(value) && value > 0 ? value : 0);
    return { memoryBytes: positive(memoryBytes), cpus: positive(cpus) };
  } catch {
    return { memoryBytes: 0, cpus: 0 };
  }
}

export function sandboxTuning(totalMemBytes: number, cpus = 1): SandboxTuning {
  const budgetMib = Math.floor(totalMemBytes / MIB);
  const sharedBuffersMib = clampMib(totalMemBytes / 4, 256, 2048);
  const maintenanceWorkMemMib = clampMib(totalMemBytes / 8, 256, 1024);
  // 并行恢复时每一路都可能同时在建索引,各自吃满 maintenance_work_mem:路数 × maintenance_work_mem
  // 加上 shared_buffers 不超过预算的一半,另一半留给 pg_restore、Docker 和同机的其他任务
  // (8 GB 的 worker 正好 2 路,2026-10-17 在它上面实测 -j2 没出内存问题)。
  // 再封顶 4 路:pg_restore 的并行度受表和索引个数限制,再多收益很小,演练还常跑在用户自己的电脑上。
  const memoryBoundJobs = Math.floor((budgetMib / 2 - sharedBuffersMib) / maintenanceWorkMemMib);
  const restoreJobs = Math.max(1, Math.min(cpus, memoryBoundJobs, 4));
  return {
    settings: [
      "fsync=off",
      "synchronous_commit=off",
      "full_page_writes=off",
      "wal_level=minimal",
      "max_wal_senders=0",
      `maintenance_work_mem=${maintenanceWorkMemMib}MB`,
      "max_wal_size=4GB",
      "checkpoint_timeout=30min",
      `shared_buffers=${sharedBuffersMib}MB`,
    ],
    // Docker 默认 /dev/shm 只有 64 MB;并行建索引(pgvector 的 HNSW 尤其)走动态共享内存,
    // 64 MB 会撞 "No space left on device" 把好备份误判失败(交叉审查 2026-09-12 复现)。
    // 每一路并行恢复给 maintenance_work_mem 的两倍、至少 1 GB;tmpfs 只按实际用量占内存,给大不吃亏。
    shmSize: `${Math.max(1024, maintenanceWorkMemMib * 2 * restoreJobs)}m`,
    restoreJobs,
  };
}

function validateSupervision(supervision?: DrillSupervision, appCheckCommand?: string, keepSandboxOnFailure?: boolean): void {
  if (supervision && (appCheckCommand !== undefined || keepSandboxOnFailure)) {
    throw new Error("Supervised drills cannot execute app commands or keep sandboxes");
  }
  if (supervision && !/^bd-drill-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(supervision.resourceName)) {
    throw new Error("Invalid supervised drill resource name");
  }
}

async function observeCleanup(supervision?: DrillSupervision): Promise<void> {
  if (!supervision) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => supervision.observe({ phase: "cleanup" })),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); }),
    ]);
  } catch { /* 清理的优先级高于监控,同步抛错也不能挡住 teardown。 */ }
  finally { if (timer) clearTimeout(timer); }
}

export function sandboxDataVolumeTarget(major: number): string {
  // PG18 将镜像的 VOLUME 上移一层;挂错路径会额外生成无法按名字回收的匿名卷。
  return major >= 18 ? "/var/lib/postgresql" : "/var/lib/postgresql/data";
}

/**
 * 沙箱镜像先单独拉好。让 docker run 自己拉的话,拉取和建容器在同一个命令里:中断落在拉取中途,
 * 停掉命令也说不准守护进程之后还会不会把容器建出来(交叉审查)。拆开之后,慢的那一步(第一次拉镜像
 * 可能好几分钟)什么都不建,中断时直接停掉;docker run 只剩建容器和启动。
 */
/**
 * 本地已有镜像也要每次 pull:标签(postgres:17-alpine)跟着小版本走,只拉一次就会永远停在当时的小版本。
 * 2026-11-24 事故:worker 上的沙箱停在 17.10,源库被 Supabase 升到带 CVE-2026-6460 补丁的新小版本,
 * 旧 pg_dump 导出的 `ALTER COLUMN ... SET (pg_attver=…)` 在 17.10 上报 unrecognized parameter,
 * 整个演练失败;17.12 会接受并忽略这句。镜像没变时 pull 只比一次清单,很快。
 * 已有缓存时刷新失败(断网、仓库限流、超时)不算演练失败:退回本地镜像并提示。
 *
 * 收尾不等 stdio 关闭:docker 拉起的凭据助手可能还占着 stderr(交叉审查用卡住的助手复现)。
 * 只等 docker 本身退出,到点就 SIGKILL 它,然后把我们这头的管道关掉,CLI 才能照常退出。
 * pull 留在演练所在的进程组里(不 detach):worker 叫停演练时按组结束,连助手一起带走。
 */
// 测试用的环境变量只为把 5 分钟缩短到几秒;不对用户公开
const IMAGE_REFRESH_TIMEOUT_MS = Number(process.env.BACKUPDRILL_TEST_IMAGE_REFRESH_TIMEOUT_MS) || 5 * 60_000;

async function ensureImage(image: string): Promise<void> {
  const present = await execFileAsync("docker", ["image", "inspect", "--format", "{{.Id}}", image]).then(
    () => true,
    () => false
  );
  throwIfInterrupted();
  log.step(present ? `Checking ${image} for updates…` : `Pulling ${image}…`);
  const pull = spawn("docker", ["pull", "--quiet", image], { stdio: ["ignore", "ignore", "pipe"] });
  const forget = stopOnInterrupt(pull);
  let stderr = "";
  pull.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  let timer: NodeJS.Timeout | undefined;
  const outcome = await new Promise<"ok" | "failed" | "timeout">((resolve) => {
    pull.on("error", (error) => {
      stderr ||= error.message;
      resolve("failed");
    });
    pull.on("exit", (code) => resolve(code === 0 ? "ok" : "failed"));
    if (present) timer = setTimeout(() => resolve("timeout"), IMAGE_REFRESH_TIMEOUT_MS);
  });
  clearTimeout(timer);
  if (outcome === "timeout") pull.kill("SIGKILL");
  pull.stderr?.destroy();
  forget();
  throwIfInterrupted();
  if (outcome === "ok") return;
  const reason =
    outcome === "timeout"
      ? `no answer within ${Math.round(IMAGE_REFRESH_TIMEOUT_MS / 1000)}s`
      : stderr.split("\n").map((line) => line.trim()).find(Boolean) ?? "docker pull failed";
  if (!present) throw new Error(`could not pull ${image}: ${reason}`);
  log.warn(`Could not refresh ${image}; using the local copy (${reason})`);
}

async function startEphemeralPostgres(image: string, major: number, resourceName?: string): Promise<Ephemeral> {
  const dataVolumeTarget = sandboxDataVolumeTarget(major);
  if (resourceName) {
    const existing = await execFileAsync("docker", ["volume", "ls", "--format", "{{.Name}}", "--filter", `name=^${resourceName}$`], { timeout: 10_000 });
    if (existing.stdout.trim().split("\n").includes(resourceName)) {
      throw new Error("Supervised drill volume already exists; refusing to restore into a reused sandbox");
    }
  }
  log.step(`Starting ephemeral ${image}…`);
  const resources = await dockerResources();
  const tuning = sandboxTuning(resources.memoryBytes, resources.cpus);
  await ensureImage(image);
  // 名字先定好:Ctrl+C 可能落在 docker run 还没返回 ID 的时候,按名字才删得掉
  const name = resourceName ?? `backupdrill-drill-${randomBytes(6).toString("hex")}`;
  // 沙箱里是恢复出来的生产数据。端口只绑 127.0.0.1,但同机的其他系统账号照样连得上,
  // 固定密码等于没设:每个沙箱一个随机密码。只写 "-e POSTGRES_PASSWORD" 不带值,
  // docker 从它自己的环境变量取值,密码就不进 argv(ps 看得到 argv)
  const password = randomBytes(16).toString("hex");
  throwIfInterrupted();
  const started = execFileAsync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      ...(resourceName ? ["--mount", `type=volume,source=${resourceName},target=${dataVolumeTarget}`] : []),
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_DB=postgres",
      "-p",
      "127.0.0.1:0:5432", // 随机主机端口,避免撞端口
      // 拉镜像只在 ensureImage 里做(有超时、可中断);缓存恰好在刷新时被清掉的话,这里报错而不是悄悄再拉一次
      "--pull=never",
      `--shm-size=${tuning.shmSize}`,
      image,
      "postgres",
      ...tuning.settings.flatMap((kv) => ["-c", kv]),
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: password } }
  );
  // 删容器只有一份:正常收尾(drillDump 的 finally)和中断收尾(interrupt.ts)等的是同一个 promise。
  // 两边各发一次 docker rm 会撞上 "removal already in progress",后到的那个报删除失败,
  // 进程又在真正删完之前就退出了(信号测试抓到的竞争)。
  let volumeName: string | null = resourceName ?? null;
  let runSettled = false;
  started.then(
    () => (runSettled = true),
    () => (runSettled = true)
  );
  const removeByName = async () => {
    try {
      // -v 连匿名卷一起删:中断可能落在下面查卷名之前
      await execFileAsync("docker", ["rm", "-fv", name], { timeout: 60_000 });
    } catch (error) {
      if (!/No such container/i.test(String((error as { stderr?: string }).stderr ?? error))) {
        log.warn(`could not remove the drill sandbox; remove it with: docker rm -fv ${name}`);
      }
    }
  };
  let teardownRun: Promise<void> | null = null;
  const teardown = () =>
    (teardownRun ??= (async () => {
      if (!runSettled) {
        // 中断落在 docker run 还没返回的时候。镜像已经在本地(ensureImage),它只剩建容器和启动,
        // 等它落定再按名字删:中途停掉命令说不准守护进程会不会稍后把容器建出来(交叉审查复现)。
        // Docker 迟迟不回话就不等了,把容器名告诉用户
        let timer: NodeJS.Timeout | undefined;
        const settled = await Promise.race([
          started.then(() => true, () => true),
          new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), 20_000))),
        ]);
        clearTimeout(timer);
        if (!settled) {
          started.child?.kill("SIGKILL");
          log.warn(
            `docker run did not finish within 20s; if a container named ${name} shows up later, ` +
              `remove it with: docker rm -fv ${name}`
          );
        }
      }
      await removeByName();
      // 显式删卷(--rm 不可靠,见下);幂等,已经没了也不报错
      if (volumeName) await execFileAsync("docker", ["volume", "rm", "-f", volumeName]).catch(() => {});
    })());
  const forgetInterruptCleanup = onInterrupt(teardown);
  let stdout: string;
  try {
    ({ stdout } = await started);
  } catch (error) {
    forgetInterruptCleanup();
    throw error;
  }
  const containerId = stdout.trim();
  // postgres 镜像把数据目录声明成 VOLUME → 每次 run 都建一个匿名卷。生产实测 `--rm` **没有**把它
  // 带走(一次演练遗留 37.6 GB,三次失败把 59 GB 根盘灌满),所以记下卷名,销毁容器后显式删。
  volumeName = resourceName ?? await execFileAsync("docker", [
    "inspect",
    "-f",
    '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}',
    containerId,
  ])
    .then((r) => r.stdout.trim() || null)
    .catch(() => null);

  try {
    const portOut = await execFileAsync("docker", [
      "port",
      containerId,
      "5432/tcp",
    ]);
    // 形如 "127.0.0.1:54321"
    const port = portOut.stdout.trim().split(":").pop()!.trim();
    const connString = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;

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
        return { containerId, port, connString, offline: false, restoreJobs: tuning.restoreJobs, teardown, forgetInterruptCleanup };
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error("ephemeral Postgres did not become ready within 30s");
  } catch (error) {
    await teardown();
    forgetInterruptCleanup();
    throw error;
  }
}

// ── 断网跑 SQL(模拟注册用,2.11.1)────────────────────────────────

/** 沙箱容器当前接着的 Docker 网络 */
async function containerNetworks(containerId: string): Promise<string[]> {
  const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", containerId], {
    timeout: 15_000,
  });
  return Object.keys((JSON.parse(stdout.trim() || "null") as Record<string, unknown> | null) ?? {});
}

/** 在容器里跑一条命令(docker exec);timeoutMs 或 signal 到了就杀掉本地的 docker exec 客户端 */
function containerExec(
  containerId: string,
  command: string[],
  opts: { input?: string; timeoutMs: number; signal?: AbortSignal; env?: string[] }
): Promise<{ code: number | null; stdout: string; killed: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(
      "docker",
      [
        "exec",
        ...(opts.input !== undefined ? ["-i"] : []),
        ...(opts.env ?? []).flatMap((kv) => ["-e", kv]),
        containerId,
        ...command,
      ],
      { stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "ignore"] }
    );
    let stdout = "";
    proc.stdout!.on("data", (d: Buffer) => {
      // 只要我们自己 select 出来的那一行;封顶,不让输出无限长
      if (stdout.length < 64 * 1024) stdout += d.toString();
    });
    let killed = false;
    const kill = () => {
      killed = true;
      proc.kill("SIGKILL");
    };
    const timer = setTimeout(kill, opts.timeoutMs);
    if (opts.signal?.aborted) kill();
    opts.signal?.addEventListener("abort", kill, { once: true });
    proc.on("error", () => {});
    proc.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      resolve({ code, stdout, killed });
    });
    if (opts.input !== undefined) {
      proc.stdin!.on("error", () => {});
      proc.stdin!.end(opts.input);
    }
  });
}

/** 容器里用 psql 跑 SQL(默认走 unix socket,不经网络)。官方镜像对本地 socket 和 127.0.0.1 都是 trust */
const PSQL = ["psql", "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"];

/** 模拟注册在容器里的几样痕迹,都带同一个随机标记:取消标记文件、psql 的 pid 文件、会话的 application_name */
function signupTraces(marker: string) {
  if (!/^[0-9a-f]{16}$/.test(marker)) throw new Error("bad sign-up marker");
  return {
    cancelFile: `/tmp/backupdrill-signup-${marker}.cancel`,
    pidFile: `/tmp/backupdrill-signup-${marker}.pid`,
    appName: `backupdrill-signup-${marker}`,
  };
}

/**
 * 模拟注册本地那一侧(docker exec 客户端)最多等多久;导出供测试调短,产品里不改。
 * launchPauseSeconds 只给测试用:在启动脚本"看过取消标记"和"exec psql"之间停一会儿,复现最坏的时序
 */
export const OFFLINE_SIGNUP_LIMITS = { psqlMs: 6 * 60 * 1000, launchPauseSeconds: 0 };

/**
 * 容器里启动模拟注册的脚本。和 stopSignup 的约定:**先占位、再看取消**。
 *  - 启动脚本先独占创建 pid 文件(set -C),写进自己的 pid,然后才看取消标记,有就退出;
 *  - stopSignup 先建取消标记,然后才看 pid 文件。
 * 所以 stopSignup 没看到 pid 文件,启动脚本之后一定会看到取消标记而退出;看到了,就按 pid 杀掉它——
 * 不管它还是 sh(停在 exec 之前)还是已经 exec 成了 psql,pid 都是同一个。
 *
 * psql 经 127.0.0.1 连(断网后 loopback 还在):走 unix socket 时 inet_client_addr() 是 NULL,
 * 真实注册经 TCP 进来,要客户端地址的触发器会被误判成坏的。官方镜像 loopback 是 trust;
 * 万一不是,用容器自己的 POSTGRES_PASSWORD
 */
function signupLauncher(marker: string): string {
  const { cancelFile, pidFile } = signupTraces(marker);
  const pause = Math.max(0, Math.floor(OFFLINE_SIGNUP_LIMITS.launchPauseSeconds));
  return (
    `set -C; echo $$ > ${pidFile} || exit 99; [ -e ${cancelFile} ] && exit 99; ` +
    (pause ? `sleep ${pause}; ` : "") +
    `PGPASSWORD="$POSTGRES_PASSWORD" exec ${PSQL.join(" ")} -h 127.0.0.1`
  );
}

/**
 * 停掉一次没有正常结束的模拟注册,并等到它在容器里确实没了,到 deadline(时间戳)为止。本地的 docker exec 客户端被杀掉
 * (超时、叫停)时,容器里的那次启动照样在跑,甚至可能还没起来。按 signupLauncher 的约定:
 *  1. 先建取消标记,再看 pid 文件:没有 pid 文件 = 它以后也不会启动;有 = 那个进程(sh 或 psql)还活着就杀掉;
 *  2. 终止它的会话(按 application_name,或者语句里带着这次的随机标记——触发器能改 application_name)。
 * 进程没了、会话也没了才算停下来。每条 docker 命令的时限也截在 deadline 之内,整体不会超过它
 */
async function stopSignup(containerId: string, marker: string, deadline: number): Promise<boolean> {
  const { cancelFile, pidFile, appName } = signupTraces(marker);
  // 输出 "alive":还有进程(刚杀掉,或者 pid 文件刚建、还没写进 pid),下一轮再看
  const killLauncher =
    `touch ${cancelFile}; if [ -e ${pidFile} ]; then p=$(cat ${pidFile}); ` +
    `if [ -z "$p" ]; then echo alive; ` +
    `else c=$(cat /proc/$p/comm 2>/dev/null); if [ "$c" = sh ] || [ "$c" = psql ]; then kill -9 "$p"; echo alive; fi; fi; fi; true`;
  const sessions =
    `select count(pg_terminate_backend(pid)) from pg_stat_activity where pid <> pg_backend_pid() ` +
    `and (application_name = '${appName}' or query like '%${marker}%')`;
  const left = () => deadline - Date.now();
  while (left() > 0) {
    const killed = await containerExec(containerId, ["sh", "-c", killLauncher], { timeoutMs: Math.max(1, left()) });
    if (killed.code !== 0 || left() <= 0) return false;
    const sessionsLeft = await containerExec(containerId, [...PSQL, "-c", sessions], { timeoutMs: Math.max(1, left()) });
    if (sessionsLeft.code !== 0) return false;
    if (killed.stdout.trim() === "" && sessionsLeft.stdout.trim() === "0") return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, left()))));
  }
  return false;
}

/** 停掉模拟注册最多等多久(整体,从开始停算起) */
const STOP_SIGNUP_MS = 15_000;

/**
 * 模拟注册用的"断网跑 SQL"(见 auth-drill.ts OfflineSandbox)。
 *
 * 为什么是临时断网,而不是一开始就不给沙箱联网:CLI 和 pg_restore 都从主机经发布的端口连沙箱,
 * --network none 和 --internal 网络都发布不了端口。所以恢复、校验照旧,只在最后的模拟注册之前把容器从所有
 * 网络上摘下来(只剩 loopback),经 docker exec 里的 psql 连 127.0.0.1 跑(见 signupLauncher)。
 *
 * **断了就不再接回**:能确认的只有会话和那个 psql 都没了,确认不了触发器有没有留下别的东西(后台进程等),
 * 一接回它们就又能连出去。所以模拟注册是这个沙箱上的最后一件事,跑完沙箱就销毁。--keep 要留下沙箱时
 * 根本不跑模拟注册(见 drillDump),留下的沙箱和 2.11.0 一样连得上。
 * 每一步之前都看一眼是否已被叫停:叫停后(报告可能已经出了)不再断开任何网络。摘不干净就不跑。
 */
/** @internal 演练内部用;导出只为测试能直接对一个容器验证断网、叫停和超时收尾 */
export function offlineSandbox(pg: { containerId: string; offline: boolean }): OfflineSandbox {
  let running: string | null = null;
  // 同一次注册的收尾只做一次:本地超时、叫停、演练那边的 stopOfflineSessions 谁先来谁启动,其余的等同一个结果
  const stopping = new Map<string, Promise<boolean>>();
  const stopOnce = (marker: string) => {
    let p = stopping.get(marker);
    if (!p) stopping.set(marker, (p = stopSignup(pg.containerId, marker, Date.now() + STOP_SIGNUP_MS)));
    return p;
  };
  return {
    offline: () => pg.offline,
    async stopOfflineSessions() {
      if (running) await stopOnce(running);
    },
    async runOffline(script, marker, signal) {
      const { appName } = signupTraces(marker);
      const stopped = () => {
        if (signal?.aborted) throw new Error("stopped");
      };
      stopped();
      const networks = await containerNetworks(pg.containerId);
      for (const network of networks) {
        stopped();
        await execFileAsync("docker", ["network", "disconnect", network, pg.containerId], { timeout: 30_000 });
        // 只记确认过的状态:这一个网络已经摘掉了,之后不会再接回
        pg.offline = true;
      }
      const left = await containerNetworks(pg.containerId);
      if (left.length) throw new Error(`the sandbox is still on ${left.join(", ")}`);
      pg.offline = true;
      stopped();
      running = marker;
      const result = await containerExec(
        pg.containerId,
        ["sh", "-c", signupLauncher(marker)],
        { input: script, timeoutMs: OFFLINE_SIGNUP_LIMITS.psqlMs, signal, env: [`PGAPPNAME=${appName}`] }
      );
      // 本地超时或被叫停:容器里的那次模拟注册可能还在跑,先确实停掉它,再交出结果(之后沙箱才会被销毁)
      if (result.killed || signal?.aborted) {
        // 超时收尾时演练可能正同时销毁沙箱:容器已经停了(或没了),里面的注册也就跟着没了,不必提示
        const stillThere = () =>
          execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", pg.containerId], { timeout: 10_000 }).then(
            (r) => r.stdout.trim() === "true",
            () => false
          );
        if (!(await stopOnce(marker)) && (await stillThere())) {
          log.warn("Couldn't confirm the stopped test sign-up ended inside the drill sandbox; it stays off the network until it is removed.");
        }
      }
      return { code: result.killed ? null : result.code, stdout: result.stdout };
    },
  };
}

/** --keep 留下的沙箱:和 2.11.0 一样给连接串(留沙箱时不跑模拟注册,它一直连得上),另给一条进容器的命令 */
function keptSandboxInfo(pg: Ephemeral): NonNullable<DrillReport["keptSandbox"]> {
  return { containerId: pg.containerId, connString: pg.connString, inspect: `docker exec -it ${pg.containerId.slice(0, 12)} psql -U postgres` };
}

// installExtensions 已上移到统一引擎(restore-engine.ts):沙箱与真实恢复共用,
// 唯一差异是调用方对"装不上"的裁决——沙箱记录后继续,真实目标阻断。

/** post-data 第二遍恢复的结果:用户对象失败 vs Supabase 托管对象的沙箱预期跳过。 */
interface PostDataResult {
  supabaseSkipped: number;
  failures: string[];
  /** 已同时计入 failures */
  orphanedForeignKeys?: OrphanedForeignKey[];
  /** 授权重建结果;失败时不存在,原因在 failures 里 */
  grants?: GrantRestore;
}

// 只有这些特征说明恢复失败源于沙箱缺扩展(限定类型/schema 解析不到、扩展装不上)。
// 真实 Supabase 项目的 manifest 几乎必然含沙箱装不上的托管扩展(pg_graphql 等),
// 若不按特征过滤,任何硬失败(归档损坏、OOM…)都会被误归因到沙箱。
const MISSING_EXTENSION_ERROR =
  /type "[^"]+" does not exist|schema "[^"]+" does not exist|extension "[^"]+" is not available/i;

// 沙箱小版本早于 2026-11 安全更新(CVE-2026-6460):不认识旧 pg_dump 从已更新的源库导出的列参数。
// 逐段看 pre-data 失败:主错误(段首 ERROR: 之后、Command was: 之前)整句就是这一条才算,
// 语句正文或 DETAIL 里出现这个词不算
const PG_ATTVER_REJECTED =
  /^pg_restore: error: could not execute query: ERROR:\s+unrecognized parameter "pg_attver"\s+Command was:/;

/** pre-data 硬失败;sandboxTooOld = 至少一段失败的主错误是沙箱不认 pg_attver */
class PreDataRestoreError extends Error {
  constructor(message: string, readonly sandboxTooOld: boolean) {
    super(message);
  }
}

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
async function pgRestore(
  dumpPath: string,
  connString: string,
  dumpedSchemas: string[],
  jobs: number,
  grants: GrantedObject[] | undefined
): Promise<PostDataResult> {
  const result = await restoreDatabaseArtifact({
    dumpPath,
    connString,
    target: "sandbox",
    dumpedSchemas,
    jobs,
    grants: { schemas: dumpedSchemas, recorded: grants },
  });
  if (result.preData.failures.length) {
    throw new PreDataRestoreError(
      `pg_restore failed: ${result.preData.failures.join(" | ")}`,
      result.preData.failures.some((failure) => PG_ATTVER_REJECTED.test(failure))
    );
  }
  return {
    supabaseSkipped: result.postData.expectedSkips,
    failures: result.postData.failures,
    orphanedForeignKeys: result.orphanedForeignKeys,
    grants: result.grants,
  };
}

// ── 校验 ────────────────────────────────────────────────────────────

/** 恢复出的一张表(verifyRestored 里查到的口径) */
interface RestoredTable {
  schema: string;
  name: string;
  kind: string;
  extension_member: boolean;
}

/**
 * 第 4 项检查:恢复后每张表的行数和备份文件里的确切行数逐表相等。
 * 只比普通表(含分区的叶子):matview 的数据是 REFRESH、分区父表不存行,dump 里都没有行可数;
 * 扩展建的表 dump 里只有一部分行(见 verifyRestored 的 extension_member)。
 * 备份文件数不出来、某张表在备份文件里找不到数据段,都判失败:比不了就是没验证过,不拿估算顶上。
 */
export function rowCountsCheck(
  inBackup: Map<string, number> | null,
  manifest: Manifest,
  restoredTables: RestoredTable[],
  /** 键 = tableKey */
  restoredRows: Map<string, number>
): DrillCheck {
  const name = "row counts match the backup";
  if (!inBackup) {
    return { name, pass: false, detail: "couldn't count the rows in the backup file, so row counts weren't compared" };
  }
  const inManifest = new Set(manifest.database.tables.map((t) => tableKey(t)));
  const format = (n: number) => n.toLocaleString("en-US");
  const differ: string[] = [];
  const notInFile: string[] = [];
  let compared = 0;
  let rows = 0;
  for (const t of restoredTables) {
    if (t.kind !== "r" || t.extension_member || !inManifest.has(tableKey(t))) continue;
    const label = `${t.schema}.${t.name}`;
    const expected = inBackup.get(tableKey(t));
    if (expected === undefined) {
      notInFile.push(label);
      continue;
    }
    compared++;
    rows += expected;
    const restored = restoredRows.get(tableKey(t)) ?? 0;
    if (restored !== expected) differ.push(`${label} has ${format(restored)}, the backup has ${format(expected)}`);
  }
  const problems = [...differ, ...notInFile.map((label) => `${label} has no data section in the backup file`)];
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join("; ");
    const more = problems.length > 5 ? `; and ${problems.length - 5} more` : "";
    return { name, pass: false, detail: `${shown}${more}` };
  }
  return {
    name,
    pass: true,
    detail:
      compared === 0
        ? "no tables to compare"
        : `all ${format(compared)} tables match the backup exactly (${format(rows)} rows)`,
  };
}

/** 导出:真实恢复(restore.ts)复用同一套表级验证——两条路径对同一快照必须同一结论。 */
export async function verifyRestored(
  connString: string,
  manifest: Manifest,
  /** 恢复用的那份 dump:逐表行数从它里面数(第 4 项检查),恢复出空表时也回查它(第 3 项) */
  dumpPath?: string
): Promise<{ checks: DrillCheck[]; tableCount: number; rowTotal: number }> {
  // pgConnectOptions:真实 Supabase 目标(restore 复用本函数)需要打包根 CA;
  // 沙箱的 docker 连接串非 Supabase 主机,原样透传,行为不变
  const client = await connectPg(connString);
  // 备份文件里的确切行数只读本地文件、不连库,和下面逐表 count(*) 同时跑,省掉一段等待。
  // 连上库之后才开始;这一步中途失败时由 finally 停掉它,不让它在演练收尾之后还在后台读整份 dump
  const stopCounting = new AbortController();
  const backupRowsP = dumpPath ? countRowsInDump(dumpPath, stopCounting.signal) : null;
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
      extension_member: boolean;
    }>(
      // extension_member:扩展建的表(比如装在 public 里的 PostGIS spatial_ref_sys)。CREATE EXTENSION 会自带
      // 初始行,dump 里只有过了扩展过滤条件的那部分,恢复后的行数天然比 dump 多,不做逐行比对
      `select n.nspname as schema, c.relname as name,
              c.relkind as kind, c.relispopulated as populated,
              exists (select 1 from pg_depend d
                       where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e') as extension_member
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
      // tableKey(NUL 分隔),不用点号拼:public."a.b" 和 "public.a".b 拼出来都是 public.a.b,会串表
      const key = tableKey(t);
      // 未填充的 matview 无法 count(*)(Postgres 直接报错)。它要么备份时就没数据
      // (dump 里本来就没有 REFRESH),要么 REFRESH 在 post-data 阶段失败——后者已由
      // post-data 检查如实记录,这里按 0 行处理即可。
      if (t.kind === "m" && !t.populated) {
        counts.set(key, 0);
        unpopulatedMatviews.add(key);
        continue;
      }
      // 名字来自恢复出的库(= 来自 dump = 桶里的数据):必须走标识符转义,
      // 内嵌引号的合法名不炸,构造名不注入
      // 普通表用 only:老式继承的父表 count(*) 会连子表的行一起算,dump 里父表只有它自己的行。
      // 分区父表本身不存行,照旧数全部分区(只用于"有没有数据",不参与逐表比对)
      const only = t.kind === "r" ? "only " : "";
      const c = await client.query<{ n: string }>(
        `select count(*)::bigint as n from ${only}${quoteIdent(t.schema)}.${quoteIdent(t.name)}`
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
      (t) => !restoredSet.has(tableKey(t))
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
    const restoredEmpty = manifest.database.tables.filter(
      (t) =>
        t.estimatedRows > 0 &&
        !unpopulatedMatviews.has(tableKey(t)) &&
        (counts.get(tableKey(t)) ?? 0) === 0
    );
    // manifest 的行数是 pg_dump 之前另开连接取的 n_live_tup(统计估算),和 dump 不是同一个快照。
    // 队列、会话、一次性密钥这类表,取统计时有行、dump 时已经删光,恢复出 0 行是对的
    // (2026-10-24 生产演练:recovery_job_secrets)。所以拿 dump 本身作证:dump 里也是 0 行才放过,
    // dump 有行或查不清,照样判失败。
    const emptyInBackup: typeof restoredEmpty = [];
    const emptied: typeof restoredEmpty = [];
    for (const t of restoredEmpty) {
      const inDump = dumpPath ? await tableDataInDump(dumpPath, t.schema, t.name) : "unknown";
      (inDump === "empty" ? emptyInBackup : emptied).push(t);
    }
    const names = (tables: typeof restoredEmpty) => tables.map((t) => `${t.schema}.${t.name}`).join(", ");
    checks.push({
      name: "populated tables came back",
      pass: emptied.length === 0,
      detail:
        emptied.length > 0
          ? `restored empty despite manifest rows: ${names(emptied)}`
          : emptyInBackup.length > 0
            ? `no populated table restored empty (already empty in the backup: ${names(emptyInBackup)})`
            : "no populated table restored empty",
    });

    // 4. 逐表行数和备份文件里一模一样。manifest 的行数是统计估算,只能管"别变空";确切的备份行数
    // 从 dump 本身数(dump 是 pg_dump 在一个一致快照里导出的,它的行数就是这次备份下来的行数),
    // 不去源库 count(*):那要在用户的库上全表扫一遍。数不出来就判失败,不退回估算
    if (backupRowsP) checks.push(rowCountsCheck(await backupRowsP, manifest, restoredTables, counts));

    return { checks, tableCount: restoredTables.length, rowTotal };
  } finally {
    // 正常走完时它早已结束,这两步什么都不做
    stopCounting.abort();
    await backupRowsP;
    await client.end();
  }
}

/**
 * Storage 完整性校验:从备份桶重新读回文件、比对 manifest 里记录的 sha256,
 * 证明备份的文件副本真实存在且未损坏。文件多时抽样(默认上限),避免大量 egress。
 */
async function verifyStorage(
  location: StorageFilesLocation,
  manifest: Manifest,
  verifyAll: boolean
): Promise<DrillCheck> {
  const files = manifest.storage!.files;
  const sample = verifyAll ? files : sampleStorageFiles(files, STORAGE_SAMPLE_CAP);
  // 备份写入时的键:<snapshot base>/storage/<bucket>/<key>
  const mismatches: string[] = [];
  for (const f of sample) {
    const objectKey = `${location.base}/storage/${f.bucket}/${f.key}`;
    try {
      const { sha256 } = await hashObject(location.s3, location.bucket, objectKey);
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
    // 也因为自成一组,终端的 Ctrl+C 到不了它:中断时由我们按组停掉
    stopOnInterrupt(proc, { group: true });
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
  opts: {
    appCheckCommand?: string;
    keepSandboxOnFailure?: boolean;
    supervision?: DrillSupervision;
    /** 快照带 Auth 用户时 runDrill 在后台下载的 auth.dump(和正式演练同时进行) */
    authDump?: Promise<AuthDumpForDrill>;
    /** Auth 那一节超时放弃时,叫停还没下完的 auth.dump */
    stopAuthDownload?: () => void;
  } = {}
): Promise<DrillReport> {
  // 空/纯空白命令 = 危险的假配置(CI 里变量没展开的典型形态):跑了会以 exit 0
  // 假通过,忽略会让用户以为检查在跑。拒绝,且要在起沙箱之前拒绝。
  validateSupervision(opts.supervision, opts.appCheckCommand, opts.keepSandboxOnFailure);
  const appCheckCommand = opts.appCheckCommand?.trim();
  if (opts.appCheckCommand !== undefined && !appCheckCommand) {
    throw new Error(
      "--check-cmd is empty (did an env var fail to expand?) — refusing to report a check that would never run"
    );
  }

  const checks: DrillCheck[] = [...preChecks];
  await opts.supervision?.observe({ phase: "sandbox" });
  const sourceMajor = parseInt(manifest.database.serverVersion, 10);
  const toolMajor = await localPgRestoreMajor();
  const sandboxMajor = sandboxMajorFor(sourceMajor, toolMajor);
  const image = sandboxImage(manifest, sandboxMajor);
  const pg = await startEphemeralPostgres(image, sandboxMajor, opts.supervision?.resourceName);
  let pass = false; // 异常路径视为失败,供 finally 决定 --keep 是否保留沙箱
  try {
    if (sandboxMajor !== sourceMajor) {
      // 报告里写明沙箱比源库新以及原因:读报告的人要知道这次证明的是
      // "能恢复进 PostgreSQL N",而不是同版本
      checks.push({
        name: "sandbox version",
        pass: true,
        detail:
          `restored into PostgreSQL ${sandboxMajor} (source is ${sourceMajor}): ` +
          (toolMajor !== null && restoreToolBreaksOnTarget(toolMajor, sourceMajor)
            ? `pg_restore ${toolMajor} sends SET transaction_timeout, which PostgreSQL ${sourceMajor} rejects`
            : `output of pg_restore ${toolMajor} is only guaranteed to load into PostgreSQL ${toolMajor} or newer`) +
          `; restoring into a newer major version is supported`,
      });
    }
    // 旧 manifest(≤0.1.1)没有 extensions 字段 → 不装任何扩展,行为与从前一致
    const extensions = manifest.database.extensions ?? [];
    const unavailable = await installExtensions(pg.connString, extensions);
    // Supabase 运行面的桩(auth.uid() 等 + 标准角色):没有它,参数/列默认值里引用
    // auth.uid() 的函数与表在 pre-data 就建不出来 —— 见 installSandboxShim 头注。
    // 转储自己带了 auth schema 就不建函数,否则 pg_restore 会撞 "already exists"。
    await installSandboxShim(pg.connString, {
      authFunctions: !manifest.database.schemas.includes("auth"),
    });
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

    await opts.supervision?.observe({ phase: "restore" });
    throwIfInterrupted();
    const started = Date.now();
    log.step("Restoring into ephemeral Postgres…");
    let postData: PostDataResult;
    try {
      postData = await pgRestore(
        dumpPath,
        pg.connString,
        manifest.database.schemas,
        pg.restoreJobs,
        manifest.database.grants
      );
    } catch (error) {
      // 沙箱装不上扩展 + 错误特征命中"缺类型/schema/扩展" → 假设式归因到沙箱环境
      // (不对备份健康下断言);其余失败与扩展无关,必须原样抛出
      const message = (error as Error).message;
      // 必须排在缺扩展归因前面:这类失败的连带错误(type "…" does not exist)也会命中
      // MISSING_EXTENSION_ERROR,2026-11-24 的告警就被误指成了 supabase_vault
      if (error instanceof PreDataRestoreError && error.sandboxTooOld) {
        throw new Error(
          `restore failed: the drill sandbox (${image}) predates the November 2026 PostgreSQL security ` +
            `release and rejects the "SET (pg_attver=…)" lines that a pg_dump older than that release writes ` +
            `when the source database already has it. Run "docker pull ${image}" and drill again; upgrading ` +
            `pg_dump to the latest minor version keeps these lines out of new backups. All errors: ${message}`
        );
      }
      if (unavailable.length && MISSING_EXTENSION_ERROR.test(message)) {
        throw new Error(
          `restore failed; likely because the drill sandbox cannot install ` +
            `extension(s) ${unavailable.join(", ")}. Original error: ${message}`
        );
      }
      throw error;
    }
    const restoreSeconds = Math.round((Date.now() - started) / 100) / 10;
    checks.push({
      name: "pg_restore",
      pass: true,
      detail: `completed in ${restoreSeconds}s` + (pg.restoreJobs > 1 ? ` (${pg.restoreJobs} parallel jobs)` : ""),
    });
    // 用户自己的 post-data 对象(索引/约束/触发器)必须全部恢复;Supabase 托管对象
    // 的沙箱预期跳过如实写进报告(演练不假装它们恢复了)。
    checks.push({
      name: "post-data objects",
      pass: postData.failures.length === 0,
      detail:
        postData.failures.length > 0
          ? `${postData.failures.length} failed: ${postData.failures[0]}`
          : postData.supabaseSkipped > 0
            ? // 说清跳过的是什么,以及它对真实恢复意味着什么:2026-10-22 实验里演练 PASS,
              // 恢复却死在被跳过的那条 FK → auth.users 上,因为新项目的 auth.users 是空的
              `user objects restored; ${postData.supabaseSkipped} Supabase-managed object(s) skipped ` +
              `(they reference tables such as auth.users, which the drill sandbox doesn't have; ` +
              `restoring into a new project needs the rows they point at to be there first)`
            : "all post-data objects restored",
    });

    await opts.supervision?.observe({ phase: "verify" });
    const verify = await verifyRestored(pg.connString, manifest, dumpPath);
    checks.push(...verify.checks);
    if (postData.grants) checks.push(grantsCheck(postData.grants, "drill"));
    const orphaned = postData.orphanedForeignKeys ?? [];
    if (orphaned.length) checks.push(orphanedForeignKeysCheck(orphaned));

    // 语义层钩子:只在结构层全绿时才跑——结构已失败时再跑应用检查,只会把
    // 一次失败报成两层失败,误导排查方向。没配置则不跑、报告里不出现该行。
    if (appCheckCommand && checks.every((c) => c.pass)) {
      throwIfInterrupted();
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
    if (orphaned.length) report.orphanedForeignKeys = orphaned;
    // Auth 附加校验:结论(pass)上面已经定了,这里只往报告里加一节。它在同一个沙箱里补外键、
    // 建触发器、模拟注册——放在所有正式检查之后,不影响它们;自己出错也只记在这一节里
    const authSection = await authDrillSection(pg.connString, manifest, dumpPath, opts.authDump, opts.stopAuthDownload, {
      // 托管 worker 在这一步前后换磁盘守卫的规则:Auth 阶段吃紧只叫停这一节,不判演练失败
      begin: opts.supervision ? () => opts.supervision!.observe({ phase: "auth" }) : undefined,
      stop: opts.supervision?.authStop,
      sandbox: offlineSandbox(pg),
      // --keep 要留下这个沙箱时不跑模拟注册:断了网就不能再接回,留下的沙箱就连不上了(脚本靠 keptSandbox.connString)。
      // 结论(pass)这时已经定了,只有真的会留沙箱(演练没通过)才跳过
      skipSignup: opts.keepSandboxOnFailure && !pass ? "--keep leaves the sandbox connected so you can inspect it" : undefined,
    });
    if (authSection) {
      report.auth = authSection;
      const line = `Auth users: ${authSection.summary}`;
      if (authSection.status === "verified") log.ok(line);
      else log.warn(line);
    }
    if (opts.keepSandboxOnFailure && !pass) {
      // 写进报告让 --keep 可被脚本消费(拿连接串排查),不只靠人眼看日志
      report.keptSandbox = keptSandboxInfo(pg);
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
      await observeCleanup(opts.supervision);
      log.step("Tearing down ephemeral Postgres…");
      await pg.teardown();
    }
    // 删完了,或者按 --keep 有意留着:之后再收到信号都不该再动它
    pg.forgetInterruptCleanup();
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
    supervision?: DrillSupervision;
    /** 快照从哪读;省略 = config.storage 指的 S3 兼容桶 */
    store?: SnapshotStore;
    /**
     * 快照带 Auth 用户时做不做附加的 Auth 校验(不影响结论,见 auth-drill.ts)。默认:没有 supervision 时做
     * (CLI);有 supervision(托管 worker)时不做——auth.dump 不在它按 dumpBytes 算的磁盘预算里,
     * 等 worker 把两份都算进预算再显式打开
     */
    authCheck?: boolean;
  } = {}
): Promise<DrillReport> {
  validateSupervision(opts.supervision, opts.appCheckCommand, opts.keepSandboxOnFailure);
  const store = opts.store ?? s3SnapshotStore(config);
  const reader = await store.openSnapshot(opts.snapshot);
  const snapshot = reader.name;
  log.step(`Drilling snapshot ${snapshot}`);

  const manifest = parseManifest(await reader.readManifest());

  const workdir = opts.supervision?.workdir ?? await mkdtemp(join(tmpdir(), "backupdrill-"));
  const dumpPath = join(workdir, "dump.pgcustom");
  // 下载的 dump 在这里;托管模式的目录归 supervisor 管
  const authDownloadStop = new AbortController();
  const forgetWorkdir = opts.supervision
    ? () => {}
    : onInterrupt(() => rm(workdir, { recursive: true, force: true }).catch(() => {}));
  try {
    await opts.supervision?.observe({ phase: "download", dumpBytes: manifest.dump.bytes });
    log.step("Downloading dump…");
    const { sha256: sha } = await reader.downloadDump(manifest, dumpPath);
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
      await opts.supervision?.observe({ phase: "storage" });
      log.step("Verifying Storage files…");
      const location = reader.storageFiles(manifest);
      preChecks.push(
        location
          ? await verifyStorage(location, manifest, opts.verifyAllFiles ?? false)
          : {
              name: "storage file integrity",
              pass: false,
              detail: "the manifest lists Storage files, but this snapshot location cannot hold them",
            }
      );
    }

    // 快照带 Auth 用户:在后台把 auth.dump 取下来给附加校验用,和正式演练同时进行、不让它等。
    // 取不到只记进报告的 Auth 一节
    let authDump: Promise<AuthDumpForDrill> | undefined;
    if (manifest.auth?.status === "included" && (opts.authCheck ?? !opts.supervision)) {
      const authPath = join(workdir, "auth.dump");
      const download = reader.downloadAuthDump;
      const stopAuthDownload = authDownloadStop;
      // 下载出错的原文不进报告(里面可能有凭据、对象键之类),只给固定的说法;
      // 同步抛出的错误也在这个 Promise 里接住,绝不冒到演练本身
      authDump = download
        ? Promise.resolve()
            .then(() => download.call(reader, manifest, authPath, { signal: stopAuthDownload.signal }))
            .then(
              (): AuthDumpForDrill => ({ path: authPath }),
              (): AuthDumpForDrill => ({ error: "the Auth archive couldn't be downloaded" })
            )
        : Promise.resolve({ error: "this snapshot location can't read the Auth archive" });
    }

    return await drillDump(dumpPath, manifest, snapshot, preChecks, {
      appCheckCommand: opts.appCheckCommand,
      keepSandboxOnFailure: opts.keepSandboxOnFailure,
      supervision: opts.supervision,
      authDump,
      stopAuthDownload: () => authDownloadStop.abort(),
    });
  } finally {
    // 演练怎么结束都一样:还在下的 auth.dump 立刻停掉,不留着连接把进程拖住
    authDownloadStop.abort();
    if (!opts.supervision) await rm(workdir, { recursive: true, force: true }).catch(() => {});
    forgetWorkdir();
  }
}
