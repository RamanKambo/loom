import type { Acceptance, Model, RecordKind, RecordRef, TaskSpec } from './generated/types.js';
import { indexModel, findRecord, resolveProperty, type ModelIndex } from './records.js';
import { modelRevision, recordHash, canonicalHash } from './hash.js';
import type { EvaluationInputs } from './inputs.js';

export const refKey = (r: RecordRef): string => `${r.kind}:${r.id}`;

/** Parse an evidence input or claim reference '<recordKind>:<recordId>'; null for any other form. */
export function parseRefKey(value: string, index: ModelIndex): RecordRef | null {
  const colon = value.indexOf(':');
  if (colon < 0) return null;
  const kind = value.slice(0, colon) as RecordKind;
  if (!index.byKind.has(kind) && kind !== 'property' && kind !== 'criterion') return null;
  return { kind, id: value.slice(colon + 1) };
}

/** Kinds whose records carry contract shape: the records maturity and acceptance are judged on. */
export const CONTRACT_KINDS: ReadonlySet<RecordKind> = new Set<RecordKind>(['type', 'operation', 'routine', 'storage', 'mapping', 'mutation']);

/** Components accountable for a record. */
export function ownersOf(index: ModelIndex, ref: RecordRef): string[] {
  if (ref.kind === 'component') return [ref.id];
  if (ref.kind === 'property') {
    const p = resolveProperty(index, ref.id);
    return p ? [p.type.owner] : [];
  }
  const record = findRecord(index, ref) as Record<string, unknown> | undefined;
  if (!record) return [];
  if (typeof record['owner'] === 'string' && index.byKind.get('component')?.has(record['owner'] as string)) return [record['owner'] as string];
  switch (ref.kind) {
    case 'requirement':
      return [...((record['scope'] as string[]) ?? [])];
    case 'criterion': {
      const entry = index.criteria.get(ref.id);
      return entry ? [...entry.requirement.scope] : [];
    }
    case 'scenario':
      return [...new Set(((record['requirements'] as string[]) ?? []).flatMap((r) => ownersOf(index, { kind: 'requirement', id: r })))];
    case 'deploymentUnit':
      return [...((record['components'] as string[]) ?? [])];
    case 'consumerBinding': {
      const consumer = record['consumer'] as RecordRef;
      return consumer.kind === 'component' ? [consumer.id] : ownersOf(index, consumer);
    }
    case 'publishedContract':
      return [...((record['consumers'] as string[]) ?? [])];
    case 'inventory':
      return [...((record['components'] as string[]) ?? [])];
    case 'retainedBehavior':
      return ownersOf(index, { kind: 'inventory', id: String(record['from']) });
    case 'migration':
      return ownersOf(index, record['contract'] as RecordRef);
    case 'decision':
      return [...new Set(((record['affects'] as RecordRef[]) ?? []).flatMap((r) => ownersOf(index, r)))];
    default:
      return [];
  }
}

export interface Scope {
  mode: 'component' | 'slice';
  components: string[];
  requirements: string[];
  criteria: string[];
  /** Every record in scope, sorted by kind and id. */
  records: RecordRef[];
  keys: Set<string>;
}

