import { SQL_KIND_FAMILY, procedureName, type Model, type Routine, type SqlType, type Storage } from '@loom/core';

/** The catalog of one database as read from the sys views, through a single FOR JSON query. */
export interface Catalog {
  tables?: CatalogTable[];
  procedures?: CatalogProcedure[];
}

export interface CatalogColumn {
  name: string;
  type: string;
  maxLength: number;
  precision: number;
  scale: number;
  nullable: boolean;
  collation: string | null;
  identity: boolean;
  default: string | null;
}

export interface CatalogTable {
  schema: string;
  table: string;
  columns?: CatalogColumn[];
  keys?: Array<{ name: string; type: string; columns?: Array<{ name: string }> }>;
  foreignKeys?: Array<{ name: string; refSchema: string; refTable: string; onDelete: string; columns?: Array<{ col: string; ref: string }> }>;
  checks?: Array<{ name: string; definition: string }>;
  indexes?: Array<{ name: string; unique: boolean; columns?: Array<{ name: string }> }>;
}

export interface CatalogProcedure {
  schema: string;
  name: string;
  params?: Array<{ name: string; type: string; maxLength: number; precision: number; scale: number; ordinal: number }>;
}

const colList = (objectExpr: string, indexExpr: string, included = ''): string =>
  `(SELECT col.name FROM sys.index_columns ic JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id WHERE ic.object_id = ${objectExpr} AND ic.index_id = ${indexExpr}${included} ORDER BY ic.key_ordinal FOR JSON PATH)`;

/** One query over sys.tables, sys.columns, sys.types, the constraint views, sys.indexes and sys.procedures. */
export const CATALOG_QUERY = [
  'SELECT (SELECT',
  '  (SELECT s.name AS [schema], t.name AS [table],',
  '    (SELECT c.name, ty.name AS [type], c.max_length AS maxLength, c.precision, c.scale, c.is_nullable AS nullable, c.collation_name AS collation, c.is_identity AS [identity], dc.definition AS [default]',
  '       FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id',
  '       LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id',
  '       WHERE c.object_id = t.object_id ORDER BY c.column_id FOR JSON PATH, INCLUDE_NULL_VALUES) AS columns,',
  `    (SELECT kc.name, kc.type, ${colList('kc.parent_object_id', 'kc.unique_index_id')} AS columns FROM sys.key_constraints kc WHERE kc.parent_object_id = t.object_id FOR JSON PATH) AS keys,`,
  '    (SELECT fk.name, OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS refSchema, OBJECT_NAME(fk.referenced_object_id) AS refTable, fk.delete_referential_action_desc AS onDelete,',
  '       (SELECT pc.name AS col, rc.name AS ref FROM sys.foreign_key_columns fkc',
  '          JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id',
  '          JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id',
  '          WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id FOR JSON PATH) AS columns',
  '       FROM sys.foreign_keys fk WHERE fk.parent_object_id = t.object_id FOR JSON PATH) AS foreignKeys,',
  '    (SELECT cc.name, cc.definition FROM sys.check_constraints cc WHERE cc.parent_object_id = t.object_id FOR JSON PATH) AS checks,',
  `    (SELECT i.name, i.is_unique AS [unique], ${colList('i.object_id', 'i.index_id', ' AND ic.is_included_column = 0')} AS columns`,
  '       FROM sys.indexes i WHERE i.object_id = t.object_id AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.type > 0 FOR JSON PATH) AS indexes',
  '   FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE t.is_ms_shipped = 0 FOR JSON PATH) AS tables,',
  '  (SELECT OBJECT_SCHEMA_NAME(p.object_id) AS [schema], p.name,',
  '    (SELECT pa.name, ty.name AS [type], pa.max_length AS maxLength, pa.precision, pa.scale, pa.parameter_id AS ordinal',
  '       FROM sys.parameters pa JOIN sys.types ty ON ty.user_type_id = pa.user_type_id',
  '       WHERE pa.object_id = p.object_id AND pa.parameter_id > 0 ORDER BY pa.parameter_id FOR JSON PATH) AS params',
  '   FROM sys.procedures p WHERE p.is_ms_shipped = 0 FOR JSON PATH) AS procedures',
  ' FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS j;',
].join('\n');

