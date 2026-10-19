// drill --record:演练结论写进桶,给 exporter 读。钉住记什么、不记什么、写到哪、写不进去时
// 不改演练结论,以及记录文件放在 <project>/ 下不会被当成快照。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildDrillRecord,
  parseDrillRecord,
  recordDrillOutcome,
  writeDrillRecord,
} from "../dist/drill-record.js";
import { resolveSnapshot } from "../dist/snapshots.js";
import { TOOL_VERSION } from "../dist/version.js";
import { startFakeS3 } from "./fake-s3.js";

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

const FINISHED = new Date("2026-01-20T04:00:00.000Z");
const PASSED_REPORT = {
  snapshot: "2026-10-19T03-00-00-000Z",
  pass: true,
  checks: [{ name: "archive integrity", pass: true, detail: "sha256 matches" }],
  restoreSeconds: 41,
  restoredTableCount: 2,
  restoredRowTotal: 500,
};
const FAILED_REPORT = {
  ...PASSED_REPORT,
  pass: false,
  checks: [{ name: "pg_restore", pass: false, detail: 'DETAIL: Key (email)=(someone@example.com) already exists.' }],
  restoreSeconds: 7,
};

test("通过的演练:记快照名和恢复用时,不记检查明细", () => {
  const record = buildDrillRecord(PASSED_REPORT, FINISHED);
  assert.deepEqual(record, {
    schemaVersion: 1,
    tool: "backupdrill-cli",
    toolVersion: TOOL_VERSION,
    finishedAt: "2026-01-20T04:00:00.000Z",
    pass: true,
    snapshot: "2026-10-19T03-00-00-000Z",
    restoreSeconds: 41,
  });
});

test("没通过的演练:不记恢复用时(可能只是半程),失败明细里的表数据不进桶", () => {
  const record = buildDrillRecord(FAILED_REPORT, FINISHED);
  assert.equal(record.pass, false);
  assert.equal(record.restoreSeconds, undefined);
  assert.ok(!JSON.stringify(record).includes("someone@example.com"));
});

test("中途抛错、没有报告:记一次没通过,不带快照名", () => {
  const record = buildDrillRecord(null, FINISHED);
  assert.equal(record.pass, false);
  assert.equal(record.snapshot, undefined);
  assert.equal(record.restoreSeconds, undefined);
});

test("写到哪:通过时写 last-drill.json 和 last-passed-drill.json,没通过只写 last-drill.json", async () => {
  const fake = await startFakeS3();
  try {
    const config = CONFIG(fake.bucket);
    await writeDrillRecord(fake.s3, config, buildDrillRecord(PASSED_REPORT, FINISHED));
    assert.deepEqual([...fake.objects.keys()].sort(), [
      "backupdrill/my-app/last-drill.json",
      "backupdrill/my-app/last-passed-drill.json",
    ]);

    const later = new Date("2026-01-27T04:00:00.000Z");
    await writeDrillRecord(fake.s3, config, buildDrillRecord(FAILED_REPORT, later));
    const last = JSON.parse(fake.objects.get("backupdrill/my-app/last-drill.json"));
    const lastPassed = JSON.parse(fake.objects.get("backupdrill/my-app/last-passed-drill.json"));
    assert.equal(last.pass, false);
    assert.equal(last.finishedAt, later.toISOString());
    assert.equal(lastPassed.finishedAt, FINISHED.toISOString());
  } finally {
    await fake.close();
  }
});

test("写不进去(只读 key):只警告,不抛错", async () => {
  const fake = await startFakeS3();
  const warnings = [];
  const m = mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  try {
    fake.fail((req) => (req.method === "PUT" ? { status: 403, code: "AccessDenied" } : null));
    await recordDrillOutcome(CONFIG(fake.bucket), PASSED_REPORT, fake.s3);
    assert.match(warnings.join("\n"), /Could not record the drill result.*--record needs write access/s);
    assert.equal(fake.objects.size, 0);
  } finally {
    m.mock.restore();
    await fake.close();
  }
});

test("两次演练重叠:晚写进桶的旧结论不盖掉更新的结论", async () => {
  const fake = await startFakeS3();
  const warnings = [];
  const m = mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  try {
    const config = CONFIG(fake.bucket);
    const newerFailure = buildDrillRecord(FAILED_REPORT, new Date("2026-01-20T05:00:00.000Z"));
    const olderSuccess = buildDrillRecord(PASSED_REPORT, new Date("2026-01-20T04:00:00.000Z"));
    await writeDrillRecord(fake.s3, config, newerFailure);
    await writeDrillRecord(fake.s3, config, olderSuccess);
    const last = JSON.parse(fake.objects.get("backupdrill/my-app/last-drill.json"));
    assert.equal(last.pass, false, "the newer failure must survive");
    assert.equal(last.finishedAt, "2026-01-20T05:00:00.000Z");
    // last-passed-drill.json 里还没有更新的,旧的通过照常写进去
    assert.equal(JSON.parse(fake.objects.get("backupdrill/my-app/last-passed-drill.json")).finishedAt, "2026-01-20T04:00:00.000Z");
    assert.match(warnings.join("\n"), /last-drill\.json already holds a newer drill/);
  } finally {
    m.mock.restore();
    await fake.close();
  }
});

