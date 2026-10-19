// drill --record:每次演练在桶里写一个新对象,给 exporter 读。钉住记什么、不记什么、写到哪、
// 写不进去或桶不回应时不改演练结论,以及记录不在 <project>/ 里、不会被当成快照。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import {
  buildDrillRecord,
  drillRecordName,
  parseDrillRecord,
  parseDrillRecordName,
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
  snapshot: "2026-01-19T03-00-00-000Z",
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

async function quietly(run) {
  const warnings = [];
  const m = mock.method(console, "error", (...args) => warnings.push(args.join(" ")));
  try {
    return await run(warnings);
  } finally {
    m.mock.restore();
  }
}

test("通过的演练:记快照名和恢复用时,不记检查明细", () => {
  assert.deepEqual(buildDrillRecord(PASSED_REPORT, FINISHED), {
    schemaVersion: 1,
    tool: "backupdrill-cli",
    toolVersion: TOOL_VERSION,
    finishedAt: "2026-01-20T04:00:00.000Z",
    pass: true,
    snapshot: "2026-01-19T03-00-00-000Z",
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

test("文件名:结束时间 + 结论,能原样读回;别的名字不认", () => {
  const name = drillRecordName(buildDrillRecord(PASSED_REPORT, FINISHED));
  assert.equal(name, "2026-01-20T04-00-00-000Z-passed.json");
  assert.deepEqual(parseDrillRecordName(name), { finishedAt: FINISHED.getTime(), pass: true });
  assert.deepEqual(parseDrillRecordName("2026-01-20T04-00-00-000Z-failed.json"), {
    finishedAt: FINISHED.getTime(),
    pass: false,
  });
  for (const other of ["notes.txt", "2026-01-20T04-00-00Z-passed.json", "2026-13-40T99-00-00-000Z-passed.json", "x2026-01-20T04-00-00-000Z-passed.json"]) {
    assert.equal(parseDrillRecordName(other), null, other);
  }
});

test("写到哪:每次一个新对象,在 <project>.drills/ 下;不读桶,也不覆盖之前的", async () => {
  const fake = await startFakeS3();
  try {
    const config = CONFIG(fake.bucket);
    await writeDrillRecord(fake.s3, config, buildDrillRecord(PASSED_REPORT, FINISHED));
    await writeDrillRecord(fake.s3, config, buildDrillRecord(FAILED_REPORT, new Date("2026-01-27T04:00:00.000Z")));
    assert.deepEqual([...fake.objects.keys()].sort(), [
      "backupdrill/my-app.drills/2026-01-20T04-00-00-000Z-passed.json",
      "backupdrill/my-app.drills/2026-01-27T04-00-00-000Z-failed.json",
    ]);
    assert.deepEqual(fake.requests.map((r) => r.method), ["PUT", "PUT"]);
    const passed = JSON.parse(fake.objects.get("backupdrill/my-app.drills/2026-01-20T04-00-00-000Z-passed.json"));
    assert.equal(passed.restoreSeconds, 41);
  } finally {
    await fake.close();
  }
});

test("写不进去(只读 key):只警告,不抛错", async () => {
  const fake = await startFakeS3();
  try {
    fake.fail((req) => (req.method === "PUT" ? { status: 403, code: "AccessDenied" } : null));
    await quietly(async (warnings) => {
      await recordDrillOutcome(CONFIG(fake.bucket), PASSED_REPORT, fake.s3);
      assert.match(warnings.join("\n"), /Could not record the drill result.*--record needs write access/s);
    });
    assert.equal(fake.objects.size, 0);
  } finally {
    await fake.close();
  }
});

test("桶接了请求不回应:记一笔有时限,演练不会卡住", async () => {
  const fake = await startFakeS3();
  try {
    fake.fail((req) => (req.method === "PUT" ? "hang" : null));
    await quietly(async (warnings) => {
      const started = Date.now();
      await recordDrillOutcome(CONFIG(fake.bucket), PASSED_REPORT, fake.s3, 300);
      assert.ok(Date.now() - started < 2000, "should give up after the deadline");
      assert.match(warnings.join("\n"), /no answer from the bucket within 0\.3s/);
    });
  } finally {
    await fake.close();
  }
});

test("桶回 503 + Retry-After:SDK 按默认设置重试在睡,时限照样算数", async () => {
  const fake = await startFakeS3();
  try {
    fake.fail(() => ({ status: 503, code: "SlowDown", headers: { "retry-after": "2" } }));
    const s3 = new S3Client({
      region: "us-east-1",
      endpoint: fake.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await quietly(async (warnings) => {
      const started = Date.now();
      await recordDrillOutcome(CONFIG(fake.bucket), PASSED_REPORT, s3, 300);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 1000, `took ${elapsed}ms with a 300ms limit`);
      assert.match(warnings.join("\n"), /no answer from the bucket within 0\.3s/);
    });
  } finally {
    await fake.close();
  }
});

test("记录不在 <project>/ 里,resolveSnapshot 照样选最新的快照目录", async () => {
  const fake = await startFakeS3();
  try {
    const config = CONFIG(fake.bucket);
    fake.objects.set("backupdrill/my-app/2026-01-19T03-00-00-000Z/manifest.json", Buffer.from("{}"));
    await writeDrillRecord(fake.s3, config, buildDrillRecord(PASSED_REPORT, FINISHED));
    assert.equal(await resolveSnapshot(fake.s3, config), "backupdrill/my-app/2026-01-19T03-00-00-000Z/");
  } finally {
    await fake.close();
  }
});

test("parseDrillRecord:读回自己写的;拒绝错型、缺字段和更新的版本", () => {
  const ok = JSON.stringify(buildDrillRecord(PASSED_REPORT, FINISHED));
  assert.equal(parseDrillRecord(ok, "f").restoreSeconds, 41);

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
    assert.match(recorded.stderr, /Drill result recorded → s3:\/\/backups\/backupdrill\/my-app\.drills\/.*-failed\.json/);
    const [key] = [...fake.objects.keys()];
    assert.match(key, /^backupdrill\/my-app\.drills\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-failed\.json$/);
    const record = JSON.parse(fake.objects.get(key));
    assert.equal(record.pass, false);
    assert.equal(record.snapshot, undefined);
  } finally {
    await fake.close();
  }
});
