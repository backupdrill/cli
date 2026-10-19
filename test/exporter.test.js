// backupdrill exporter:每次抓取现读桶,按 Prometheus 文本格式报备份和演练的状态。
// 用内存假桶 + 真 SDK 走真 HTTP,钉住:选哪份快照、演练记录怎么读、读不了桶时只报 up=0、
// manifest 没变时不重新下载、超时、HTTP 路由。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createBucketReader, createExporterServer, renderMetrics, scrapeTimeoutMs } from "../dist/exporter.js";
import { TOOL_VERSION } from "../dist/version.js";
import { startFakeS3, manifestJson } from "./fake-s3.js";

const CONFIG = (bucket) => ({
  databaseUrl: "postgresql://unused",
  projectName: "my-app",
  schemas: ["public"],
  storage: {
    region: "us-east-1",
    bucket,
    accessKeyId: "test",
    secretAccessKey: "test",
    prefix: "backupdrill",
    forcePathStyle: true,
  },
});

const ROOT = "backupdrill/my-app/";
const OLD = "2026-10-18T03-00-00-000Z";
const NEW = "2026-10-19T03-00-00-000Z";
const RUNNING = "2026-10-20T03-00-00-000Z";

function putSnapshot(fake, snapshot, createdAt, extra = {}) {
  fake.objects.set(`${ROOT}${snapshot}/dump.pgcustom`, Buffer.from("PGDMP"));
  fake.objects.set(
    `${ROOT}${snapshot}/manifest.json`,
    Buffer.from(manifestJson({ snapshot, createdAt, ...extra }))
  );
}

function drillRecord(over) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      tool: "backupdrill-cli",
      toolVersion: "2.6.0",
      ...over,
    })
  );
}

/** 文本格式解析成 { name -> value };带标签的样本用完整的 name{labels} 作键 */
function parseMetrics(text) {
  const values = {};
  for (const line of text.trim().split("\n")) {
    if (line.startsWith("#")) continue;
    const at = line.lastIndexOf(" ");
    values[line.slice(0, at)] = Number(line.slice(at + 1));
  }
  return values;
}

async function withQuietLog(run) {
  const warnings = [];
  const m = mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  try {
    return await run(warnings);
  } finally {
    m.mock.restore();
  }
}

test("最新一份完整快照:跳过还没写 manifest 的目录,快照数含它", async () => {
  const fake = await startFakeS3();
  try {
    putSnapshot(fake, OLD, "2026-10-18T03:04:00.000Z", { dumpBytes: 1000 });
    putSnapshot(fake, NEW, "2026-10-19T03:05:30.500Z", {
      dumpBytes: 2048,
      rows: 900,
      storage: {
        fileCount: 2,
        totalBytes: 30,
        files: [
          { bucket: "avatars", key: "a.png", bytes: 10, sha256: "a".repeat(64) },
          { bucket: "avatars", key: "b.png", bytes: 20, sha256: "b".repeat(64) },
        ],
      },
    });
    // 正在跑的备份:dump 已上传,manifest 还没写
    fake.objects.set(`${ROOT}${RUNNING}/dump.pgcustom`, Buffer.from("PGDMP"));

    const read = createBucketReader(fake.s3, CONFIG(fake.bucket));
    const m = parseMetrics(renderMetrics(await read(AbortSignal.timeout(5000)), 0.1));
    assert.equal(m.backupdrill_up, 1);
    assert.equal(m.backupdrill_snapshots, 3);
    assert.equal(m.backupdrill_backup_last_success_timestamp_seconds, Date.parse("2026-10-19T03:05:30.500Z") / 1000);
    assert.equal(m.backupdrill_latest_snapshot_dump_bytes, 2048);
    assert.equal(m.backupdrill_latest_snapshot_storage_files, 2);
    assert.equal(m.backupdrill_latest_snapshot_storage_bytes, 30);
    assert.equal(m.backupdrill_latest_snapshot_tables, 2);
    assert.equal(m.backupdrill_latest_snapshot_estimated_rows, 900);
  } finally {
    await fake.close();
  }
});

test("只备数据库的快照:Storage 两项是 0", async () => {
  const fake = await startFakeS3();
  try {
    putSnapshot(fake, NEW, "2026-10-19T03:05:00.000Z");
    const m = parseMetrics(
      renderMetrics(await createBucketReader(fake.s3, CONFIG(fake.bucket))(AbortSignal.timeout(5000)), 0)
    );
    assert.equal(m.backupdrill_latest_snapshot_storage_files, 0);
    assert.equal(m.backupdrill_latest_snapshot_storage_bytes, 0);
  } finally {
    await fake.close();
  }
});

