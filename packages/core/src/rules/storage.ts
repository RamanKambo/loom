import type { Storage } from '../generated/types.js';
import { FINDING } from '../codes.js';
import {
  SQL_KIND_FAMILY,
  PRIMARY_KEY_MAX_BYTES,
  PRIMARY_KEY_MAX_COLUMNS,
  keyColumnBytes,
  lossReason,
  sameSqlType,
  sqlTypeText,
  unsupportedReason,
} from '../sql-types.js';
import { intentRepair, ref, type Rule } from './context.js';

/** Physical storage: ownership, table identity, keys, column mapping, exact types and foreign keys. */
export const storageRules: Rule = (ctx) => {
  const tables = new Map<string, Storage>();
  for (const s of ctx.model.storage) {
    const about = [ref('storage', s.id)];
    const base = `storage/${s.id}`;
    const type = ctx.index.types.get(s.type);
    const table = `${s.schema}.${s.table}`.toLowerCase();
    const first = tables.get(table);
    if (first) {
      ctx.report(FINDING.STORAGE_TABLE_DUPLICATE, `${base}/table`, `storage '${s.id}' declares table '${s.schema}.${s.table}', which storage '${first.id}' already declares`, [...about, ref('storage', first.id)], `give storage '${s.id}' a table of its own`);
    } else tables.set(table, s);
    if (!type) continue;
    if (s.owner !== type.owner) {
      ctx.report(FINDING.STORAGE_NONOWNER, `${base}/owner`, `storage '${s.id}' is owned by '${s.owner}', but its type '${type.id}' is owned by '${type.owner}'`, about, `set storage '${s.id}' owner to '${type.owner}'`);
    }

    const byName = new Map(s.columns.map((c) => [c.name, c]));
    const props = new Map(type.properties.map((p) => [p.name, p]));
    for (const c of s.columns) {
      const cpath = `${base}/columns/${c.name}`;
      const unsupported = unsupportedReason(c.sqlType);
      if (unsupported) {
        ctx.report(FINDING.STORAGE_TYPE_UNSUPPORTED, `${cpath}/sqlType`, `column '${s.id}.${c.name}' declares ${sqlTypeText(c.sqlType)}: ${unsupported}`, about, `declare a complete ${c.sqlType.name} type on column '${c.name}'`);
        continue;
      }
      if (c.property === undefined) continue;
      const p = props.get(c.property);
      if (!p) {
        ctx.report(FINDING.STORAGE_COLUMN_UNKNOWN_PROPERTY, `${cpath}/property`, `column '${s.id}.${c.name}' maps '${c.property}', which is not a property of '${type.id}'`, about, `map column '${c.name}' to a property of '${type.id}' (${type.properties.map((x) => x.name).join(', ')})`);
        continue;
      }
      const family = SQL_KIND_FAMILY[p.kind];
      if (family.length === 0) {
        ctx.report(FINDING.STORAGE_TYPE_UNSUPPORTED, `${cpath}/sqlType`, `column '${s.id}.${c.name}' stores ${p.kind} property '${type.id}.${p.name}', which the SQL profile cannot store in one column`, about, `store the members of '${type.id}.${p.name}' in their own storage record`);
        continue;
      }
      if (p.kind === 'decimal' && (c.sqlType.name === 'float' || c.sqlType.name === 'real')) {
        ctx.report(FINDING.STORAGE_COLUMN_LOSSY, `${cpath}/sqlType`, `column '${s.id}.${c.name}' stores exact decimal '${type.id}.${p.name}' as binary floating point ${c.sqlType.name}, which rounds decimal values`, about, `store '${type.id}.${p.name}' as decimal(${p.decimal?.precision ?? 18},${p.decimal?.scale ?? 0})`);
        continue;
      }
      if (!family.includes(c.sqlType.name)) {
        ctx.report(FINDING.STORAGE_COLUMN_TYPE_MISMATCH, `${cpath}/sqlType`, `column '${s.id}.${c.name}' is ${sqlTypeText(c.sqlType)}, outside the ${p.kind} family (${family.join(', ')}) of '${type.id}.${p.name}'`, about, `store '${type.id}.${p.name}' as one of ${family.join(', ')}`);
        continue;
      }
      const loss = lossReason(p, c.sqlType);
      if (loss) {
        ctx.report(FINDING.STORAGE_COLUMN_LOSSY, `${cpath}/sqlType`, `column '${s.id}.${c.name}' loses values of '${type.id}.${p.name}': ${loss}`, about, `widen column '${c.name}' so every value of '${type.id}.${p.name}' survives`, {
          repairs: [
            intentRepair('widen-column', `Widen column '${c.name}' to hold every declared value.`, ['The physical schema changes and needs a migration.']),
            intentRepair('narrow-property', `Narrow the declared shape of '${type.id}.${p.name}' to what the column holds.`, ['The accepted value domain of the property changes.']),
          ],
        });
      }
      const expectNull = p.nullable || !p.required;
      if (c.nullable !== expectNull) {
        ctx.report(
          FINDING.STORAGE_COLUMN_NULLABILITY_MISMATCH,
          `${cpath}/nullable`,
          `column '${s.id}.${c.name}' is ${c.nullable ? 'NULL' : 'NOT NULL'}, but '${type.id}.${p.name}' is ${p.required ? 'required' : 'optional'} and ${p.nullable ? 'nullable' : 'non-nullable'}`,
          about,
          `set column '${c.name}' nullable to ${String(expectNull)}`,
        );
      }
    }
    const mapped = new Set(s.columns.map((c) => c.property).filter((x): x is string => x !== undefined));
    for (const p of type.properties) {
      if (p.required && !mapped.has(p.name) && SQL_KIND_FAMILY[p.kind].length > 0) {
        ctx.report(FINDING.STORAGE_PROPERTY_UNMAPPED, `${base}/columns`, `required property '${type.id}.${p.name}' has no column in storage '${s.id}'`, about, `add a column mapping '${p.name}' to storage '${s.id}'`);
      }
    }

    // Primary key: existing, distinct, non-nullable, indexable columns that map the type key.
    const pkPath = `${base}/primaryKey`;
    const seen = new Set<string>();
    let bytes = 0;
    let indexable = true;
    for (const k of s.primaryKey) {
      const c = byName.get(k);
      if (seen.has(k)) {
        ctx.report(FINDING.STORAGE_KEY_INVALID, pkPath, `storage '${s.id}' primary key lists '${k}' twice`, about, `remove the repeated '${k}' from the primary key`);
        continue;
      }
      seen.add(k);
      if (!c) {
        indexable = false;
        ctx.report(FINDING.STORAGE_KEY_INVALID, pkPath, `storage '${s.id}' primary key names '${k}', which is not a column`, about, `remove '${k}' from the primary key or declare the column`);
        continue;
      }
      if (c.nullable) ctx.report(FINDING.STORAGE_KEY_INVALID, pkPath, `storage '${s.id}' primary key column '${k}' is nullable`, about, `set column '${k}' nullable to false`);
      const width = keyColumnBytes(c.sqlType);
      if (width === null) {
        indexable = false;
        ctx.report(FINDING.STORAGE_KEY_INVALID, pkPath, `storage '${s.id}' primary key column '${k}' is ${sqlTypeText(c.sqlType)}, which cannot be an index key`, about, `give column '${k}' a bounded length`);
      } else bytes += width;
    }
    if (s.primaryKey.length > PRIMARY_KEY_MAX_COLUMNS) {
      ctx.report(FINDING.STORAGE_KEY_INVALID, pkPath, `storage '${s.id}' primary key has ${s.primaryKey.length} columns; at most ${PRIMARY_KEY_MAX_COLUMNS} are allowed`, about, `reduce the primary key to at most ${PRIMARY_KEY_MAX_COLUMNS} columns`);
    }
    if (type.key && type.key.length) {
      const pkProps = s.primaryKey.map((k) => byName.get(k)?.property);
      if (pkProps.join('|') !== type.key.join('|')) {
        ctx.report(FINDING.STORAGE_KEY_INVALID, pkPath, `storage '${s.id}' primary key (${s.primaryKey.join(', ')}) does not map the key of '${type.id}' (${type.key.join(', ')})`, about, `make the primary key the columns of ${type.key.map((k) => `'${k}'`).join(', ')} in that order`);
      }
    }
    if (indexable && bytes > PRIMARY_KEY_MAX_BYTES) {
      ctx.report(FINDING.STORAGE_KEY_WIDE, pkPath, `storage '${s.id}' primary key declares ${bytes} bytes; writes whose key data exceeds ${PRIMARY_KEY_MAX_BYTES} bytes fail`, about, `narrow the primary key columns of storage '${s.id}' to fit ${PRIMARY_KEY_MAX_BYTES} bytes`);
    }

    const columnsExist = (cols: readonly string[], where: string, code: typeof FINDING.STORAGE_KEY_INVALID | typeof FINDING.STORAGE_FOREIGN_KEY_INVALID): void => {
      for (const c of cols) {
        if (!byName.has(c)) ctx.report(code, where, `${where} names '${c}', which is not a column of storage '${s.id}'`, about, `name an existing column of storage '${s.id}'`);
      }
    };
    for (const u of s.unique ?? []) columnsExist(u.columns, `${base}/unique/${u.name}`, FINDING.STORAGE_KEY_INVALID);
    for (const ix of s.indexes ?? []) columnsExist(ix.columns, `${base}/indexes/${ix.name}`, FINDING.STORAGE_KEY_INVALID);
    for (const fk of s.foreignKeys ?? []) {
      const fkPath = `${base}/foreignKeys/${fk.name}`;
      columnsExist(fk.columns, fkPath, FINDING.STORAGE_FOREIGN_KEY_INVALID);
      const target = ctx.model.storage.find((x) => x.id === fk.references);
      if (!target) continue;
      if (fk.columns.length !== fk.referencedColumns.length) {
        ctx.report(FINDING.STORAGE_FOREIGN_KEY_INVALID, fkPath, `foreign key '${fk.name}' has ${fk.columns.length} column(s) but references ${fk.referencedColumns.length}`, about, `reference as many columns as the foreign key declares`);
        continue;
      }
      const targetKey = target.primaryKey.join('|');
      const isKey = fk.referencedColumns.join('|') === targetKey || (target.unique ?? []).some((u) => u.columns.join('|') === fk.referencedColumns.join('|'));
      if (!isKey) {
        ctx.report(FINDING.STORAGE_FOREIGN_KEY_INVALID, fkPath, `foreign key '${fk.name}' references (${fk.referencedColumns.join(', ')}), which is neither the primary key nor a unique key of '${target.id}'`, about, `reference the primary key (${target.primaryKey.join(', ')}) of '${target.id}'`);
        continue;
      }
      fk.columns.forEach((col, i) => {
        const mine = byName.get(col);
        const theirs = target.columns.find((c) => c.name === fk.referencedColumns[i]);
        if (mine && theirs && !sameSqlType(mine.sqlType, theirs.sqlType)) {
          ctx.report(FINDING.STORAGE_FOREIGN_KEY_INVALID, fkPath, `foreign key '${fk.name}' column '${col}' is ${sqlTypeText(mine.sqlType)} but references ${sqlTypeText(theirs.sqlType)}`, about, `declare column '${col}' as ${sqlTypeText(theirs.sqlType)}`);
        }
      });
    }
  }
};