const WIDE_CHAR = new Set(['nvarchar', 'nchar']);
const SIZED = new Set(['nvarchar', 'varchar', 'nchar', 'char', 'varbinary', 'binary']);
const TEMPORAL_SCALE = new Set(['datetime2', 'time', 'datetimeoffset']);

/** The sys.columns max_length a declared SqlType implies: bytes, with -1 for max. */
function expectedMaxLength(t: SqlType): number | undefined {
  if (!SIZED.has(t.name) || t.length === undefined) return undefined;
  if (t.length === 'max') return -1;
  return WIDE_CHAR.has(t.name) ? t.length * 2 : t.length;
}

const ON_DELETE: Readonly<Record<string, string>> = { 'no-action': 'NO_ACTION', cascade: 'CASCADE', 'set-null': 'SET_NULL' };

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i]!.toLowerCase());
const names = (cols: Array<{ name: string }> | undefined): string[] => (cols ?? []).map((c) => c.name);

function defaultMismatch(where: string, declared: NonNullable<Storage['columns'][number]['default']>, actual: string | null): string | null {
  if (actual === null) return `${where} has no default constraint, but the storage record declares one`;
  const text = actual.toLowerCase();
  if (declared.function !== undefined && !text.includes(`${declared.function}()`)) return `${where} default is ${actual}, not ${declared.function}()`;
  if (declared.literal !== undefined && declared.literal !== null) {
    const lit = String(declared.literal).toLowerCase();
    const bool = typeof declared.literal === 'boolean' ? (declared.literal ? '1' : '0') : null;
    if (!text.includes(lit) && !(bool && text.includes(bool))) return `${where} default is ${actual}, not ${String(declared.literal)}`;
  }
  return null;
}

/**
 * Every difference between the deployed catalog and the storage records
 * (exact type, length, precision, scale, nullability, collation, identity,
 * defaults, keys, unique, foreign keys, checks and indexes). The expectation
 * is computed here from the records, independently of the generated contract
 * tests, so the two oracles can disagree.
 */
