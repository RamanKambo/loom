import type { Kind, Property } from './types.js';

/**
 * T-SQL mapping of model kinds, shared by validate() (key rules) and the SQL
 * projections so the two can never disagree. Limits are SQL Server's documented
 * maximum capacity specifications: 8,000 bytes per short string column (so
 * NVARCHAR(4000)), 900 bytes and 32 columns per primary key; an NVARCHAR(MAX)
 * column cannot be an index key column.
 */
export const NVARCHAR_MAX_LENGTH = 4000;
export const PRIMARY_KEY_MAX_BYTES = 900;
export const PRIMARY_KEY_MAX_COLUMNS = 32;

function enumLength(p: Property): number {
  return Math.max(1, ...(p.enumValues ?? []).map((v) => v.length));
}

function nvarchar(length: number | undefined): string {
  if (length === undefined || length > NVARCHAR_MAX_LENGTH) return 'NVARCHAR(MAX)';
  return `NVARCHAR(${Math.max(1, length)})`;
}

/** Column type of a property: string -> NVARCHAR(maxLength | MAX), integer -> BIGINT, number -> FLOAT, boolean -> BIT, enum -> NVARCHAR(longest value). */
export function sqlColumnType(p: Property): string {
  switch (p.kind) {
    case 'string':
      return nvarchar(p.bounds?.maxLength);
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'FLOAT';
    case 'boolean':
      return 'BIT';
    case 'enum':
      return nvarchar(enumLength(p));
  }
}

/** Declared byte width of a key column, or null when the column is NVARCHAR(MAX) and cannot be an index key. */
export function keyColumnBytes(p: Property): number | null {
  const type = sqlColumnType(p);
  if (type === 'NVARCHAR(MAX)') return null;
  if (type === 'BIGINT' || type === 'FLOAT') return 8;
  if (type === 'BIT') return 1;
  const match = /^NVARCHAR\((\d+)\)$/.exec(type);
  return match ? 2 * Number(match[1]) : null;
}

/** SQL Server base type names (TYPE_NAME / INFORMATION_SCHEMA DATA_TYPE) compatible with each kind. */
export const SQL_TYPE_FAMILY: Readonly<Record<Kind, readonly string[]>> = {
  string: ['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'uniqueidentifier'],
  integer: ['tinyint', 'smallint', 'int', 'bigint'],
  number: ['decimal', 'numeric', 'float', 'real', 'money', 'smallmoney'],
  boolean: ['bit'],
  enum: ['char', 'varchar', 'nchar', 'nvarchar'],
};
