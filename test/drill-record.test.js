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

const FINISHED = new Date("2026-10-20T04:00:00.000Z");
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
    finishedAt: "2026-10-20T04:00:00.000Z",
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

    const later = new Date("2026-10-27T04:00:00.000Z");
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
