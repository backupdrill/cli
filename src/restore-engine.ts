// 统一数据库恢复引擎(恢复闭环 PRD §5.2):drill 沙箱与真实 Supabase 目标共用同一条
// pg_restore 路径与错误分类,同一快照不得在演练与真实恢复中得出不同结论。
//
// R0 spike 的三条实证直接塑造了这里的形状:
//  1. 裸退出码在真实目标上永远不干净 → 成功判定 = 零未分类错误(版本化 allowlist);
//  2. 不用 --clean:与"只允许空目标"(D5)冲突、制造伪错,且在真实 Supabase 上
//     DROP/CREATE public 会抹掉 anon/authenticated 的默认授权(--no-privileges 转储
//     不会带回来),恢复出的 API 直接 401;
//  3. dump 自带 CREATE SCHEMA,而目标(新容器或 Supabase)恒有同名 schema →
//     pre-data 阶段的 schema "already exists" 是两类目标共同的预期冲突。
import { spawn } from "node:child_process";
import { Client } from "pg";
import type { ExtensionInfo } from "./manifest.js";
import { resolvePgRestoreBin } from "./pgbin.js";
import { pgConnectOptions } from "./supabase-ca.js";

export type RestoreTargetKind = "sandbox" | "supabase";

export interface ClassifiedPass {
  /** allowlist 命中数(环境预期/托管冲突)——如实入报告,不算失败 */
  expectedSkips: number;
  /** 真失败(压缩到 200 字符的错误块) */
  failures: string[];
}

export interface EngineResult {
  preData: ClassifiedPass;
  postData: ClassifiedPass;
  ok: boolean;
}

export function spawnPgRestore(
  bin: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    // 不透传原始 spawn Error:node 会把 spawnargs(含 --dbname 连接串=凭据)挂在
    // 异常对象上,顺着 reject 流进日志/Sentry。只保留启动失败的事实与 bin 名。
    proc.on("error", (error) =>
      reject(new Error(`${bin} failed to start: ${(error as NodeJS.ErrnoException).code ?? error.message}`))
    );
    proc.on("close", (code) => resolve({ code, stderr }));
  });
}

// 演练沙箱是裸 Postgres,Supabase 托管的 schema/角色必然缺席。post-data 里
// 引用它们的失败是"环境预期",不是备份坏了;其余失败才是演练要抓的。
// 真实 Supabase 目标不适用:角色/托管 schema 恒在,post-data 全严格。
export const SANDBOX_MANAGED_ERROR =
  /schema "(auth|storage|realtime|vault|extensions|graphql[a-z_]*)" does not exist|role "(authenticated|anon|service_role|supabase_[a-z_]+)" does not exist|\bauth\.uid\b|\bauth\.jwt\b/i;

// pre-data 唯一的预期冲突(见文件头注 3)。目标空门/新容器保证没有其他冲突源,
// 任何别的 "already exists" 都是真冲突,必须失败。
export const SCHEMA_EXISTS_ERROR = /schema "[^"]+" already exists/i;

const NEVER_MATCH = /(?!)/;

/**
 * 把 pg_restore 的 stderr 拆成单个错误块并按 allowlist 分类。
 * 只对 ERROR 原因行分类,不看 "Command was:" 之后的语句文本——否则一个恰好
 * 引用 auth.uid 的用户对象因"损坏/语法错误"失败时,会被误判成预期跳过。
 */
export function classifyBlocks(stderr: string, allow: RegExp): ClassifiedPass {
  const blocks = stderr
    .split(/(?=pg_restore: error:)/)
    .filter((b) => /pg_restore: error:/.test(b));
  let expectedSkips = 0;
  const failures: string[] = [];
  for (const block of blocks) {
    const cause = block.split(/Command was:/i)[0];
    if (allow.test(cause)) {
      expectedSkips += 1;
    } else {
      failures.push(block.replace(/\s+/g, " ").trim().slice(0, 200));
    }
  }
  return { expectedSkips, failures };
}

/**
 * 一遍恢复的最终裁决,两条独立规则:
 * 1. 被信号杀死(code=null)**无条件失败**——即使 stderr 里已有被 allowlist 解释的
 *    错误块。真实目标恒有一个预期 schema 跳过,若跳过能抵扣信号死亡,中途被 OOM/kill
 *    的半截恢复就会被报成功(评审第 7 轮抓出的假成功路径)。
 * 2. 非零退出且零错误块(归档器致命错、非英文 locale…)同样不能谎报成功。
 *    非零退出但每个错误都已分类 = pg_restore 对被忽略错误的正常退出形态,通过。
 */
