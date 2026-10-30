// 源库自带的孤儿行:子表里有行指向父表里已经不存在的行,而外键在源库里又标着"已校验"
// (典型来源:在 session_replication_role = replica 下删父表的行,外键触发器不触发)。
// pg_dump 原样带走这些行,恢复时重建外键就会以 23503 失败。
//
// 演练和真实恢复对它的处理一致:先照原样加外键;失败原因是 23503 时,改成 NOT VALID 再加一次,
// 并数出孤儿行。NOT VALID 的外键照样约束之后写入的行,只是不回头检查已有的行——恢复出的库
// 与源库的实际状态一致,数据一行不丢。真实恢复因此成功并在报告里列出这些外键;演练仍判失败,
// 因为这是用户该清理的数据问题(创始人决策 2026-10-31,起因是 2026-10-30 一个 Team 项目的演练)。
//
// 只处理两端都在本次备份里的外键:指向备份之外(如 auth.users)的外键另有预检
// (external-refs.ts)和沙箱托管豁免,行为不变。分区父表上的外键也不处理,PostgreSQL 不允许
// 给分区表加 NOT VALID 外键。
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

/** 能交给 addForeignKeys 处理的外键:两端都在备份里、会校验已有行、不在分区父表上。 */
export function isDeferrableForeignKey(fk: ForeignKeyDef, dumpedSchemas: string[]): boolean {
  return (
    fk.validatesRows &&
    !fk.onPartitionedTable &&
    dumpedSchemas.includes(fk.table.schema) &&
    dumpedSchemas.includes(fk.references.schema)
  );
}

/** 同一条语句改成 NOT VALID:选项(ON DELETE、DEFERRABLE…)之后、分号之前。 */
export function notValidStatement(statement: string): string {
  return statement.replace(/;\s*$/, " NOT VALID;");
}

/** 数违反外键的行。MATCH SIMPLE 只查引用列全非空的行;MATCH FULL 另算"部分为空"的行。 */
export function orphanCountSql(fk: ForeignKeyDef): string {
  const child = (column: string) => `c.${quoteIdent(column)}`;
  const allSet = fk.columns.map((column) => `${child(column)} is not null`).join(" and ");
  const anySet = fk.columns.map((column) => `${child(column)} is not null`).join(" or ");
  const matches = fk.columns
    .map((column, i) => `p.${quoteIdent(fk.referencedColumns[i])} = ${child(column)}`)
    .join(" and ");
  const parent = `${quoteIdent(fk.references.schema)}.${quoteIdent(fk.references.name)}`;
  const missing = `not exists (select 1 from ${parent} p where ${matches})`;
  const where = fk.matchFull ? `(${anySet}) and (not (${allSet}) or ${missing})` : `${allSet} and ${missing}`;
  return `select count(*)::bigint as n from ${quoteIdent(fk.table.schema)}.${quoteIdent(fk.table.name)} c where ${where}`;
}

/** 一条孤儿外键给人看的说法(演练报告的失败项、真实恢复报告的说明共用)。 */
export function describeOrphanedForeignKey(orphaned: OrphanedForeignKey): string {
  const rows = orphaned.orphanRows === null ? "Some rows" : `${orphaned.orphanRows} row(s)`;
  return `${rows} in ${orphaned.table} point to rows missing from ${orphaned.referencedTable} (foreign key ${orphaned.constraint})`;
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
  opts: { allow: RegExp; stopOnError: boolean }
): Promise<AddForeignKeysResult> {
  const result: AddForeignKeysResult = { orphaned: [], expectedSkips: 0, failures: [] };
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
        const counted = await client.query<{ n: string }>(orphanCountSql(fk));
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
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
  return result;
}
