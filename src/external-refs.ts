// 指向备份之外的外键:恢复前查目标库里有没有被引用的行。
//
// 触因(2026-10-22 实验):只备 public 的快照,profiles.id 外键指向 auth.users。演练沙箱没有
// auth.users,这条外键被归为托管对象跳过,演练 PASS;dry-run 只拿 manifest 对目标环境,
// 根本不看 dump,也过了;恢复到新 Supabase 项目时 auth.users 在、但一行都没有,
// ADD CONSTRAINT 校验已有行失败。外键定义和引用方的数据都只在 dump 里,所以这项检查必须读 dump。
//
// 只查"会校验已有行"的外键(NOT VALID / NOT ENFORCED 的恢复时不校验),只查被引用表在
// 备份之外的(备份之内的表和数据一起恢复,天然对得上)。
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type pg from "pg";
import {
  decodeCopyField,
  formatQualified,
  parseCopyHeader,
  parseForeignKeys,
  parsePartitionAttachments,
  parseTableColumns,
  type ForeignKeyDef,
  type QualifiedName,
} from "./dump-sql.js";
import { libpqChildEnv, pgRestoreOutput, quoteIdent } from "./restore-engine.js";
import { resolvePgRestoreBin } from "./pgbin.js";
import { connectPg } from "./supabase-ca.js";

/** 一批最多带多少个不同的键去目标库查。uuid 键一批约 200 KB 参数,目标端一次反连接。 */
const KEY_BATCH = 5000;

export interface CheckedForeignKey {
  fk: ForeignKeyDef;
  /** 引用列全非空的行数(MATCH SIMPLE:有一列为空就不校验) */
  rows: number;
  /** 其中在目标库找不到被引用行的 */
  missingRows: number;
}

export interface ExternalReferenceCheck {
  checked: CheckedForeignKey[];
  /** 恢复一定会失败的原因,一条一句 */
  problems: string[];
  /** 没能检查的,一条一句。恢复在一个事务里跑,这些真出问题也会整体回滚,所以只提示不拦 */
  unchecked: string[];
}

const keyOf = (name: QualifiedName) => `${name.schema}\u0000${name.name}`;

/** 一个 COPY 头最长读这么多字符;超过就当作读不了,免得坏归档把内存吃满。 */
const MAX_COPY_HEADER = 100_000;

/**
 * 读 dump,找出指向 dumpedSchemas 之外的外键,逐条拿目标库对行。只读:目标库上只跑 select。
 * pg_restore 起不来、归档读不了时抛错,由调用方当成 blocker。单条外键查不成(目标端报错、
 * 数据块读不了)只影响它自己,记进 unchecked,不拖累别的外键的结论。
 */