test("桶里还没有快照、没有演练记录:up=1,两个时间是 0,其余不出", async () => {
  const fake = await startFakeS3();
  try {
    const text = renderMetrics(await createBucketReader(fake.s3, CONFIG(fake.bucket))(AbortSignal.timeout(5000)), 0);
    const m = parseMetrics(text);
    assert.equal(m.backupdrill_up, 1);
    assert.equal(m.backupdrill_snapshots, 0);
    assert.equal(m.backupdrill_backup_last_success_timestamp_seconds, 0);
    assert.equal(m.backupdrill_drill_last_run_timestamp_seconds, 0);
    assert.equal(m.backupdrill_drill_last_success_timestamp_seconds, 0);
    for (const absent of [
      "backupdrill_latest_snapshot_dump_bytes",
      "backupdrill_drill_last_run_passed",
      "backupdrill_drill_last_success_restore_duration_seconds",
    ]) {
      assert.ok(!text.includes(absent), `${absent} should be absent`);
    }
  } finally {
    await fake.close();
  }
});

test("演练记录:最近一次没通过时,上一次通过的时间和恢复用时还在", async () => {
  const fake = await startFakeS3();
  try {
    putSnapshot(fake, NEW, "2026-10-19T03:05:00.000Z");
    fake.objects.set(
      `${ROOT}last-drill.json`,
      drillRecord({ finishedAt: "2026-10-20T04:00:00.000Z", pass: false, snapshot: NEW })
    );
    fake.objects.set(
      `${ROOT}last-passed-drill.json`,
      drillRecord({ finishedAt: "2026-10-13T04:00:00.000Z", pass: true, snapshot: OLD, restoreSeconds: 42.5 })
    );
    const m = parseMetrics(
      renderMetrics(await createBucketReader(fake.s3, CONFIG(fake.bucket))(AbortSignal.timeout(5000)), 0)
    );
    assert.equal(m.backupdrill_drill_last_run_timestamp_seconds, Date.parse("2026-10-20T04:00:00.000Z") / 1000);
    assert.equal(m.backupdrill_drill_last_run_passed, 0);
    assert.equal(m.backupdrill_drill_last_success_timestamp_seconds, Date.parse("2026-10-13T04:00:00.000Z") / 1000);
    assert.equal(m.backupdrill_drill_last_success_restore_duration_seconds, 42.5);
    // 演练记录是 <project>/ 下的对象,不是目录,不能算进快照
    assert.equal(m.backupdrill_snapshots, 1);
  } finally {
    await fake.close();
  }
});

test("manifest 没变:第二次抓取带 If-None-Match,拿到 304 不传正文,数值不变;换了新快照就读新的", async () => {
  const fake = await startFakeS3();
  try {
    putSnapshot(fake, OLD, "2026-10-18T03:04:00.000Z", { dumpBytes: 1000 });
    const read = createBucketReader(fake.s3, CONFIG(fake.bucket));
    const first = parseMetrics(renderMetrics(await read(AbortSignal.timeout(5000)), 0));

    fake.requests.length = 0;
    const second = parseMetrics(renderMetrics(await read(AbortSignal.timeout(5000)), 0));
    const manifestGets = fake.requests.filter((r) => r.key.endsWith("manifest.json"));
    assert.equal(manifestGets.length, 1);
    assert.ok(manifestGets[0].ifNoneMatch, "second read should send If-None-Match");
    assert.equal(second.backupdrill_latest_snapshot_dump_bytes, first.backupdrill_latest_snapshot_dump_bytes);
    assert.equal(
      second.backupdrill_backup_last_success_timestamp_seconds,
      first.backupdrill_backup_last_success_timestamp_seconds
    );

    putSnapshot(fake, NEW, "2026-10-19T03:05:00.000Z", { dumpBytes: 3000 });
    fake.requests.length = 0;
    const third = parseMetrics(renderMetrics(await read(AbortSignal.timeout(5000)), 0));
    assert.equal(third.backupdrill_latest_snapshot_dump_bytes, 3000);
    assert.equal(fake.requests.find((r) => r.key.endsWith(`${NEW}/manifest.json`)).ifNoneMatch, null);
  } finally {
    await fake.close();
  }
});

