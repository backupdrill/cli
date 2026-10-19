import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { requireBucket, type BackupConfig } from "./config.js";
import {
  LAST_DRILL_FILE,
  LAST_PASSED_DRILL_FILE,
  drillRecordKey,
  parseDrillRecord,
  type DrillRecord,
} from "./drill-record.js";
import { log } from "./log.js";
import { parseManifest } from "./manifest.js";
import { listSnapshotPrefixes, targetClient } from "./snapshots.js";
import { TOOL_VERSION } from "./version.js";

/**
 * `backupdrill exporter`:按 Prometheus 文本格式暴露桶里备份与演练的状态。
 * 规矩照 https://prometheus.io/docs/instrumenting/writing_exporters/ :
 *  - 每次抓取现读桶,不按自己的定时器预取,不报旧值;
 *  - 读不了桶时照样回 200,backupdrill_up 为 0,其余业务指标不出(半套数据比没有更误导);
 *  - 指标不带标签(一个 exporter 进程只看一个项目,项目名属于 Prometheus 那边的 target 标签),
 *    连接串、key、桶名一律不进指标。
 */

/** 10059:Prometheus wiki「Default port allocations」上 10058 之后的第一个空位(2026-10-20 查)。 */
export const DEFAULT_EXPORTER_PORT = 10059;

/** 没有 Prometheus 超时头时(手动 curl)给读桶留的时间,与 Prometheus 默认 scrape_timeout 一致 */
const DEFAULT_SCRAPE_TIMEOUT_MS = 10_000;

/** 最新一份完整快照里 exporter 要用的数,不留整份 manifest(Storage 文件多时 manifest 很大) */
export interface SnapshotSummary {
  createdAt: number; // 毫秒
  dumpBytes: number;
  storageFiles: number;
  storageBytes: number;
  tables: number;
  estimatedRows: number;
}

export interface BucketState {
  /** <prefix>/<project>/ 下的快照目录数,含没写完 manifest 的 */
  snapshots: number;
  /** 最新一份有 manifest.json 的快照;一份都没有时为 null */
  latest: SnapshotSummary | null;
  lastDrill: DrillRecord | null;
  lastPassedDrill: DrillRecord | null;
}

type ObjectRead =
  | { status: "missing" }
  | { status: "not-modified" }
  | { status: "ok"; text: string; etag?: string };

function httpStatusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

async function readObject(
  s3: S3Client,
  bucket: string,
  key: string,
  abortSignal: AbortSignal,
  ifNoneMatch?: string
): Promise<ObjectRead> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: ifNoneMatch }),
      { abortSignal }
    );
    return { status: "ok", text: await res.Body!.transformToString(), etag: res.ETag };
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === 304) return { status: "not-modified" };
    if (status === 404 || (error as Error).name === "NoSuchKey") return { status: "missing" };
    throw error;
  }
}

function summarize(text: string, key: string): SnapshotSummary {
  const manifest = parseManifest(text);
  // parseManifest 不校验 createdAt(演练和恢复用不到),这里要拿它当备份时间,自己把关
  const createdAt = Date.parse(manifest.createdAt);
  if (!Number.isFinite(createdAt)) {
    throw new Error(`${key} is malformed: createdAt`);
  }
  return {
    createdAt,
    dumpBytes: manifest.dump.bytes,
    storageFiles: manifest.storage?.fileCount ?? 0,
    storageBytes: manifest.storage?.totalBytes ?? 0,
    tables: manifest.database.tableCount,
    estimatedRows: manifest.database.estimatedRowTotal,
  };
}

async function readDrillRecord(
  s3: S3Client,
  config: BackupConfig,
  file: string,
  abortSignal: AbortSignal
): Promise<DrillRecord | null> {
  const key = drillRecordKey(config, file);
  const read = await readObject(s3, requireBucket(config).bucket, key, abortSignal);
  return read.status === "ok" ? parseDrillRecord(read.text, file) : null;
}

/**
 * 读桶的函数。每次调用都现读;唯一记住的是最新一份 manifest 的 ETag 和摘要:
 * 下次带 If-None-Match 去问,没变就是 304、不传正文。快照写完就不再改,而一份 manifest 列着
 * 每个 Storage 文件,可能有几十 MB,每 30 秒整份下载一遍会变成用户账单上的流量。
 */