test("桶里的记录时间在将来(被改过或时钟快了):不让它挡住新结论,覆盖并警告", async () => {
  const fake = await startFakeS3();
  const warnings = [];
  const m = mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  try {
    const config = CONFIG(fake.bucket);
    const future = new Date(Date.now() + 365 * 86400_000);
    await writeDrillRecord(fake.s3, config, buildDrillRecord(PASSED_REPORT, future));
    const now = new Date();
    await writeDrillRecord(fake.s3, config, buildDrillRecord(FAILED_REPORT, now));
    const last = JSON.parse(fake.objects.get("backupdrill/my-app/last-drill.json"));
    assert.equal(last.pass, false);
    assert.equal(last.finishedAt, now.toISOString());
    assert.match(warnings.join("\n"), /in the future; overwriting it/);

    // 几分钟的时钟差不算:比自己晚 5 分钟的记录照样当成更新的
    const slightlyAhead = new Date(now.getTime() + 5 * 60_000);
    await writeDrillRecord(fake.s3, config, buildDrillRecord(PASSED_REPORT, slightlyAhead));
    await writeDrillRecord(fake.s3, config, buildDrillRecord(FAILED_REPORT, now));
    assert.equal(JSON.parse(fake.objects.get("backupdrill/my-app/last-drill.json")).finishedAt, slightlyAhead.toISOString());
  } finally {
    m.mock.restore();
    await fake.close();
  }
});

test("桶里是更新的 CLI 写的记录(schemaVersion 2):不覆盖,警告里提示升级", async () => {
  const fake = await startFakeS3();
  const warnings = [];
  const m = mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  try {
    const v2 = Buffer.from(JSON.stringify({ schemaVersion: 2, finishedAt: "2026-01-19T00:00:00.000Z", pass: true }));
    fake.objects.set("backupdrill/my-app/last-drill.json", v2);
    await recordDrillOutcome(CONFIG(fake.bucket), FAILED_REPORT, fake.s3);
    assert.equal(fake.requests.filter((r) => r.method === "PUT").length, 0);
    assert.deepEqual(fake.objects.get("backupdrill/my-app/last-drill.json"), v2);
    assert.match(warnings.join("\n"), /Could not record the drill result.*Upgrade the CLI/s);
  } finally {
    m.mock.restore();
    await fake.close();
  }
});

test("桶接了请求不回应:记一笔有时限,演练不会卡住", async () => {
  const fake = await startFakeS3();
  const warnings = [];
  const m = mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  try {
    fake.fail((req) => (req.method === "PUT" ? "hang" : null));
    const started = Date.now();
    await recordDrillOutcome(CONFIG(fake.bucket), PASSED_REPORT, fake.s3, 300);
    assert.ok(Date.now() - started < 2000, "should give up after the deadline");
    assert.match(warnings.join("\n"), /no answer from the bucket within 0\.3s/);
  } finally {
    m.mock.restore();
    await fake.close();
  }
});

test("记录文件在 <project>/ 下,resolveSnapshot 照样选最新的快照目录", async () => {
  const fake = await startFakeS3();
  try {
    const config = CONFIG(fake.bucket);
    fake.objects.set("backupdrill/my-app/2026-10-19T03-00-00-000Z/manifest.json", Buffer.from("{}"));
    await writeDrillRecord(fake.s3, config, buildDrillRecord(PASSED_REPORT, FINISHED));
    // "last-..." 按字典序排在时间戳后面;要是被当成目录,这里会选错
    assert.equal(
      await resolveSnapshot(fake.s3, config),
      "backupdrill/my-app/2026-10-19T03-00-00-000Z/"
    );
  } finally {
    await fake.close();
  }
});

test("parseDrillRecord:读回自己写的;拒绝错型、缺字段和更新的版本", () => {
  const ok = JSON.stringify(buildDrillRecord(PASSED_REPORT, FINISHED));
  assert.equal(parseDrillRecord(ok, "last-drill.json").restoreSeconds, 41);

  const bad = (over) => JSON.stringify({ ...JSON.parse(ok), ...over });
  assert.throws(() => parseDrillRecord("[]", "f"), /root is not an object/);
  assert.throws(() => parseDrillRecord("nope", "f"), /not valid JSON/);
  assert.throws(() => parseDrillRecord(bad({ schemaVersion: "1" }), "f"), /schemaVersion/);
  assert.throws(() => parseDrillRecord(bad({ schemaVersion: 2 }), "f"), /Upgrade the CLI/);
  assert.throws(() => parseDrillRecord(bad({ finishedAt: "soon" }), "f"), /finishedAt/);
  assert.throws(() => parseDrillRecord(bad({ pass: 1 }), "f"), /pass/);
  assert.throws(() => parseDrillRecord(bad({ snapshot: 5 }), "f"), /snapshot/);
  assert.throws(() => parseDrillRecord(bad({ restoreSeconds: -1 }), "f"), /restoreSeconds/);
});

function runCli(args, env) {
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd: "/" });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

test("CLI:drill --record 在桶里没快照时记一次没通过;不加 --record 不写", async () => {
  const fake = await startFakeS3();
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
    const plain = await runCli(["drill"], env);
    assert.equal(plain.code, 1);
    assert.match(plain.stderr, /No snapshots found/);
    assert.equal(fake.objects.size, 0);

    const recorded = await runCli(["drill", "--record"], env);
    assert.equal(recorded.code, 1);
    assert.match(recorded.stderr, /Drill result recorded/);
    const record = JSON.parse(fake.objects.get("backupdrill/my-app/last-drill.json"));
    assert.equal(record.pass, false);
    assert.equal(record.snapshot, undefined);
    assert.ok(!fake.objects.has("backupdrill/my-app/last-passed-drill.json"));
  } finally {
    await fake.close();
  }
});