export function finalizePass(
  code: number | null,
  stderr: string,
  classified: ClassifiedPass
): ClassifiedPass {
  const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 200) || "(no stderr)";
  if (code === null) {
    return {
      ...classified,
      failures: [...classified.failures, `pg_restore was killed by a signal: ${detail}`],
    };
  }
  if (code !== 0 && classified.expectedSkips === 0 && classified.failures.length === 0) {
    return { ...classified, failures: [`pg_restore exited with code ${code}: ${detail}`] };
  }
  return classified;
}

/** 标识符转义(内嵌引号翻倍)。导出:任何把目录里读到的名字拼进 SQL 的地方都必须用它。 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 恢复前把 manifest 记录的扩展装进目标(--schema 转储不含 CREATE EXTENSION)。
 * 必须装进与源库相同的 schema:dump 里的类型是限定名(如 extensions.vector)。
 * 装不上的扩展如实收集返回,由调用方按目标类型裁决:沙箱记录后继续(托管扩展
 * 本就装不上,public 转储通常不引用),真实目标应当阻断(用户能在 dashboard 开启)。
 */
export async function installExtensions(
  connString: string,
  extensions: ExtensionInfo[]
): Promise<string[]> {
  if (!extensions.length) return [];
  // pgConnectOptions:Supabase 主机自动带打包根 CA(node-pg 把 require 按 verify-full
  // 处理,裸 Client 对 pooler 必报 self-signed chain);沙箱等非 Supabase 目标原样透传
  const client = new Client(pgConnectOptions(connString));
  await client.connect();
  const unavailable: string[] = [];
  try {
    for (const ext of extensions) {
      try {
        await client.query(`create schema if not exists ${quoteIdent(ext.schema)}`);
        // CASCADE 自动带上依赖扩展,免受 manifest 里的安装顺序摆布
        await client.query(
          `create extension if not exists ${quoteIdent(ext.name)} schema ${quoteIdent(ext.schema)} cascade`
        );
      } catch {
        unavailable.push(ext.name);
      }
    }
  } finally {
    await client.end();
  }
  return unavailable;
}

/**
 * 两遍恢复(真实首演炸出的设计,现为 drill 与真实恢复共用):
 * 1. pre-data+data —— 表结构 + 数据。除 schema 冲突(预期)外任何错误都是硬失败。
 * 2. post-data —— 用户自己的索引/约束/触发器必须恢复成功;allowlist 按目标类型:
 *    沙箱豁免 Supabase 托管对象引用,真实 Supabase 目标零豁免。
 */
/**
 * 凭据不进 argv(D6 同源要求):连接串里的密码对 `ps` 全程可见——拆出来经
 * PGPASSWORD 环境变量传给 libpq,argv 里的 URL 不再携带。解析不了的连接串
 * 原样透传(libpq 自己适配的形态,不在这里破坏)。
 */
export function credentialSafeDbArgs(connString: string): { url: string; env: NodeJS.ProcessEnv } {
  try {
    const url = new URL(connString);
    if (!url.password) return { url: connString, env: {} };
    const password = decodeURIComponent(url.password);
    url.password = "";
    return { url: url.toString(), env: { PGPASSWORD: password } };
  } catch {
    return { url: connString, env: {} };
  }
}

export async function restoreDatabaseArtifact(opts: {
  dumpPath: string;
  connString: string;
  target: RestoreTargetKind;
}): Promise<EngineResult> {
  const bin = resolvePgRestoreBin();
  const { url, env } = credentialSafeDbArgs(opts.connString);
  const common = ["--no-owner", "--no-privileges", "--dbname", url, opts.dumpPath];

  const first = await spawnPgRestore(bin, ["--section=pre-data", "--section=data", ...common], env);
  const preData = finalizePass(
    first.code,
    first.stderr,
    classifyBlocks(first.stderr, SCHEMA_EXISTS_ERROR)
  );
  if (preData.failures.length) {
    return { preData, postData: { expectedSkips: 0, failures: [] }, ok: false };
  }

  const second = await spawnPgRestore(bin, ["--section=post-data", ...common], env);
  const postData = finalizePass(
    second.code,
    second.stderr,
    classifyBlocks(second.stderr, opts.target === "sandbox" ? SANDBOX_MANAGED_ERROR : NEVER_MATCH)
  );

  return { preData, postData, ok: postData.failures.length === 0 };
}
