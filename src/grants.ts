// 恢复后把 Data API 角色的授权照源库原样补回。
//
// 为什么要这一步:转储和恢复都带 --no-privileges(平台角色的 ACL、ALTER DEFAULT PRIVILEGES
// 会在沙箱和目标上报错),恢复出来的对象拿到什么授权全看目标库的默认授权。Supabase 从
// 2026-05-30(新项目)/2026-10-30(老项目)起不再给 public 里的新表默认授权给 anon /
// authenticated / service_role,于是恢复出来的表数据都在,supabase-js 读写却全部 42501。
// 反过来,还没切换的老项目会给每张恢复出来的表都开放授权,包括源库里刻意不开放的表。
// 两个方向都靠"照源库原样"来修:备份时记下这几个角色(加 PUBLIC)在每个对象上的授权,
// 恢复完先清掉目标给的,再按记录补回。
//
// 只管 PUBLIC 和 Supabase 的三个 API 角色:别的角色(supabase_admin、自建角色)不一定在目标上,
// 而 Data API 能不能读写只看这几个。演练沙箱里这三个角色由 sandboxShimSql 预建,所以演练和真实
// 恢复走的是同一段代码。
//
// 旧快照(manifest 里没有 grants)没有记录可依:public 里的对象按 Supabase 以前的默认授权补
// (拍这些快照时源项目基本都还是这套默认,和改动前恢复进老项目的结果一致),报告里写明。
import type { Client } from "pg";

export const API_ROLES = ["anon", "authenticated", "service_role"] as const;
export type GrantRole = "PUBLIC" | (typeof API_ROLES)[number];
export const GRANT_ROLES: readonly GrantRole[] = ["PUBLIC", ...API_ROLES];

export type GrantedObjectKind = "schema" | "table" | "sequence" | "routine" | "column";
export const GRANTED_OBJECT_KINDS: readonly GrantedObjectKind[] = ["schema", "table", "sequence", "routine", "column"];

// aclexplode 吐出的权限名。MAINTAIN 只有 PG17+ 有,恢复进旧版本时跳过
export const GRANT_PRIVILEGES = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN",
  "USAGE", "EXECUTE", "CREATE",
] as const;

/**
 * 一个对象上 PUBLIC 和三个 API 角色的授权。表、视图、序列、函数一律记下(没有授权也记,
 * privileges 为空 = 源库没给这几个角色任何权限);列只记有列级授权的;schema 一律记。
 */
export interface GrantedObject {
  kind: GrantedObjectKind;
  schema: string;
  /** table / sequence / routine 的名字;column 是它所在的表;schema 没有 */
  name?: string;
  column?: string;
  /** routine:pg_get_function_identity_arguments,聚合是输入参数类型(search_path 为空时取,类型都带 schema) */
  args?: string;
  privileges: Partial<Record<GrantRole, string[]>>;
}

export interface GrantRestore {
  /** recorded = 照快照记录;legacy-defaults = 旧快照,按 Supabase 以前的默认授权补 public */
  mode: "recorded" | "legacy-defaults";
  /** 处理过的对象数 */
  objects: number;
}

