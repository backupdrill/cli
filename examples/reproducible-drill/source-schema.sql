-- 仿 Supabase 项目的源库:平台角色、extensions schema、Auth 两张表、RLS 策略、授权、
-- 分区表、物化视图、触发器。
-- 形态参照 research/spike-r0 在真实 Supabase 上验证过的固件结构。

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_auth_admin nologin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ── Supabase Auth ────────────────────────────────────────────────────
-- 两张表的结构照 GoTrue v2.186.0 迁移后的 auth.users / auth.identities 原样抄来
-- (supabase/postgres:17.6.1.084 上 pg_dump --schema-only 的输出,去掉了注释)。
-- 必须一致:--with-login 把备份恢复进一个真的 GoTrue,列对不上就写不进去。
-- 和托管项目一样:属主是 supabase_auth_admin,开着 RLS。
create schema auth;
-- 外键检查以被引用表(auth.users)属主的身份执行:没有这条,profiles 的外键一查就 permission denied
grant usage, create on schema auth to supabase_auth_admin;

create table auth.users (
  instance_id uuid,
  id uuid not null,
  aud character varying(255),
  role character varying(255),
  email character varying(255),
  encrypted_password character varying(255),
  email_confirmed_at timestamp with time zone,
  invited_at timestamp with time zone,
  confirmation_token character varying(255),
  confirmation_sent_at timestamp with time zone,
  recovery_token character varying(255),
  recovery_sent_at timestamp with time zone,
  email_change_token_new character varying(255),
  email_change character varying(255),
  email_change_sent_at timestamp with time zone,
  last_sign_in_at timestamp with time zone,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  phone text default null::character varying,
  phone_confirmed_at timestamp with time zone,
  phone_change text default ''::character varying,
  phone_change_token character varying(255) default ''::character varying,
  phone_change_sent_at timestamp with time zone,
  confirmed_at timestamp with time zone generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  email_change_token_current character varying(255) default ''::character varying,
  email_change_confirm_status smallint default 0,
  banned_until timestamp with time zone,
  reauthentication_token character varying(255) default ''::character varying,
  reauthentication_sent_at timestamp with time zone,
  is_sso_user boolean default false not null,
  deleted_at timestamp with time zone,
  is_anonymous boolean default false not null,
  constraint users_email_change_confirm_status_check
    check (((email_change_confirm_status >= 0) and (email_change_confirm_status <= 2))),
  constraint users_pkey primary key (id),
  constraint users_phone_key unique (phone)
);
create unique index confirmation_token_idx on auth.users using btree (confirmation_token)
  where ((confirmation_token)::text !~ '^[0-9 ]*$'::text);
create unique index email_change_token_current_idx on auth.users using btree (email_change_token_current)
  where ((email_change_token_current)::text !~ '^[0-9 ]*$'::text);
create unique index email_change_token_new_idx on auth.users using btree (email_change_token_new)
  where ((email_change_token_new)::text !~ '^[0-9 ]*$'::text);
create unique index reauthentication_token_idx on auth.users using btree (reauthentication_token)
  where ((reauthentication_token)::text !~ '^[0-9 ]*$'::text);
create unique index recovery_token_idx on auth.users using btree (recovery_token)
  where ((recovery_token)::text !~ '^[0-9 ]*$'::text);
create unique index users_email_partial_key on auth.users using btree (email) where (is_sso_user = false);
create index users_instance_id_email_idx on auth.users using btree (instance_id, lower((email)::text));
create index users_instance_id_idx on auth.users using btree (instance_id);
create index users_is_anonymous_idx on auth.users using btree (is_anonymous);

create table auth.identities (
  provider_id text not null,
  user_id uuid not null,
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  email text generated always as (lower((identity_data ->> 'email'::text))) stored,
  id uuid default gen_random_uuid() not null,
  constraint identities_pkey primary key (id),
  constraint identities_provider_id_provider_unique unique (provider_id, provider),
  constraint identities_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade
);
create index identities_email_idx on auth.identities using btree (email text_pattern_ops);
create index identities_user_id_idx on auth.identities using btree (user_id);

alter table auth.users enable row level security;
alter table auth.identities enable row level security;
alter table auth.users owner to supabase_auth_admin;
alter table auth.identities owner to supabase_auth_admin;

