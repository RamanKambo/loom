import type { Expression, Model, Operand, Routine, SqlType, Storage, StorageColumn } from '../generated/types.js';
import { indexModel, columnOf, resolveProperty, type ModelIndex } from '../records.js';
import { defaultSqlType, sqlTypeText, type LogicalShape } from '../sql-types.js';
import { SQL_NOTICE, toText } from './notice.js';
import type { RenderContext } from './context.js';

export const SQL_SCHEMA_FILE = 'schema.sql';
export const SQL_TESTS_FILE = 'contract-tests.sql';

/** Bracket-quote a T-SQL identifier. */
export function bracket(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`;
}

/** A Unicode T-SQL string literal. */
export function nstr(s: string): string {
  return `N'${s.replace(/'/g, "''")}'`;
}

/** A LIKE pattern that matches the bracketed identifier literally: '[' opens a character class in LIKE. */
const likeBracketed = (name: string): string => nstr(`%[[]${name.replace(/[%_[]/g, '[$&]')}]%`);

const objectName = (schema: string, name: string): string => `${bracket(schema)}.${bracket(name)}`;

function literal(v: unknown): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(v);
  return nstr(String(v));
}

const SQL_OPS: Record<string, string> = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' };

/** The column a predicate operand names: the column mapping that property, or the name itself. */
type ColumnOf = (property: string) => string;

/** T-SQL text of a loom-predicate-1 expression; a comparison with null becomes IS [NOT] NULL. */
export function sqlExpression(e: Expression, column: ColumnOf = (p) => p): string {
  const operand = (o: Operand): string => ('property' in o ? bracket(column(o.property)) : literal(o.literal));
  switch (e.op) {
    case 'and':
    case 'or':
      return e.args.map((a) => `(${sqlExpression(a, column)})`).join(` ${e.op.toUpperCase()} `);
    case 'not':
      return `NOT (${sqlExpression(e.arg, column)})`;
    case 'in':
      return `${operand(e.operand)} IN (${e.values.map(literal).join(', ')})`;
    case 'isNull':
      return `${operand(e.operand)} IS NULL`;
    case 'isNotNull':
      return `${operand(e.operand)} IS NOT NULL`;
    default: {
      if ('literal' in e.right && e.right.literal === null && (e.op === 'eq' || e.op === 'ne')) return `${operand(e.left)} IS ${e.op === 'ne' ? 'NOT ' : ''}NULL`;
      return `${operand(e.left)} ${SQL_OPS[e.op]} ${operand(e.right)}`;
    }
  }
}

/** Every column a predicate expression reads. */
function expressionColumns(e: Expression, column: ColumnOf): string[] {
  const of = (o: Operand): string[] => ('property' in o ? [column(o.property)] : []);
  switch (e.op) {
    case 'and':
    case 'or':
      return e.args.flatMap((a) => expressionColumns(a, column));
    case 'not':
      return expressionColumns(e.arg, column);
    case 'in':
    case 'isNull':
    case 'isNotNull':
      return of(e.operand);
    default:
      return [...of(e.left), ...of(e.right)];
  }
}

const columnResolver = (s: Storage): ColumnOf => (p) => s.columns.find((c) => c.property === p)?.name ?? p;

function columnDefault(c: StorageColumn): string {
  if (!c.default) return '';
  if (c.default.function !== undefined) return ` DEFAULT (${c.default.function.toUpperCase()}())`;
  return ` DEFAULT (${literal(c.default.literal)})`;
}

const columnDefinition = (c: StorageColumn): string =>
  `${bracket(c.name)} ${sqlTypeText(c.sqlType)}${c.collation ? ` COLLATE ${c.collation}` : ''}${c.identity ? ' IDENTITY(1,1)' : ''} ${c.nullable ? 'NULL' : 'NOT NULL'}${columnDefault(c)}`;

/** Enum-valued columns: each gets a CHECK over its value set. */
function enumColumns(index: ModelIndex, s: Storage): Array<{ column: StorageColumn; values: string[] }> {
  const type = index.types.get(s.type);
  const out: Array<{ column: StorageColumn; values: string[] }> = [];
  for (const c of s.columns) {
    const p = c.property !== undefined ? type?.properties.find((x) => x.name === c.property) : undefined;
    if (p?.kind === 'enum' && p.enumValues?.length) out.push({ column: c, values: p.enumValues });
  }
  return out;
}

