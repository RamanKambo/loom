import type { ConcernDefinition, NotApplicable, Operation, RecordKind, RecordRef } from '../generated/types.js';
import { PROFILES } from '../generated/contracts.js';
import { FINDING } from '../codes.js';
import { columnOf } from '../records.js';
import { ref, type Rule, type RuleContext } from './context.js';

/** Every applicable-concern definition the behavior and host profiles declare. */
export const CONCERNS: readonly ConcernDefinition[] = PROFILES.flatMap((p) => p.concerns ?? []);

interface Candidate {
  ref: RecordRef;
  record: Record<string, unknown>;
  path: string;
  notApplicable: readonly NotApplicable[];
  operation?: Operation;
  optional?: boolean;
  storageMapped?: boolean;
}

function candidates(ctx: RuleContext, kind: RecordKind): Candidate[] {
  const m = ctx.model;
  switch (kind) {
    case 'operation':
      return m.operations.map((o) => ({ ref: ref('operation', o.id), record: o as unknown as Record<string, unknown>, path: `operations/${o.id}`, notApplicable: o.notApplicable ?? [], operation: o }));
    case 'type':
      return m.types.map((t) => ({ ref: ref('type', t.id), record: t as unknown as Record<string, unknown>, path: `types/${t.id}`, notApplicable: t.notApplicable ?? [], storageMapped: ctx.index.storageByType.has(t.id) }));
    case 'property':
      return m.types.flatMap((t) =>
        t.properties.map((p) => ({
          ref: ref('property', `${t.id}.${p.name}`),
          record: p as unknown as Record<string, unknown>,
          path: `types/${t.id}/properties/${p.name}`,
          notApplicable: p.notApplicable ?? [],
          optional: !p.required,
          storageMapped: columnOf(ctx.index, t.id, p.name) !== null,
        })),
      );
    case 'deploymentUnit':
      return m.deploymentUnits.map((u) => ({ ref: ref('deploymentUnit', u.id), record: u as unknown as Record<string, unknown>, path: `deploymentUnits/${u.id}`, notApplicable: u.notApplicable ?? [] }));
    default:
      return [];
  }
}

/** True when the operation changes state: it invokes a mutation, or a routine that performs one. */
function mutating(ctx: RuleContext, o: Operation): boolean {
  return (o.invokes ?? []).some((i) => i.kind === 'mutation' || (i.kind === 'routine' && (ctx.model.routines.find((r) => r.id === i.id)?.performsMutations.length ?? 0) > 0));
}

function applies(ctx: RuleContext, c: ConcernDefinition, x: Candidate): boolean {
  const profile = ctx.model.systemProfile;
  if (!profile) return false;
  const w = c.when;
  if (w.systemKinds && !w.systemKinds.includes(profile.kind)) return false;
  if (w.anyTraits && !w.anyTraits.some((t) => (profile.traits as string[]).includes(t))) return false;
  if (w.operationKinds && !(x.operation && w.operationKinds.includes(x.operation.kind))) return false;
  if (w.transports && !(x.operation && (x.operation.bindings ?? []).some((b) => w.transports!.includes(b.transport)))) return false;
  if (w.mutating !== undefined && !(x.operation && mutating(ctx, x.operation) === w.mutating)) return false;
  if (w.storageMapped !== undefined && x.storageMapped !== w.storageMapped) return false;
  if (w.optional !== undefined && x.optional !== w.optional) return false;
  return true;
}

function declared(record: Record<string, unknown>, field: string): boolean {
  let v: unknown = record;
  for (const part of field.split('.')) {
    if (v === null || typeof v !== 'object') return false;
    v = (v as Record<string, unknown>)[part];
  }
  return v !== undefined && !(Array.isArray(v) && v.length === 0);
}

/**
 * Completeness conditional on the declared system profile. An applicable
 * concern is satisfied by a declared value, by an unknown that stands in for
 * it, or by a justified not-applicable entry on the record; an inapplicable
 * concern is never asked, so a CLI meets no distributed-system question.
 */
export const concernRules: Rule = (ctx) => {
  if (!ctx.model.systemProfile) return;
  const coveredByUnknown = new Set(ctx.model.unknowns.flatMap((u) => (u.concerns ?? []).map((c) => `${c.record.kind}:${c.record.id}#${c.concern}`)));
  for (const c of CONCERNS) {
    for (const x of candidates(ctx, c.record)) {
      if (!applies(ctx, c, x)) continue;
      if (declared(x.record, c.field)) continue;
      if (coveredByUnknown.has(`${x.ref.kind}:${x.ref.id}#${c.id}`)) continue;
      if (x.notApplicable.some((n) => n.concern === c.id)) continue;
      const code = c.id === 'operation.enforcement' ? FINDING.OPERATION_ENFORCEMENT_MISSING : FINDING.CONCERN_UNRESOLVED;
      ctx.report(
        code,
        `${x.path}/${c.field}`,
        `concern '${c.id}' applies to ${x.ref.kind} '${x.ref.id}' and is unresolved: ${c.description}`,
        [x.ref],
        `declare ${c.field} on ${x.ref.kind} '${x.ref.id}', record an unknown whose concerns name '${c.id}', or justify '${c.id}' in its notApplicable`,
      );
    }
  }
};
