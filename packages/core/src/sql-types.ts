import type { Kind, SqlType, DecimalShape, Bounds } from './generated/types.js';

/**
 * SQL Server physical type rules shared by validate() and the SQL projections,
 * so the two can never disagree. Limits are SQL Server's documented capacity
 * specifications: 4,000 characters per NVARCHAR/NCHAR column and 8,000 per
 * VARCHAR/CHAR/VARBINARY/BINARY column below MAX, 900 bytes and 32 columns per
 * primary key, and a (MAX) column cannot be an index key column.
 */
export const NVARCHAR_MAX_LENGTH = 4000;
export const VARCHAR_MAX_LENGTH = 8000;
export const PRIMARY_KEY_MAX_BYTES = 900;
export const PRIMARY_KEY_MAX_COLUMNS = 32;

export type SqlTypeName = SqlType['name'];

/** SQL type names each logical kind may be stored as. */
export const SQL_KIND_FAMILY: Readonly<Record<Kind, readonly SqlTypeName[]>> = {
  string: ['nvarchar', 'varchar', 'nchar', 'char'],
  enum: ['nvarchar', 'varchar', 'nchar', 'char'],
  uuid: ['uniqueidentifier', 'nchar', 'char'],
  integer: ['tinyint', 'smallint', 'int', 'bigint'],
  number: ['float', 'real'],
  decimal: ['decimal', 'numeric'],
  boolean: ['bit'],
  date: ['date'],
  datetime: ['datetime2', 'datetimeoffset'],
  ref: [],
  array: [],
  union: [],
};

const LENGTH_TYPES = new Set<SqlTypeName>(['nvarchar', 'varchar', 'nchar', 'char', 'varbinary', 'binary']);
const UNICODE_TYPES = new Set<SqlTypeName>(['nvarchar', 'nchar']);
const PRECISION_TYPES = new Set<SqlTypeName>(['decimal', 'numeric']);

