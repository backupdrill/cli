// auth.dump 上传前抹掉待处理 token(2.11.1)。这里拼出和 pg_dump 管道输出同形的 custom 格式归档
// (不同的归档版本、压缩与不压缩),过一遍改写,再用真的 pg_restore 读回来:不需要数据库,也不需要 Docker。
// 真实 pg_dump 输出的端到端检查在 auth-backup / auth-restore / auth-drill 的测试里。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { createDeflate, deflateSync } from "node:zlib";
import { PENDING_AUTH_COPY_VALUES, copyColumns, scrubPendingAuthTokens } from "../dist/auth-archive.js";
import { CLEAR_PENDING_AUTH_SQL } from "../dist/auth-restore.js";

const x = promisify(execFile);
const pgRestore = process.env.BACKUPDRILL_PG_RESTORE || "pg_restore";
const pgRestoreVersion = await x(pgRestore, ["--version"]).then((r) => r.stdout, () => null);
const pgRestoreMajor = pgRestoreVersion ? Number(/(\d+)(?:\.\d+)?/.exec(pgRestoreVersion)?.[1]) : null;
// 每个归档版本最早能读它的 pg_restore(pg_backup_archiver.h:1.14 = 12,1.15 = 16,1.16 = 17;1.12 早于 10)
const READABLE_FROM = { 12: 10, 14: 12, 15: 16, 16: 17 };
/** 本机 pg_restore 读不了这个版本的归档时跳过,并说清楚原因 */
const needsPgRestoreFor = (minor) =>
  pgRestoreMajor === null
    ? "requires pg_restore"
    : pgRestoreMajor < READABLE_FROM[minor]
      ? `pg_restore ${pgRestoreMajor} can't read archive version 1.${minor} (needs ${READABLE_FROM[minor]} or newer)`
      : false;

const USER_COLUMNS = [
  "id", "email", "encrypted_password", "raw_user_meta_data", "confirmation_token", "recovery_token",
  "email_change_token_new", "email_change_token_current", "phone_change_token", "reauthentication_token",
  "email_change", "phone_change", "email_change_confirm_status", "confirmation_sent_at", "recovery_sent_at",
  "email_change_sent_at", "phone_change_sent_at", "reauthentication_sent_at", "Odd \"name\", here",
];

function userRow(i) {
  return [
    `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `u${i}@example.test`, "$2a$10$hash",
    // 数据里的制表符、换行、反斜杠在 COPY 文本里都是转义过的
    `{"name": "tab\\\\there\\\\nnew ü 中"}`, `conf-${i}`, `reset-${i}`, `new-${i}`, `cur-${i}`, `phone-${i}`, `reauth-${i}`,
    `next${i}@example.test`, "+15550000", "1", "2020-01-01 00:00:00+00", "2020-01-02 00:00:00+00",
    "2020-01-03 00:00:00+00", "\\N", "2020-01-05 00:00:00+00", "x\\ty",
  ].join("\t");
}

const SCRUBBED_EXPECT = new Map(PENDING_AUTH_COPY_VALUES);

/** 拼一份 custom 格式归档:auth.users、auth.identities 两张表的结构和数据,offset 一律"未记录"(管道输出就是这样) */
function buildArchive({
  minor = 16, compression = "gzip", users = 3, chunkSize = 1000, offsetFlag = 1, identitiesBlock = true, usersPayload = null,
} = {}) {
  const intSize = 4;
  const parts = [];
  const byte = (b) => parts.push(Buffer.from([b]));
  const int = (v) => {
    const b = Buffer.alloc(1 + intSize);
    b[0] = v < 0 ? 1 : 0;
    b.writeUInt32LE(Math.abs(v), 1);
    parts.push(b);
  };
  const str = (s) => {
    if (s === null) return int(-1);
    const b = Buffer.from(s, "utf8");
    int(b.length);
    parts.push(b);
  };
  parts.push(Buffer.from("PGDMP"));
  byte(1), byte(minor), byte(0), byte(intSize), byte(8), byte(1);
  if (minor >= 15) byte(compression === "gzip" ? 1 : 0);
  else int(compression === "gzip" ? -1 : 0);
  for (const v of [0, 0, 0, 1, 0, 125, 0]) int(v);
  str("postgres"), str("17.0"), str("17.0");
  const quote = (c) => (/^[a-z_][a-z0-9_]*$/.test(c) ? c : `"${c.replace(/"/g, '""')}"`);
  const entries = [
    { id: 1, tag: "auth", desc: "SCHEMA", section: 2, defn: "CREATE SCHEMA auth;\n", ns: null },
    {
      id: 2, tag: "users", desc: "TABLE", section: 2, ns: "auth",
      defn: `CREATE TABLE auth.users (\n${USER_COLUMNS.map((c) => `    ${quote(c)} text`).join(",\n")}\n);\n`,
    },
    { id: 3, tag: "identities", desc: "TABLE", section: 2, ns: "auth", defn: "CREATE TABLE auth.identities (\n    user_id text,\n    provider text\n);\n" },
    { id: 4, tag: "users", desc: "TABLE DATA", section: 3, ns: "auth", dumper: 1, deps: ["2"],
      copy: `COPY auth.users (${USER_COLUMNS.map(quote).join(", ")}) FROM stdin;\n` },
    { id: 5, tag: "identities", desc: "TABLE DATA", section: 3, ns: "auth", dumper: 1, deps: ["3"],
      copy: "COPY auth.identities (user_id, provider) FROM stdin;\n" },
  ];
  int(entries.length);
  for (const e of entries) {
    int(e.id), int(e.dumper ?? 0), str("0"), str("0"), str(e.tag), str(e.desc), int(e.section);
    str(e.defn ?? ""), str(""), str(e.copy ?? ""), str(e.ns), str("");
    if (minor >= 14) str("heap");
    if (minor >= 16) int(114);
    str("postgres"), str("false");
    for (const d of e.deps ?? []) str(d);
    str(null);
    byte(e.dumper ? offsetFlag : 3);
    parts.push(Buffer.alloc(8));
  }
  const dataBlock = (id, text, ready = null) => {
    byte(1), int(id);
    const payload = ready ?? (compression === "gzip" ? deflateSync(Buffer.from(text)) : Buffer.from(text));
    // 和 pg_dump 一样分成若干块;块边界会落在行中间
    for (let at = 0; at < payload.length; at += chunkSize) {
      const piece = payload.subarray(at, at + chunkSize);
      int(piece.length);
      parts.push(piece);
    }
    int(0);
  };
  const rows = Array.from({ length: users }, (_, i) => userRow(i + 1));
  dataBlock(4, rows.map((r) => `${r}\n`).join("") + "\\.\n\n\n", usersPayload);
  if (identitiesBlock) dataBlock(5, Array.from({ length: users }, (_, i) => `u${i}\temail\n`).join("") + "\\.\n\n\n");
  return Buffer.concat(parts);
}