export function storageMismatches(storage: readonly Storage[], catalog: Catalog, options: { exhaustive?: boolean } = {}): string[] {
  const out: string[] = [];
  const tables = catalog.tables ?? [];
  const byName = new Map(storage.map((s) => [`${s.schema}.${s.table}`.toLowerCase(), s]));
  for (const s of storage) {
    const t = tables.find((x) => x.schema.toLowerCase() === s.schema.toLowerCase() && x.table.toLowerCase() === s.table.toLowerCase());
    const label = `[${s.schema}].[${s.table}]`;
    if (!t) {
      out.push(`table ${label} of storage ${s.id} does not exist`);
      continue;
    }
    const cols = t.columns ?? [];
    // Physical column position is not a storage obligation: the comparison policy treats a reorder as
    // compatible and an additive migration appends. The set of columns is.
    const declaredNames = new Set(s.columns.map((c) => c.name.toLowerCase()));
    const missing = s.columns.filter((c) => !cols.some((a) => a.name.toLowerCase() === c.name.toLowerCase())).map((c) => c.name);
    const extra = cols.filter((a) => !declaredNames.has(a.name.toLowerCase())).map((a) => a.name);
    if (missing.length) out.push(`${label} lacks column(s) ${missing.join(', ')}`);
    if (extra.length) out.push(`${label} has column(s) ${extra.join(', ')} the storage record does not declare`);
    for (const c of s.columns) {
      const a = cols.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
      const where = `${label}.[${c.name}]`;
      if (!a) continue;
      if (a.type !== c.sqlType.name) out.push(`${where} is ${a.type}, not ${c.sqlType.name}`);
      const len = expectedMaxLength(c.sqlType);
      if (len !== undefined && a.maxLength !== len) out.push(`${where} has max_length ${a.maxLength}, not ${len}`);
      if ((c.sqlType.name === 'decimal' || c.sqlType.name === 'numeric') && c.sqlType.precision !== undefined) {
        if (a.precision !== c.sqlType.precision || a.scale !== (c.sqlType.scale ?? 0)) out.push(`${where} is (${a.precision},${a.scale}), not (${c.sqlType.precision},${c.sqlType.scale ?? 0})`);
      }
      if (TEMPORAL_SCALE.has(c.sqlType.name) && c.sqlType.scale !== undefined && a.scale !== c.sqlType.scale) out.push(`${where} has scale ${a.scale}, not ${c.sqlType.scale}`);
      if (a.nullable !== c.nullable) out.push(`${where} is ${a.nullable ? 'NULL' : 'NOT NULL'}, not ${c.nullable ? 'NULL' : 'NOT NULL'}`);
      if (c.collation !== undefined && (a.collation ?? '').toLowerCase() !== c.collation.toLowerCase()) out.push(`${where} has collation ${String(a.collation)}, not ${c.collation}`);
      if (c.identity !== undefined && a.identity !== c.identity) out.push(`${where} identity is ${String(a.identity)}, not ${String(c.identity)}`);
      if (c.default) {
        const d = defaultMismatch(where, c.default, a.default);
        if (d) out.push(d);
      } else if (a.default !== null) out.push(`${where} has default ${a.default}, but the storage record declares none`);
    }
    const pk = (t.keys ?? []).find((k) => k.type === 'PK');
    if (!pk) out.push(`${label} has no primary key`);
    else if (!sameList(names(pk.columns), s.primaryKey)) out.push(`${label} primary key is (${names(pk.columns).join(', ')}), not (${s.primaryKey.join(', ')})`);
    const uqs = (t.keys ?? []).filter((k) => k.type === 'UQ');
    for (const u of s.unique ?? []) {
      const a = uqs.find((x) => x.name.toLowerCase() === `uq_${s.table}_${u.name}`.toLowerCase());
      if (!a) out.push(`${label} lacks unique constraint ${u.name}`);
      else if (!sameList(names(a.columns), u.columns)) out.push(`${label} unique ${u.name} is (${names(a.columns).join(', ')}), not (${u.columns.join(', ')})`);
    }
    if (uqs.length !== (s.unique ?? []).length) out.push(`${label} has ${uqs.length} unique constraint(s), the storage record declares ${(s.unique ?? []).length}`);
    for (const fk of s.foreignKeys ?? []) {
      const target = storage.find((x) => x.id === fk.references) ?? null;
      const a = (t.foreignKeys ?? []).find((x) => x.name.toLowerCase() === `fk_${s.table}_${fk.name}`.toLowerCase());
      if (!a) {
        out.push(`${label} lacks foreign key ${fk.name}`);
        continue;
      }
      if (target && (a.refSchema.toLowerCase() !== target.schema.toLowerCase() || a.refTable.toLowerCase() !== target.table.toLowerCase())) {
        out.push(`${label} foreign key ${fk.name} references [${a.refSchema}].[${a.refTable}], not [${target.schema}].[${target.table}]`);
      }
      if (!sameList((a.columns ?? []).map((c) => c.col), fk.columns) || !sameList((a.columns ?? []).map((c) => c.ref), fk.referencedColumns)) {
        out.push(`${label} foreign key ${fk.name} maps (${(a.columns ?? []).map((c) => `${c.col}->${c.ref}`).join(', ')}), not (${fk.columns.map((c, i) => `${c}->${fk.referencedColumns[i]}`).join(', ')})`);
      }
      const want = ON_DELETE[fk.onDelete ?? 'no-action'];
      if (a.onDelete !== want) out.push(`${label} foreign key ${fk.name} deletes with ${a.onDelete}, not ${want}`);
    }
    if ((t.foreignKeys ?? []).length !== (s.foreignKeys ?? []).length) out.push(`${label} has ${(t.foreignKeys ?? []).length} foreign key(s), the storage record declares ${(s.foreignKeys ?? []).length}`);
    for (const k of s.checks ?? []) {
      if (!(t.checks ?? []).some((x) => x.name.toLowerCase() === `ck_${s.table}_${k.name}`.toLowerCase())) out.push(`${label} lacks check constraint ${k.name}`);
    }
    for (const ix of s.indexes ?? []) {
      const a = (t.indexes ?? []).find((x) => x.name.toLowerCase() === `ix_${s.table}_${ix.name}`.toLowerCase());
      if (!a) out.push(`${label} lacks index ${ix.name}`);
      else {
        if (!sameList(names(a.columns), ix.columns)) out.push(`${label} index ${ix.name} is on (${names(a.columns).join(', ')}), not (${ix.columns.join(', ')})`);
        if (a.unique !== ix.unique) out.push(`${label} index ${ix.name} is ${a.unique ? '' : 'not '}unique, the storage record says ${ix.unique ? 'unique' : 'not unique'}`);
      }
    }
    if ((t.indexes ?? []).length !== (s.indexes ?? []).length) out.push(`${label} has ${(t.indexes ?? []).length} index(es), the storage record declares ${(s.indexes ?? []).length}`);
  }
  if (options.exhaustive) {
    for (const t of tables) {
      if (!byName.has(`${t.schema}.${t.table}`.toLowerCase())) out.push(`table [${t.schema}].[${t.table}] exists but no storage record declares it`);
    }
  }
  return out;
}