-- Supabase 里 RLS 策略最常用的那个函数,定义同托管项目(演练沙箱里是桩函数)
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

-- ── 业务表 ───────────────────────────────────────────────────────────
create table public.customers (
  id uuid primary key default extensions.gen_random_uuid(),
  email text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.products (
  id bigserial primary key,
  sku text not null unique,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.orders (
  id bigserial primary key,
  customer_id uuid not null references public.customers (id) on delete cascade,
  amount_cents integer not null,
  status text not null default 'paid',
  created_at timestamptz not null default now()
);
create index orders_customer_idx on public.orders (customer_id);

create table public.order_items (
  id bigserial primary key,
  order_id bigint not null references public.orders (id) on delete cascade,
  product_id bigint not null references public.products (id),
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null
);
create index order_items_order_idx on public.order_items (order_id);

-- 分区表:恢复时分区继承约束是已知的"预期跳过"来源
create table public.events (
  id bigint not null,
  kind text not null,
  at timestamptz not null,
  primary key (id, at)
) partition by range (at);
create table public.events_2026_06 partition of public.events
  for values from ('2026-06-01') to ('2026-07-01');
create table public.events_2026_07 partition of public.events
  for values from ('2026-07-01') to ('2026-08-01');

create table public.notes (
  id bigserial primary key,
  customer_id uuid references public.customers (id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index notes_body_trgm on public.notes using gin (body extensions.gin_trgm_ops);

create table public.sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  ip inet,
  user_agent text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table public.audit_log (
  id bigserial primary key,
  actor text not null,
  action text not null,
  target text,
  payload jsonb,
  at timestamptz not null default now()
);
create index audit_log_at_idx on public.audit_log (at desc);

-- 上传文件的元数据表:这正是"数据库恢复只带回指针"的那张表
create table public.attachments (
  id bigserial primary key,
  customer_id uuid references public.customers (id) on delete set null,
  bucket text not null,
  object_key text not null,
  bytes bigint not null,
  content_type text not null,
  uploaded_at timestamptz not null default now(),
  unique (bucket, object_key)
);

-- 每个 Auth 用户一行,主键就是 auth.users 的 id:Supabase 项目里最常见的那条外键。
-- 只恢复数据库、不带 Auth 用户时,新项目的 auth.users 是空的,这条外键建不起来
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

-- 刻意留空:演练的"有数据的表必须非空"只针对备份时有行的表
create table public.webhook_deliveries (
  id bigserial primary key,
  endpoint text not null,
  status_code integer,
  delivered_at timestamptz
);

-- ── RLS(引用 Supabase 平台角色,drill 沙箱里这些角色不存在)──────────
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.notes enable row level security;
alter table public.sessions enable row level security;
alter table public.profiles enable row level security;

create policy customers_self_read on public.customers
  for select to authenticated using (true);
create policy orders_owner_read on public.orders
  for select to authenticated using (true);
create policy order_items_owner_read on public.order_items
  for select to authenticated using (true);
create policy notes_owner_all on public.notes
  for all to authenticated using (true) with check (true);
create policy sessions_anon_none on public.sessions
  for select to anon using (false);
create policy profiles_self_read on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

-- ── 触发器与物化视图 ─────────────────────────────────────────────────
create function public.touch_order() returns trigger language plpgsql as $$
begin
  new.created_at = coalesce(new.created_at, now());
  return new;
end $$;
create trigger orders_touch before insert on public.orders
  for each row execute function public.touch_order();

-- 注册触发器:新用户写进 auth.users 时建一行 profile。写法照 Supabase 文档(security definer、
-- search_path 置空)。恢复时要和用户一起补建,否则恢复后新注册的人没有 profile
create function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create materialized view public.order_totals as
  select o.customer_id, count(*) as orders, sum(o.amount_cents) as total_cents
  from public.orders o group by o.customer_id;

-- ── API 角色的授权 ───────────────────────────────────────────────────
-- 2026-10-30 起 Supabase 不再自动把 public 的新表授权给 anon / authenticated / service_role,
-- 这些授权都是项目自己写的。备份把它们记进 manifest,恢复和演练照原样补回、回读核对
grant usage on schema public to anon, authenticated, service_role;
grant select on public.products to anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.notes to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
