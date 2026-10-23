// Ctrl+C / SIGTERM 时收拾演练自己起的东西。
//
// Node 默认收到 SIGINT/SIGTERM 就直接退出,finally 一个都不跑:沙箱容器(docker run -d)和它的
// 匿名卷留着,--check-cmd 在自己的进程组里(detached,终端的 Ctrl+C 到不了它)接着跑,
// 下载下来的 dump 留在临时目录。被 `kill <pid>` 只发给 node 时,pg_restore 也会接着跑。
//
// 做法:演练代码每建一样东西就登记一个清理函数,用完自己注销;CLI 收到信号时把还登记着的
// 倒序跑一遍(先停子进程,再删容器,最后删临时目录),然后以 128+信号号退出。
// 信号处理只由 CLI 装(exitCleanlyOnSignals),库调用方(托管 worker)有自己的进程管理,
// 登记本身对它们没有副作用。
import type { ChildProcess } from "node:child_process";
import { log } from "./log.js";

type Cleanup = () => Promise<void> | void;

const pending = new Set<Cleanup>();
let interruptedBy: NodeJS.Signals | null = null;

/** 收到过信号没有。主流程据此闭嘴:信号处理正在收尾并会自己退出,别再打印报告、发 ping、写记录。 */
export function interrupted(): boolean {
  return interruptedBy !== null;
}

/**
 * 收到信号之后不再开始新的一步(起容器、跑 pg_restore、跑检查命令)。清理在跑的时候主流程还活着,
 * 一个刚返回的探测会接着往下走:不拦的话,清理快照之后才起的沙箱就没人删了(交叉审查)。
 */
export function throwIfInterrupted(): void {
  if (interruptedBy) throw new Error(`${interruptedBy} received; stopping`);
}

/** 登记一个中断时要跑的清理;返回注销函数,正常走完后调用。 */
export function onInterrupt(cleanup: Cleanup): () => void {
  pending.add(cleanup);
  return () => {
    pending.delete(cleanup);
  };
}

/**
 * 中断时停掉一个子进程。先 SIGTERM 给它收尾的机会,2 秒后还在就 SIGKILL。
 * group:子进程自成进程组(detached,如 --check-cmd),按组发信号,连它派生的进程一起停。
 * 看的是**整组**还在不在,不是组长:shell 收到 SIGTERM 先退了,忽略 SIGTERM 的孙进程还在,
 * 只盯组长就会跳过 SIGKILL 把它留下(交叉审查复现)。
 */
export function stopOnInterrupt(child: ChildProcess, opts: { group?: boolean } = {}): () => void {
  const pid = child.pid;
  // Windows 没有负 pid 的进程组信号,process.kill(-pid) 直接报错:那里退回到只看、只停子进程本身
  // (和 --check-cmd 超时那条路一样),孙进程可能留下。没在 Windows 上测过
  const byGroup = opts.group && process.platform !== "win32";
  const alive = (): boolean => {
    if (!pid) return false;
    if (!byGroup) return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (byGroup && pid) process.kill(-pid, sig);
      else child.kill(sig);
    } catch {
      // 已经退出
    }
  };
  const forget = onInterrupt(async () => {
    if (!alive()) return;
    signal("SIGTERM");
    const deadline = Date.now() + 2_000;
    while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    if (alive()) signal("SIGKILL");
  });
  // 组长退出时组里可能还有进程:那就继续登记着,中断时照样能按组停掉
  child.once("close", () => {
    if (!alive()) forget();
  });
  return forget;
}

/**
 * 每个清理最多等这么久:docker 守护进程卡住时也要能退出。要比沙箱的收尾(等 docker run 落定 20 秒、
 * docker rm 最多 60 秒)长,不然收尾还没做完就退出了。
 */
const CLEANUP_TIMEOUT_MS = 90_000;

async function runCleanups(): Promise<void> {
  // 一直跑到没有登记为止:清理途中主流程可能还登记了新东西(比如收到信号时正在返回的 docker run)
  for (let round = 0; pending.size && round < 10; round++) {
    const tasks = [...pending].reverse();
    pending.clear();
    await runTasks(tasks);
  }
}

async function runTasks(tasks: Cleanup[]): Promise<void> {
  for (const task of tasks) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const finished = await Promise.race([
        Promise.resolve()
          .then(task)
          .then(() => true),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), CLEANUP_TIMEOUT_MS))),
      ]);
      if (!finished) log.warn(`a cleanup step did not finish within ${CLEANUP_TIMEOUT_MS / 1000}s; check \`docker ps -a\``);
    } catch {
      // 清理函数自己报告失败;一个失败不挡后面的
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * CLI 专用:在 what(比如 "drill")运行期间接管 SIGINT/SIGTERM。第一次收到信号时跑完登记的清理,
 * 以 130(SIGINT)/ 143(SIGTERM)退出;清理途中再按一次 Ctrl+C 就不等了,直接退出。
 * 返回卸载函数。
 */
export function exitCleanlyOnSignals(what: string): () => void {
  const handler = (signal: NodeJS.Signals) => {
    const code = signal === "SIGINT" ? 130 : 143;
    if (interruptedBy) {
      log.error(`${signal} again — exiting without finishing the cleanup`);
      process.exit(code);
    }
    interruptedBy = signal;
    log.warn(
      `${signal} received — stopping the ${what} and cleaning up` +
        (signal === "SIGINT" ? " (press Ctrl+C again to skip)…" : "…")
    );
    void runCleanups().finally(() => {
      log.error(`${what} interrupted`);
      process.exit(code);
    });
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
