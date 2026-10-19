import { randomUUID } from "node:crypto";
import type { BackupConfig } from "./config.js";
import { log } from "./log.js";
import { projectRefOf } from "./restore-engine.js";
import { TOOL_VERSION } from "./version.js";

// 按 Healthchecks.io 的 ping 约定报告一次 backup / drill(https://healthchecks.io/docs/http_api/):
// 开始 <url>/start,成功 <url>,失败 <url>/fail,失败原因放请求体。三次请求带同一个 rid,
// Healthchecks 才能把开始和结束配成一对算耗时,同一个检查并发跑两次也不会串。
// 监控是旁路:ping 出任何问题只打警告,绝不改变备份/演练本身的结果和退出码。

/** 每次请求的上限:Healthchecks 建议必须设超时,卡住的 /start 不能拖住备份本身 */
const TIMEOUT_MS = 10_000;
/** 网络错误和 5xx 重试;4xx(404 = 网址写错)重试也没用 */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;
/** 失败原因只给个梗概:Healthchecks 会把请求体原样放进告警邮件和事件日志 */
const BODY_LIMIT = 1_000;

export interface Pinger {
  start(): Promise<void>;
  success(summary: string): Promise<void>;
  /** sensitive:这次运行用到的连接串、密钥等,发出去之前从 reason 里抹掉 */
  fail(reason: string, sensitive?: string[]): Promise<void>;
}

const NO_PING: Pinger = {
  start: async () => {},
  success: async () => {},
  fail: async () => {},
};

export function createPinger(
  rawUrl: string | undefined,
  opts: { timeoutMs?: number; attempts?: number; retryDelayMs?: number } = {}
): Pinger {
  if (!rawUrl) return NO_PING;
  let base: URL;
  try {
    base = new URL(rawUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("not http(s)");
  } catch {
    // 网址本身不对也只是监控没接上:备份照跑,Healthchecks 那边会因为收不到 ping 报警
    log.warn("The ping URL is not a valid http(s) URL, so no pings will be sent. The run carries on.");
    return NO_PING;
  }
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const attempts = opts.attempts ?? ATTEMPTS;
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const rid = randomUUID();

  const endpoint = (suffix: "" | "/start" | "/fail"): string => {
    const url = new URL(base.href);
    // 改 pathname 而不是拼字符串:slug 网址可能带 ?create=1,后缀要落在问号前面
    if (suffix) url.pathname = url.pathname.replace(/\/+$/, "") + suffix;
    url.searchParams.set("rid", rid);
    return url.href;
  };

  // 日志里只写 start/success/fail,不写网址:网址里的 UUID 谁拿到都能替你报平安
  const send = async (kind: "start" | "success" | "fail", url: string, body?: string) => {
    let lastProblem = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          body,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "user-agent": `backupdrill/${TOOL_VERSION}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        await res.body?.cancel();
        if (res.ok) return;
        lastProblem = `HTTP ${res.status}`;
        if (res.status < 500) break;
      } catch (error) {
        const err = error as Error & { cause?: { code?: string; message?: string } };
        lastProblem =
          err.name === "TimeoutError"
            ? `no response within ${Math.round(timeoutMs / 1000)}s`
            : err.cause?.code ?? err.cause?.message ?? err.message;
      }
      if (attempt < attempts) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    }
    log.warn(`Could not send the ${kind} ping (${lastProblem}). The run carries on.`);
  };

  return {
    start: () => send("start", endpoint("/start")),
    success: (summary) => send("success", endpoint(""), truncate(summary)),
    fail: (reason, sensitive = []) => send("fail", endpoint("/fail"), truncate(scrubForPing(reason, sensitive))),
  };
}

function truncate(text: string): string {
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT - 1)}…` : text;
}

/**
 * 失败原因发出去之前抹掉连接信息。先按值抹(这次运行确实用到的连接串、密码、主机、密钥),
 * 再按形状兜底:pg / S3 的报错会带主机名、IP、整条连接串,配置文件解析失败时 JSON.parse
 * 的报错还会带一截文件原文,这些都不是事先知道的值。
 */
export function scrubForPing(text: string, sensitive: string[]): string {
  let out = text;
  // 长的先换:密码可能是连接串的一部分,先换短的会把长的打散,长的就匹配不上了
  for (const value of [...new Set(sensitive)].sort((a, b) => b.length - a.length)) {
    if (value.length >= 4) out = out.split(value).join("[redacted]");
  }
  return out
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi, "[url]")
    .replace(/[^\s"'<>`/@]*:[^\s"'<>`/@]*@/g, "[redacted]@")
    // Supabase pooler 的用户名是 postgres.<项目 ref>
    .replace(/\bpostgres\.[a-z0-9]{16,}\b/gi, "postgres.[ref]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}\b/gi, "[ip]")
    // 至少两个点的主机名;常见文件扩展名放过,免得把 backupdrill.config.json 也抹了
    .replace(/\b(?:[a-z0-9-]+\.){2,}(?!(?:json|md|ya?ml|js|ts|txt|log|sql|pgcustom)\b)[a-z]{2,}\b/gi, "[host]");
}

/** 这次运行里不该出现在 ping 里的值:连接串、密码、主机、项目 ref、桶和 Storage 的密钥。 */
export function sensitiveValuesOf(config: BackupConfig | undefined, extraDatabaseUrl?: string): string[] {
  const env = process.env;
  const values: (string | undefined)[] = [
    env.BACKUPDRILL_S3_ACCESS_KEY_ID,
    env.BACKUPDRILL_S3_SECRET_ACCESS_KEY,
    env.BACKUPDRILL_SUPABASE_STORAGE_ACCESS_KEY_ID,
    env.BACKUPDRILL_SUPABASE_STORAGE_SECRET_ACCESS_KEY,
    config?.storage?.accessKeyId,
    config?.storage?.secretAccessKey,
    config?.supabaseStorage?.accessKeyId,
    config?.supabaseStorage?.secretAccessKey,
  ];
  for (const conn of [config?.databaseUrl, extraDatabaseUrl, env.BACKUPDRILL_DATABASE_URL, env.DATABASE_URL]) {
    if (!conn) continue;
    values.push(conn, projectRefOf(conn) ?? undefined);
    // 用户名不进列表:常见的就是 postgres,按值抹会把报错里每个 postgres 都换掉;
    // pooler 用户名里真正要藏的项目 ref 上面已经单独抹了
    try {
      const url = new URL(conn);
      values.push(url.hostname, url.password, decodeURIComponent(url.password));
    } catch {
      // 解析不了的连接串整条已经在列表里了
    }
  }
  return values.filter((v): v is string => Boolean(v));
}
