import type { Bounds, Default, Kind, Property, RecordRef } from '../generated/types.js';
import { FINDING } from '../codes.js';
import { mechanicalRepair, intentRepair, type Rule, type RuleContext } from './context.js';

interface Shape {
  kind: Kind;
  enumValues?: string[];
  unknownEnumPolicy?: string;
  bounds?: Bounds;
  decimal?: { precision: number; scale: number };
  ref?: string;
  variants?: string[];
  discriminator?: string;
  items?: Shape;
}

const LENGTH_BOUNDS = ['minLength', 'maxLength', 'pattern'] as const;
const NUMERIC_BOUNDS = ['min', 'max'] as const;
const ITEM_BOUNDS = ['minItems', 'maxItems'] as const;

/** Bounds a shape of `kind` may not carry. */
export function misplacedBounds(kind: Kind, b: Bounds | undefined): string[] {
  if (!b) return [];
  const out: string[] = [];
  if (kind !== 'string') for (const k of LENGTH_BOUNDS) if (b[k] !== undefined) out.push(k);
  if (kind !== 'integer' && kind !== 'number' && kind !== 'decimal') for (const k of NUMERIC_BOUNDS) if (b[k] !== undefined) out.push(k);
  if (kind !== 'array') for (const k of ITEM_BOUNDS) if (b[k] !== undefined) out.push(k);
  return out;
}

/** A routine slot that binds an enum property takes its values from it, so it may omit enumValues. */
function checkShape(ctx: RuleContext, s: Shape, path: string, label: string, about: RecordRef[], valuesFromBinds = false): void {
  if (s.kind === 'enum') {
    if ((!s.enumValues || s.enumValues.length === 0) && !valuesFromBinds) {
      ctx.report(FINDING.ENUM_WITHOUT_VALUES, `${path}/enumValues`, `enum ${label} declares no enumValues`, about, `list the allowed values of ${label} in enumValues`);
    } else if (s.enumValues) {
      const dup = s.enumValues.filter((v, i) => s.enumValues!.indexOf(v) !== i);
      for (const v of [...new Set(dup)]) {
        ctx.report(FINDING.ENUM_DUPLICATE_VALUE, `${path}/enumValues`, `${label} lists enum value '${v}' more than once`, about, `remove the repeated '${v}' from ${label} enumValues`, {
          repairs: [mechanicalRepair('remove-repeated-value', `Remove the repeated '${v}'.`, undefined)],
        });
      }
    }
  } else {
    if (s.enumValues !== undefined) ctx.report(FINDING.VALUE_SHAPE_INCOMPLETE, `${path}/enumValues`, `${label} is '${s.kind}' but declares enumValues`, about, `remove enumValues from ${label}, or set its kind to 'enum'`);
    if (s.unknownEnumPolicy !== undefined) ctx.report(FINDING.VALUE_SHAPE_INCOMPLETE, `${path}/unknownEnumPolicy`, `${label} is '${s.kind}' but declares unknownEnumPolicy`, about, `remove unknownEnumPolicy from ${label}`);
  }

  const misplaced = misplacedBounds(s.kind, s.bounds);
  if (misplaced.length) {
    ctx.report(FINDING.BOUNDS_KIND_MISMATCH, `${path}/bounds`, `${label} is '${s.kind}' but declares ${misplaced.join(', ')}`, about, `remove ${misplaced.join(', ')} from the bounds of ${label}`);
  }
  const b = s.bounds;
  if (b) {
    for (const [lo, hi] of [['min', 'max'], ['minLength', 'maxLength'], ['minItems', 'maxItems']] as const) {
      const l = b[lo];
      const h = b[hi];
      if (l !== undefined && h !== undefined && l > h) {
        ctx.report(FINDING.BOUNDS_INVERTED, `${path}/bounds`, `${label} declares ${lo} ${l} above ${hi} ${h}`, about, `lower ${lo} or raise ${hi} of ${label} so that ${lo} <= ${hi}`, {
          repairs: [intentRepair('reorder-bounds', `Choose which of ${lo} ${l} and ${hi} ${h} states the intended range.`, ['The accepted value range of the property changes.'])],
        });
      }
    }
  }

  if (s.kind === 'decimal') {
    if (!s.decimal) ctx.report(FINDING.DECIMAL_SHAPE_INVALID, path, `decimal ${label} declares no precision and scale`, about, `declare decimal { precision, scale } on ${label}`);
    else if (s.decimal.scale > s.decimal.precision) {
      ctx.report(FINDING.DECIMAL_SHAPE_INVALID, `${path}/decimal`, `${label} declares scale ${s.decimal.scale} above precision ${s.decimal.precision}`, about, `set the scale of ${label} to at most ${s.decimal.precision}`);
    }
  } else if (s.decimal) {
    ctx.report(FINDING.DECIMAL_SHAPE_INVALID, `${path}/decimal`, `${label} is '${s.kind}' but declares a decimal shape`, about, `remove decimal from ${label}, or set its kind to 'decimal'`);
  }

  const member = (present: boolean, needed: boolean, name: string, need: string): void => {
    if (needed && !present) ctx.report(FINDING.VALUE_SHAPE_INCOMPLETE, path, `${s.kind} ${label} declares no ${name}`, about, `declare ${need} on ${label}`);
    if (!needed && present) ctx.report(FINDING.VALUE_SHAPE_INCOMPLETE, `${path}/${name}`, `${label} is '${s.kind}' but declares ${name}`, about, `remove ${name} from ${label}`);
  };
  member(s.ref !== undefined, s.kind === 'ref', 'ref', 'the referenced type id in ref');
  member(s.items !== undefined, s.kind === 'array', 'items', 'the element shape in items');
  member(s.variants !== undefined, s.kind === 'union', 'variants', 'at least two variant type ids');
  member(s.discriminator !== undefined, s.kind === 'union', 'discriminator', 'the discriminating property name');
  if (s.kind === 'union' && s.variants && s.variants.length < 2) {
    ctx.report(FINDING.VALUE_SHAPE_INCOMPLETE, `${path}/variants`, `union ${label} declares fewer than two variants`, about, `declare at least two variants on ${label}, or use kind 'ref'`);
  }
  if (s.items) checkShape(ctx, s.items, `${path}/items`, `the items of ${label}`, about);
}