const sortRefs = (refs: Iterable<RecordRef>): RecordRef[] =>
  [...new Map([...refs].map((r) => [refKey(r), r])).values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

/**
 * The records a task covers. 'component' scope is everything the named
 * components own; 'slice' scope is the closure of the named requirements
 * across components: criteria, scenarios, operations, mutations, the types
 * they exchange, their storage, mappings and routines. Both add the
 * deployment units, migrations, retained behaviors and decisions that touch
 * the scoped records.
 */
export function resolveScope(index: ModelIndex, task?: Pick<TaskSpec, 'mode' | 'components' | 'requirements' | 'records'>): Scope {
  const m = index.model;
  const mode = task?.mode ?? 'component';
  const out = new Map<string, RecordRef>();
  const add = (kind: RecordKind, id: string): void => {
    if (findRecord(index, { kind, id }) !== undefined) out.set(`${kind}:${id}`, { kind, id });
  };
  const comps = new Set<string>();
  const reqs = new Set<string>(task?.requirements ?? []);

  if (mode === 'component') {
    for (const c of task?.components?.length ? task.components : m.components.map((x) => x.id)) comps.add(c);
    for (const r of m.requirements) if (r.scope.some((c) => comps.has(c))) reqs.add(r.id);
    const owned = <T extends { id: string; owner: string }>(list: readonly T[], kind: RecordKind): void => {
      for (const x of list) if (comps.has(x.owner)) add(kind, x.id);
    };
    owned(m.types, 'type');
    owned(m.operations, 'operation');
    owned(m.routines, 'routine');
    owned(m.mutations, 'mutation');
    owned(m.storage, 'storage');
    owned(m.mappings, 'mapping');
  } else {
    const criteria = new Set(m.requirements.filter((r) => reqs.has(r.id)).flatMap((r) => r.criteria.map((c) => c.id)));
    const scenarios = m.scenarios.filter((s) => s.requirements.some((r) => reqs.has(r)) || s.criteria.some((c) => criteria.has(c)));
    const scenarioOps = new Set(scenarios.flatMap((s) => s.operations ?? []));
    const ops = m.operations.filter((o) => scenarioOps.has(o.id) || (o.criteria ?? []).some((c) => criteria.has(c)) || (o.scenarios ?? []).some((s) => scenarios.some((x) => x.id === s)));
    const muts = m.mutations.filter((x) => x.requirements.some((r) => reqs.has(r)) || (x.criteria ?? []).some((c) => criteria.has(c)) || ops.some((o) => (o.invokes ?? []).some((i) => i.kind === 'mutation' && i.id === x.id)));
    const typeIds = new Set<string>([...ops.flatMap((o) => [o.request, o.response, o.result].filter((t): t is string => typeof t === 'string')), ...muts.map((x) => x.type)]);
    const routines = m.routines.filter((r) => ops.some((o) => (o.invokes ?? []).some((i) => i.kind === 'routine' && i.id === r.id)) || r.performsMutations.some((p) => muts.some((x) => x.id === p)));
    for (const o of ops) add('operation', o.id);
    for (const x of muts) add('mutation', x.id);
    for (const r of routines) add('routine', r.id);
    for (const s of m.storage) if (typeIds.has(s.type)) add('storage', s.id);
    for (const map of m.mappings) if (typeIds.has(map.from) || typeIds.has(map.to)) {
      add('mapping', map.id);
      typeIds.add(map.from);
      typeIds.add(map.to);
    }
    for (const t of typeIds) add('type', t);
    for (const s of scenarios) add('scenario', s.id);
    for (const r of [...out.values()]) for (const c of ownersOf(index, r)) comps.add(c);
    for (const r of m.requirements) if (reqs.has(r.id)) for (const c of r.scope) comps.add(c);
  }

  for (const c of comps) add('component', c);
  for (const r of m.requirements) {
    if (!reqs.has(r.id)) continue;
    add('requirement', r.id);
    for (const c of r.criteria) add('criterion', c.id);
  }
  const criteria = new Set(m.requirements.filter((r) => reqs.has(r.id)).flatMap((r) => r.criteria.map((c) => c.id)));
  for (const s of m.scenarios) if (s.criteria.some((c) => criteria.has(c)) || s.requirements.some((r) => reqs.has(r))) add('scenario', s.id);
  for (const u of m.deploymentUnits) if (u.components.some((c) => comps.has(c))) add('deploymentUnit', u.id);
  for (const rb of m.retainedBehaviors) if (ownersOf(index, { kind: 'retainedBehavior', id: rb.id }).some((c) => comps.has(c)) || rb.scenarios.some((s) => out.has(`scenario:${s}`))) add('retainedBehavior', rb.id);
  for (const mig of m.migrations) if (out.has(refKey(mig.contract)) || ownersOf(index, mig.contract).some((c) => comps.has(c))) add('migration', mig.id);
  for (const cb of m.consumerBindings) if (ownersOf(index, { kind: 'consumerBinding', id: cb.id }).some((c) => comps.has(c))) add('consumerBinding', cb.id);
  for (const pc of m.publishedContracts) if (pc.consumers.some((c) => comps.has(c))) add('publishedContract', pc.id);
  for (const d of m.decisions) if (d.affects.some((a) => out.has(refKey(a)) || ownersOf(index, a).some((c) => comps.has(c)))) add('decision', d.id);
  for (const r of task?.records ?? []) add(r.kind, r.id);

  const records = sortRefs(out.values());
  return {
    mode,
    components: [...comps].sort(),
    requirements: [...reqs].filter((r) => out.has(`requirement:${r}`)).sort(),
    criteria: records.filter((r) => r.kind === 'criterion').map((r) => r.id),
    records,
    keys: new Set(records.map(refKey)),
  };
}

/** True when a record named by `target` is the scoped record itself or contains it. */
function covers(index: ModelIndex, target: RecordRef, ref: RecordRef): boolean {
  if (target.kind === ref.kind && target.id === ref.id) return true;
  if (target.kind === 'type' && ref.kind === 'property') return ref.id.startsWith(`${target.id}.`);
  if (target.kind === 'requirement' && ref.kind === 'criterion') return index.criteria.get(ref.id)?.requirement.id === target.id;
  if (target.kind === 'component') return ownersOf(index, ref).includes(target.id);
  return false;
}

/** True when an acceptance's scope covers the record; an empty scope covers the whole subject. */
export function acceptanceScopeCovers(index: ModelIndex, acceptance: Acceptance, ref: RecordRef): boolean {
  return acceptance.scope.length === 0 || acceptance.scope.some((s) => covers(index, s, ref));
}

/** Trusted acceptance records that accepted their subject. */
export const trustedAcceptances = (inputs: EvaluationInputs): Acceptance[] =>
  (inputs.acceptances ?? []).filter((a) => a.trusted && a.record.decision === 'accepted').map((a) => a.record);

/** True when the verified baseline is accepted by a trusted acceptance record. */
export function baselineAccepted(inputs: EvaluationInputs): boolean {
  const b = inputs.baseline;
  if (!b || !b.verified) return false;
  return trustedAcceptances(inputs).some((a) => a.id === b.record.acceptance || (a.subject.kind === 'baseline' && a.subject.baseline === b.record.id));
}

/**
 * Acceptance of one record in the candidate: a trusted acceptance of exactly
 * this candidate revision whose scope covers the record, or an unchanged
 * record of a verified, accepted baseline. Never the record's own status word.
 */
export function makeAcceptanceCheck(model: Model, inputs: EvaluationInputs): (ref: RecordRef) => boolean {
  const index = indexModel(model);
  const revision = modelRevision(model);
  const trusted = trustedAcceptances(inputs).filter((a) => a.subject.candidate === revision);
  const accepted = baselineAccepted(inputs);
  const baselineModel = inputs.baseline?.model;
  const cache = new Map<string, boolean>();
  return (ref) => {
    const k = refKey(ref);
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    let ok = trusted.some((a) => acceptanceScopeCovers(index, a, ref));
    if (!ok && accepted && baselineModel) {
      const now = recordHash(model, ref);
      ok = now !== null && now === recordHash(baselineModel, ref);
    }
    cache.set(k, ok);
    return ok;
  };
}

/** Canonical hash of every record in a scope, for work-package inputs and recompute. */
export function scopeHashes(model: Model, scope: Scope): Map<string, string> {
  const index = indexModel(model);
  const out = new Map<string, string>();
  for (const r of scope.records) {
    const rec = findRecord(index, r);
    if (rec !== undefined) out.set(refKey(r), canonicalHash(rec));
  }
  return out;
}
