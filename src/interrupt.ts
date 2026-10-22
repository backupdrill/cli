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

/** 登记一个中断时要跑的清理;返回注销函数,正常走完后调用。 */
export function onInterrupt(cleanup: Cleanup): () => void {
  pending.add(cleanup);
  return () => {
    pending.delete(cleanup);
  };
}

/**
 * 中断时停掉一个子进程。detached 的子进程(自成进程组,如 --check-cmd)按组发信号,
 * 连它派生的孙进程一起停。先 SIGTERM 给它收尾的机会,2 秒后还在就 SIGKILL。
 */
export function stopOnInterrupt(child: ChildProcess, opts: { group?: boolean } = {}): () => void {
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (opts.group && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // 已经退出
    }
  };
  const forget = onInterrupt(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    signal("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), 2_000))),
    ]);
    clearTimeout(timer);
    if (timedOut) signal("SIGKILL");
  });
  child.once("close", forget);
  return forget;
}

/** 每个清理最多等这么久:docker 守护进程卡住时也要能退出。 */
const CLEANUP_TIMEOUT_MS = 30_000;

async function runCleanups(): Promise<void> {
  const tasks = [...pending].reverse();
  pending.clear();
  for (const task of tasks) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(task),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS))),
      ]);
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