// 表、视图、物化视图、外部表、分区表、序列;函数和过程;schema;有列级授权的列。
// 扩展自带的对象不在转储里,恢复时由扩展自己建,不碰。
// search_path 由调用方设成空:identity arguments 里的类型才会都带 schema,两端比得上。
const CATALOG_OBJECTS_SQL = `
  with api_roles(oid, role) as (
    select 0::oid, 'PUBLIC'
    union all
    select oid, rolname::text from pg_catalog.pg_roles where rolname = any($2::text[])
  ),
  relations as (
    select c.oid, n.nspname::text as schema, c.relname::text as name, c.relkind,
           coalesce(c.relacl, pg_catalog.acldefault(case when c.relkind = 'S' then 's' else 'r' end::"char", c.relowner)) as acl
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1::text[])
       and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
       and not exists (select 1 from pg_catalog.pg_depend d
                        where d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass and d.objid = c.oid and d.deptype = 'e')
  ),
  objects as (
    select case when relkind = 'S' then 'sequence' else 'table' end as kind,
           schema, name, null::text as column_name, null::text as args, acl
      from relations
    union all
    select 'column', r.schema, r.name, a.attname::text, null, a.attacl
      from relations r
      join pg_catalog.pg_attribute a on a.attrelid = r.oid
     where a.attnum > 0 and not a.attisdropped and a.attacl is not null
    union all
    -- 聚合用输入参数类型:有序集聚合的 identity arguments 带 ORDER BY,GRANT 不认
    select 'routine', n.nspname::text, p.proname::text, null,
           case when p.prokind = 'a' then pg_catalog.oidvectortypes(p.proargtypes)
                else pg_catalog.pg_get_function_identity_arguments(p.oid) end,
           coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any($1::text[])
       and not exists (select 1 from pg_catalog.pg_depend d
                        where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid = p.oid and d.deptype = 'e')
    union all
    select 'schema', n.nspname::text, null, null, null, coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))
      from pg_catalog.pg_namespace n
     where n.nspname = any($1::text[])
  )
  select o.kind, o.schema, o.name, o.column_name, o.args, r.role,
         -- distinct:同一权限可以由几个授权人各给一次,ACL 里就有几条
         pg_catalog.array_agg(distinct x.privilege_type::text order by x.privilege_type::text) filter (where r.role is not null) as privileges
    from objects o
    left join lateral pg_catalog.aclexplode(o.acl) x on true
    left join api_roles r on r.oid = x.grantee
   group by 1, 2, 3, 4, 5, 6
   order by 1, 2, 3, 4, 5, 6`;

interface CatalogRow {
  kind: GrantedObjectKind;
  schema: string;
  name: string | null;
  column_name: string | null;
  args: string | null;
  role: GrantRole | null;
  privileges: string[] | null;
}

function objectKey(o: Pick<GrantedObject, "kind" | "schema" | "name" | "column" | "args">): string {
  return JSON.stringify([o.kind, o.schema, o.name ?? null, o.column ?? null, o.args ?? null]);
}

/** 在已开的事务里调用:search_path 必须为空(见 CATALOG_OBJECTS_SQL)。 */
async function catalogObjects(client: Client, schemas: string[]): Promise<GrantedObject[]> {
  const res = await client.query<CatalogRow>(CATALOG_OBJECTS_SQL, [schemas, [...API_ROLES]]);
  const objects = new Map<string, GrantedObject>();
  for (const row of res.rows) {
    const object: GrantedObject = {
      kind: row.kind,
      schema: row.schema,
      ...(row.name !== null ? { name: row.name } : {}),
      ...(row.column_name !== null ? { column: row.column_name } : {}),
      ...(row.args !== null ? { args: row.args } : {}),
      privileges: {},
    };
    const key = objectKey(object);
    const existing = objects.get(key) ?? object;
    objects.set(key, existing);
    if (row.role && row.privileges?.length) existing.privileges[row.role] = row.privileges;
  }
  // 列级授权只给别的角色时,这一列对我们没有意义
  return [...objects.values()].filter((o) => o.kind !== "column" || Object.keys(o.privileges).length > 0);
}

