// Auth 用户备份/演练测试共用的东西:起一个一次性 Postgres、和 Supabase 同形的最小 auth、
// 能写也能读的内存快照存储。文件名不带 .test,node --test test/*.test.js 不会把它当测试跑。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";

const x = promisify(execFile);


export async function startPostgres(ids) {
  const { stdout } = await x("docker", [
    "run", "-d", "--rm", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_PASSWORD=pw",
    "-p", "127.0.0.1:0:5432", "postgres:17-alpine",
  ]);
  const id = stdout.trim();
  ids.push(id);
  const port = (await x("docker", ["port", id, "5432/tcp"])).stdout.trim().split("\n")[0].split(":").pop();
  for (let i = 0; i < 60; i++) {
    try {
      await x("docker", ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-q"]);
      return port;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("postgres did not become ready");
}

export async function sql(url, text) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(text);
  } finally {
    await client.end();
  }
}

// 新项目里平台建好的 auth 两张表(空的),源库和恢复目标都用它
export const AUTH_DDL = `
  create schema auth;
  create table auth.users (
    instance_id uuid, id uuid primary key, email text, encrypted_password text,
    is_anonymous boolean not null default false, is_sso_user boolean not null default false,
    raw_user_meta_data jsonb, raw_app_meta_data jsonb,
    created_at timestamptz, updated_at timestamptz,
    confirmation_token varchar(255) default '', recovery_token varchar(255) default '',
    email_change_token_new varchar(255) default '', email_change_token_current varchar(255) default '',
    phone_change_token varchar(255) default '', reauthentication_token varchar(255) default '',
    email_change varchar(255) default '', phone_change text default '', email_change_confirm_status smallint default 0,
    confirmation_sent_at timestamptz, recovery_sent_at timestamptz, email_change_sent_at timestamptz,
    phone_change_sent_at timestamptz, reauthentication_sent_at timestamptz
  );
  create table auth.identities (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    provider text not null, provider_id text not null, identity_data jsonb
  );
  alter table auth.users enable row level security;
  alter table auth.identities enable row level security;
`;

// 和 Supabase 同形的最小 auth:两张表开 RLS、identities 外键指向 users;public.profiles 外键指向 auth.users,
// auth.users 上挂注册时建 profile 的触发器;auth.users 上一条策略引用了不在备份里的 private schema 的函数
export const SETUP = `
${AUTH_DDL}
  create table public.profiles (id uuid primary key references auth.users (id), name text);
  create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
  begin insert into public.profiles (id, name) values (new.id, new.email); return new; end $$;
  create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
  create schema private;
  create function private.uid() returns uuid language sql stable as 'select null::uuid';
  create policy self_read on auth.users for select using (id = private.uid());
  insert into auth.users (id, email, encrypted_password, is_anonymous) values
    ('11111111-1111-1111-1111-111111111111', 'pw@example.test', '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123', false),
    ('22222222-2222-2222-2222-222222222222', 'oauth@example.test', null, false),
    ('33333333-3333-3333-3333-333333333333', 'enc@example.test',
     '{"key_id":"k1","alg":"aes-gcm-hkdf","data":"AAAA","nonce":"AAAAAAAAAAAAAAAA"}', false),
    ('44444444-4444-4444-4444-444444444444', null, '', true);
  update auth.users set recovery_token = 'pending-reset', recovery_sent_at = now()
   where id = '11111111-1111-1111-1111-111111111111';
  insert into auth.identities (user_id, provider, provider_id) values
    ('11111111-1111-1111-1111-111111111111', 'email', '11111111-1111-1111-1111-111111111111'),
    ('22222222-2222-2222-2222-222222222222', 'google', '1000001'),
    ('22222222-2222-2222-2222-222222222222', 'github', '2000002'),
    ('33333333-3333-3333-3333-333333333333', 'email', '33333333-3333-3333-3333-333333333333');
  create table public."archived SCHEMA - public data" (x int);
  insert into public."archived SCHEMA - public data" values (1);
  create role reader_limited login password 'r' bypassrls connection limit 2;
  grant pg_read_all_data to reader_limited;
  create role authenticated nologin;
  grant select on auth.users to authenticated;
  create role reader_ok login password 'r' bypassrls;
  grant pg_read_all_data to reader_ok;
  create role reader_norls login password 'r';
  grant pg_read_all_data to reader_norls;
  create role reader_nousage login password 'r';
  grant select on all tables in schema public to reader_nousage;
`;


/**
 * 内存快照存储,写进去的东西还能读回来(演练要读)。files 记着写了哪些文件;
 * readable.authCapable=false 模拟还没适配 auth.dump 的读端
 */
export function readableMemoryStore({ readAuth = true } = {}) {
  const files = new Map();
  let manifest;
  const collect = (name) => (body) => ({
    done: (async () => {
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      files.set(name, Buffer.concat(chunks));
    })(),
    abort: async () => {},
  });
  const download = (name) => async (_manifest, dest) => {
    const data = files.get(name);
    if (!data) throw new Error(`${name} is not in this snapshot`);
    await writeFile(dest, data);
    return { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  };
  return {
    files,
    manifest: () => manifest,
    setManifest: (m) => (manifest = m),
    store: {
      createSnapshot: async () => ({
        dumpKey: "backupdrill/t/snap/dump.pgcustom",
        storageFiles: null,
        describe: (file) => file,
        uploadDump: collect("dump.pgcustom"),
        authDumpKey: "backupdrill/t/snap/auth.dump",
        uploadAuthDump: collect("auth.dump"),
        writeRecoveryDoc: async () => {},
        writeManifest: async (written) => {
          manifest = written;
        },
      }),
      openSnapshot: async () => ({
        name: "snap",
        readManifest: async () => JSON.stringify(manifest),
        downloadDump: download("dump.pgcustom"),
        ...(readAuth ? { downloadAuthDump: download("auth.dump") } : {}),
        storageFiles: () => null,
      }),
    },
  };
}