export function createBucketReader(
  s3: S3Client,
  config: BackupConfig
): (abortSignal: AbortSignal) => Promise<BucketState> {
  const storage = requireBucket(config);
  const root = `${storage.prefix}/${config.projectName}/`;
  let remembered: { key: string; etag: string; summary: SnapshotSummary } | null = null;

  return async (abortSignal) => {
    const prefixes = (await listSnapshotPrefixes(s3, storage.bucket, root, abortSignal))
      .sort()
      .reverse();

    // manifest 是快照的完成标记,最后写。目录在、manifest 不在 = 备份还在跑或中途失败了,
    // 往前找上一份完整的。不设上限:找太久就撞上抓取超时,报 up=0,这本身就该有人去看
    let latest: SnapshotSummary | null = null;
    for (const prefix of prefixes) {
      const key = `${prefix}manifest.json`;
      const known = remembered?.key === key ? remembered : null;
      const read = await readObject(s3, storage.bucket, key, abortSignal, known?.etag);
      if (read.status === "missing") continue;
      if (read.status === "not-modified" && known) {
        latest = known.summary;
      } else if (read.status === "ok") {
        latest = summarize(read.text, key);
        remembered = read.etag ? { key, etag: read.etag, summary: latest } : null;
      } else {
        // 没带 If-None-Match 却收到 304:对端行为不对,别猜
        throw new Error(`unexpected 304 Not Modified for ${key}`);
      }
      break;
    }

    const [lastDrill, lastPassedDrill] = await Promise.all([
      readDrillRecord(s3, config, LAST_DRILL_FILE, abortSignal),
      readDrillRecord(s3, config, LAST_PASSED_DRILL_FILE, abortSignal),
    ]);
    return { snapshots: prefixes.length, latest, lastDrill, lastPassedDrill };
  };
}

interface MetricFamily {
  name: string;
  help: string;
  samples: Array<{ labels?: Record<string, string>; value: number }>;
}

const escapeHelp = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const escapeLabel = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const seconds = (ms: number) => ms / 1000;

function gauge(name: string, help: string, value: number | null): MetricFamily | null {
  return value === null ? null : { name, help, samples: [{ value }] };
}

