import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drillDump } from "../dist/drill.js";

const x = promisify(execFile);
const pgDump = process.env.BACKUPDRILL_PG_DUMP || "pg_dump";

async function available(cmd, args) {
  try {
    await x(cmd, args);
    return true;
  } catch {
    return false;
  }
}

// 需要 Docker + pg_dump;缺任一则跳过(本地无环境或纯 lint CI 不至于失败)
const canRun =
  (await available("docker", ["version"])) && (await available(pgDump, ["--version"]));

test(
  "drill: verifies a good backup (PASS) and catches a tampered manifest (FAIL)",
  { skip: canRun ? false : "requires Docker + pg_dump" },
  async () => {
    // 1. 起源库、塞 100 行、dump 成 custom 格式
    const { stdout: idOut } = await x("docker", [
      "run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=seed",
      "-p", "127.0.0.1:0:5432", "postgres:17-alpine",
    ]);
    const id = idOut.trim();
    const dumpPath = join(tmpdir(), `bd-test-${id.slice(0, 8)}.pgcustom`);
    let sha, bytes;
    try {
      const { stdout: portOut } = await x("docker", ["port", id, "5432/tcp"]);
      const port = portOut.trim().split(":").pop().trim();
      for (let i = 0; i < 60; i++) {
        try {
          await x("docker", ["exec", id, "pg_isready", "-U", "postgres", "-q"]);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      await x("docker", [
        "exec", id, "psql", "-U", "postgres", "-c",
        "create table demo(id int primary key, v text); insert into demo select g, 'row'||g from generate_series(1,100) g;",
      ]);
      const conn = `postgresql://postgres:seed@127.0.0.1:${port}/postgres`;
      await x(pgDump, [
        "--format=custom", "--no-owner", "--no-privileges", "--schema=public",
        "--dbname", conn, "-f", dumpPath,
      ]);
      const buf = readFileSync(dumpPath);
      bytes = buf.length;
      sha = createHash("sha256").update(buf).digest("hex");
    } finally {
      await x("docker", ["rm", "-f", id]).catch(() => {});
    }

    const manifest = {
      tool: "backupdrill-cli", toolVersion: "test", createdAt: "2026-07-04T00:00:00.000Z",
      projectName: "test",
      database: {
        serverVersion: "17.4", pgDumpVersion: "test", schemas: ["public"],
        tableCount: 1, estimatedRowTotal: 100,
        tables: [{ schema: "public", name: "demo", estimatedRows: 100 }],
      },
      dump: { key: "seed/dump.pgcustom", format: "custom", bytes, sha256: sha },
      storage: null,
    };

    // 2. PASS:好备份应通过,且恢复出 100 行 / 1 表
    const good = await drillDump(dumpPath, manifest, "good");
    assert.equal(good.pass, true, "good backup should pass");
    assert.equal(good.restoredRowTotal, 100);
    assert.equal(good.restoredTableCount, 1);

    // 3. FAIL:manifest 谎报一张 dump 里没有的表,演练必须抓到
    const tampered = {
      ...manifest,
      database: {
        ...manifest.database,
        tableCount: 2,
        tables: [...manifest.database.tables, { schema: "public", name: "ghost", estimatedRows: 5 }],
      },
    };
    const bad = await drillDump(dumpPath, tampered, "bad");
    assert.equal(bad.pass, false, "tampered manifest should fail");
    assert.ok(
      bad.checks.some((c) => c.name === "no missing tables" && !c.pass),
      "the 'no missing tables' check should fail"
    );
  }
);
