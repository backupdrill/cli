// 演练里的 Auth 校验(2.10.0,附加模式)。头一条要求:**演练结论只由原来的规则决定**——
// Auth 这一节对上了、对不上、没法检查,pass 和其余检查都和不带 Auth 时一模一样;它只往报告里加 auth 一节。
// 真实 Postgres + 真实演练沙箱(Docker)上跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runBackup } from "../dist/backup.js";
import { runDrill } from "../dist/drill.js";
import { AUTH_DRILL_LIMITS, authDrillSection } from "../dist/auth-drill.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
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
          assert.equal(report.auth.signup.detail, "a new sign-up would fail: permission denied (SQLSTATE 42501)");
        } finally {
          await sql(admin, "alter function public.handle_new_user() security definer");
        }
      });

      await t.test("an error raised inside a trigger never carries data into the report", async () => {
        // 触发器把一个已存的密码哈希塞进异常消息:报告里只能有 SQLSTATE
        await sql(admin, `
          create function public.leak() returns trigger language plpgsql security definer set search_path = '' as $$
          begin raise exception 'leak %', (select encrypted_password from auth.users where encrypted_password like '$2a%' limit 1); end $$;
          create trigger leak after insert on auth.users for each row execute function public.leak();`);
        try {
          const mem = await backup("default");
          const report = await runDrill(config, { store: mem.store });
          assert.deepEqual(verdict(report), verdict(baseline));
          assert.equal(report.auth.status, "problems");
          assert.equal(report.auth.signup.detail, "a new sign-up would fail: an exception was raised (SQLSTATE P0001)");
          assert.equal(JSON.stringify(report).includes("$2a$"), false);
        } finally {
          await sql(admin, "drop trigger leak on auth.users; drop function public.leak()");
        }
      });

      await t.test("a trigger message or RAISE USING fields under an ordinary error code never reach the report", async () => {
        // 23514(CHECK)是会给对象名的那类错误码,但消息是触发器自己写的:报告里只能有固定说法
        await sql(admin, `
          create function public.leak2() returns trigger language plpgsql security definer set search_path = '' as $$
          declare secret text := (select encrypted_password from auth.users where encrypted_password like '$2a%' limit 1);
          begin raise exception using errcode = '23514', message = secret,
            table = secret, column = secret, constraint = secret, schema = secret; end $$;
          create trigger leak2 after insert on auth.users for each row execute function public.leak2();`);
        try {
          const mem = await backup("default");
          const report = await runDrill(config, { store: mem.store });
          assert.equal(report.auth.signup.detail, "a new sign-up would fail: a check constraint was violated (SQLSTATE 23514)");
          assert.equal(JSON.stringify(report).includes("$2a$"), false);
        } finally {
          await sql(admin, "drop trigger leak2 on auth.users; drop function public.leak2()");
        }
      });

      await t.test("a download error (thrown or rejected) never reaches the report and never fails the drill", async () => {
        const mem = await backup("default");
        const reader = await mem.store.openSnapshot();
        for (const downloadAuthDump of [
          () => Promise.reject(new Error("GET https://bucket/x?X-Amz-Credential=AKIASECRET token=abc bob@example.com")),
          () => {
            throw new Error("sync failure with secret bob@example.com");
          },
        ]) {
          const store = { ...mem.store, openSnapshot: async () => ({ ...reader, downloadAuthDump }) };
          const report = await runDrill(config, { store });
          assert.deepEqual(verdict(report), verdict(baseline));
          assert.equal(report.auth.status, "not_checked");
          assert.equal(report.auth.summary, "the Auth archive couldn't be downloaded");
        }
      });

      await t.test("a foreign key whose definition can't be read is reported as unchecked, never as verified", async () => {
        // 列名里带换行:合法,但逐行读 pg_dump 输出的解析器读不全它
        await sql(admin, `create table public.weird ("user
id" uuid references auth.users (id) on delete set null)`);
        try {
          const mem = await backup("default");
          const report = await runDrill(config, { store: mem.store });
          assert.deepEqual(verdict(report).pass, baseline.pass);
          if (report.auth.foreignKeys.created === 2) return; // 解析器读得了这种写法:那就是两条都建上了,同样没问题
          assert.equal(report.auth.status, "problems", report.auth.summary);
          assert.match(report.auth.summary, /couldn't be read, so they weren't checked/);
        } finally {
          await sql(admin, "drop table public.weird");
        }
      });

      await t.test("a trigger that also fires on UPDATE is noted as not exercised by the test sign-up", async () => {
        await sql(admin, `
          create function public.touch_users() returns trigger language plpgsql security definer set search_path = '' as $$
          begin return new; end $$;
          create trigger touch_users before insert or update on auth.users for each row execute function public.touch_users();`);
        try {
          const mem = await backup("default");
          const report = await runDrill(config, { store: mem.store });
          assert.equal(report.auth.status, "verified", report.auth.summary);
          assert.ok(report.auth.notes.some((n) => /touch_users .* also fires on UPDATE/.test(n)), JSON.stringify(report.auth.notes));
        } finally {
          await sql(admin, "drop trigger touch_users on auth.users; drop function public.touch_users()");
        }
      });

      await t.test("the test sign-up looks like a real email sign-up (timestamps, provider metadata)", async () => {
        // 照抄 NEW.created_at 进必填列、按 provider 分支的触发器:健康的就该判注册成功
        await sql(admin, `
          create table public.signups (user_id uuid primary key, signed_up_at timestamptz not null, provider text not null);
          create function public.track_signup() returns trigger language plpgsql security definer set search_path = '' as $$
          begin
            -- 不像一次真实的邮箱注册就直接报错:测试的注册少了这些,这条测试就会失败
            if new.raw_app_meta_data ->> 'provider' is distinct from 'email' or new.created_at is null then
              raise exception 'not a real-looking email sign-up';
            end if;
            insert into public.signups values (new.id, new.created_at, new.raw_app_meta_data ->> 'provider');
            return new;
          end $$;
          create trigger track_signup after insert on auth.users for each row execute function public.track_signup();`);
        try {
          const mem = await backup("default");
          const report = await runDrill(config, { store: mem.store });
          assert.deepEqual(report.auth.signup, { ran: true, ok: true }, JSON.stringify(report.auth));
        } finally {
          await sql(admin, "drop trigger track_signup on auth.users; drop function public.track_signup(); drop table public.signups");
        }
      });

      await t.test("a timeout stops the Auth work in a sandbox that stays around (as with --keep)", async () => {
        // 自己起一个沙箱并留着:先把主 dump 的表和数据恢复进去,再从另一个会话锁住 public.profiles,
        // Auth 这一节补外键时就会卡在那里。超时后:马上返回、沙箱里不留它的会话、之后也不再改动沙箱
        const mem = await backup("default");
        const dir = mkdtempSync(join(tmpdir(), "bd-auth-timeout-"));
        const sandboxPort = await startPostgres(ids);
        const sandbox = `postgresql://postgres:pw@127.0.0.1:${sandboxPort}/postgres`;
        const dumpPath = join(dir, "dump.pgcustom");
        const authPath = join(dir, "auth.dump");
        writeFileSync(dumpPath, mem.files.get("dump.pgcustom"));
        writeFileSync(authPath, mem.files.get("auth.dump"));
        // 唯一预期的报错是 schema "public" already exists(新库里本来就有),其余都算失败
        await x(process.env.BACKUPDRILL_PG_RESTORE || "pg_restore", [
          "--no-owner", "--no-privileges", "--section=pre-data", "--section=data", "--dbname", sandbox, dumpPath,
        ]).catch((error) => {
          const errors = (error.stderr ?? "").split("\n").filter((l) => /ERROR:/.test(l));
          if (errors.length !== 1 || !/schema "public" already exists/.test(errors[0])) throw error;
        });
        const locker = new pg.Client({ connectionString: sandbox });
        await locker.connect();
        const previous = AUTH_DRILL_LIMITS.totalMs;
        AUTH_DRILL_LIMITS.totalMs = 4000;
        try {
          await locker.query("begin; lock table public.profiles in access exclusive mode");
          const started = Date.now();
          const result = await authDrillSection(sandbox, mem.manifest(), dumpPath, Promise.resolve({ path: authPath }), () => {});
          assert.equal(result.status, "not_checked");
          assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
          // 后台的收尾很快就把这一节的会话都终止了
          const others = async () =>
            (
              await sql(
                sandbox,
                `select count(*)::int as n from pg_stat_activity
                  where backend_type = 'client backend' and pid <> pg_backend_pid() and pid <> ${locker.processID}`
              )
            ).rows[0].n;
          let n = 1;
          for (let i = 0; i < 50 && n > 0; i++) {
            n = await others();
            if (n > 0) await new Promise((r) => setTimeout(r, 100));
          }
          assert.equal(n, 0, "no Auth session left in the sandbox");
        } finally {
          AUTH_DRILL_LIMITS.totalMs = previous;
          await locker.query("rollback").catch(() => {});
          await locker.end();
        }
        // 锁放开以后也不能再有人往沙箱里加外键:被叫停的活没有接着做
        await new Promise((r) => setTimeout(r, 1500));
        const fk = await sql(
          sandbox,
          "select count(*)::int as n from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'f'"
        );
        assert.equal(fk.rows[0].n, 0);
        rmSync(dir, { recursive: true, force: true });
      });

      await t.test("a deferred trigger that fails at commit is caught by the test sign-up", async () => {
        await sql(admin, `
          create function public.fail_late() returns trigger language plpgsql security definer set search_path = '' as $$
          begin raise exception 'late'; end $$;
          create constraint trigger fail_late after insert on auth.users deferrable initially deferred
            for each row execute function public.fail_late();`);
        try {
          const mem = await backup("default");
          const report = await runDrill(config, { store: mem.store });
          assert.deepEqual(verdict(report), verdict(baseline));
          assert.equal(report.auth.signup.ok, false, JSON.stringify(report.auth));
        } finally {
          await sql(admin, "drop trigger fail_late on auth.users; drop function public.fail_late()");
        }
      });

      await t.test("a commented trigger and a foreign key sharing a name with an Auth one are both handled", async () => {
        await sql(admin, `
          comment on trigger on_auth_user_created on auth.users is 'creates the profile';
          create table public.links (
            user_id uuid,
            constraint identities_user_id_fkey foreign key (user_id) references auth.users (id)
          );`);
        try {
          const mem = await backup("default");
          const report = await runDrill(config, { store: mem.store });
          assert.deepEqual(verdict(report).pass, baseline.pass);
          assert.equal(report.auth.status, "verified", report.auth.summary);
          assert.equal(report.auth.foreignKeys.created, 2, "profiles' and links' foreign keys into auth.users");
          assert.deepEqual(report.auth.triggers.created, ["on_auth_user_created"]);
        } finally {
          await sql(admin, "drop table public.links; comment on trigger on_auth_user_created on auth.users is null");
        }
      });

      await t.test("an Auth download that never finishes: not checked within the limit, the verdict doesn't move", async () => {
        const mem = await backup("default");
        const reader = await mem.store.openSnapshot();
        let stopped = false;
        // 一个只在被叫停时才结束的下载:超时后必须收到叫停,不然连接会把 CLI 进程拖住
        const stuck = {
          ...mem.store,
          openSnapshot: async () => ({
            ...reader,
            downloadAuthDump: (_m, _dest, opts) =>
              new Promise((_, reject) =>
                opts?.signal?.addEventListener("abort", () => {
                  stopped = true;
                  reject(new Error("aborted"));
                })
              ),
          }),
        };
        const previous = AUTH_DRILL_LIMITS.totalMs;
        AUTH_DRILL_LIMITS.totalMs = 1000;
        try {
          const started = Date.now();
          const report = await runDrill(config, { store: stuck });
          assert.deepEqual(verdict(report), verdict(baseline));
          assert.equal(report.auth.status, "not_checked");
          assert.match(report.auth.summary, /didn't finish/);
          assert.equal(stopped, true, "the stuck download was stopped");
          assert.ok(Date.now() - started < 60_000, `took ${Date.now() - started} ms`);
        } finally {
          AUTH_DRILL_LIMITS.totalMs = previous;
        }
      });

      await t.test("a supervised (hosted) drill leaves the Auth check off unless asked", async () => {
        const mem = await backup("default");
        const workdir = mkdtempSync(join(tmpdir(), "bd-auth-sup-"));
        // 托管 worker 的资源名形如 bd-drill-<uuid>(drill.ts 会校验)
        const supervision = { workdir, resourceName: `bd-drill-${randomUUID()}`, observe: async () => {} };
        try {
          const off = await runDrill(config, { store: mem.store, supervision });
          assert.equal(off.auth, undefined);
          const on = await runDrill(config, { store: mem.store, supervision, authCheck: true });
          assert.equal(on.auth.status, "verified", on.auth.summary);
        } finally {
          rmSync(workdir, { recursive: true, force: true });
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
      for (const id of ids) await x("docker", ["rm", "-f", "-v", id]).catch(() => {});
    }
  }
);
