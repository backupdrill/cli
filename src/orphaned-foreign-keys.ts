// 源库自带的孤儿行:子表里有行指向父表里已经不存在的行,而外键在源库里又标着"已校验"
// (典型来源:在 session_replication_role = replica 下删父表的行,外键触发器不触发)。
// pg_dump 原样带走这些行,恢复时重建外键就会以 23503 失败。
//
// 演练和真实恢复对它的处理一致:先照原样加外键;失败原因是 23503 时,改成 NOT VALID 再加一次,
// 并数出孤儿行。NOT VALID 的外键照样约束之后写入的行,只是不回头检查已有的行——恢复出的库
// 与源库的实际状态一致,数据一行不丢。真实恢复因此成功并在报告里列出这些外键;演练仍判失败,
// 因为这是用户该清理的数据问题(创始人决策 2026-10-31,起因是 2026-10-30 一个 Team 项目的演练)。
//
// 只处理两端的数据都在本次快照里的外键(归档里有两张表的 TABLE DATA 条目):孤儿行这时只能来自源库。
// 指向备份之外(如 auth.users)或扩展自带的表(数据不在 dump 里,恢复后是目标上扩展装出来的那份)的外键
// 照旧严格校验,另有预检(external-refs.ts)和沙箱托管豁免。分区父表上的外键也不处理,PostgreSQL
// 不允许给分区表加 NOT VALID 外键。
import type { Client } from "pg";
import { formatQualified, type ForeignKeyDef } from "./dump-sql.js";
import { quoteIdent } from "./restore-engine.js";

export interface OrphanedForeignKey {
  constraint: string;
  /** schema.name */
  table: string;
  referencedTable: string;
  /** 违反约束的行数;数不出来(比如列类型没有可用的 = 运算符)时为 null */
  orphanRows: number | null;
}

/**
 * 归档目录里 TABLE DATA 条目对应的表:`<id>; 0 <oid> TABLE DATA <schema> <名> <属主>`。
 * 名字可以带空格、不加引号,所以去掉末尾的属主后整串比对,不拆分。
 */
export function tablesWithData(listing: string): Set<string> {
  const tables = new Set<string>();
  for (const line of listing.split("\n")) {
    const match = /^\d+; \d+ \d+ TABLE DATA (.*)$/.exec(line);
    if (match) tables.add(match[1].slice(0, match[1].lastIndexOf(" ")));
  }
  return tables;
}

/** 能交给 addForeignKeys 处理的外键:两端的数据都在快照里、会校验已有行、不在分区父表上。 */
export function isDeferrableForeignKey(fk: ForeignKeyDef, withData: Set<string>): boolean {
  return (
    fk.validatesRows &&
    !fk.onPartitionedTable &&
    withData.has(`${fk.table.schema} ${fk.table.name}`) &&
    withData.has(`${fk.references.schema} ${fk.references.name}`)
  );
}

/** 同一条语句改成 NOT VALID:选项(ON DELETE、DEFERRABLE…)之后、分号之前。 */
export function notValidStatement(statement: string): string {
  return statement.replace(/;\s*$/, " NOT VALID;");
}

/**
 * 外键自己比较时用的运算符(pg_constraint.conpfeqop,逐列 PK = FK)和被引用表是不是分区表。
 * 从刚建好的约束上读:裸 = 的语义可能不同(citext 列上外键按不区分大小写比),继承子表也不该算进来。
 */
export interface ComparisonPlan {
  operators: Array<{ schema: string; name: string; left: string; right: string }>;
  referencedPartitioned: boolean;
}

export const COMPARISON_PLAN_SQL = `
  select n.nspname as schema, o.oprname as name,
         format_type(o.oprleft, null) as left, format_type(o.oprright, null) as right,
         (select relkind = 'p' from pg_class where oid = c.confrelid) as referenced_partitioned
    from pg_constraint c
    cross join lateral unnest(c.conpfeqop) with ordinality as u(op, i)
    join pg_operator o on o.oid = u.op
    join pg_namespace n on n.oid = o.oprnamespace
   where c.conname = $1 and c.conrelid = $2::regclass
   order by u.i`;

/**
 * 数违反外键的行,与 PostgreSQL 校验外键(RI_Initial_Check)同一个口径:引用方 ONLY(外键不管继承子表),
 * 被引用方普通表 ONLY、分区表带上分区;比较用约束记录的运算符和类型。
 * MATCH SIMPLE 只查引用列全非空的行;MATCH FULL 另算"部分为空"的行。
 */
export function orphanCountSql(fk: ForeignKeyDef, plan: ComparisonPlan): string {
  const child = (column: string) => `c.${quoteIdent(column)}`;
  const allSet = fk.columns.map((column) => `${child(column)} is not null`).join(" and ");
  const anySet = fk.columns.map((column) => `${child(column)} is not null`).join(" or ");
  const matches = fk.columns
    .map((column, i) => {
      const op = plan.operators[i];
      return (
        `p.${quoteIdent(fk.referencedColumns[i])}::${op.left} ` +
        `OPERATOR(${quoteIdent(op.schema)}.${op.name}) ${child(column)}::${op.right}`
      );
    })
    .join(" and ");
  const parent = `${plan.referencedPartitioned ? "" : "only "}${quoteIdent(fk.references.schema)}.${quoteIdent(fk.references.name)}`;
  const missing = `not exists (select 1 from ${parent} p where ${matches})`;
  const where = fk.matchFull ? `(${anySet}) and (not (${allSet}) or ${missing})` : `${allSet} and ${missing}`;
  return `select count(*)::bigint as n from only ${quoteIdent(fk.table.schema)}.${quoteIdent(fk.table.name)} c where ${where}`;
}

