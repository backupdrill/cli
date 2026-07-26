-- 仿 Supabase 项目的源库:平台角色、extensions schema、RLS 策略、分区表、物化视图、触发器。
-- 形态参照 research/spike-r0 在真实 Supabase 上验证过的固件结构。

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

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

-- ── 触发器与物化视图 ─────────────────────────────────────────────────
create function public.touch_order() returns trigger language plpgsql as $$
begin
  new.created_at = coalesce(new.created_at, now());
  return new;
end $$;
create trigger orders_touch before insert on public.orders
  for each row execute function public.touch_order();

create materialized view public.order_totals as
  select o.customer_id, count(*) as orders, sum(o.amount_cents) as total_cents
  from public.orders o group by o.customer_id;