export async function checkExternalReferences(opts: {
  dumpPath: string;
  dumpedSchemas: string[];
  targetUrl: string;
  /**
   * 还没装到目标上的扩展会装进的 schema(dry-run 时才有;正式恢复先装扩展再查)。被引用的表在这些
   * schema 里又暂时不存在时,可能是扩展装上之后才有的,这时报"装完扩展才查得了",不当成 blocker。
   */
  pendingExtensionSchemas?: string[];
}): Promise<ExternalReferenceCheck> {
  const bin = resolvePgRestoreBin();
  const result: ExternalReferenceCheck = { checked: [], problems: [], unchecked: [] };

  const listing = await pgRestoreOutput(bin, ["--list", opts.dumpPath]);
  if (listing.code !== 0) throw new Error(`pg_restore --list exited with code ${listing.code}: ${oneLine(listing.stderr)}`);
  const entries = listing.stdout.split("\n");
  const fkEntries = entries.filter((line) => /^\d+; \d+ \d+ FK CONSTRAINT /.test(line));
  if (!fkEntries.length) return result;
  const attachEntries = entries.filter((line) => /^\d+; \d+ \d+ TABLE ATTACH /.test(line));
  // 建表语句:比较时要用引用方列的类型
  const tableEntries = entries.filter((line) => /^\d+; \d+ \d+ TABLE (?!DATA |ATTACH )/.test(line));

  const listDir = await mkdtemp(join(tmpdir(), "backupdrill-refs-"));
  let definitions: string;
  try {
    const listFile = join(listDir, "fk.list");
    await writeFile(listFile, [...tableEntries, ...fkEntries, ...attachEntries].join("\n") + "\n");
    const ddl = await pgRestoreOutput(bin, ["-f", "-", `--use-list=${listFile}`, opts.dumpPath]);
    if (ddl.code !== 0) throw new Error(`pg_restore exited with code ${ddl.code}: ${oneLine(ddl.stderr)}`);
    definitions = ddl.stdout;
  } finally {
    await rm(listDir, { recursive: true, force: true });
  }

  const foreignKeys = parseForeignKeys(definitions);
  if (foreignKeys.length < fkEntries.length) {
    result.unchecked.push(
      `${fkEntries.length - foreignKeys.length} foreign key definition(s) in the dump are in a form this check can't read`
    );
  }
  const dumped = new Set(opts.dumpedSchemas);
  const external = foreignKeys.filter((fk) => !dumped.has(fk.references.schema) && fk.validatesRows);
  if (!external.length) return result;

  // 分区父表上的外键,数据在各级叶子分区里(dump 只给叶子写 COPY)
  const children = new Map<string, QualifiedName[]>();
  for (const { parent, child } of parsePartitionAttachments(definitions)) {
    children.set(keyOf(parent), [...(children.get(keyOf(parent)) ?? []), child]);
  }
  const leavesOf = (table: QualifiedName): QualifiedName[] => {
    const below = children.get(keyOf(table)) ?? [];
    return below.length ? below.flatMap(leavesOf) : [table];
  };
  const pending = new Set(opts.pendingExtensionSchemas ?? []);
  const tableColumns = parseTableColumns(definitions);

  const client = await connectPg(opts.targetUrl);
  try {
    const scans: Scan[] = [];
    for (const fk of external) {
      let lookup: Awaited<ReturnType<typeof comparisonPlan>>;
      try {
        lookup = await comparisonPlan(client, fk, tableColumns.get(keyOf(fk.table)));
      } catch (error) {
        result.unchecked.push(`${describe(fk)}: could not look up ${formatQualified(fk.references)} on the target (${(error as Error).message})`);
        continue;
      }
      if ("unchecked" in lookup) {
        result.unchecked.push(`${describe(fk)}: ${lookup.unchecked}`);
        continue;
      }
      if ("problem" in lookup) {
        if (lookup.tableMissing && pending.has(fk.references.schema)) {
          result.unchecked.push(
            `${describe(fk)}: ${formatQualified(fk.references)} isn't on the target yet, and an extension the restore ` +
              `installs into schema ${fk.references.schema} may create it; the restore checks it after installing extensions`
          );
        } else {
          result.problems.push(`${describe(fk)}: ${lookup.problem}`);
        }
        continue;
      }
      const checked: CheckedForeignKey = { fk, rows: 0, missingRows: 0 };
      result.checked.push(checked);
      scans.push({ checked, comparisons: lookup.comparisons, leaves: new Set(leavesOf(fk.table).map(keyOf)), seen: new Set(), batch: new Map() });
    }
    if (scans.length) {
      try {
        await scanDumpData(bin, opts.dumpPath, scans, client);
      } catch (error) {
        for (const scan of scans) scan.failed ??= `could not read the dump's data (${(error as Error).message})`;
      }
      for (const scan of scans) {
        const unseen = [...scan.leaves].filter((table) => !scan.seen.has(table));
        if (!scan.failed && unseen.length) {
          const names = unseen.map((key) => {
            const [schema, name] = key.split("\u0000");
            return formatQualified({ schema, name });
          });
          scan.failed = `could not read the dumped data of ${names.join(", ")}`;
        }
        const { fk, rows, missingRows } = scan.checked;
        if (missingRows > 0) {
          // 已经确认缺的行是事实,后面查不下去也不能把它吞掉
          result.problems.push(
            scan.failed
              ? `${describe(fk)}: at least ${missingRows.toLocaleString("en-US")} row(s) point at ` +
                  `${formatQualified(fk.references)} rows the target doesn't have (the check stopped early: ${scan.failed})`
              : `${describe(fk)}: ${missingRows.toLocaleString("en-US")} of ${rows.toLocaleString("en-US")} row(s) ` +
                  `point at ${formatQualified(fk.references)} rows the target doesn't have`
          );
        } else if (scan.failed) {
          result.unchecked.push(`${describe(fk)}: ${scan.failed}`);
          result.checked = result.checked.filter((c) => c !== scan.checked);
        }
      }
    }
  } finally {
    await client.end();
  }
  return result;
}