function tableBlock(index: ModelIndex, s: Storage, ctx: RenderContext): string[] {
  const type = index.types.get(s.type);
  const column = columnResolver(s);
  const defs = s.columns.map((c) => `    ${columnDefinition(c)}`);
  defs.push(`    CONSTRAINT ${bracket(`PK_${s.table}`)} PRIMARY KEY (${s.primaryKey.map(bracket).join(', ')})`);
  for (const u of s.unique ?? []) defs.push(`    CONSTRAINT ${bracket(`UQ_${s.table}_${u.name}`)} UNIQUE (${u.columns.map(bracket).join(', ')})`);
  for (const { column: c, values } of enumColumns(index, s)) {
    defs.push(`    CONSTRAINT ${bracket(`CK_${s.table}_${c.name}`)} CHECK (${bracket(c.name)} IN (${values.map(nstr).join(', ')}))`);
  }
  for (const k of s.checks ?? []) {
    if (k.predicate.form === 'prose') {
      ctx.unsupported('check.prose', { kind: 'storage', id: s.id }, `check '${k.name}' of storage '${s.id}' is prose and cannot be rendered as a CHECK constraint`);
      continue;
    }
    defs.push(`    CONSTRAINT ${bracket(`CK_${s.table}_${k.name}`)} CHECK (${sqlExpression(k.predicate.expression, column)})`);
  }
  const create = `CREATE TABLE ${objectName(s.schema, s.table)} (`;
  ctx.covered({ kind: 'storage', id: s.id }, SQL_SCHEMA_FILE, create, ...s.columns.map((c) => columnDefinition(c)));
  return [`-- storage ${s.id} (type ${s.type}${type ? `, version ${type.version}` : ''}, ${s.platform})`, create, defs.join(',\n'), ');', 'GO', ''];
}

/** Storage records of one component's instance, or of every component for a singleton rendering. */
function storageOf(model: Model, component: string | undefined): Storage[] {
  return model.storage.filter((s) => component === undefined || s.owner === component);
}

/**
 * Components whose storage a SQL instance holds, in an order that creates every
 * table a foreign key references first. Ties keep the model's component order.
 */
export function sqlDeploymentOrder(model: Model): string[] {
  const owners = model.components.map((c) => c.id).filter((id) => model.storage.some((s) => s.owner === id));
  const ownerOf = new Map(model.storage.map((s) => [s.id, s.owner]));
  const needs = new Map(owners.map((o) => [o, new Set<string>()]));
  for (const s of model.storage) {
    for (const fk of s.foreignKeys ?? []) {
      const target = ownerOf.get(fk.references);
      if (target && target !== s.owner) needs.get(s.owner)?.add(target);
    }
  }
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < owners.length) {
    const next = owners.find((o) => !placed.has(o) && [...(needs.get(o) ?? [])].every((d) => placed.has(d) || !needs.has(d)));
    // A foreign-key cycle across components cannot be ordered; the rest follow in model order.
    const pick = next ?? owners.find((o) => !placed.has(o))!;
    order.push(pick);
    placed.add(pick);
  }
  return order;
}

/**
 * T-SQL DDL of one component's storage records: schemas, tables with exact
 * column types, keys, unique and check constraints; then foreign keys and
 * indexes, which follow every table so creation order inside the file never
 * matters. A foreign key into another component's table needs that
 * component's DDL first (sqlDeploymentOrder). Procedure bodies are authored
 * by the implementation, and so are migrations.
 */