async function withEmptySearchPath<T>(client: Client, work: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local search_path = ''");
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/** 备份端:读源库里这几个 schema 下每个对象给 PUBLIC 和 API 角色的授权。 */
export async function captureGrants(client: Client, schemas: string[]): Promise<GrantedObject[]> {
  return withEmptySearchPath(client, () => catalogObjects(client, schemas));
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualifiedName(o: GrantedObject): string {
  return `${quoteIdent(o.schema)}.${quoteIdent(o.name ?? "")}`;
}

function objectClause(o: GrantedObject): string {
  switch (o.kind) {
    case "schema":
      return `schema ${quoteIdent(o.schema)}`;
    case "sequence":
      return `sequence ${qualifiedName(o)}`;
    case "routine":
      // ROUTINE 同时认函数、聚合、过程(PG11+)
      return `routine ${qualifiedName(o)}(${o.args ?? ""})`;
    default:
      return `table ${qualifiedName(o)}`;
  }
}

function roleName(role: GrantRole): string {
  return role === "PUBLIC" ? "public" : quoteIdent(role);
}

/**
 * 把一组对象的授权写成 SQL:schema、表、序列、函数先清掉这几个角色的全部权限再照记录授,
 * 列级授权放在最后(清表权限会连带清掉列权限)。schema 也要清:源库可能靠不给 USAGE 把整个
 * schema 关起来,目标上的 public 却是 Supabase 默认开放的。
 * roles:目标上实际存在的角色(PUBLIC 恒在);maintain:目标是否认 MAINTAIN;
 * revoke: false = 只出授权语句(RECOVERY.md 的清权限按目标目录来,见 recoveryGrantsSql)。
 */
export function grantStatements(
  objects: GrantedObject[],
  opts: { roles: readonly GrantRole[]; maintain: boolean; revoke?: boolean }
): string[] {
  const roles = GRANT_ROLES.filter((role) => opts.roles.includes(role));
  const revokeFrom = roles.map(roleName).join(", ");
  const statements: string[] = [];
  const columns: string[] = [];
  for (const o of objects) {
    if (o.kind !== "column" && opts.revoke !== false) {
      statements.push(`revoke all on ${objectClause(o)} from ${revokeFrom}`);
    }
    for (const role of roles) {
      const privileges = (o.privileges[role] ?? []).filter(
        (p) => (GRANT_PRIVILEGES as readonly string[]).includes(p) && (opts.maintain || p !== "MAINTAIN")
      );
      if (!privileges.length) continue;
      if (o.kind === "column") {
        const column = quoteIdent(o.column ?? "");
        columns.push(
          `grant ${privileges.map((p) => `${p.toLowerCase()} (${column})`).join(", ")} on table ${qualifiedName(o)} to ${roleName(role)}`
        );
      } else {
        statements.push(`grant ${privileges.map((p) => p.toLowerCase()).join(", ")} on ${objectClause(o)} to ${roleName(role)}`);
      }
    }
  }
  return [...statements, ...columns];
}

/** Supabase 以前给 public 里新对象的默认授权(pg_default_acl 实测:表 arwdDxtm、序列 rwU、函数 X)。 */
function legacyDefaultGrants(objects: GrantedObject[]): GrantedObject[] {
  const all = (privileges: string[]) => Object.fromEntries(API_ROLES.map((role) => [role, privileges]));
  return objects
    .filter((o) => o.schema === "public" && (o.kind === "table" || o.kind === "sequence" || o.kind === "routine"))
    .map((o) => ({
      ...o,
      privileges: {
        ...o.privileges,
        ...all(
          o.kind === "table"
            ? ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]
            : o.kind === "sequence"
              ? ["SELECT", "UPDATE", "USAGE"]
              : ["EXECUTE"]
        ),
      },
    }));
}

// 一次发太多条会让单条查询文本过大;几百条一批足够快
const STATEMENTS_PER_QUERY = 200;

/**
 * 恢复端:在恢复出来的对象上照记录重建授权,一个事务内完成,提交前回读目录核对。
 * 目标上的对象以目标目录为准:记录里有、目标上没有的(沙箱跳过的托管对象)略过;
 * 目标上有、记录里没有的(备份转储完之后才建的)按"没有授权"处理,只清不授。
 * recorded 为 undefined = 旧快照:public 里的表、序列、函数在目标已有授权之上补齐 Supabase 以前的默认授权。
 */
export async function restoreGrants(
  client: Client,
  opts: { schemas: string[]; recorded: GrantedObject[] | undefined }
): Promise<GrantRestore> {
  return withEmptySearchPath(client, async () => {
    const target = await targetFacts(client);
    const onTarget = await catalogObjects(client, opts.schemas);

    let planned: GrantedObject[];
    if (opts.recorded === undefined) {
      planned = legacyDefaultGrants(onTarget);
    } else {
      const recorded = new Map(opts.recorded.map((o) => [objectKey(o), o]));
      // 授权在转储之后才读,转储期间新加的列不在归档里:只处理目标上真有的列
      const columns = await targetColumns(client, opts.schemas);
      planned = [
        // 目标上的 schema、表、序列、函数都要过一遍:记录里没有的按"源库没给授权"处理
        ...onTarget
          .filter((o) => o.kind !== "column")
          .map((o) => ({ ...o, privileges: recorded.get(objectKey(o))?.privileges ?? {} })),
        ...opts.recorded.filter((o) => o.kind === "column" && columns.has(objectKey(o))),
      ];
    }
    await execute(client, grantStatements(planned, target));
    await assertGrantsTookEffect(client, opts.schemas, planned, target);
    return { mode: opts.recorded === undefined ? "legacy-defaults" : "recorded", objects: planned.length };
  });
}

/**
 * 补授权失败时的退路(只用于真实目标):把恢复出来的表、序列、函数上这几个角色的权限全部收走。
 * 应用会 42501,但源库关着的东西不会因为目标的默认授权而开着。schema 不动,免得连带目标上别的东西。
 */
export async function revokeApiAccess(client: Client, schemas: string[]): Promise<void> {
  await withEmptySearchPath(client, async () => {
    const target = await targetFacts(client);
    const planned = (await catalogObjects(client, schemas))
      .filter((o) => o.kind === "table" || o.kind === "sequence" || o.kind === "routine")
      .map((o) => ({ ...o, privileges: {} }));
    await execute(client, grantStatements(planned, target));
    await assertGrantsTookEffect(client, schemas, planned, target);
  });
}

async function targetColumns(client: Client, schemas: string[]): Promise<Set<string>> {
  const res = await client.query<{ schema: string; name: string; column_name: string }>(
    `select n.nspname::text as schema, c.relname::text as name, a.attname::text as column_name
       from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1::text[]) and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and a.attnum > 0 and not a.attisdropped`,
    [schemas]
  );
  return new Set(res.rows.map((r) => objectKey({ kind: "column", schema: r.schema, name: r.name, column: r.column_name })));
}

interface TargetFacts {
  roles: GrantRole[];
  maintain: boolean;
}

async function targetFacts(client: Client): Promise<TargetFacts> {
  const version = await client.query<{ server_version_num: string }>("show server_version_num");
  const roleRows = await client.query<{ rolname: GrantRole }>(
    "select rolname from pg_catalog.pg_roles where rolname = any($1::text[])",
    [[...API_ROLES]]
  );
  return {
    roles: ["PUBLIC", ...roleRows.rows.map((r) => r.rolname)],
    maintain: Number(version.rows[0].server_version_num) >= 170000,
  };
}

async function execute(client: Client, statements: string[]): Promise<void> {
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_QUERY) {
    await client.query(statements.slice(i, i + STATEMENTS_PER_QUERY).join(";\n"));
  }
}

