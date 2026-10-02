import type { Expression, Model, Operand, Routine, SqlType, Storage, StorageColumn } from '../generated/types.js';
import { indexModel, columnOf, resolveProperty, type ModelIndex } from '../records.js';
import { defaultSqlType, sqlTypeText, type LogicalShape } from '../sql-types.js';
import { SQL_NOTICE, toText } from './notice.js';
import type { RenderContext } from './context.js';

/** Bracket-quote a T-SQL identifier. */
export function bracket(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`;
}

/** A Unicode T-SQL string literal. */
export function nstr(s: string): string {
  return `N'${s.replace(/'/g, "''")}'`;
}

const objectName = (schema: string, name: string): string => `${bracket(schema)}.${bracket(name)}`;

function literal(v: unknown): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(v);
  return nstr(String(v));
}

const SQL_OPS: Record<string, string> = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' };
const operand = (o: Operand): string => ('property' in o ? bracket(o.property) : literal(o.literal));

/** T-SQL text of a loom-predicate-1 expression over column names; a comparison with null becomes IS [NOT] NULL. */
export function sqlExpression(e: Expression): string {
  switch (e.op) {
    case 'and':
    case 'or':
      return e.args.map((a) => `(${sqlExpression(a)})`).join(` ${e.op.toUpperCase()} `);
    case 'not':
      return `NOT (${sqlExpression(e.arg)})`;
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

function columnDefault(c: StorageColumn): string {
  if (!c.default) return '';
  if (c.default.function !== undefined) return ` DEFAULT (${c.default.function.toUpperCase()}())`;
  return ` DEFAULT (${literal(c.default.literal)})`;
}

function tableBlock(index: ModelIndex, s: Storage, ctx: RenderContext): string[] {
  const type = index.types.get(s.type);
  const defs = s.columns.map(
    (c) =>
      `    ${bracket(c.name)} ${sqlTypeText(c.sqlType)}${c.collation ? ` COLLATE ${c.collation}` : ''}${c.identity ? ' IDENTITY(1,1)' : ''} ${c.nullable ? 'NULL' : 'NOT NULL'}${columnDefault(c)}`,
  );
  defs.push(`    CONSTRAINT ${bracket(`PK_${s.table}`)} PRIMARY KEY (${s.primaryKey.map(bracket).join(', ')})`);
  for (const u of s.unique ?? []) defs.push(`    CONSTRAINT ${bracket(`UQ_${s.table}_${u.name}`)} UNIQUE (${u.columns.map(bracket).join(', ')})`);
  for (const c of s.columns) {
    const p = c.property !== undefined ? type?.properties.find((x) => x.name === c.property) : undefined;
    if (p?.kind !== 'enum' || !p.enumValues?.length) continue;
    defs.push(`    CONSTRAINT ${bracket(`CK_${s.table}_${c.name}`)} CHECK (${bracket(c.name)} IN (${p.enumValues.map(nstr).join(', ')}))`);
  }
  for (const k of s.checks ?? []) {
    if (k.predicate.form === 'prose') {
      ctx.unsupported('check.prose', { kind: 'storage', id: s.id }, `check '${k.name}' of storage '${s.id}' is prose and cannot be rendered as a CHECK constraint`);
      continue;
    }
    defs.push(`    CONSTRAINT ${bracket(`CK_${s.table}_${k.name}`)} CHECK (${sqlExpression(k.predicate.expression)})`);
  }
  return [`-- storage ${s.id} (type ${s.type}${type ? `, version ${type.version}` : ''}, ${s.platform})`, `CREATE TABLE ${objectName(s.schema, s.table)} (`, defs.join(',\n'), ');', 'GO', ''];
}

/**
 * T-SQL DDL of every storage record: schemas, tables with exact column types,
 * keys, unique and check constraints; then foreign keys and indexes, which
 * follow every table so creation order never matters. Procedure bodies are
 * authored by the implementation.
 */
export function projectSql(model: Model, ctx: RenderContext): string {
  const index = indexModel(model);
  const lines: string[] = [SQL_NOTICE, '-- T-SQL DDL for every storage record, then foreign keys and indexes. Procedure bodies are outside the model.', ''];
  const schemas = [...new Set(model.storage.map((s) => s.schema))].filter((s) => s.toLowerCase() !== 'dbo').sort();
  for (const s of schemas) lines.push(`CREATE SCHEMA ${bracket(s)};`, 'GO', '');
  for (const s of model.storage) lines.push(...tableBlock(index, s, ctx));
  const byId = new Map(model.storage.map((s) => [s.id, s]));
  for (const s of model.storage) {
    for (const fk of s.foreignKeys ?? []) {
      const target = byId.get(fk.references);
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
  for (const s of model.storage) {
    for (const ix of s.indexes ?? []) {
      lines.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${bracket(`IX_${s.table}_${ix.name}`)} ON ${objectName(s.schema, s.table)} (${ix.columns.map(bracket).join(', ')});`, 'GO', '');
    }
  }
  return toText(lines);
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

/** INFORMATION_SCHEMA.COLUMNS predicate for an exact type; CHARACTER_MAXIMUM_LENGTH is in characters and -1 for MAX. */
function columnTypePredicate(t: SqlType): string {
  const conds = [`c.DATA_TYPE = ${nstr(t.name)}`];
  if (t.length !== undefined && t.name !== 'varbinary' && t.name !== 'binary') conds.push(`c.CHARACTER_MAXIMUM_LENGTH = ${t.length === 'max' ? -1 : t.length}`);
  if (t.name === 'decimal' || t.name === 'numeric') conds.push(`c.NUMERIC_PRECISION = ${t.precision ?? 18}`, `c.NUMERIC_SCALE = ${t.scale ?? 0}`);
  return conds.join(' AND ');
}

function storageBlock(model: Model, s: Storage): string[] {
  const obj = objectName(s.schema, s.table);
  const fail = (n: number, message: string): string => `    THROW ${n}, ${nstr(`Loom contract: table ${obj} ${message}`)}, 1;`;
  const lines: string[] = [`-- storage ${s.id} (table ${s.schema}.${s.table}, type ${s.type})`, `IF OBJECT_ID(${nstr(obj)}, N'U') IS NULL`, fail(50011, 'does not exist')];
  for (const c of s.columns) {
    const where = `c.TABLE_SCHEMA = ${nstr(s.schema)} AND c.TABLE_NAME = ${nstr(s.table)} AND c.COLUMN_NAME = ${nstr(c.name)}`;
    lines.push(
      `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS AS c WHERE ${where})`,
      fail(50012, `has no column ${bracket(c.name)}`),
      `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS AS c WHERE ${where} AND c.IS_NULLABLE = ${nstr(c.nullable ? 'YES' : 'NO')})`,
      fail(50013, `column ${bracket(c.name)} must be ${c.nullable ? 'nullable' : 'NOT NULL'}`),
      `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS AS c WHERE ${where} AND ${columnTypePredicate(c.sqlType)})`,
      fail(50014, `column ${bracket(c.name)} is not ${sqlTypeText(c.sqlType)}`),
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
      `    WHERE fk.parent_object_id = OBJECT_ID(${nstr(obj)}, N'U')`,
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
      fail(50015, `has no enabled foreign key (${fk.columns.map(bracket).join(', ')}) referencing ${referenced} (${fk.referencedColumns.map(bracket).join(', ')})`),
    );
  }
  lines.push('GO');
  return lines;
}

/**
 * T-SQL conformance checks: one batch per sql-procedure routine (existence,
 * parameter names and order under positional passing, exact parameter types,
 * first result set columns, nullability and exact types) and one per storage
 * record (columns with exact types and nullability, and each declared foreign
 * key). Read-only and idempotent: SELECT inside IF predicates and THROW only.
 */
export function projectSqlContractTests(model: Model): string {
  const index = indexModel(model);
  const lines: string[] = [
    SQL_NOTICE,
    '-- Loom conformance checks for SQL procedures and tables. Read-only and idempotent: SELECT and THROW only.',
    '-- Each block is one batch; a failed check THROWs an exact message',
    '-- (50001-50007 procedures, 50011-50015 tables). Run with sqlcmd -b so the first failure fails the pipeline.',
    '',
  ];
  for (const r of model.routines) if (r.host === 'sql-procedure') lines.push(...procedureBlock(index, r), '');
  for (const s of model.storage) lines.push(...storageBlock(model, s), '');
  return toText(lines);
}