/** Every difference between deployed procedures and the routine records: presence, parameter names, order, type family and exact size. */
export function routineMismatches(routines: readonly Routine[], catalog: Catalog): string[] {
  const out: string[] = [];
  for (const r of routines.filter((x) => x.host === 'sql-procedure')) {
    const { schema, name } = procedureName(r);
    const label = `[${schema}].[${name}]`;
    const p = (catalog.procedures ?? []).find((x) => x.schema.toLowerCase() === schema.toLowerCase() && x.name.toLowerCase() === name.toLowerCase());
    if (!p) {
      out.push(`procedure ${label} of routine ${r.id} does not exist`);
      continue;
    }
    const actual = (p.params ?? []).map((x) => x.name.replace(/^@/, ''));
    const declared = r.params.map((x) => x.name);
    const sameSet = actual.length === declared.length && declared.every((d) => actual.some((a) => a.toLowerCase() === d.toLowerCase()));
    if (r.parameterPassing === 'positional' ? !sameList(actual, declared) : !sameSet) {
      out.push(`${label} parameters are ${actual.join(', ') || '(none)'}, not ${declared.join(', ') || '(none)'}${r.parameterPassing === 'positional' ? ' in this order' : ''}`);
    }
    for (const d of r.params) {
      const a = (p.params ?? []).find((x) => x.name.replace(/^@/, '').toLowerCase() === d.name.toLowerCase());
      if (!a) continue;
      const family = SQL_KIND_FAMILY[d.kind] as readonly string[];
      if (family.length && !family.includes(a.type)) out.push(`${label} parameter @${d.name} is ${a.type}, outside the ${d.kind} family (${family.join(', ')})`);
      if (d.kind === 'decimal' && d.decimal && (a.precision !== d.decimal.precision || a.scale !== d.decimal.scale)) out.push(`${label} parameter @${d.name} is (${a.precision},${a.scale}), not (${d.decimal.precision},${d.decimal.scale})`);
      if ((d.kind === 'string' || d.kind === 'enum') && d.bounds?.maxLength !== undefined && WIDE_CHAR.has(a.type) && a.maxLength !== d.bounds.maxLength * 2) {
        out.push(`${label} parameter @${d.name} holds ${a.maxLength / 2} characters, not ${d.bounds.maxLength}`);
      }
    }
  }
  return out;
}

/** Every storage and routine record a catalog check compares, as '<kind>:<id>'. */
export const catalogRecords = (model: Model): string[] => [
  ...model.storage.map((s) => `storage:${s.id}`),
  ...model.routines.filter((r) => r.host === 'sql-procedure').map((r) => `routine:${r.id}`),
];