async function scrub(buffer, pieceSize = 7) {
  // 输入切成很小的碎片:整数、字符串、数据块的边界都会被切开
  const pieces = [];
  for (let at = 0; at < buffer.length; at += pieceSize) pieces.push(buffer.subarray(at, at + pieceSize));
  const chunks = [];
  for await (const chunk of scrubPendingAuthTokens(Readable.from(pieces))) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** pg_restore 读回 COPY 数据:列名 → 每行的值 */
async function restoredUsers(archive) {
  const dir = mkdtempSync(join(tmpdir(), "bd-scrub-"));
  try {
    const path = join(dir, "auth.dump");
    writeFileSync(path, archive);
    const { stdout } = await x(pgRestore, ["--data-only", "-t", "users", "-f", "-", path], { maxBuffer: 64 * 1024 * 1024 });
    const lines = stdout.split("\n");
    const start = lines.findIndex((l) => l.startsWith("COPY auth.users "));
    const rows = [];
    for (let i = start + 1; lines[i] !== "\\."; i++) rows.push(lines[i].split("\t"));
    return rows;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("copyColumns reads quoted and plain column names", () => {
  assert.deepEqual(copyColumns('COPY auth.users (id, "Odd ""name"", here", email) FROM stdin;\n'), ["id", 'Odd "name", here', "email"]);
  assert.throws(() => copyColumns("COPY auth.users FROM stdin;"), /expected form/);
});

test("the columns blanked in the archive are exactly the ones the restore clears, with the same values", () => {
  const assignments = new Map(
    CLEAR_PENDING_AUTH_SQL.replace(/^update auth\.users set /, "").replace(/;$/, "").split(", ").map((a) => a.split(" = "))
  );
  const asCopy = (sqlValue) => (sqlValue === "null" ? "\\N" : sqlValue === "''" ? "" : sqlValue);
  assert.deepEqual(
    [...assignments].map(([column, value]) => [column, asCopy(value)]),
    PENDING_AUTH_COPY_VALUES.map(([column, value]) => [column, value])
  );
});

for (const [minor, compression] of [[16, "gzip"], [16, "none"], [15, "gzip"], [14, "gzip"], [14, "none"], [12, "gzip"]]) {
  test(`archive 1.${minor} (${compression}): pending tokens are blanked, everything else reads back the same`, { skip: needsPgRestoreFor(minor) }, async () => {
    const original = buildArchive({ minor, compression, users: 500 });
    const scrubbed = await scrub(original);
    const before = await restoredUsers(original);
    const after = await restoredUsers(scrubbed);
    assert.equal(after.length, 500);
    for (let r = 0; r < before.length; r++) {
      USER_COLUMNS.forEach((column, c) => {
        const expected = SCRUBBED_EXPECT.has(column) ? SCRUBBED_EXPECT.get(column) : before[r][c];
        assert.equal(after[r][c], expected, `row ${r} column ${column}`);
      });
    }
    // 目录和另一张表逐字节不变:auth.identities 的数据照抄
    const dir = mkdtempSync(join(tmpdir(), "bd-scrub-"));
    try {
      writeFileSync(join(dir, "a"), original);
      writeFileSync(join(dir, "b"), scrubbed);
      const list = async (f) => (await x(pgRestore, ["-l", join(dir, f)])).stdout.split("\n").filter((l) => !l.startsWith(";")).join("\n");
      assert.equal(await list("b"), await list("a"));
      // pg_restore 17.6 起每次输出一个随机的 \restrict 口令,比较前去掉
      const identities = async (f) =>
        (await x(pgRestore, ["--data-only", "-t", "identities", "-f", "-", join(dir, f)])).stdout.replace(/^\\(un)?restrict .*$/gm, "");
      assert.equal(await identities("b"), await identities("a"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(!scrubbed.includes("reset-1") && !(compression === "none" && scrubbed.includes("next1@")));
  });
}

test("a truncated archive, recorded data offsets or a row that doesn't match the columns are errors, never a silent pass", async () => {
  const good = buildArchive({ compression: "none" });
  await assert.rejects(scrub(good.subarray(0, good.length - 20)), /ended early/);
  await assert.rejects(scrub(buildArchive({ offsetFlag: 2 })), /data offsets/);
  await assert.rejects(scrub(Buffer.from("PGDMX-not-an-archive")), /isn't a pg_dump custom-format archive/);
  // 一行少了一个字段(把最后一个制表符换成空格,长度不变,块长度仍然对)
  const sameLength = Buffer.from(good.toString("latin1").replace("\tx\\ty\n", " x\\ty\n"), "latin1");
  assert.equal(sameLength.length, good.length);
  await assert.rejects(scrub(sameLength), /fields, but the COPY statement lists/);
  // 归档版本比认得的新:不猜
  const newer = Buffer.from(good);
  newer[6] = 17;
  await assert.rejects(scrub(newer), /archive version 1\.17/);
});

test("an empty auth.users and a gzip archive split into one-byte pieces still come out readable", { skip: needsPgRestoreFor(16) }, async () => {
  const empty = await scrub(buildArchive({ users: 0 }), 1);
  assert.deepEqual(await restoredUsers(empty), []);
  const tiny = await scrub(buildArchive({ users: 20, chunkSize: 3 }), 1);
  assert.equal((await restoredUsers(tiny)).length, 20);
});

test("an archive whose TOC declares data that never comes (auth.identities cut off) is an error, not an upload", async () => {
  await assert.rejects(scrub(buildArchive({ identitiesBlock: false })), /ended before all of its data blocks/);
});

test("one huge, highly compressible row streams through in bounded memory and linear time", async () => {
  // 一行 256 MiB 的 metadata,压缩后只有几百 KB:整行缓冲的写法会在这里吃掉几百 MB 内存、反复拷贝
  const fieldMiB = 256;
  const deflate = createDeflate();
  const compressed = [];
  deflate.on("data", (c) => compressed.push(c));
  const done = new Promise((resolve) => deflate.on("end", resolve));
  const fields = userRow(1).split("\t");
  const metadataAt = USER_COLUMNS.indexOf("raw_user_meta_data");
  deflate.write(Buffer.from(fields.slice(0, metadataAt).join("\t") + "\t"));
  const block = Buffer.alloc(1024 * 1024, "a");
  for (let i = 0; i < fieldMiB; i++) deflate.write(block);
  deflate.end(Buffer.from("\t" + fields.slice(metadataAt + 1).join("\t") + "\n\\.\n"));
  await done;
  const archive = buildArchive({ users: 1, usersPayload: Buffer.concat(compressed), chunkSize: 16 * 1024 });
  const before = process.memoryUsage();
  let peakArrayBuffers = 0;
  let bytes = 0;
  const started = Date.now();
  for await (const chunk of scrubPendingAuthTokens(Readable.from([archive]))) {
    bytes += chunk.length;
    peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers - before.arrayBuffers);
  }
  assert.ok(bytes > 0);
  assert.ok(peakArrayBuffers < 64 * 1024 * 1024, `buffered ${Math.round(peakArrayBuffers / 1024 / 1024)} MiB for a ${fieldMiB} MiB row`);
  assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
});

test("the auth.users data must end with pg_dump's end marker, followed by nothing but blank lines", async () => {
  const rows = [userRow(1), userRow(2)].map((r) => `${r}\n`).join("");
  const archiveWith = (text) => buildArchive({ compression: "none", users: 2, usersPayload: Buffer.from(text) });
  // 和 pg_dump 一样:结束标记后跟空行
  await scrub(archiveWith(`${rows}\\.\n\n\n`));
  // 没有结束标记
  await assert.rejects(scrub(archiveWith(rows)), /no end marker/);
  // 结束标记之后还有别的字节(多一行数据,或者垃圾)
  await assert.rejects(scrub(archiveWith(`${rows}\\.\n${userRow(3)}\n`)), /something after its end marker/);
  await assert.rejects(scrub(archiveWith(`${rows}\\.\n\nx`)), /something after its end marker/);
});
