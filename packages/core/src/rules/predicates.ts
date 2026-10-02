import type { Expression, Kind, Operand, Predicate, RecordRef, SqlType } from '../generated/types.js';
import { FINDING } from '../codes.js';
import { SQL_KIND_FAMILY } from '../sql-types.js';
import { ref, type Rule, type RuleContext } from './context.js';

export interface ScopeMember {
  kind: Kind;
  enumValues?: string[];
}
export type PredicateScope = ReadonlyMap<string, ScopeMember>;

const ORDERED = new Set<Kind>(['integer', 'number', 'decimal', 'date', 'datetime']);
const STRINGLIKE = new Set<Kind>(['string', 'enum', 'date', 'datetime', 'uuid']);
const NUMERIC = new Set<Kind>(['integer', 'number', 'decimal']);

type OperandType = { property: string; member: ScopeMember } | { literal: unknown } | { unknown: string };

function operandType(o: Operand, scope: PredicateScope): OperandType {
  if ('property' in o) {
    const member = scope.get(o.property);
    return member ? { property: o.property, member } : { unknown: o.property };
  }
  return { literal: o.literal };
}

function literalFits(m: ScopeMember, value: unknown): string | null {
  if (value === null) return null;
  if (m.kind === 'enum') return typeof value === 'string' && (m.enumValues ?? []).includes(value) ? null : `${JSON.stringify(value)} is not a value of the enum`;
  if (STRINGLIKE.has(m.kind)) return typeof value === 'string' ? null : `${JSON.stringify(value)} is not a ${m.kind}`;
  if (NUMERIC.has(m.kind)) return typeof value === 'number' ? null : `${JSON.stringify(value)} is not a number`;
  if (m.kind === 'boolean') return typeof value === 'boolean' ? null : `${JSON.stringify(value)} is not a boolean`;
  return `a ${m.kind} value is not comparable`;
}

/** Type-check one loom-predicate-1 expression; returns every problem found. */
export function checkExpression(e: Expression, scope: PredicateScope): Array<{ code: 'PREDICATE_PROPERTY_UNKNOWN' | 'PREDICATE_TYPE_MISMATCH'; message: string }> {
  const out: Array<{ code: 'PREDICATE_PROPERTY_UNKNOWN' | 'PREDICATE_TYPE_MISMATCH'; message: string }> = [];
  const operand = (o: Operand): OperandType => {
    const t = operandType(o, scope);
    if ('unknown' in t) out.push({ code: 'PREDICATE_PROPERTY_UNKNOWN', message: `'${t.unknown}' is not a member of the constrained type` });
    return t;
  };
  const visit = (x: Expression): void => {
    switch (x.op) {
      case 'and':
      case 'or':
        x.args.forEach(visit);
        return;
      case 'not':
        visit(x.arg);
        return;
      case 'isNull':
      case 'isNotNull': {
        const t = operand(x.operand);
        if ('literal' in t) out.push({ code: 'PREDICATE_TYPE_MISMATCH', message: `${x.op} applies to a property, not a literal` });
        return;
      }
      case 'in': {
        const t = operand(x.operand);
        if ('member' in t) for (const v of x.values) {
          const why = literalFits(t.member, v);
          if (why) out.push({ code: 'PREDICATE_TYPE_MISMATCH', message: `'${t.property}' in [...]: ${why}` });
        }
        return;
      }
      default: {
        const l = operand(x.left);
        const r = operand(x.right);
        const ordering = x.op !== 'eq' && x.op !== 'ne';
        for (const side of [l, r]) {
          if ('member' in side && ordering && !ORDERED.has(side.member.kind)) {
            out.push({ code: 'PREDICATE_TYPE_MISMATCH', message: `'${side.property}' is ${side.member.kind}, which has no order for ${x.op}` });
          }
          if ('member' in side && (side.member.kind === 'ref' || side.member.kind === 'array' || side.member.kind === 'union')) {
            out.push({ code: 'PREDICATE_TYPE_MISMATCH', message: `'${side.property}' is ${side.member.kind}, which is not comparable` });
          }
        }
        if ('member' in l && 'member' in r) {
          const same = l.member.kind === r.member.kind || (NUMERIC.has(l.member.kind) && NUMERIC.has(r.member.kind));
          if (!same) out.push({ code: 'PREDICATE_TYPE_MISMATCH', message: `'${l.property}' (${l.member.kind}) and '${r.property}' (${r.member.kind}) are not comparable` });
        } else {
          const prop = 'member' in l ? l : 'member' in r ? r : null;
          const lit = 'literal' in l ? l : 'literal' in r ? r : null;
          if (prop && 'member' in prop && lit && 'literal' in lit) {
            const why = literalFits(prop.member, lit.literal);
            if (why) out.push({ code: 'PREDICATE_TYPE_MISMATCH', message: `'${prop.property}' ${x.op} ${JSON.stringify(lit.literal)}: ${why}` });
            if (lit.literal === null && ordering) out.push({ code: 'PREDICATE_TYPE_MISMATCH', message: `null has no order for ${x.op}` });
          }
        }
      }
    }
  };
  visit(e);
  return out;
}