test("快照目录多过一页:分页列完", async () => {
  const fake = await startFakeS3({ pageSize: 2 });
  try {
    for (let day = 10; day <= 14; day++) {
      putSnapshot(fake, `2026-10-${day}T03-00-00-000Z`, `2026-10-${day}T03:05:00.000Z`);
    }
    const m = parseMetrics(
      renderMetrics(await createBucketReader(fake.s3, CONFIG(fake.bucket))(AbortSignal.timeout(5000)), 0)
    );
    assert.equal(m.backupdrill_snapshots, 5);
    assert.equal(m.backupdrill_backup_last_success_timestamp_seconds, Date.parse("2026-10-14T03:05:00.000Z") / 1000);
  } finally {
    await fake.close();
  }
});

for (const [name, setup, expectedWarning] of [
  [
    "桶拒绝访问",
    (fake) => fake.fail(() => ({ status: 403, code: "AccessDenied" })),
    /AccessDenied/,
  ],
  [
    "manifest 坏了",
    (fake) => fake.objects.set(`${ROOT}${NEW}/manifest.json`, Buffer.from("{not json")),
    /manifest\.json is not valid JSON/,
  ],
  [
    "manifest 没有可读的 createdAt",
    (fake) =>
      fake.objects.set(
        `${ROOT}${NEW}/manifest.json`,
        Buffer.from(manifestJson({ snapshot: NEW, createdAt: "yesterday" }))
      ),
    /createdAt/,
  ],
  [
    "演练记录结构不对",
    (fake) => fake.objects.set(`${ROOT}last-drill.json`, drillRecord({ finishedAt: "2026-10-20T04:00:00Z", pass: "yes" })),
    /last-drill\.json is malformed: pass/,
  ],
  [
    "演练记录是更新的 CLI 写的",
    (fake) =>
      fake.objects.set(
        `${ROOT}last-passed-drill.json`,
        drillRecord({ schemaVersion: 2, finishedAt: "2026-10-20T04:00:00Z", pass: true })
      ),
    /Upgrade the CLI/,
  ],
]) {
  test(`读不成桶(${name}):回 200,只有 up=0、抓取用时和版本,日志写原因`, async () => {
    const fake = await startFakeS3();
    try {
      putSnapshot(fake, OLD, "2026-10-18T03:04:00.000Z");
      setup(fake);
      const server = createExporterServer(createBucketReader(fake.s3, CONFIG(fake.bucket)));
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        await withQuietLog(async (warnings) => {
          const res = await fetch(`http://127.0.0.1:${server.address().port}/metrics`);
          assert.equal(res.status, 200);
          const m = parseMetrics(await res.text());
          assert.deepEqual(Object.keys(m).sort(), [
            `backupdrill_build_info{version="${TOOL_VERSION}"}`,
            "backupdrill_scrape_duration_seconds",
            "backupdrill_up",
          ]);
          assert.equal(m.backupdrill_up, 0);
          assert.match(warnings.join("\n"), expectedWarning);
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      await fake.close();
    }
  });
}

test("桶不回应:按 Prometheus 给的超时放弃,报 up=0,不拖过抓取时限", async () => {
  const fake = await startFakeS3();
  try {
    fake.fail(() => "hang");
    const server = createExporterServer(createBucketReader(fake.s3, CONFIG(fake.bucket)));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await withQuietLog(async (warnings) => {
        const started = Date.now();
        const res = await fetch(`http://127.0.0.1:${server.address().port}/metrics`, {
          headers: { "X-Prometheus-Scrape-Timeout-Seconds": "1" },
        });
        const elapsed = Date.now() - started;
        assert.equal(parseMetrics(await res.text()).backupdrill_up, 0);
        assert.ok(elapsed < 1000, `took ${elapsed}ms, Prometheus would have given up at 1000ms`);
        assert.match(warnings.join("\n"), /timed out after 0\.5s/);
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await fake.close();
  }
});

test("抓取时限:跟着 Prometheus 的请求头走,留余量;没有头时 10 秒", () => {
  assert.equal(scrapeTimeoutMs("10"), 9500);
  assert.equal(scrapeTimeoutMs("1"), 500);
  assert.equal(scrapeTimeoutMs(undefined), 10_000);
  assert.equal(scrapeTimeoutMs("abc"), 10_000);
  assert.equal(scrapeTimeoutMs("0"), 10_000);
});

test("HTTP:/metrics 的 Content-Type、首页链到 /metrics、其他路径 404、非 GET 405", async () => {
  const server = createExporterServer(async () => ({ snapshots: 0, latest: null, lastDrill: null, lastPassedDrill: null }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
    const landing = await fetch(`${base}/`);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /<a href="\/metrics">/);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/metrics`, { method: "POST" })).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("文本格式:每个指标先 HELP 后 TYPE gauge,名字合规,只有 build_info 带标签", () => {
  const text = renderMetrics(
    {
      snapshots: 3,
      latest: {
        createdAt: Date.parse("2026-10-19T03:05:00Z"),
        dumpBytes: 1,
        storageFiles: 0,
        storageBytes: 0,
        tables: 1,
        estimatedRows: 1,
      },
      lastDrill: { schemaVersion: 1, tool: "backupdrill-cli", toolVersion: "x", finishedAt: "2026-10-20T00:00:00Z", pass: true, restoreSeconds: 3 },
      lastPassedDrill: { schemaVersion: 1, tool: "backupdrill-cli", toolVersion: "x", finishedAt: "2026-10-20T00:00:00Z", pass: true, restoreSeconds: 3 },
    },
    0.25
  );
  const lines = text.trim().split("\n");
  const names = [];
  for (let i = 0; i < lines.length; ) {
    const help = /^# HELP (\S+) .+$/.exec(lines[i]);
    assert.ok(help, `expected HELP at line ${i}: ${lines[i]}`);
    const name = help[1];
    assert.match(name, /^backupdrill_[a-z_]+$/);
    assert.equal(lines[i + 1], `# TYPE ${name} gauge`);
    i += 2;
    while (i < lines.length && !lines[i].startsWith("#")) {
      assert.ok(lines[i].startsWith(name), `sample ${lines[i]} under ${name}`);
      if (name !== "backupdrill_build_info") assert.ok(!lines[i].includes("{"), `unexpected label: ${lines[i]}`);
      i++;
    }
    names.push(name);
  }
  assert.equal(new Set(names).size, names.length, "metric names must be unique");
  assert.equal(names.length, 14);
});

test("CLI:exporter 子命令起服务、读环境变量里的桶、--port 校验", async () => {
  const fake = await startFakeS3();
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const env = {
    PATH: process.env.PATH,
    NO_COLOR: "1",
    BACKUPDRILL_S3_ENDPOINT: fake.endpoint,
    BACKUPDRILL_S3_REGION: "us-east-1",
    BACKUPDRILL_S3_BUCKET: fake.bucket,
    BACKUPDRILL_S3_ACCESS_KEY_ID: "test",
    BACKUPDRILL_S3_SECRET_ACCESS_KEY: "test",
    BACKUPDRILL_PROJECT_NAME: "my-app",
  };
  try {
    putSnapshot(fake, NEW, "2026-10-19T03:05:00.000Z");
    const bad = spawn(process.execPath, [cli, "exporter", "--port", "70000"], { env, cwd: "/" });
    let badErr = "";
    bad.stderr.on("data", (c) => (badErr += c));
    assert.equal(await new Promise((resolve) => bad.on("exit", resolve)), 1);
    assert.match(badErr, /--port must be a whole number from 1 to 65535/);

    // 先占一个空闲端口再放掉,交给子进程用
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const child = spawn(process.execPath, [cli, "exporter", "--port", String(port)], { env, cwd: "/" });
    try {
      // 从启动日志里读出地址,顺带确认日志报的是实际端口
      const url = await new Promise((resolve, reject) => {
        let err = "";
        child.stderr.on("data", (c) => {
          err += c;
          const hit = /at (http:\/\/127\.0\.0\.1:\d+\/metrics)/.exec(err);
          if (hit) resolve(hit[1]);
        });
        child.on("exit", () => reject(new Error(`exporter exited: ${err}`)));
      });
      assert.equal(url, `http://127.0.0.1:${port}/metrics`);
      const m = parseMetrics(await (await fetch(url)).text());
      assert.equal(m.backupdrill_up, 1);
      assert.equal(m.backupdrill_snapshots, 1);
    } finally {
      child.kill();
    }
  } finally {
    await fake.close();
  }
});