function effectivePrivileges(o: GrantedObject, role: GrantRole, target: TargetFacts): string {
  return (o.privileges[role] ?? [])
    .filter((p) => (GRANT_PRIVILEGES as readonly string[]).includes(p) && (target.maintain || p !== "MAINTAIN"))
    .sort()
    .join(",");
}

/**
 * GRANT/REVOKE 遇到不归自己管的对象只给 WARNING、什么也不做(比如恢复用的角色不是属主)。
 * 回读目录逐个对象比,对不上就报错,让事务回滚、调用方走退路,不把"以为设好了"当成功。
 */
async function assertGrantsTookEffect(
  client: Client,
  schemas: string[],
  planned: GrantedObject[],
  target: TargetFacts
): Promise<void> {
  const actual = new Map((await catalogObjects(client, schemas)).map((o) => [objectKey(o), o]));
  const off = planned.filter((o) => {
    const now = actual.get(objectKey(o)) ?? { ...o, privileges: {} };
    return target.roles.some((role) => effectivePrivileges(o, role, target) !== effectivePrivileges(now, role, target));
  });
  if (!off.length) return;
  const named = off
    .slice(0, 3)
    .map((o) => `${o.kind} ${o.schema}${o.name ? `.${o.name}` : ""}${o.column ? `.${o.column}` : ""}`)
    .join(", ");
  throw new Error(
    `grants didn't take effect on ${off.length} object(s) (${named}${off.length > 3 ? ", …" : ""}); ` +
      `the role running the restore probably doesn't own them`
  );
}

/** 演练和恢复报告里的一行。旧快照那句按场合说:恢复是已经开放了要收回,演练是提醒真恢复时会这样。 */
export function grantsCheck(outcome: GrantRestore, context: "drill" | "restore"): { name: string; pass: boolean; detail: string } {
  const legacyScope = `Supabase's old default access to the ${outcome.objects} table(s), sequence(s) and function(s) in public`;
  return {
    name: "API grants",
    pass: true,
    detail:
      outcome.mode === "recorded"
        ? `access for anon, authenticated and service_role set as it was at backup time on ${outcome.objects} object(s)`
        : context === "restore"
          ? `this snapshot was taken before BackupDrill recorded grants, so anon, authenticated and service_role got ` +
            `${legacyScope}. Revoke it on anything you kept private`
          : `this snapshot was taken before BackupDrill recorded grants, so restoring it gives anon, authenticated and ` +
            `service_role ${legacyScope}. Newer backups record the grants`,
  };
}

