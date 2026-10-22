// 读 pg_restore 吐出来的 SQL(纯函数,可单测)。只认 pg_dump 自己的输出格式:
// 名字一律由 fmtId / quote_identifier 生成——[a-z_][a-z0-9_]* 原样,其余加双引号、内嵌引号翻倍,
// dump 头部把 search_path 设成空串,所以引用的表总是 schema.name 全限定。
// 不是通用 SQL 解析器,也不需要是:认不出的语句由调用方如实报"没法检查",不猜。

const QUOTED_IDENT = String.raw`"(?:[^"]|"")+"`;
const IDENT = String.raw`(?:${QUOTED_IDENT}|[a-z_][a-z0-9_]*)`;
const QUALIFIED = String.raw`(${IDENT})\.(${IDENT})`;
const COLUMNS = String.raw`(${IDENT}(?:\s*,\s*${IDENT})*)`;

export interface QualifiedName {
  schema: string;
  name: string;
}

export function unquoteIdent(ident: string): string {
  return ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident;
}

function splitColumns(list: string): string[] {
  return [...list.matchAll(new RegExp(IDENT, "g"))].map((match) => unquoteIdent(match[0]));
}

export function formatQualified(name: QualifiedName): string {
  const show = (part: string) => (/^[a-z_][a-z0-9_]*$/.test(part) ? part : `"${part.replace(/"/g, '""')}"`);
  return `${show(name.schema)}.${show(name.name)}`;
}

/** `pg_restore -f - -L <只含 SCHEMA 条目的清单>` 的输出 → 按出现顺序的 schema 名。 */
export function parseCreateSchemas(sql: string): string[] {
  return [...sql.matchAll(new RegExp(String.raw`^CREATE SCHEMA (${IDENT});$`, "gm"))].map((match) =>
    unquoteIdent(match[1])
  );
}

export interface ForeignKeyDef {
  constraint: string;
  table: QualifiedName;
  columns: string[];
  references: QualifiedName;
  referencedColumns: string[];
  /**
   * ADD CONSTRAINT 时会不会校验已有的行。NOT VALID(源库就没校验过)和 PG18 的 NOT ENFORCED
   * 都不校验,恢复不会因为缺行而失败,所以不用查。
   */
  validatesRows: boolean;
}

/**
 * pg_dump 的外键语句(dumpConstraint):
 *   ALTER [FOREIGN ]TABLE [ONLY ]<表>\n    ADD CONSTRAINT <名> FOREIGN KEY (<列>) REFERENCES <表>(<列>)<选项>;
 * 分区父表上的外键没有 ONLY。认不出的形态(如 PG18 的 PERIOD 时态外键)不返回,
 * 调用方拿条目数对账,差多少就如实报多少条没检查。
 */
export function parseForeignKeys(sql: string): ForeignKeyDef[] {
  const pattern = new RegExp(
    String.raw`^ALTER (?:FOREIGN )?TABLE (?:ONLY )?${QUALIFIED}\n {4}ADD CONSTRAINT (${IDENT}) ` +
      String.raw`FOREIGN KEY \(${COLUMNS}\) REFERENCES ${QUALIFIED}\s*\(${COLUMNS}\)(.*);$`,
    "gm"
  );
  return [...sql.matchAll(pattern)].map((match) => {
    // 选项里可能有带引号的列名(ON DELETE SET NULL ("x")),先去掉再找关键字
    const options = match[8].replace(new RegExp(QUOTED_IDENT, "g"), "");
    return {
      constraint: unquoteIdent(match[3]),
      table: { schema: unquoteIdent(match[1]), name: unquoteIdent(match[2]) },
      columns: splitColumns(match[4]),
      references: { schema: unquoteIdent(match[5]), name: unquoteIdent(match[6]) },
      referencedColumns: splitColumns(match[7]),
      validatesRows: !/\bNOT (?:VALID|ENFORCED)\b/.test(options),
    };
  });
}

/** pg_dump 的挂分区语句(dumpTableAttach):ALTER TABLE ONLY <父> ATTACH PARTITION <子> <边界>; */
export function parsePartitionAttachments(sql: string): Array<{ parent: QualifiedName; child: QualifiedName }> {
  const pattern = new RegExp(String.raw`^ALTER TABLE ONLY ${QUALIFIED} ATTACH PARTITION ${QUALIFIED} `, "gm");
  return [...sql.matchAll(pattern)].map((match) => ({
    parent: { schema: unquoteIdent(match[1]), name: unquoteIdent(match[2]) },
    child: { schema: unquoteIdent(match[3]), name: unquoteIdent(match[4]) },
  }));
}

/**
 * 数据段的 COPY 头(dumpTableData_copy):"COPY <表> <列清单> FROM stdin;"。没有列的表列清单是空串,
 * 所以那一行中间是两个空格,返回空列表。
 */
export function parseCopyHeader(line: string): { table: QualifiedName; columns: string[] } | null {
  const match = new RegExp(String.raw`^COPY ${QUALIFIED} (?:\(${COLUMNS}\))? FROM stdin;$`).exec(line);
  if (!match) return null;
  return {
    table: { schema: unquoteIdent(match[1]), name: unquoteIdent(match[2]) },
    columns: match[3] ? splitColumns(match[3]) : [],
  };
}

/**
 * COPY 文本格式的一个字段 → 值(\N = NULL)。转义规则照 PostgreSQL 文档 "COPY / Text Format":
 * \b \f \n \r \t \v \\,\ 加 1–3 位八进制,\x 加 1–2 位十六进制,其余 \c 就是 c 本身。
 */
export function decodeCopyField(field: string): string | null {
  if (field === "\\N") return null;
  if (!field.includes("\\")) return field;
  return field.replace(/\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|(.))/g, (_, octal, hex, char: string | undefined) => {
    if (octal) return String.fromCharCode(parseInt(octal, 8));
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    const named: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
    return named[char!] ?? char!;
  });
}