/** state 为 null = 这次没读成桶。全部是 gauge:都是"某一刻的状态",没有一个会只增不减。 */
export function renderMetrics(state: BucketState | null, scrapeSeconds: number): string {
  const latest = state?.latest ?? null;
  const lastDrill = state?.lastDrill ?? null;
  const lastPassed = state?.lastPassedDrill ?? null;

  const families: Array<MetricFamily | null> = [
    gauge("backupdrill_up", "Whether the last read of the backup bucket worked (1) or failed (0).", state ? 1 : 0),
    gauge(
      "backupdrill_scrape_duration_seconds",
      "How long this scrape took to read the backup bucket.",
      scrapeSeconds
    ),
    {
      name: "backupdrill_build_info",
      help: "The backupdrill CLI version running this exporter. Always 1.",
      samples: [{ labels: { version: TOOL_VERSION }, value: 1 }],
    },
  ];

  if (state) {
    families.push(
      gauge(
        "backupdrill_snapshots",
        "Snapshot folders under <prefix>/<project>/, including ones without a manifest.json yet.",
        state.snapshots
      ),
      gauge(
        "backupdrill_backup_last_success_timestamp_seconds",
        "When the newest complete snapshot finished (its manifest.json createdAt), as a Unix timestamp. 0 if there is none.",
        latest ? seconds(latest.createdAt) : 0
      ),
      gauge(
        "backupdrill_latest_snapshot_dump_bytes",
        "Size of the database dump (pg_dump custom format) in the newest complete snapshot.",
        latest?.dumpBytes ?? null
      ),
      gauge(
        "backupdrill_latest_snapshot_storage_files",
        "Supabase Storage files in the newest complete snapshot. 0 for a database-only backup.",
        latest?.storageFiles ?? null
      ),
      gauge(
        "backupdrill_latest_snapshot_storage_bytes",
        "Total size of the Supabase Storage files in the newest complete snapshot.",
        latest?.storageBytes ?? null
      ),
      gauge(
        "backupdrill_latest_snapshot_tables",
        "Tables, partitioned tables and materialized views captured in the newest complete snapshot.",
        latest?.tables ?? null
      ),
      gauge(
        "backupdrill_latest_snapshot_estimated_rows",
        "Row count of the newest complete snapshot, estimated from Postgres statistics (n_live_tup) at backup time.",
        latest?.estimatedRows ?? null
      ),
      gauge(
        "backupdrill_drill_last_run_timestamp_seconds",
        "When the last drill recorded with --record finished, passed or not, as a Unix timestamp. 0 if none is recorded.",
        lastDrill ? seconds(Date.parse(lastDrill.finishedAt)) : 0
      ),
      gauge(
        "backupdrill_drill_last_run_passed",
        "Whether the last recorded drill passed (1) or not (0).",
        lastDrill ? (lastDrill.pass ? 1 : 0) : null
      ),
      gauge(
        "backupdrill_drill_last_success_timestamp_seconds",
        "When the last passing drill recorded with --record finished, as a Unix timestamp. 0 if none is recorded.",
        lastPassed ? seconds(Date.parse(lastPassed.finishedAt)) : 0
      ),
      gauge(
        "backupdrill_drill_last_success_restore_duration_seconds",
        "How long the database restore took in the last passing recorded drill.",
        lastPassed?.restoreSeconds ?? null
      )
    );
  }

  const lines: string[] = [];
  for (const family of families) {
    if (!family) continue;
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`, `# TYPE ${family.name} gauge`);
    for (const sample of family.samples) {
      const labels = sample.labels
        ? `{${Object.entries(sample.labels)
            .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
            .join(",")}}`
        : "";
      lines.push(`${family.name}${labels} ${sample.value}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * 读桶的时限跟着 Prometheus 走:它在请求头里告诉我们这次抓取最多等多久,留半秒余量,
 * 好让超时的这次还能回一个 up=0,而不是被 Prometheus 当成 exporter 挂了。
 */
export function scrapeTimeoutMs(header: string | string[] | undefined): number {
  const value = Number(Array.isArray(header) ? header[0] : header);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SCRAPE_TIMEOUT_MS;
  return Math.max(value - 0.5, value / 2) * 1000;
}

const LANDING_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>backupdrill exporter</title></head>
<body>
<h1>backupdrill exporter</h1>
<p>Version ${TOOL_VERSION}. Prometheus metrics for the backups and recorded restore drills in one project's bucket.</p>
<p><a href="/metrics">Metrics</a></p>
</body>
</html>
`;

export function createExporterServer(
  read: (abortSignal: AbortSignal) => Promise<BucketState>
): Server {
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed\n");
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(LANDING_PAGE);
      return;
    }
    if (path !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found\n");
      return;
    }

    const started = performance.now();
    const timeoutMs = scrapeTimeoutMs(req.headers["x-prometheus-scrape-timeout-seconds"]);
    let state: BucketState | null = null;
    try {
      state = await read(AbortSignal.timeout(timeoutMs));
    } catch (error) {
      const e = error as Error;
      const reason =
        e.name === "TimeoutError" || e.name === "AbortError"
          ? `timed out after ${(timeoutMs / 1000).toFixed(1)}s`
          : e.message;
      log.warn(`Could not read the backup bucket: ${reason}`);
    }
    // 微秒够用,免得样本里出现 0.021267749999999978 这种浮点尾巴
    const body = renderMetrics(state, Number(((performance.now() - started) / 1000).toFixed(6)));
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(body);
  });
}

/** CLI 的 `backupdrill exporter`:起 HTTP 服务,直到进程被停掉。 */
export async function startExporter(
  config: BackupConfig,
  opts: { host: string; port: number }
): Promise<Server> {
  const storage = requireBucket(config);
  const server = createExporterServer(createBucketReader(targetClient(config), config));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // 报实际绑定的端口:--port 0 时由系统挑
  const port = (server.address() as AddressInfo).port;
  const shownHost = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  log.ok(
    `Serving metrics for s3://${storage.bucket}/${storage.prefix}/${config.projectName}/ ` +
      `at http://${shownHost}:${port}/metrics`
  );
  return server;
}