/** 选一个不出现在任何内容里的 dollar-quote 标签,内容原样放进去不用转义。 */
function dollarQuoteTag(base: string, contents: string[]): string {
  for (let i = 0; ; i++) {
    const tag = `$${base}${i || ""}$`;
    if (!contents.some((text) => text.includes(tag))) return tag;
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * RECOVERY.md 手工恢复那一步的 SQL(CLI 的 S3 版和 worker 的 Drive 版共用),做法和 restoreGrants 一样:
 * 先按恢复后的目录,把快照里各 schema 下每个 schema、表、序列、函数上 PUBLIC 和三个角色的权限全部收走
 * (扩展自带的对象不碰),再逐条授回记录里的;记录里有、恢复出来没有的对象跳过并提示,不中断。
 * 授权是在转储完之后读的:两次读之间删掉的对象在转储里、不在记录里,只按记录逐个收权就会漏掉它,
 * 它会带着默认的 PUBLIC 执行权恢复出来(交叉审查 2026-10-31);反过来,之间新加的对象(列)在记录里、
 * 不在转储里,直接授权会报错,在 Supabase 的 SQL 编辑器里整段回滚。所以整段放进一个 DO 块。
 * 旧快照没有记录,给 Supabase 以前的默认授权。
 * MAINTAIN 只会出现在 PG17+ 源库的记录里,而恢复目标的版本不低于源库,所以照写。
 */
export function recoveryGrantsSql(database: { schemas: string[]; grants?: GrantedObject[] }): string {
  if (database.grants === undefined) {
    return [
      "grant all on all tables in schema public to anon, authenticated, service_role;",
      "grant all on all sequences in schema public to anon, authenticated, service_role;",
      "grant execute on all functions in schema public to anon, authenticated, service_role;",
    ].join("\n");
  }
  const grants = grantStatements(database.grants, { roles: GRANT_ROLES, maintain: true, revoke: false });
  const inner = dollarQuoteTag("g", grants);
  const outer = dollarQuoteTag("grants", [...grants, ...database.schemas, inner]);
  const schemas = `array[${database.schemas.map(sqlLiteral).join(", ")}]::text[]`;
  const grantArray = grants.length
    ? `array[\n${grants.map((g) => `    ${inner}${g}${inner}`).join(",\n")}\n  ]`
    : "array[]::text[]";
  const notFromExtension = (catalog: string, alias: string) =>
    `not exists (select 1 from pg_catalog.pg_depend d where d.classid = '${catalog}'::pg_catalog.regclass ` +
    `and d.objid = ${alias}.oid and d.deptype = 'e')`;
  return `do ${outer}
declare
  statement text;
begin
  perform pg_catalog.set_config('search_path', '', true);
  -- 1. Take PUBLIC, anon, authenticated and service_role off everything the restore created
  --    (objects that belong to an extension are left alone)
  for statement in
    select pg_catalog.format('revoke all on schema %I from public, anon, authenticated, service_role', n.nspname)
      from pg_catalog.pg_namespace n
     where n.nspname = any (${schemas})
    union all
    select pg_catalog.format('revoke all on %s %I.%I from public, anon, authenticated, service_role',
             case when c.relkind = 'S' then 'sequence' else 'table' end, n.nspname, c.relname)
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any (${schemas})
       and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
       and ${notFromExtension("pg_catalog.pg_class", "c")}
    union all
    select pg_catalog.format('revoke all on routine %I.%I(%s) from public, anon, authenticated, service_role',
             n.nspname, p.proname,
             case when p.prokind = 'a' then pg_catalog.oidvectortypes(p.proargtypes)
                  else pg_catalog.pg_get_function_identity_arguments(p.oid) end)
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any (${schemas})
       and ${notFromExtension("pg_catalog.pg_proc", "p")}
  loop
    execute statement;
  end loop;
  -- 2. Grant back what the source had at backup time; skip what this restore didn't create
  foreach statement in array ${grantArray}
  loop
    begin
      execute statement;
    exception when undefined_table or undefined_column or undefined_function or invalid_schema_name then
      raise notice 'skipped, not in this restore: %', statement;
    end;
  end loop;
end
${outer};`;
}
