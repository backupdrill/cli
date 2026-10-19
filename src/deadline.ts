/**
 * 到点就放弃,不管 run 停没停。只把 AbortSignal 交给 SDK 不够:它在两次重试之间按
 * Retry-After 睡觉时不看 signal,503 带 Retry-After: 2 就能把 1 秒的时限拖到 2 秒多。
 * signal 仍然传下去;结束时(成功、失败、超时)一律 abort,让并行中还没回来的请求收手,
 * 不然一个先失败、一个挂着的 Promise.all 会把挂着的那个连接一直留着。
 */
export async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${ms}ms`);
      error.name = "TimeoutError";
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** 超时类错误(withDeadline 的、AbortSignal 的)统一认出来,好给一句人话 */
export function isTimeout(error: unknown): boolean {
  const name = (error as Error | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}
