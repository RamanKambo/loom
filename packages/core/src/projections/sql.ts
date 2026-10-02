import type { Model, Routine, TypeDef, Kind } from '../types.js';
import { qualifyTable, tableOwner } from '../refs.js';
import { sqlColumnType, SQL_TYPE_FAMILY } from '../sql-types.js';
import { SQL_NOTICE, toText } from './notice.js';

/** Bracket-quote a T-SQL identifier. */
export function bracket(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`;
}

/** A Unicode T-SQL string literal. */
function nstr(s: string): string {
  return `N'${s.replace(/'/g, "''")}'`;
}

interface SqlTable {
  schema: string;
  name: string;
  type: TypeDef;
}

/** Table-backed types with their schema (the owning component) and table name, in model order. */
export function sqlTables(model: Model): SqlTable[] {
  const componentIds = model.components.map((c) => c.id);
  const out: SqlTable[] = [];
  for (const t of model.types) {
    if (t.table === undefined) continue;
    const own = tableOwner(qualifyTable(t.table, t.owner), componentIds);
    out.push({ schema: own ? own.owner : t.owner, name: own ? own.bare : t.table, type: t });
  }
  return out;
}

/**
 * A procedure's SQL name: the schema is the routine's owner; the name is the
 * routine id with any '<owner>.' prefix removed ('ordering.sp_place_order' ->
 * [ordering].[sp_place_order]).
 */
export function procedureName(r: Routine): { schema: string; name: string } {
  const prefix = `${r.owner}.`;
  return { schema: r.owner, name: r.id.startsWith(prefix) ? r.id.slice(prefix.length) : r.id };
}

const objectName = (schema: string, name: string): string => `${bracket(schema)}.${bracket(name)}`;

/** T-SQL DDL: one CREATE TABLE per table-backed type. Procedure bodies are outside the model. */
export function projectSql(model: Model): string {
  const tables = sqlTables(model);
  const lines: string[] = [
    SQL_NOTICE,
    '-- T-SQL DDL for every table-backed type. Procedure bodies are outside the model.',
    '',
  ];
  const schemas = [...new Set(tables.map((t) => t.schema))].filter((s) => s.toLowerCase() !== 'dbo').sort();
  for (const s of schemas) lines.push(`CREATE SCHEMA ${bracket(s)};`, 'GO', '');
  for (const { schema, name, type: t } of tables) {
    const defs = t.properties.map(
      (p) => `    ${bracket(p.name)} ${sqlColumnType(p)} ${p.nullable ? 'NULL' : 'NOT NULL'}`,
    );
    if (t.key && t.key.length) {
      defs.push(`    CONSTRAINT ${bracket(`PK_${name}`)} PRIMARY KEY (${t.key.map(bracket).join(', ')})`);
    }
    for (const p of t.properties) {
      if (p.kind !== 'enum' || !p.enumValues || p.enumValues.length === 0) continue;
      defs.push(
        `    CONSTRAINT ${bracket(`CK_${name}_${p.name}`)} CHECK (${bracket(p.name)} IN (${p.enumValues.map(nstr).join(', ')}))`,
      );
    }
    lines.push(`-- type ${t.id} (version ${t.version})`, `CREATE TABLE ${objectName(schema, name)} (`, defs.join(',\n'), ');', 'GO', '');
  }
  return toText(lines);
}

function family(kind: Kind): readonly string[] {
  return SQL_TYPE_FAMILY[kind];
}

const inList = (values: readonly string[]): string => values.map(nstr).join(', ');