/** The logical kind a physical column type implies, for check constraints over columns. */
function kindOfSqlType(t: SqlType): Kind {
  for (const [kind, family] of Object.entries(SQL_KIND_FAMILY) as Array<[Kind, readonly string[]]>) {
    if (kind !== 'enum' && kind !== 'uuid' && family.includes(t.name)) return kind;
  }
  return t.name === 'uniqueidentifier' ? 'uuid' : 'string';
}

function checkPredicate(ctx: RuleContext, p: Predicate, scope: PredicateScope, path: string, about: RecordRef[], label: string, scenarioLinked: boolean | null): void {
  if (p.form === 'prose') {
    if (scenarioLinked === false || scenarioLinked === null) {
      ctx.report(FINDING.PREDICATE_UNVERIFIED, path, `${label} is prose: a claim that needs scenario evidence, never evaluated`, about, `link a scenario that exercises ${label}, or restate it as a loom-predicate-1 expression`);
    }
    return;
  }
  for (const problem of checkExpression(p.expression, scope)) {
    ctx.report(FINDING[problem.code], path, `${label}: ${problem.message}`, about, `reference only members of the constrained type and compare values of compatible kinds`);
  }
}

const scopeOf = (props: ReadonlyArray<{ name: string; kind: Kind; enumValues?: string[] }> | undefined): PredicateScope =>
  new Map((props ?? []).map((p) => [p.name, { kind: p.kind, enumValues: p.enumValues }]));

/** Guards, invariants, pre- and postconditions and check constraints, against the type each constrains. */
export const predicateRules: Rule = (ctx) => {
  for (const t of ctx.model.types) {
    const scope = scopeOf(t.properties);
    const about = [ref('type', t.id)];
    (t.invariants ?? []).forEach((p, i) => checkPredicate(ctx, p, scope, `types/${t.id}/invariants/${i}`, about, `invariant ${i} of type '${t.id}'`, null));
    for (const prop of t.properties) {
      (prop.invariants ?? []).forEach((p, i) =>
        checkPredicate(ctx, p, scope, `types/${t.id}/properties/${prop.name}/invariants/${i}`, about, `invariant ${i} of property '${t.id}.${prop.name}'`, null),
      );
    }
  }
  for (const m of ctx.model.mutations) {
    const t = ctx.index.types.get(m.type);
    checkPredicate(ctx, m.guard, scopeOf(t?.properties), `mutations/${m.id}/guard`, [ref('mutation', m.id)], `the guard of mutation '${m.id}'`, m.scenarios.length > 0);
  }
  for (const o of ctx.model.operations) {
    const about = [ref('operation', o.id)];
    const linked = (o.scenarios ?? []).length > 0;
    const pre = scopeOf(o.request ? ctx.index.types.get(o.request)?.properties : undefined);
    const post = scopeOf((o.response ? ctx.index.types.get(o.response) : o.result ? ctx.index.types.get(o.result) : undefined)?.properties);
    (o.preconditions ?? []).forEach((p, i) => checkPredicate(ctx, p, pre, `operations/${o.id}/preconditions/${i}`, about, `precondition ${i} of operation '${o.id}'`, linked));
    (o.postconditions ?? []).forEach((p, i) => checkPredicate(ctx, p, post, `operations/${o.id}/postconditions/${i}`, about, `postcondition ${i} of operation '${o.id}'`, linked));
  }
  for (const s of ctx.model.storage) {
    const type = ctx.index.types.get(s.type);
    const props = new Map((type?.properties ?? []).map((p) => [p.name, p]));
    const scope: PredicateScope = new Map(
      s.columns.map((c) => {
        const p = c.property ? props.get(c.property) : undefined;
        return [c.name, p ? { kind: p.kind, enumValues: p.enumValues } : { kind: kindOfSqlType(c.sqlType) }];
      }),
    );
    for (const c of s.checks ?? []) {
      if (c.predicate.form === 'prose') continue;
      checkPredicate(ctx, c.predicate, scope, `storage/${s.id}/checks/${c.name}`, [ref('storage', s.id)], `check '${c.name}' of storage '${s.id}'`, true);
    }
  }
};