export function describe(fk: ForeignKeyDef): string {
  return `${formatQualified(fk.table)} → ${formatQualified(fk.references)} (${fk.constraint})`;
}

interface Scan {
  checked: CheckedForeignKey;
  /** 各外键列怎么和被引用列比较(见 comparisonPlan) */
  comparisons: ColumnComparison[];
  /** 这条外键的数据所在的表(普通表就是它自己;分区表是各级叶子分区) */
  leaves: Set<string>;
  /** 读到过 COPY 块的表 */
  seen: Set<string>;
  /** 本批待查的不同键 → 出现的行数 */
  batch: Map<string, { key: string[]; rows: number }>;
  /** 查不下去的原因(数据里没有外键列、目标端查询报错…);有了就不再收键 */
  failed?: string;
}

/**
 * 目标端的查询一律放进只读事务,查完回滚:dry-run 承诺零写入,而类型转换、域约束、自定义相等
 * 运算符都能调用户函数(交叉审查第二轮复现过域 CHECK 写审计表)。每条语句各开一个事务,
 * 一条出错不会让后面的查询跟着报 "current transaction is aborted"。
 */
async function readOnly<T extends pg.QueryResultRow>(client: pg.Client, sql: string, params: unknown[]): Promise<pg.QueryResult<T>> {
  await client.query("begin transaction read only");
  try {
    return await client.query<T>(sql, params);
  } finally {
    await client.query("rollback").catch(() => {});
  }
}

/**
 * 拿来写 `::类型` 的名字。format_type 给 bpchar 和 bit 的是 character / bit,写进转换里就成了
 * char(1) / bit(1),值被截成一位(交叉审查复现:ABCD 和 AXYZ 被当成同一个键)。这两个换成不带长度的写法。
 */
const CAST_NAME = (oid: string) => `case ${oid}
    when 'pg_catalog.bpchar'::regtype then 'pg_catalog.bpchar'
    when 'pg_catalog._bpchar'::regtype then 'pg_catalog.bpchar[]'
    when 'pg_catalog.bit'::regtype then 'pg_catalog.varbit'
    when 'pg_catalog._bit'::regtype then 'pg_catalog.varbit[]'
    else format_type(${oid}, null) end`;

/** 一列怎么比:`r.<被引用列> OPERATOR(<schema>.<op>) k.<值>::<右类型>`,每一段都取自目标的系统表。 */
interface ColumnComparison {
  referencedColumn: string;
  operator: string;
  /** 引用方的值先转成它自己的类型(去掉域),再按需转成运算符右侧的类型 */
  rightCast: string;
}

/**
 * 照外键自己的做法定比较方式(ATAddForeignKeyConstraint):找被引用列上那个唯一索引,取它每列的
 * 运算符族,在族里找 (索引输入类型, 引用方类型) 的相等运算符;找不到而引用方类型能隐式转成索引输入
 * 类型时,用 (输入类型, 输入类型) 那个。运算符带 schema 写死:裸 `=` 在 search_path 里看不到
 * extensions 时会把 citext 解析成 text 的相等,大小写不同的值就被误报成缺(交叉审查复现)。
 * 引用方列的类型从 dump 的建表语句读,值本来就出自这一列。
 * 被引用的表、列、唯一索引不在时返回 problem(建外键必然失败);其余没法照做的报 unchecked。
 */