function procedureBlock(r: Routine): string[] {
  const { schema, name } = procedureName(r);
  const obj = objectName(schema, name);
  const oid = `OBJECT_ID(${nstr(obj)}, N'P')`;
  const dmf = `sys.dm_exec_describe_first_result_set_for_object(${oid}, 0)`;
  const fail = (n: number, message: string): string =>
    `    THROW ${n}, ${nstr(`Loom contract: procedure ${obj} ${message}`)}, 1;`;

  const lines: string[] = [
    `-- routine ${r.id} (sql-procedure, version ${r.version})`,
    `IF ${oid} IS NULL`,
    fail(50001, 'does not exist'),
  ];

  const params = r.params.map((p, i) => ({ ordinal: i + 1, name: `@${p.name.replace(/^@/, '')}`, kind: p.kind }));
  if (params.length === 0) {
    lines.push(
      `IF EXISTS (SELECT 1 FROM sys.parameters AS p WHERE p.object_id = ${oid} AND p.parameter_id > 0)`,
      fail(50002, 'declares parameters, but the contract declares none'),
    );
  } else {
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
    for (const p of params) {
      const types = family(p.kind);
      lines.push(
        `IF NOT EXISTS (SELECT 1 FROM sys.parameters AS p WHERE p.object_id = ${oid} AND p.parameter_id = ${p.ordinal} AND TYPE_NAME(p.system_type_id) IN (${inList(types)}))`,
        fail(50003, `parameter ${p.name} is not of the ${p.kind} type family (${types.join(', ')})`),
      );
    }
  }

  const columns = r.resultSet.map((c, i) => ({ ordinal: i + 1, column: c }));
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
    fail(
      50005,
      `first result set columns differ from the contract (expected ${columns.map((c) => c.column.name).join(', ')} in this order)`,
    ),
  );
  for (const { ordinal, column } of columns) {
    const types = family(column.kind);
    lines.push(
      `IF NOT EXISTS (SELECT 1 FROM ${dmf} AS r WHERE r.column_ordinal = ${ordinal} AND r.is_nullable = ${column.nullable ? 1 : 0})`,
      fail(50006, `result column ${column.name} must be ${column.nullable ? 'nullable' : 'NOT NULL'}`),
      `IF NOT EXISTS (SELECT 1 FROM ${dmf} AS r WHERE r.column_ordinal = ${ordinal} AND TYPE_NAME(r.system_type_id) IN (${inList(types)}))`,
      fail(50007, `result column ${column.name} is not of the ${column.kind} type family (${types.join(', ')})`),
    );
  }
  lines.push('GO');
  return lines;
}

function tableBlock({ schema, name, type: t }: SqlTable): string[] {
  const obj = objectName(schema, name);
  const fail = (n: number, message: string): string =>
    `    THROW ${n}, ${nstr(`Loom contract: table ${obj} ${message}`)}, 1;`;
  const lines: string[] = [
    `-- table ${schema}.${name} (type ${t.id}, version ${t.version})`,
    `IF OBJECT_ID(${nstr(obj)}, N'U') IS NULL`,
    fail(50011, 'does not exist'),
  ];
  for (const p of t.properties) {
    const where = `c.TABLE_SCHEMA = ${nstr(schema)} AND c.TABLE_NAME = ${nstr(name)} AND c.COLUMN_NAME = ${nstr(p.name)}`;
    const types = family(p.kind);
    lines.push(
      `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS AS c WHERE ${where})`,
      fail(50012, `has no column ${bracket(p.name)}`),
      `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS AS c WHERE ${where} AND c.IS_NULLABLE = ${nstr(p.nullable ? 'YES' : 'NO')})`,
      fail(50013, `column ${bracket(p.name)} must be ${p.nullable ? 'nullable' : 'NOT NULL'}`),
      `IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS AS c WHERE ${where} AND c.DATA_TYPE IN (${inList(types)}))`,
      fail(50014, `column ${bracket(p.name)} is not of the ${p.kind} type family (${types.join(', ')})`),
    );
  }
  lines.push('GO');
  return lines;
}

/**
 * T-SQL conformance checks: one batch per sql-procedure routine (existence,
 * parameter names/order/count and type families, first result set columns,
 * nullability and type families) and one per table-backed type (each property
 * column present with the right nullability and type family). Read-only and
 * idempotent: only SELECT inside IF predicates and THROW.
 */
export function projectSqlContractTests(model: Model): string {
  const lines: string[] = [
    SQL_NOTICE,
    '-- Loom conformance checks for SQL procedures and tables. Read-only and idempotent: SELECT and THROW only.',
    '-- Each block is one batch; a failed check THROWs an exact message',
    '-- (50001-50007 procedures, 50011-50014 tables). Run with sqlcmd -b so the first failure fails the pipeline.',
    '',
  ];
  for (const r of model.routines) {
    if (r.host === 'sql-procedure') lines.push(...procedureBlock(r), '');
  }
  for (const table of sqlTables(model)) lines.push(...tableBlock(table), '');
  return toText(lines);
}