function literalFits(kind: Kind, value: unknown, p: Property): boolean {
  if (value === null) return p.nullable;
  switch (kind) {
    case 'string':
    case 'date':
    case 'datetime':
    case 'uuid':
      return typeof value === 'string';
    case 'enum':
      return typeof value === 'string' && (p.enumValues ?? []).includes(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'decimal':
      return typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value));
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

function checkDefault(ctx: RuleContext, p: Property, d: Default, path: string, label: string, about: RecordRef[]): void {
  if (d.policy === 'literal') {
    if (d.value === undefined) ctx.report(FINDING.DEFAULT_KIND_MISMATCH, `${path}/default`, `${label} declares a literal default without a value`, about, `set default.value on ${label}`);
    else if (!literalFits(p.kind, d.value, p)) {
      ctx.report(FINDING.DEFAULT_KIND_MISMATCH, `${path}/default/value`, `${label} default ${JSON.stringify(d.value)} is not a value of its ${p.nullable ? 'nullable ' : ''}${p.kind}`, about, `set default.value of ${label} to a value of kind '${p.kind}'`);
    }
  } else if (d.value !== undefined) {
    ctx.report(FINDING.DEFAULT_KIND_MISMATCH, `${path}/default/value`, `${label} default policy '${d.policy}' takes no literal value`, about, `remove default.value from ${label}, or set default.policy to 'literal'`);
  }
}

/** Value shapes of type properties, routine params and result columns, and HTTP parameters. */
export const valueShapes: Rule = (ctx) => {
  for (const t of ctx.model.types) {
    const about = [{ kind: 'type' as const, id: t.id }];
    for (const p of t.properties) {
      const path = `types/${t.id}/properties/${p.name}`;
      const label = `property '${t.id}.${p.name}'`;
      checkShape(ctx, p, path, label, about);
      if (p.default) checkDefault(ctx, p, p.default, path, label, about);
      if (p.unknownEnumPolicy === 'fallback' && (p.default?.policy !== 'literal' || !(p.enumValues ?? []).includes(String(p.default.value)))) {
        ctx.report(FINDING.VALUE_SHAPE_INCOMPLETE, `${path}/unknownEnumPolicy`, `${label} falls back on an unknown value but declares no literal default among its values`, about, `declare a literal default from the enumValues of ${label}`);
      }
    }
  }
  for (const r of ctx.model.routines) {
    const about = [{ kind: 'routine' as const, id: r.id }];
    for (const p of r.params) checkShape(ctx, p, `routines/${r.id}/params/${p.name}`, `param '${p.name}' of routine '${r.id}'`, about, p.binds !== undefined);
    for (const c of r.resultSet) checkShape(ctx, c, `routines/${r.id}/resultSet/${c.name}`, `result column '${c.name}' of routine '${r.id}'`, about, c.binds !== undefined);
  }
  for (const o of ctx.model.operations) {
    (o.bindings ?? []).forEach((b, i) => {
      for (const p of b.parameters ?? []) {
        if (p.kind === undefined) continue;
        checkShape(ctx, { kind: p.kind, enumValues: p.enumValues }, `operations/${o.id}/bindings/${i}/parameters/${p.in}|${p.name}`, `parameter '${p.name}' of operation '${o.id}'`, [{ kind: 'operation', id: o.id }]);
      }
    });
  }
};
