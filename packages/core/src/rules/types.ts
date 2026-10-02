import { FINDING } from '../codes.js';
import { columnOf, resolveProperty } from '../records.js';
import { sameSqlType, sqlTypeText } from '../sql-types.js';
import { mechanicalRepair, ref, type Rule } from './context.js';

const sameDecimal = (a?: { precision: number; scale: number }, b?: { precision: number; scale: number }): boolean =>
  (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.precision === b.precision && a.scale === b.scale);

/** State property, key, and property bindings to another type's key. */
export const typeRules: Rule = (ctx) => {
  for (const t of ctx.model.types) {
    const about = [ref('type', t.id)];
    if (t.stateProperty !== undefined) {
      const sp = t.properties.find((p) => p.name === t.stateProperty);
      if (!sp || sp.kind !== 'enum' || !sp.enumValues || sp.enumValues.length === 0) {
        ctx.report(
          FINDING.TYPE_STATE_PROPERTY_INVALID,
          `types/${t.id}/stateProperty`,
          `type '${t.id}' stateProperty '${t.stateProperty}' must name an enum property with at least one value`,
          about,
          `point stateProperty at an enum property of '${t.id}' that declares its states`,
        );
      }
    }
    const seen = new Set<string>();
    for (const k of t.key ?? []) {
      const path = `types/${t.id}/key`;
      if (seen.has(k)) {
        ctx.report(FINDING.TYPE_KEY_INVALID, path, `type '${t.id}' key lists '${k}' twice`, about, `remove the repeated '${k}' from type '${t.id}' key`, {
          repairs: [mechanicalRepair('remove-repeated-key', `Remove the repeated '${k}' from the key.`, undefined)],
        });
        continue;
      }
      seen.add(k);
      const p = t.properties.find((x) => x.name === k);
      if (!p) ctx.report(FINDING.TYPE_KEY_INVALID, path, `type '${t.id}' key names '${k}', which is not a property of '${t.id}'`, about, `remove '${k}' from type '${t.id}' key`);
      else if (!p.required || p.nullable) {
        ctx.report(FINDING.TYPE_KEY_INVALID, path, `type '${t.id}' key property '${k}' must be required and non-nullable`, about, `set '${t.id}.${k}' required to true and nullable to false`);
      }
    }

    for (const p of t.properties) {
      if (p.binds === undefined) continue;
      const path = `types/${t.id}/properties/${p.name}/binds`;
      const label = `property '${t.id}.${p.name}'`;
      const target = resolveProperty(ctx.index, p.binds);
      if (!target || !target.property) continue;
      const key = target.type.key ?? [];
      if (key.length !== 1 || key[0] !== target.name) {
        const why =
          key.length === 0
            ? `type '${target.type.id}' declares no key`
            : key.length > 1
              ? `the key of '${target.type.id}' is composite (${key.join(', ')})`
              : `'${target.name}' is not the key of '${target.type.id}' (key: ${key[0]})`;
        ctx.report(
          FINDING.BINDING_NOT_KEY,
          path,
          `${label} binds '${p.binds}', but ${why}; a property is one value, so it may reference only a single-property key`,
          about,
          key.length === 1 ? `bind ${label} to '${target.type.id}.${key[0]}'` : `remove binds from ${label}, or give '${target.type.id}' a single-property key`,
        );
        continue;
      }
      const kp = target.property;
      if (kp.kind !== p.kind || !sameDecimal(kp.decimal, p.decimal)) {
        ctx.report(
          FINDING.BINDING_KIND_MISMATCH,
          path,
          `${label} is '${p.kind}' but binds '${p.binds}', which is '${kp.kind}'${kp.decimal ? ` decimal(${kp.decimal.precision},${kp.decimal.scale})` : ''}`,
          about,
          `set ${label} kind to '${kp.kind}' with the same shape, then bump type '${t.id}' version and acknowledge it`,
        );
        continue;
      }
      const mine = columnOf(ctx.index, t.id, p.name);
      const theirs = columnOf(ctx.index, target.type.id, target.name);
      if (mine && theirs && !sameSqlType(mine.column.sqlType, theirs.column.sqlType)) {
        ctx.report(
          FINDING.BINDING_SQL_TYPE_MISMATCH,
          `storage/${mine.storage.id}/columns/${mine.column.name}/sqlType`,
          `${label} is stored as ${sqlTypeText(mine.column.sqlType)} but binds '${p.binds}', stored as ${sqlTypeText(theirs.column.sqlType)}; a foreign key's columns must have the same SQL type and length`,
          [ref('storage', mine.storage.id), ...about],
          `store ${label} as ${sqlTypeText(theirs.column.sqlType)}`,
        );
      }
    }
  }
};