export function projectSql(model: Model, ctx: RenderContext): Record<string, string> {
  const index = indexModel(model);
  const storage = storageOf(model, ctx.component);
  const lines: string[] = [
    SQL_NOTICE,
    `-- T-SQL DDL for the storage records of ${ctx.component ? `component ${ctx.component}` : 'every component'}, then foreign keys and indexes.`,
    '-- Procedure bodies and migrations are authored by the implementation, never generated.',
    '',
  ];
  const schemas = [...new Set(storage.map((s) => s.schema))].filter((s) => s.toLowerCase() !== 'dbo').sort();
  // Each component's file creates the schemas it uses, so creation must tolerate a schema another file created.
  for (const s of schemas) lines.push(`IF SCHEMA_ID(${nstr(s)}) IS NULL EXEC(${nstr(`CREATE SCHEMA ${bracket(s)}`)});`, 'GO', '');
  for (const s of storage) lines.push(...tableBlock(index, s, ctx));
  for (const s of storage) {
    for (const fk of s.foreignKeys ?? []) {
      const target = model.storage.find((x) => x.id === fk.references);
      if (!target) continue;
      const action = fk.onDelete === 'cascade' ? ' ON DELETE CASCADE' : fk.onDelete === 'set-null' ? ' ON DELETE SET NULL' : '';
      lines.push(
        `-- foreign key ${s.id}.${fk.name} references ${target.id}`,
        `ALTER TABLE ${objectName(s.schema, s.table)} ADD CONSTRAINT ${bracket(`FK_${s.table}_${fk.name}`)} FOREIGN KEY (${fk.columns.map(bracket).join(', ')}) REFERENCES ${objectName(target.schema, target.table)} (${fk.referencedColumns.map(bracket).join(', ')})${action};`,
        'GO',
        '',
      );
    }
  }
  for (const s of storage) {
    for (const ix of s.indexes ?? []) {
      lines.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${bracket(`IX_${s.table}_${ix.name}`)} ON ${objectName(s.schema, s.table)} (${ix.columns.map(bracket).join(', ')});`, 'GO', '');
    }
  }
  return { [SQL_SCHEMA_FILE]: toText(lines) };
}

/**
 * A procedure's SQL name: the schema is the routine's owner; the name is the
 * routine id with any '<owner>.' prefix removed.
 */
export function procedureName(r: Routine): { schema: string; name: string } {
  const prefix = `${r.owner}.`;
  return { schema: r.owner, name: r.id.startsWith(prefix) ? r.id.slice(prefix.length) : r.id };
}

/** The exact physical type a routine slot carries: its bound column's type, or the kind's default mapping. */
function slotType(index: ModelIndex, slot: LogicalShape & { binds?: string }): SqlType {
  if (slot.binds !== undefined) {
    const target = resolveProperty(index, slot.binds);
    if (target?.property) {
      const stored = columnOf(index, target.type.id, target.name);
      if (stored) return stored.column.sqlType;
      return defaultSqlType(target.property);
    }
  }
  return defaultSqlType(slot);
}

/** sys.parameters predicate for an exact type; max_length is in bytes and -1 for MAX. */
function parameterTypePredicate(t: SqlType): string {
  const conds = [`TYPE_NAME(p.system_type_id) = ${nstr(t.name)}`];
  if (t.length !== undefined) {
    const bytes = t.length === 'max' ? -1 : t.name === 'nvarchar' || t.name === 'nchar' ? 2 * t.length : t.length;
    conds.push(`p.max_length = ${bytes}`);
  }
  if (t.name === 'decimal' || t.name === 'numeric') conds.push(`p.precision = ${t.precision ?? 18}`, `p.scale = ${t.scale ?? 0}`);
  return conds.join(' AND ');
}

/** system_type_name as sys.dm_exec_describe_first_result_set reports it; time types carry their default scale 7. */
function describedTypeName(t: SqlType): string {
  if (t.name === 'datetime2' || t.name === 'datetimeoffset' || t.name === 'time') return `${t.name}(7)`;
  return sqlTypeText(t).toLowerCase();
}

function procedureBlock(index: ModelIndex, r: Routine): string[] {
  const { schema, name } = procedureName(r);
  const obj = objectName(schema, name);
  const oid = `OBJECT_ID(${nstr(obj)}, N'P')`;
  const dmf = `sys.dm_exec_describe_first_result_set_for_object(${oid}, 0)`;
  const fail = (n: number, message: string): string => `    THROW ${n}, ${nstr(`Loom contract: procedure ${obj} ${message}`)}, 1;`;
  const lines: string[] = [`-- routine ${r.id} (sql-procedure, version ${r.version}, ${r.parameterPassing} parameters)`, `IF ${oid} IS NULL`, fail(50001, 'does not exist')];
  const params = r.params.map((p, i) => ({ ordinal: i + 1, name: `@${p.name}`, type: slotType(index, p) }));
  if (params.length === 0) {
    lines.push(`IF EXISTS (SELECT 1 FROM sys.parameters AS p WHERE p.object_id = ${oid} AND p.parameter_id > 0)`, fail(50002, 'declares parameters, but the contract declares none'));
  } else if (r.parameterPassing === 'positional') {
    lines.push(
      'IF EXISTS (',
      '    SELECT 1',
      `    FROM (VALUES ${params.map((p) => `(${p.ordinal}, ${nstr(p.name)})`).join(', ')}) AS e (ordinal, name)`,
      '    FULL OUTER JOIN (',
      '        SELECT p.parameter_id, p.name',
      '        FROM sys.parameters AS p',
      `        WHERE p.object_id = ${oid} AND p.parameter_id > 0`,
      '    ) AS a ON a.parameter_id = e.ordinal',
      '    WHERE e.name IS NULL OR a.name IS NULL OR a.name <> e.name',
      ')',
      fail(50002, `parameters differ from the contract (expected ${params.map((p) => p.name).join(', ')} in this order)`),
    );
  } else {
    lines.push(
      'IF EXISTS (',
      '    SELECT 1',
      `    FROM (VALUES ${params.map((p) => `(${nstr(p.name)})`).join(', ')}) AS e (name)`,
      '    FULL OUTER JOIN (',
      '        SELECT p.name',
      '        FROM sys.parameters AS p',
      `        WHERE p.object_id = ${oid} AND p.parameter_id > 0`,
      '    ) AS a ON a.name = e.name',
      '    WHERE e.name IS NULL OR a.name IS NULL',
      ')',
      fail(50002, `parameters differ from the contract (expected ${params.map((p) => p.name).join(', ')} by name)`),
    );
  }
  for (const p of params) {
    lines.push(
      `IF NOT EXISTS (SELECT 1 FROM sys.parameters AS p WHERE p.object_id = ${oid} AND p.name = ${nstr(p.name)} AND ${parameterTypePredicate(p.type)})`,
      fail(50003, `parameter ${p.name} is not ${sqlTypeText(p.type)}`),
    );
  }
  const columns = r.resultSet.map((c, i) => ({ ordinal: i + 1, column: c, type: slotType(index, c) }));
  lines.push(
    `IF EXISTS (SELECT 1 FROM ${dmf} AS r WHERE r.error_number IS NOT NULL)`,
    fail(50004, 'first result set cannot be described'),
    'IF EXISTS (',
    '    SELECT 1',
    `    FROM (VALUES ${columns.map((c) => `(${c.ordinal}, ${nstr(c.column.name)})`).join(', ')}) AS e (ordinal, name)`,
    '    FULL OUTER JOIN (',
    '        SELECT r.column_ordinal, r.name',
    `        FROM ${dmf} AS r`,
    '        WHERE r.is_hidden = 0',
    '    ) AS a ON a.column_ordinal = e.ordinal',
    '    WHERE e.name IS NULL OR a.name IS NULL OR a.name <> e.name',
    ')',
    fail(50005, `first result set columns differ from the contract (expected ${columns.map((c) => c.column.name).join(', ')} in this order)`),
  );
  for (const { ordinal, column, type } of columns) {
    lines.push(
      `IF NOT EXISTS (SELECT 1 FROM ${dmf} AS r WHERE r.column_ordinal = ${ordinal} AND r.is_nullable = ${column.nullable ? 1 : 0})`,
      fail(50006, `result column ${column.name} must be ${column.nullable ? 'nullable' : 'NOT NULL'}`),
      `IF NOT EXISTS (SELECT 1 FROM ${dmf} AS r WHERE r.column_ordinal = ${ordinal} AND r.system_type_name = ${nstr(describedTypeName(type))})`,
      fail(50007, `result column ${column.name} is not ${sqlTypeText(type)}`),
    );
  }
  lines.push('GO');
  return lines;
}

/** INFORMATION_SCHEMA.COLUMNS predicate for an exact type and collation; CHARACTER_MAXIMUM_LENGTH is in characters and -1 for MAX. */
function columnTypePredicate(c: StorageColumn): string {
  const t = c.sqlType;
  const conds = [`c.DATA_TYPE = ${nstr(t.name)}`];
  if (t.length !== undefined && t.name !== 'varbinary' && t.name !== 'binary') conds.push(`c.CHARACTER_MAXIMUM_LENGTH = ${t.length === 'max' ? -1 : t.length}`);
  if (t.name === 'decimal' || t.name === 'numeric') conds.push(`c.NUMERIC_PRECISION = ${t.precision ?? 18}`, `c.NUMERIC_SCALE = ${t.scale ?? 0}`);
  if (c.collation) conds.push(`c.COLLATION_NAME = ${nstr(c.collation)}`);
  return conds.join(' AND ');
}

/**
 * An index of the table (primary key, unique constraint or plain index) with
 * exactly these key columns in this order. The name is the pipeline's own, so
 * the check never depends on it.
 */
function keyIndexExists(oidExpr: string, filter: string, columns: readonly string[]): string[] {
  const expected = columns.map((c, i) => `(${i + 1}, ${nstr(c)})`).join(', ');
  return [
    'IF NOT EXISTS (',
    '    SELECT 1 FROM sys.indexes AS i',
    `    WHERE i.object_id = ${oidExpr} AND ${filter}`,
    `        AND (SELECT COUNT(*) FROM sys.index_columns AS ic WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0) = ${columns.length}`,
    '        AND NOT EXISTS (',
    `            SELECT 1 FROM (VALUES ${expected}) AS e (ordinal, name)`,
    '            WHERE NOT EXISTS (',
    '                SELECT 1 FROM sys.index_columns AS ic',
    '                WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal = e.ordinal',
    '                    AND COL_NAME(ic.object_id, ic.column_id) = e.name',
    '            )',
    '        )',
    ')',
  ];
}

function storageBlock(index: ModelIndex, model: Model, s: Storage): string[] {
  const obj = objectName(s.schema, s.table);
  const oid = `OBJECT_ID(${nstr(obj)}, N'U')`;
  const fail = (n: number, message: string): string => `    THROW ${n}, ${nstr(`Loom contract: table ${obj} ${message}`)}, 1;`;
  const cols = (names: readonly string[]): string => names.map(bracket).join(', ');
  const lines: string[] = [`-- storage ${s.id} (table ${s.schema}.${s.table}, type ${s.type})`, `IF ${oid} IS NULL`, fail(50011, 'does not exist')];
  for (const c of s.columns) {
    const where = `c.TABLE_SCHEMA = ${nstr(s.schema)} AND c.TABLE_NAME = ${nstr(s.table)} AND c.COLUMN_NAME = ${nstr(c.name)}`;
    lines.push(
      `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS AS c WHERE ${where})`,
      fail(50012, `has no column ${bracket(c.name)}`),
      `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS AS c WHERE ${where} AND c.IS_NULLABLE = ${nstr(c.nullable ? 'YES' : 'NO')})`,
      fail(50013, `column ${bracket(c.name)} must be ${c.nullable ? 'nullable' : 'NOT NULL'}`),
      `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS AS c WHERE ${where} AND ${columnTypePredicate(c)})`,
      fail(50014, `column ${bracket(c.name)} is not ${sqlTypeText(c.sqlType)}${c.collation ? ` COLLATE ${c.collation}` : ''}`),
    );
  }
  // The constraint name is the pipeline's own; the contract is an enabled
  // foreign key from exactly these columns to exactly the referenced columns.
  for (const fk of s.foreignKeys ?? []) {
    const target = model.storage.find((x) => x.id === fk.references);
    if (!target) continue;
    const referenced = objectName(target.schema, target.table);
    const pairs = fk.columns.map((c, i) => `(${nstr(c)}, ${nstr(fk.referencedColumns[i] ?? '')})`).join(', ');
    lines.push(
      'IF NOT EXISTS (',
      '    SELECT 1',
      '    FROM sys.foreign_keys AS fk',
      `    WHERE fk.parent_object_id = ${oid}`,
      `        AND fk.referenced_object_id = OBJECT_ID(${nstr(referenced)}, N'U')`,
      '        AND fk.is_disabled = 0',
      `        AND (SELECT COUNT(*) FROM sys.foreign_key_columns AS fkc WHERE fkc.constraint_object_id = fk.object_id) = ${fk.columns.length}`,
      '        AND NOT EXISTS (',
      `            SELECT 1 FROM (VALUES ${pairs}) AS e (parent, referenced)`,
      '            WHERE NOT EXISTS (',
      '                SELECT 1 FROM sys.foreign_key_columns AS fkc',
      '                WHERE fkc.constraint_object_id = fk.object_id',
      '                    AND COL_NAME(fkc.parent_object_id, fkc.parent_column_id) = e.parent',
      '                    AND COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) = e.referenced',
      '            )',
      '        )',
      ')',
      fail(50015, `has no enabled foreign key (${cols(fk.columns)}) referencing ${referenced} (${cols(fk.referencedColumns)})`),
    );
  }
  lines.push(...keyIndexExists(oid, 'i.is_primary_key = 1', s.primaryKey), fail(50016, `primary key is not (${cols(s.primaryKey)}) in this order`));
  for (const u of s.unique ?? []) {
    lines.push(...keyIndexExists(oid, 'i.is_unique = 1 AND i.is_primary_key = 0', u.columns), fail(50017, `has no unique key (${cols(u.columns)})`));
  }
  // A check constraint's stored definition is normalized by the engine, so the
  // contract is an enabled check constraint over exactly the declared columns.
  const column = columnResolver(s);
  const checks: Array<{ label: string; columns: string[] }> = enumColumns(index, s).map(({ column: c }) => ({ label: `the value set of ${bracket(c.name)}`, columns: [c.name] }));
  for (const k of s.checks ?? []) {
    if (k.predicate.form === 'expression') checks.push({ label: `check ${k.name}`, columns: [...new Set(expressionColumns(k.predicate.expression, column))] });
  }
  for (const k of checks) {
    lines.push(
      `IF NOT EXISTS (SELECT 1 FROM sys.check_constraints AS k WHERE k.parent_object_id = ${oid} AND k.is_disabled = 0${k.columns.map((c) => ` AND k.definition LIKE ${likeBracketed(c)}`).join('')})`,
      fail(50018, `has no enabled check constraint for ${k.label} over ${cols(k.columns)}`),
    );
  }
  for (const ix of s.indexes ?? []) {
    lines.push(...keyIndexExists(oid, `i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.is_unique = ${ix.unique ? 1 : 0}`, ix.columns), fail(50019, `has no ${ix.unique ? 'unique ' : ''}index (${cols(ix.columns)})`));
  }
  for (const c of s.columns) {
    const columnId = `COLUMNPROPERTY(${oid}, ${nstr(c.name)}, 'ColumnId')`;
    if (c.default) {
      const definition = c.default.function !== undefined ? ` AND d.definition LIKE ${nstr(`%${c.default.function}%`)}` : '';
      lines.push(
        `IF NOT EXISTS (SELECT 1 FROM sys.default_constraints AS d WHERE d.parent_object_id = ${oid} AND d.parent_column_id = ${columnId}${definition})`,
        fail(50020, `column ${bracket(c.name)} has no default${c.default.function !== undefined ? ` ${c.default.function.toUpperCase()}()` : ''}`),
      );
    }
    if (c.identity) {
      lines.push(`IF COLUMNPROPERTY(${oid}, ${nstr(c.name)}, 'IsIdentity') <> 1`, fail(50021, `column ${bracket(c.name)} is not an identity column`));
    }
  }
  lines.push('GO');
  return lines;
}

/**
 * T-SQL conformance checks for one component: one batch per sql-procedure
 * routine (existence, parameter names and order under positional passing,
 * exact parameter types, first result set columns, nullability and exact
 * types) and one per storage record (columns with exact types, collation and
 * nullability, foreign keys, the primary key, unique keys, check constraints,
 * indexes, defaults and identity). Read-only and idempotent: SELECT inside IF
 * predicates and THROW only.
 */
export function projectSqlContractTests(model: Model, ctx: RenderContext): Record<string, string> {
  const index = indexModel(model);
  const lines: string[] = [
    SQL_NOTICE,
    `-- Loom conformance checks for the SQL procedures and tables of ${ctx.component ? `component ${ctx.component}` : 'every component'}. Read-only and idempotent: SELECT and THROW only.`,
    '-- Each block is one batch; a failed check THROWs an exact message',
    '-- (50001-50007 procedures, 50011-50021 tables). Run with sqlcmd -b so the first failure fails the pipeline.',
    '',
  ];
  for (const r of model.routines) {
    if (r.host !== 'sql-procedure' || (ctx.component !== undefined && r.owner !== ctx.component)) continue;
    const head = `-- routine ${r.id} (`;
    ctx.covered({ kind: 'routine', id: r.id }, SQL_TESTS_FILE, head);
    lines.push(...procedureBlock(index, r), '');
  }
  for (const s of storageOf(model, ctx.component)) {
    ctx.covered({ kind: 'storage', id: s.id }, SQL_TESTS_FILE, `-- storage ${s.id} (`);
    lines.push(...storageBlock(index, model, s), '');
  }
  return { [SQL_TESTS_FILE]: toText(lines) };
}