async function comparisonPlan(
  client: pg.Client,
  fk: ForeignKeyDef,
  columnsInDump: Map<string, string> | undefined
): Promise<{ comparisons: ColumnComparison[] } | { problem: string; tableMissing: boolean } | { unchecked: string }> {
  const relation = `${quoteIdent(fk.references.schema)}.${quoteIdent(fk.references.name)}`;
  const exists = await readOnly<{ oid: string | null }>(client, "select to_regclass($1)::oid as oid", [relation]);
  const relid = exists.rows[0].oid;
  if (!relid) {
    return { problem: `${formatQualified(fk.references)} does not exist on the target`, tableMissing: true };
  }
  const attributes = await readOnly<{ name: string; num: number }>(
    client,
    `select a.attname as name, a.attnum::int as num from pg_attribute a
      where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped and a.attname = any($2::text[])`,
    [relid, fk.referencedColumns]
  );
  const attnum = new Map(attributes.rows.map((row) => [row.name, row.num]));
  const absent = fk.referencedColumns.filter((name) => !attnum.has(name));
  if (absent.length) {
    return { problem: `${formatQualified(fk.references)} on the target has no column(s) ${absent.join(", ")}`, tableMissing: false };
  }
  // 外键要求被引用列上有一个恰好覆盖这几列的唯一索引(顺序不限),而且不能是可延迟的(indimmediate)
  const indexes = await readOnly<{ keys: string; classes: string; nkeys: number }>(
    client,
    `select i.indkey::text as keys, i.indclass::text as classes, i.indnkeyatts::int as nkeys from pg_index i
      where i.indrelid = $1::oid and i.indisunique and i.indimmediate and i.indisvalid
        and i.indpred is null and i.indexprs is null`,
    [relid]
  );
  const wanted = fk.referencedColumns.map((name) => attnum.get(name)!).sort((a, b) => a - b).join(" ");
  const index = indexes.rows
    .map((row) => ({ keys: row.keys.split(" ").slice(0, row.nkeys).map(Number), classes: row.classes.split(" ") }))
    .find((row) => [...row.keys].sort((a, b) => a - b).join(" ") === wanted);
  if (!index) {
    return {
      problem: `${formatQualified(fk.references)} on the target has no unique index on (${fk.referencedColumns.join(", ")}), so the foreign key can't be created`,
      tableMissing: false,
    };
  }
  const comparisons: ColumnComparison[] = [];
  for (let i = 0; i < fk.columns.length; i++) {
    const column = fk.columns[i];
    const declared = columnsInDump?.get(column);
    if (!declared) return { unchecked: `could not read the type of column ${column} from the dump` };
    const fkType = await readOnly<{ oid: string | null; base: string | null; name: string | null }>(
      client,
      // 域按外键的做法换成底层类型(可以多层嵌套)
      `with recursive t(oid, base, depth) as (
         select to_regtype($1)::oid, to_regtype($1)::oid, 0
         union all
         select t.oid, ty.typbasetype, t.depth + 1 from t join pg_type ty on ty.oid = t.base
          where ty.typtype = 'd' and t.depth < 20)
       select oid::text as oid, base::text as base, ${CAST_NAME("base")} as name from t order by depth desc limit 1`,
      [declared]
    );
    const fkBase = fkType.rows[0]?.base;
    if (!fkType.rows[0]?.oid || !fkBase) {
      return { unchecked: `column ${column} uses type ${declared}, which is missing on the target` };
    }
    const opclass = index.classes[index.keys.indexOf(attnum.get(fk.referencedColumns[i])!)];
    // 先找 (输入类型, 引用方类型);没有就看能不能隐式转成输入类型,用 (输入类型, 输入类型)
    const operator = await readOnly<{ schema: string; name: string; right: string; coerced: boolean }>(
      client,
      `select n.nspname as schema, o.oprname as name,
              ${CAST_NAME("o.oprright")} as right, o.oprright <> $2::oid as coerced
         from pg_opclass oc
         join pg_amop am on am.amopfamily = oc.opcfamily and am.amoplefttype = oc.opcintype and am.amopstrategy = 3
         join pg_operator o on o.oid = am.amopopr
         join pg_namespace n on n.oid = o.oprnamespace
        where oc.oid = $1::oid
          and (am.amoprighttype = $2::oid
               or (am.amoprighttype = oc.opcintype
                   and not exists (select 1 from pg_amop x where x.amopfamily = oc.opcfamily and x.amoplefttype = oc.opcintype
                                     and x.amoprighttype = $2::oid and x.amopstrategy = 3)
                   and exists (select 1 from pg_cast c where c.castsource = $2::oid and c.casttarget = oc.opcintype
                                 and c.castcontext = 'i')))
        order by (am.amoprighttype = $2::oid) desc limit 1`,
      [opclass, fkBase]
    );
    const op = operator.rows[0];
    if (!op) {
      return { unchecked: `can't tell how the foreign key would compare ${declared} with ${formatQualified(fk.references)}.${fk.referencedColumns[i]}` };
    }
    // 运算符名只由符号组成(系统表保证),schema 照常加引号
    comparisons.push({
      referencedColumn: fk.referencedColumns[i],
      operator: `OPERATOR(${quoteIdent(op.schema)}.${op.name})`,
      rightCast: op.coerced ? `${fkType.rows[0].name}::${op.right}` : op.right,
    });
  }
  return { comparisons };
}