/** Integer ranges per integer type, for range-loss checks. */
const INTEGER_RANGE: Partial<Record<SqlTypeName, [number, number]>> = {
  tinyint: [0, 255],
  smallint: [-32768, 32767],
  int: [-2147483648, 2147483647],
  bigint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

/** T-SQL text of a physical type: NVARCHAR(64), DECIMAL(12,2), NVARCHAR(MAX), INT. */
export function sqlTypeText(t: SqlType): string {
  const name = t.name.toUpperCase();
  if (LENGTH_TYPES.has(t.name)) return `${name}(${t.length === 'max' ? 'MAX' : String(t.length ?? 1)})`;
  if (PRECISION_TYPES.has(t.name)) return `${name}(${t.precision ?? 18},${t.scale ?? 0})`;
  return name;
}

/** The catalog's system_type_name form (lower case), as sys.dm_exec_describe_first_result_set reports it. */
export function sqlSystemTypeName(t: SqlType): string {
  return sqlTypeText(t).toLowerCase();
}

/** Byte width of a key column, or null for a (MAX) column, which cannot be an index key. */
export function keyColumnBytes(t: SqlType): number | null {
  if (LENGTH_TYPES.has(t.name)) {
    if (t.length === 'max') return null;
    const n = t.length ?? 1;
    return UNICODE_TYPES.has(t.name) ? 2 * n : n;
  }
  switch (t.name) {
    case 'bigint':
    case 'float':
    case 'datetime2':
      return 8;
    case 'int':
    case 'real':
      return 4;
    case 'smallint':
      return 2;
    case 'tinyint':
    case 'bit':
      return 1;
    case 'date':
      return 3;
    case 'time':
      return 5;
    case 'datetimeoffset':
      return 10;
    case 'uniqueidentifier':
      return 16;
    case 'decimal':
    case 'numeric': {
      const p = t.precision ?? 18;
      return p <= 9 ? 5 : p <= 19 ? 9 : p <= 28 ? 13 : 17;
    }
    default:
      return null;
  }
}

/** Why a physical type cannot be built as declared, or null when it is complete. */
export function unsupportedReason(t: SqlType): string | null {
  if (LENGTH_TYPES.has(t.name)) {
    if (t.length === undefined) return `${t.name} needs a length`;
    const limit = UNICODE_TYPES.has(t.name) ? NVARCHAR_MAX_LENGTH : VARCHAR_MAX_LENGTH;
    if (t.length !== 'max' && t.length > limit) return `${t.name}(${t.length}) exceeds ${limit}; declare 'max'`;
    if (t.length === 'max' && (t.name === 'nchar' || t.name === 'char' || t.name === 'binary')) return `${t.name} has no MAX length`;
  } else if (t.length !== undefined) {
    return `${t.name} takes no length`;
  }
  if (PRECISION_TYPES.has(t.name)) {
    if (t.precision === undefined) return `${t.name} needs a precision`;
    if ((t.scale ?? 0) > t.precision) return `${t.name}(${t.precision},${t.scale}) has a scale above its precision`;
  } else if (t.precision !== undefined || t.scale !== undefined) {
    return `${t.name} takes no precision or scale`;
  }
  return null;
}

export interface LogicalShape {
  kind: Kind;
  enumValues?: string[];
  bounds?: Bounds;
  decimal?: DecimalShape;
}

/**
 * Why storing a logical value in `t` loses information, or null when every
 * value of the shape survives. The family check is separate: this assumes the
 * type is in the kind's family.
 */
export function lossReason(shape: LogicalShape, t: SqlType): string | null {
  switch (shape.kind) {
    case 'string': {
      if (t.length === 'max') return null;
      const max = shape.bounds?.maxLength;
      if (max === undefined) return `an unbounded string cannot fit ${sqlTypeText(t)}; declare maxLength or use length max`;
      if ((t.length ?? 1) < max) return `${sqlTypeText(t)} is shorter than maxLength ${max}`;
      if (!UNICODE_TYPES.has(t.name)) return `${sqlTypeText(t)} is not a Unicode type and loses characters outside its code page`;
      return null;
    }
    case 'enum': {
      if (t.length === 'max') return null;
      const longest = Math.max(1, ...(shape.enumValues ?? []).map((v) => v.length));
      return (t.length ?? 1) < longest ? `${sqlTypeText(t)} is shorter than the longest enum value (${longest})` : null;
    }
    case 'integer': {
      const range = INTEGER_RANGE[t.name];
      if (!range) return null;
      const min = shape.bounds?.min;
      const max = shape.bounds?.max;
      if (t.name === 'bigint') return null;
      if (min === undefined || max === undefined) return `an integer without both bounds needs bigint, not ${t.name}`;
      return min < range[0] || max > range[1] ? `${t.name} cannot hold the declared range ${min}..${max}` : null;
    }
    case 'decimal': {
      const d = shape.decimal;
      if (!d) return null;
      const p = t.precision ?? 18;
      const s = t.scale ?? 0;
      if (s < d.scale) return `${sqlTypeText(t)} has fewer fraction digits than the declared scale ${d.scale}`;
      if (p - s < d.precision - d.scale) return `${sqlTypeText(t)} has fewer integer digits than decimal(${d.precision},${d.scale})`;
      return null;
    }
    case 'number':
      return t.name === 'real' ? 'real holds only single precision; a number needs float' : null;
    case 'datetime':
      return null;
    default:
      return null;
  }
}

/** The physical type a logical shape maps to when no storage column declares one. */
export function defaultSqlType(shape: LogicalShape): SqlType {
  switch (shape.kind) {
    case 'string': {
      const max = shape.bounds?.maxLength;
      return { name: 'nvarchar', length: max === undefined || max > NVARCHAR_MAX_LENGTH ? 'max' : Math.max(1, max) };
    }
    case 'enum':
      return { name: 'nvarchar', length: Math.max(1, ...(shape.enumValues ?? []).map((v) => v.length)) };
    case 'uuid':
      return { name: 'uniqueidentifier' };
    case 'integer':
      return { name: 'bigint' };
    case 'number':
      return { name: 'float' };
    case 'decimal':
      return { name: 'decimal', precision: shape.decimal?.precision ?? 18, scale: shape.decimal?.scale ?? 0 };
    case 'boolean':
      return { name: 'bit' };
    case 'date':
      return { name: 'date' };
    case 'datetime':
      return { name: 'datetimeoffset' };
    default:
      return { name: 'nvarchar', length: 'max' };
  }
}

/** Two physical types are the same declaration. */
export function sameSqlType(a: SqlType, b: SqlType): boolean {
  return sqlTypeText(a) === sqlTypeText(b);
}
