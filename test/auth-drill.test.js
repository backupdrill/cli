// 演练里的 Auth 校验(2.10.0,附加模式)。头一条要求:**演练结论只由原来的规则决定**——
// Auth 这一节对上了、对不上、没法检查,pass 和其余检查都和不带 Auth 时一模一样;它只往报告里加 auth 一节。
// 真实 Postgres + 真实演练沙箱(Docker)上跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runBackup } from "../dist/backup.js";
import { runDrill } from "../dist/drill.js";
import { SETUP, readableMemoryStore, sql, startPostgres } from "./auth-fixtures.js";

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
const canRun = (await available("docker", ["version"])) && (await available(pgDump, ["--version"]));

/** 演练结论里与 Auth 无关的部分:检查名和通过与否(detail 里有耗时,每次不同) */
const verdict = (report) => ({ pass: report.pass, checks: report.checks.map((c) => [c.name, c.pass]) });

test(
  "drill: the Auth check adds a section to the report and never changes the verdict",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 600_000 },
  async (t) => {
    const ids = [];
    try {
      const port = await startPostgres(ids);
      const admin = `postgresql://postgres:pw@127.0.0.1:${port}/postgres`;
      await sql(admin, SETUP);
      const okUrl = `postgresql://reader_ok:r@127.0.0.1:${port}/postgres`;
      const config = { databaseUrl: okUrl, projectName: "drill", schemas: ["public"] };

      const backup = async (auth) => {
        const mem = readableMemoryStore();
        await runBackup({ ...config, auth }, { store: mem.store });
        return mem;
      };

      // 基准:同一个库、不带 Auth 的快照
      const plain = await backup("off");
      const baseline = await runDrill(config, { store: plain.store });
      assert.equal(baseline.pass, true, JSON.stringify(baseline.checks));
      assert.equal(baseline.auth, undefined);

      await t.test("a snapshot with Auth users: verified, and the verdict is the same as without them", async () => {
        const mem = await backup("default");
        assert.equal(mem.manifest().auth.status, "included");
        const report = await runDrill(config, { store: mem.store });
        assert.deepEqual(verdict(report), verdict(baseline));
        const a = report.auth;
        assert.equal(a.status, "verified", a.summary);
        assert.equal(a.users, 4);
        assert.equal(a.identities, 4);
        assert.equal(a.foreignKeys.created, 1, "public.profiles → auth.users is created now that the users are there");
        assert.deepEqual(a.foreignKeys.failed, []);
        assert.deepEqual(a.triggers.created, ["on_auth_user_created"]);
        assert.deepEqual(a.signup, { ran: true, ok: true });
        assert.ok(a.manual.some((note) => note.includes('policy "self_read"')), JSON.stringify(a.manual));
      });

      await t.test("a damaged Auth archive is reported as a problem, the verdict doesn't move", async () => {
        const mem = await backup("default");
        const archive = mem.files.get("auth.dump");
        mem.files.set("auth.dump", Buffer.concat([archive.subarray(0, archive.length - 1), Buffer.from([archive.at(-1) ^ 0xff])]));
        const report = await runDrill(config, { store: mem.store });
        assert.deepEqual(verdict(report), verdict(baseline));
        assert.equal(report.auth.status, "problems");
        assert.match(report.auth.summary, /sha256 mismatch/);
      });

      await t.test("a reader that can't fetch the Auth archive: not checked, the verdict doesn't move", async () => {
        const mem = await backup("default");
        const noAuthReader = readableMemoryStore({ readAuth: false });
        // 同一份快照,换一个还没适配 auth.dump 的读端
        for (const [k, v] of mem.files) noAuthReader.files.set(k, v);
        noAuthReader.setManifest(mem.manifest());
        const report = await runDrill(config, { store: noAuthReader.store });
        assert.deepEqual(verdict(report), verdict(baseline));
        assert.equal(report.auth.status, "not_checked");
      });

      await t.test("a sign-up trigger GoTrue's role can't run is caught, the verdict doesn't move", async () => {
        // SECURITY INVOKER:注册时以 GoTrue 的角色执行,它没有 public.profiles 的写权限
        await sql(admin, "alter function public.handle_new_user() security invoker");
        try {
          const mem = await backup("default");
          const report = await runDrill(config, { store: mem.store });
          assert.deepEqual(verdict(report), verdict(baseline));
          assert.equal(report.auth.status, "problems");
          assert.equal(report.auth.signup.ok, false);
          assert.match(report.auth.signup.detail, /a new sign-up would fail: permission denied for table profiles/);
        } finally {
          await sql(admin, "alter function public.handle_new_user() security definer");
        }
      });

      await t.test("a backed-up row count that doesn't match is a problem, the verdict doesn't move", async () => {
        const mem = await backup("default");
        const m = mem.manifest();
        mem.setManifest({ ...m, auth: { ...m.auth, rows: { users: 5, identities: 4 } } });
        const report = await runDrill(config, { store: mem.store });
        assert.deepEqual(verdict(report), verdict(baseline));
        assert.equal(report.auth.status, "problems");
        assert.match(report.auth.summary, /backup counted 5 \/ 4/);
      });
    } finally {
      for (const id of ids) await x("docker", ["rm", "-f", id]).catch(() => {});
    }
  }
);