/**
 * 把需要的表的数据从 dump 里流出来(pg_restore --data-only -f -),按 COPY 块分发给各条外键。
 * 流式读,内存只占一批键。-n/-t 在 pg_restore 里是精确名字匹配、两者取交集,
 * 多选出来的表按 COPY 头里的全名再筛一遍。
 */
async function scanDumpData(bin: string, dumpPath: string, scans: Scan[], client: pg.Client): Promise<void> {
  const wanted = new Map<string, Scan[]>();
  const schemas = new Set<string>();
  const names = new Set<string>();
  for (const scan of scans) {
    for (const table of scan.leaves) {
      wanted.set(table, [...(wanted.get(table) ?? []), scan]);
      const [schema, name] = table.split("\u0000");
      schemas.add(schema);
      names.add(name);
    }
  }
  const args = ["--data-only", "-f", "-"];
  for (const schema of schemas) args.push("-n", schema);
  for (const name of names) args.push("-t", name);
  args.push(dumpPath);

  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: libpqChildEnv() });
  let stderr = "";
  proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve, reject) => {
    proc.on("error", (error) =>
      reject(new Error(`${bin} failed to start: ${(error as NodeJS.ErrnoException).code ?? error.message}`))
    );
    proc.on("close", resolve);
  });
  exited.catch(() => {});

  const flush = async (scan: Scan) => {
    if (!scan.batch.size || scan.failed) return;
    const entries = [...scan.batch.values()];
    scan.batch.clear();
    try {
      const missing = await missingKeyIndexes(client, scan.checked.fk, scan.comparisons, entries.map((e) => e.key));
      for (const index of missing) scan.checked.missingRows += entries[index - 1].rows;
    } catch (error) {
      // 只停这一条外键:比如值转不成被引用列的类型
      scan.failed = `could not compare its rows on the target (${(error as Error).message})`;
    }
  };

  // 当前 COPY 块里每条外键要取的列下标;null = 不在 COPY 块里,[] = 在一个不需要的块里
  let current: Array<{ scan: Scan; indexes: number[] }> | null = null;
  // 带引号的名字里可以有换行,COPY 头就会跨行:攒到引号配平、以 FROM stdin; 结尾为止
  let header: string | null = null;
  const openHeader = (text: string) => {
    const parsed = parseCopyHeader(text);
    current = [];
    if (!parsed) return; // 读不了的块整块跳过;它的表没记成 seen,最后会报没查成
    const consumers = wanted.get(keyOf(parsed.table)) ?? [];
    for (const scan of consumers) {
      scan.seen.add(keyOf(parsed.table));
      const indexes = scan.checked.fk.columns.map((column) => parsed.columns.indexOf(column));
      if (indexes.some((i) => i < 0)) {
        // 生成列不进 COPY
        scan.failed ??= `column(s) ${scan.checked.fk.columns.join(", ")} are not in the dumped data of ${formatQualified(parsed.table)}`;
        continue;
      }
      current.push({ scan, indexes });
    }
  };
  const onLine = (line: string): Promise<void> | void => {
    if (current === null) {
      if (header === null && !line.startsWith("COPY ")) return;
      header = header === null ? line : `${header}\n${line}`;
      const quotes = header.split('"').length - 1;
      if ((quotes % 2 === 0 && header.endsWith(" FROM stdin;")) || header.length > MAX_COPY_HEADER) {
        openHeader(header);
        header = null;
      }
      return;
    }
    if (line === "\\.") {
      current = null;
      return;
    }
    if (!current.length) return;
    const fields = line.split("\t");
    let full: Scan[] | null = null;
    for (const { scan, indexes } of current) {
      if (scan.failed) continue;
      const key = indexes.map((i) => (i < fields.length ? decodeCopyField(fields[i]) : null));
      if (key.some((value) => value === null)) continue;
      scan.checked.rows += 1;
      const id = JSON.stringify(key);
      const seen = scan.batch.get(id);
      if (seen) seen.rows += 1;
      else scan.batch.set(id, { key: key as string[], rows: 1 });
      if (scan.batch.size >= KEY_BATCH) (full ??= []).push(scan);
    }
    // 一个接一个查:几条外键共用一条连接,同时开事务会互相串(一条报错把另一条的查询也拖成 aborted)
    if (full) {
      const ready = full;
      return ready.reduce((chain, scan) => chain.then(() => flush(scan)), Promise.resolve());
    }
  };

  try {
    const decoder = new StringDecoder("utf8");
    let carry = "";
    // for await 读 stdout 自带背压:查库的时候 pg_restore 停着等
    for await (const chunk of proc.stdout) {
      const lines = (carry + decoder.write(chunk as Buffer)).split("\n");
      carry = lines.pop()!;
      for (const line of lines) {
        const wait = onLine(line);
        if (wait) await wait;
      }
    }
    carry += decoder.end();
    if (carry) await onLine(carry);
    for (const scan of scans) await flush(scan);
  } finally {
    if (proc.exitCode === null) proc.kill();
  }
  const code = await exited;
  if (code !== 0) throw new Error(`pg_restore exited with code ${code}: ${oneLine(stderr)}`);
}

/** 一批键里哪些在被引用表里找不到;返回 1 起的下标。比较方式见 comparisonPlan。 */
async function missingKeyIndexes(
  client: pg.Client,
  fk: ForeignKeyDef,
  comparisons: ColumnComparison[],
  keys: string[][]
): Promise<number[]> {
  const aliases = comparisons.map((_, i) => `c${i}`);
  const sql =
    `select k.i::int as i from unnest(${comparisons.map((_, i) => `$${i + 1}::text[]`).join(", ")}) ` +
    `with ordinality as k(${aliases.join(", ")}, i) ` +
    `where not exists (select 1 from ${quoteIdent(fk.references.schema)}.${quoteIdent(fk.references.name)} r where ` +
    comparisons
      // 被引用列不做转换(转成 character / bit 这类名字会截断它);运算符写死了 schema,右边的类型也定了
      .map((c, i) => `r.${quoteIdent(c.referencedColumn)} ${c.operator} k.${aliases[i]}::${c.rightCast}`)
      .join(" and ") +
    `)`;
  const res = await readOnly<{ i: number }>(
    client,
    sql,
    comparisons.map((_, i) => keys.map((key) => key[i]))
  );
  return res.rows.map((row) => row.i);
}

function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 200) || "(no stderr)";
}
