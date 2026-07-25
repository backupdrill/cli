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

refresh materialized view public.order_totals;
analyze;