/** 一条孤儿外键给人看的说法(演练报告的失败项、真实恢复报告的说明共用)。 */
export function describeOrphanedForeignKey(orphaned: OrphanedForeignKey): string {
  const rows = orphaned.orphanRows === null ? "Some rows" : `${orphaned.orphanRows} row(s)`;
  // 不说"指向不存在的行":MATCH FULL 下部分为空的行也算违反,它们未必缺对应的行(文案审查)
  return `${rows} in ${orphaned.table} break foreign key ${orphaned.constraint}, which references ${orphaned.referencedTable}`;
}

export interface AddForeignKeysResult {
  orphaned: OrphanedForeignKey[];
  /** 沙箱托管豁免命中数(与 classifyBlocks 同口径) */
  expectedSkips: number;
  /** 其余失败,只在 stopOnError=false 时出现 */
  failures: string[];
}

/**
 * 在一个事务里逐条加外键,每条一个 savepoint。23503 → 改加 NOT VALID 并数孤儿行。
 * 其余错误:stopOnError(真实目标)= 回滚整个事务并抛出;否则(沙箱)按 allow 分类后继续。
 * 调用方负责连接和最终的 commit/rollback 之外的一切——这里自己 begin/commit。
 */
export async function addForeignKeys(
  client: Client,
  fks: ForeignKeyDef[],
  opts: {
    allow: RegExp;
    stopOnError: boolean;
    /** 这些外键上的 COMMENT(pg_restore 写出的 SQL):外键加完再执行,不然注释对象还不存在 */
    commentSql?: string;
  }
): Promise<AddForeignKeysResult> {
  const result: AddForeignKeysResult = { orphaned: [], expectedSkips: 0, failures: [] };
  // 和 pg_restore 的脚本头一样关掉超时:角色上配的 statement_timeout 会让大表的外键校验中途被掐断。
  // search_path 钉在 pg_catalog:pg_dump 的语句都是全限定名,计数用的类型名和运算符也就不会被用户
  // schema 里的同名对象截走(沙箱里这条连接是超级用户)
  await client.query(
    "set statement_timeout = 0; set lock_timeout = 0; set idle_in_transaction_session_timeout = 0; " +
      "set search_path = pg_catalog"
  );
  // transaction_timeout 是 PostgreSQL 17 才有的参数,旧版本上 set 会报"无此参数",忽略即可
  await client.query("set transaction_timeout = 0").catch((error: Error & { code?: string }) => {
    if (error.code !== "42704") throw error;
  });
  await client.query("begin");
  try {
    for (const fk of fks) {
      await client.query("savepoint add_fk");
      try {
        await client.query(fk.statement);
        await client.query("release savepoint add_fk");
        continue;
      } catch (error) {
        await client.query("rollback to savepoint add_fk");
        const pgError = error as Error & { code?: string };
        if (pgError.code !== "23503") {
          if (opts.stopOnError) throw error;
          if (opts.allow.test(pgError.message)) result.expectedSkips += 1;
          else result.failures.push(`foreign key ${fk.constraint} on ${formatQualified(fk.table)}: ${pgError.message}`);
          continue;
        }
      }
      // NOT VALID 失败就是真失败:不在这里吞
      try {
        await client.query(notValidStatement(fk.statement));
      } catch (error) {
        await client.query("rollback to savepoint add_fk");
        if (opts.stopOnError) throw error;
        result.failures.push(`foreign key ${fk.constraint} on ${formatQualified(fk.table)}: ${(error as Error).message}`);
        continue;
      }
      // 计数只为报告:失败(类型没有 = 运算符等)不影响已经加上的外键
      await client.query("savepoint count_orphans");
      let orphanRows: number | null = null;
      try {
        const plan = await client.query<{
          schema: string;
          name: string;
          left: string;
          right: string;
          referenced_partitioned: boolean;
        }>(COMPARISON_PLAN_SQL, [fk.constraint, `${quoteIdent(fk.table.schema)}.${quoteIdent(fk.table.name)}`]);
        if (plan.rows.length !== fk.columns.length) throw new Error("comparison operators not found");
        const counted = await client.query<{ n: string }>(
          orphanCountSql(fk, {
            operators: plan.rows,
            referencedPartitioned: plan.rows[0].referenced_partitioned,
          })
        );
        orphanRows = Number(counted.rows[0].n);
        await client.query("release savepoint count_orphans");
      } catch {
        await client.query("rollback to savepoint count_orphans");
      }
      await client.query("release savepoint add_fk");
      result.orphaned.push({
        constraint: fk.constraint,
        table: formatQualified(fk.table),
        referencedTable: formatQualified(fk.references),
        orphanRows,
      });
    }
    if (opts.commentSql) {
      await client.query("savepoint add_comments");
      try {
        await client.query(opts.commentSql);
        await client.query("release savepoint add_comments");
      } catch (error) {
        await client.query("rollback to savepoint add_comments");
        if (opts.stopOnError) throw error;
        const message = (error as Error).message;
        if (opts.allow.test(message)) result.expectedSkips += 1;
        else result.failures.push(`comments on foreign keys: ${message}`);
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
  return result;
}
