-- 服务端生成的真实体量数据。
insert into public.customers (email, name)
select 'user' || g || '@example.com', 'Customer ' || g
from generate_series(1, 20000) g;

insert into public.products (sku, name, price_cents, active)
select 'SKU-' || lpad(g::text, 7, '0'), 'Product ' || g,
       ((g::bigint * 104729) % 40000) + 199, g % 17 <> 0
from generate_series(1, 5000) g;

insert into public.orders (customer_id, amount_cents, status, created_at)
select c.id,
       ((g::bigint * 7919) % 250000) + 500,
       (array['paid','refunded','pending'])[(g % 3) + 1],
       now() - (g % 365) * interval '1 day'
from generate_series(1, 200000) g
join lateral (select id from public.customers offset (g % 20000) limit 1) c on true;

insert into public.order_items (order_id, product_id, quantity, unit_price_cents)
select (g % 200000) + 1, (g % 5000) + 1, (g % 5) + 1, ((g::bigint * 104729) % 40000) + 199
from generate_series(1, 600000) g;

insert into public.events (id, kind, at)
select g,
       (array['page_view','signup','purchase','refund','login'])[(g % 5) + 1],
       case when g % 2 = 0
            then timestamptz '2026-06-01' + (g % 29) * interval '1 day' + (g % 86400) * interval '1 second'
            else timestamptz '2026-07-01' + (g % 24) * interval '1 day' + (g % 86400) * interval '1 second'
       end
from generate_series(1, 300000) g;

insert into public.notes (customer_id, body)
select c.id, repeat('Customer note #' || g || ' about order handling and delivery. ', 8)
from generate_series(1, 40000) g
join lateral (select id from public.customers offset (g % 20000) limit 1) c on true;

insert into public.sessions (customer_id, ip, user_agent, started_at, ended_at)
select c.id,
       ('10.' || (g % 255) || '.' || ((g / 255) % 255) || '.' || ((g / 6502) % 255))::inet,
       'Mozilla/5.0 (build ' || (g % 40) || ')',
       now() - (g % 90) * interval '1 hour',
       case when g % 9 = 0 then null else now() - (g % 90) * interval '1 hour' + interval '22 minutes' end
from generate_series(1, 60000) g
join lateral (select id from public.customers offset (g % 20000) limit 1) c on true;

insert into public.audit_log (actor, action, target, payload, at)
select 'user:' || (g % 20000),
       (array['create','update','delete','export','login'])[(g % 5) + 1],
       'order:' || ((g % 200000) + 1),
       jsonb_build_object('ok', g % 7 <> 0, 'ms', (g % 900) + 12, 'source', 'api'),
       now() - (g % 120) * interval '1 hour'
from generate_series(1, 250000) g;

-- 1,000 个 Auth 用户:前 600 个用邮箱 + 密码登录(密码 demo-password-<g>,--with-login 拿第 1 个去登录),
-- 后 400 个用 Google 登录、没有密码。ID、邮箱、时间、identity 全是确定的;只有 bcrypt 的盐是随机的。
-- 字段的写法照 GoTrue 自己注册时写的:token 列是空串不是 null(GoTrue 读到 null 会报错)。
-- 每 120 个密码用户里有一个在备份时还挂着没用的重置密码链接(共 5 个),恢复时这些要清掉。
-- 插入时 on_auth_user_created 触发器顺手给每人建一行 public.profiles。
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, recovery_sent_at, email_change_token_new, email_change,
  last_sign_in_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
  case when u.password_user then extensions.crypt('demo-password-' || g, extensions.gen_salt('bf', 10)) else '' end,
  u.created_at,
  '',
  case when u.password_user and g % 120 = 0 then encode(sha224(convert_to('recovery:' || g, 'UTF8')), 'hex') else '' end,
  case when u.password_user and g % 120 = 0 then timestamptz '2026-10-01 12:00:00+00' end,
  '', '',
  u.created_at + interval '2 days',
  case when u.password_user
       then jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'))
       else jsonb_build_object('provider', 'google', 'providers', jsonb_build_array('google')) end,
  case when u.password_user
       then jsonb_build_object('sub', u.id, 'email', u.email, 'email_verified', true, 'phone_verified', false)
       else jsonb_build_object('iss', 'https://accounts.google.com', 'sub', u.google_sub, 'name', 'Customer ' || g,
                               'full_name', 'Customer ' || g, 'email', u.email, 'email_verified', true,
                               'phone_verified', false, 'provider_id', u.google_sub) end,
  false, u.created_at, u.created_at + interval '2 days'
from generate_series(1, 1000) g
cross join lateral (
  select md5('backupdrill-demo-user:' || g)::uuid as id,
         'user' || g || '@example.com' as email,
         g <= 600 as password_user,
         '1' || lpad(g::text, 20, '0') as google_sub,
         timestamptz '2026-05-01 00:00:00+00' + g * interval '37 minutes' as created_at
) u;

insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select md5('backupdrill-demo-identity:' || u.id)::uuid,
       case when u.raw_app_meta_data ->> 'provider' = 'email' then u.id::text else u.raw_user_meta_data ->> 'sub' end,
       u.id,
       case when u.raw_app_meta_data ->> 'provider' = 'email'
            then jsonb_build_object('sub', u.id, 'email', u.email, 'email_verified', false, 'phone_verified', false)
            else u.raw_user_meta_data end,
       u.raw_app_meta_data ->> 'provider',
       u.last_sign_in_at, u.created_at, u.updated_at
from auth.users u;

refresh materialized view public.order_totals;
analyze;
