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

/**
 * 读 dump,找出指向 dumpedSchemas 之外的外键,逐条拿目标库对行。只读:目标库上只跑 select。
 * pg_restore 起不来、归档读不了时抛错,由调用方当成 blocker。
 */
export async function checkExternalReferences(opts: {
  dumpPath: string;
  dumpedSchemas: string[];
  targetUrl: string;
}): Promise<ExternalReferenceCheck> {
  const bin = resolvePgRestoreBin();
  const result: ExternalReferenceCheck = { checked: [], problems: [], unchecked: [] };

  const listing = await pgRestoreOutput(bin, ["--list", opts.dumpPath]);
  if (listing.code !== 0) throw new Error(`pg_restore --list exited with code ${listing.code}: ${oneLine(listing.stderr)}`);
  const entries = listing.stdout.split("\n");
  const fkEntries = entries.filter((line) => /^\d+; \d+ \d+ FK CONSTRAINT /.test(line));
  if (!fkEntries.length) return result;
  const attachEntries = entries.filter((line) => /^\d+; \d+ \d+ TABLE ATTACH /.test(line));

  const listDir = await mkdtemp(join(tmpdir(), "backupdrill-refs-"));
  let definitions: string;
  try {
    const listFile = join(listDir, "fk.list");
    await writeFile(listFile, [...fkEntries, ...attachEntries].join("\n") + "\n");
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

  // 分区父表上的外键,数据在各个分区里(dump 按叶子分区写 COPY)
  const children = new Map<string, QualifiedName[]>();
  for (const { parent, child } of parsePartitionAttachments(definitions)) {
    children.set(keyOf(parent), [...(children.get(keyOf(parent)) ?? []), child]);
  }
  const dataTablesOf = (table: QualifiedName): QualifiedName[] => {
    const below = children.get(keyOf(table)) ?? [];
    return [table, ...below.flatMap(dataTablesOf)];
  };

  const client = await connectPg(opts.targetUrl);
  try {
    const scans: Scan[] = [];
    for (const fk of external) {
      const types = await referencedColumnTypes(client, fk);
      if (typeof types === "string") {
        result.problems.push(`${describe(fk)}: ${types}`);
        continue;
      }
      const checked: CheckedForeignKey = { fk, rows: 0, missingRows: 0 };
      result.checked.push(checked);
      scans.push({ checked, types, tables: new Set(dataTablesOf(fk.table).map(keyOf)), batch: new Map() });
    }
    if (scans.length) {
      try {
        await scanDumpData(bin, opts.dumpPath, scans, client);
      } catch (error) {
        // 目标端查询出错(权限、类型转换)不等于恢复一定失败:如实报没查成
        for (const scan of scans) {
          result.unchecked.push(`${describe(scan.checked.fk)}: could not check (${(error as Error).message})`);
        }
        result.checked = result.checked.filter((c) => !scans.some((s) => s.checked === c));
        return result;
      }
      for (const scan of scans) {
        if (scan.missingColumn) {
          result.unchecked.push(`${describe(scan.checked.fk)}: ${scan.missingColumn}`);
          result.checked = result.checked.filter((c) => c !== scan.checked);
          continue;
        }
        if (scan.checked.missingRows > 0) {
          const { fk, rows, missingRows } = scan.checked;
          result.problems.push(
            `${describe(fk)}: ${missingRows.toLocaleString("en-US")} of ${rows.toLocaleString("en-US")} row(s) ` +
              `point at ${formatQualified(fk.references)} rows the target doesn't have`
          );
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
  types: Array<{ name: string; type: string }>;
  /** 这条外键的数据所在的表(本表 + 各级分区) */
  tables: Set<string>;
  /** 本批待查的不同键 → 出现的行数 */
  batch: Map<string, { key: string[]; rows: number }>;
  /** 某个数据块里缺了外键列(生成列不进 COPY):这条外键没法从 dump 里取值 */
  missingColumn?: string;
}

/** 目标库上被引用表的列类型;表或列不在时返回给人看的原因(恢复必然失败)。 */
async function referencedColumnTypes(
  client: pg.Client,
  fk: ForeignKeyDef
): Promise<Array<{ name: string; type: string }> | string> {
  const relation = `${quoteIdent(fk.references.schema)}.${quoteIdent(fk.references.name)}`;
  const exists = await client.query<{ oid: string | null }>("select to_regclass($1)::oid as oid", [relation]);
  if (!exists.rows[0].oid) return `${formatQualified(fk.references)} does not exist on the target`;
  const columns = await client.query<{ name: string; type: string }>(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type
       from pg_attribute a
      where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped and a.attname = any($2::text[])`,
    [exists.rows[0].oid, fk.referencedColumns]
  );
  const byName = new Map(columns.rows.map((row) => [row.name, row.type]));
  const absent = fk.referencedColumns.filter((name) => !byName.has(name));
  if (absent.length) {
    return `${formatQualified(fk.references)} on the target has no column(s) ${absent.join(", ")}`;
  }
  return fk.referencedColumns.map((name) => ({ name, type: byName.get(name)! }));
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
    for (const table of scan.tables) {
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

  // 当前 COPY 块里每条外键要取的列下标;null = 不在 COPY 块里
  let current: Array<{ scan: Scan; indexes: number[] }> | null = null;
  const flush = async (scan: Scan) => {
    if (!scan.batch.size) return;
    const entries = [...scan.batch.values()];
    scan.batch.clear();
    const missing = await missingKeyIndexes(client, scan.checked.fk.references, scan.types, entries.map((e) => e.key));
    for (const index of missing) scan.checked.missingRows += entries[index - 1].rows;
  };
  const onLine = (line: string): Promise<void> | void => {
    if (current === null) {
      const header = parseCopyHeader(line);
      if (!header) return;
      const consumers = wanted.get(keyOf(header.table)) ?? [];
      current = [];
      for (const scan of consumers) {
        const indexes = scan.checked.fk.columns.map((column) => header.columns.indexOf(column));
        if (indexes.some((i) => i < 0)) {
          scan.missingColumn = `column(s) ${scan.checked.fk.columns.join(", ")} are not in the dumped data of ${formatQualified(header.table)}`;
          continue;
        }
        current.push({ scan, indexes });
      }
      return;
    }
    if (line === "\\.") {
      current = null;
      return;
    }
    const fields = line.split("\t");
    let pending: Promise<void>[] | null = null;
    for (const { scan, indexes } of current) {
      const key = indexes.map((i) => (i < fields.length ? decodeCopyField(fields[i]) : null));
      if (key.some((value) => value === null)) continue;
      scan.checked.rows += 1;
      const id = JSON.stringify(key);
      const seen = scan.batch.get(id);
      if (seen) seen.rows += 1;
      else scan.batch.set(id, { key: key as string[], rows: 1 });
      if (scan.batch.size >= KEY_BATCH) (pending ??= []).push(flush(scan));
    }
    if (pending) return Promise.all(pending).then(() => {});
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

/** 一批键里哪些在被引用表里找不到;返回 1 起的下标。按目标列类型转换后比较,和外键校验同一口径。 */
async function missingKeyIndexes(
  client: pg.Client,
  table: QualifiedName,
  columns: Array<{ name: string; type: string }>,
  keys: string[][]
): Promise<number[]> {
  const aliases = columns.map((_, i) => `c${i}`);
  const sql =
    `select k.i::int as i from unnest(${columns.map((_, i) => `$${i + 1}::text[]`).join(", ")}) ` +
    `with ordinality as k(${aliases.join(", ")}, i) ` +
    `where not exists (select 1 from ${quoteIdent(table.schema)}.${quoteIdent(table.name)} r where ` +
    columns.map((column, i) => `r.${quoteIdent(column.name)} = k.${aliases[i]}::${column.type}`).join(" and ") +
    `)`;
  const res = await client.query<{ i: number }>(
    sql,
    columns.map((_, i) => keys.map((key) => key[i]))
  );
  return res.rows.map((row) => row.i);
}

function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 200) || "(no stderr)";
}
