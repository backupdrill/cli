// 在演练沙箱里跑业务不变量检查。BACKUPDRILL_SANDBOX_URL 由 drill 注入。
// 退出码 0 = 通过;非 0 = 演练失败。
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.BACKUPDRILL_SANDBOX_URL });
await client.connect();

const one = async (sql) => (await client.query(sql)).rows[0];

const counts = await one(`
  select (select count(*) from public.orders)       as orders,
         (select count(*) from public.order_items)  as order_items,
         (select count(*) from public.customers)    as customers,
         (select count(*) from public.attachments)  as attachments,
         (select count(*) from public.events)       as events
`);

const orphanItems = await one(`
  select count(*)::int as n from public.order_items oi
  left join public.orders o on o.id = oi.order_id
  where o.id is null
`);

const orphanOrders = await one(`
  select count(*)::int as n from public.orders o
  left join public.customers c on c.id = o.customer_id
  where c.id is null
`);

const totals = await one(`
  select (select coalesce(sum(amount_cents),0) from public.orders)      as from_orders,
         (select coalesce(sum(total_cents),0)  from public.order_totals) as from_matview
`);

console.log("row counts:", JSON.stringify(counts));
console.log("orphan order_items:", orphanItems.n, "| orphan orders:", orphanOrders.n);
console.log("revenue orders vs matview:", totals.from_orders, "vs", totals.from_matview);

const failures = [];
if (orphanItems.n !== 0) failures.push(`${orphanItems.n} order_items reference a missing order`);
if (orphanOrders.n !== 0) failures.push(`${orphanOrders.n} orders reference a missing customer`);
if (String(totals.from_orders) !== String(totals.from_matview))
  failures.push("order_totals materialized view disagrees with orders");
if (Number(counts.attachments) !== 250) failures.push(`attachments = ${counts.attachments}, expected 250`);

await client.end();

if (failures.length) {
  console.error("FAILED:", failures.join("; "));
  process.exit(1);
}
console.log("all business invariants hold");
