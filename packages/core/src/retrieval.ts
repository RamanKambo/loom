import type { AffectedElement, ContextData, ContextItem, ContextTarget, Completeness, Model, RecordRef, SourceRef } from './generated/types.js';
import { canonicalJson } from './canonical.js';
import { canonicalHash, modelRevision, recordHash } from './hash.js';
import { indexModel, findRecord, type ModelIndex } from './records.js';
import { DependencyGraph } from './graph.js';
import type { EvaluationInputs } from './inputs.js';
import { ownersOf, refKey, resolveScope } from './scope.js';
import { deriveObligations, evaluateEvidence } from './evidence.js';

export interface ContextRequest {
  target: ContextTarget;
  budget: { maxRecords: number; maxBytes?: number };
  continuation?: string;
  modelRevision?: string;
}

export type ContextResult =
  | { ok: true; data: ContextData; completeness: Completeness }
  | { ok: false; cause: 'stale-base' | 'unresolved-context' | 'invalid-input'; message: string };

const TOKEN = /^ctx1\.(sha256:[0-9a-f]{64})\.(\d+)$/;

/** A continuation names the model revision it was issued for and the offset to resume at. */
export const continuationToken = (revision: string, offset: number): string => `ctx1.${revision}.${offset}`;

interface Entry {
  ref: RecordRef;
  why: AffectedElement;
  depth: number;
}

/** Breadth-first closure over dependencies and consumers, nearest first; `limit` caps the depth. */
function closure(graph: DependencyGraph, starts: readonly RecordRef[], limit: number): Entry[] {
  const out = new Map<string, Entry>();
  let frontier: Entry[] = starts.map((ref) => ({ ref, depth: 0, why: { ref, reason: 'direct-change', path: [ref.id] } }));
  for (const e of frontier) out.set(refKey(e.ref), e);
  for (let depth = 1; depth <= limit && frontier.length; depth++) {
    const next: Entry[] = [];
    for (const e of frontier) {
      const adj = graph.adjacent(e.ref);
      for (const n of [...adj.dependencies, ...adj.consumers]) {
        const k = refKey(n.ref);
        if (out.has(k)) continue;
        const entry: Entry = { ref: n.ref, depth, why: { ref: n.ref, reason: 'depends-on', path: [...e.why.path, n.ref.id], edgeKinds: n.kinds } };
        out.set(k, entry);
        next.push(entry);
      }
    }
    frontier = next;
  }
  return [...out.values()].sort((a, b) => a.depth - b.depth || refKey(a.ref).localeCompare(refKey(b.ref)));
}

function startsOf(index: ModelIndex, target: ContextTarget): { starts: RecordRef[]; depth: number } | null {
  if (target.kind === 'task') {
    if (!target.task) return null;
    return { starts: resolveScope(index, target.task).records, depth: Number.MAX_SAFE_INTEGER };
  }
  if (!target.ref || findRecord(index, target.ref) === undefined) return null;
  if (target.kind === 'component') {
    const owned = resolveScope(index, { mode: 'component', components: [target.ref.id] }).records;
    return { starts: owned, depth: 2 };
  }
  return { starts: [target.ref], depth: 2 };
}

const sourcesOf = (record: Record<string, unknown>): SourceRef[] | undefined => {
  const s = record['source'];
  if (Array.isArray(s)) return s.length ? (s as SourceRef[]) : undefined;
  if (s && typeof s === 'object') return [s as SourceRef];
  return undefined;
};

/**
 * The required context of a component, record, claim or task: its dependency
 * closure with sources, owners, baseline status, constraints and decisions,
 * within a record and byte budget. Truncation is never silent: every omitted
 * record is listed with the continuation that retrieves it, and a
 * continuation issued for another revision is refused. Record text is
 * returned as data.
 */
export function retrieveContext(model: Model, request: ContextRequest, inputs: EvaluationInputs = {}): ContextResult {
  const revision = modelRevision(model);
  if (request.modelRevision !== undefined && request.modelRevision !== revision) {
    return { ok: false, cause: 'stale-base', message: `the model is at ${revision}, not the requested ${request.modelRevision}` };
  }
  let offset = 0;
  if (request.continuation !== undefined) {
    const m = TOKEN.exec(request.continuation);
    if (!m) return { ok: false, cause: 'invalid-input', message: 'the continuation token is malformed' };
    if (m[1] !== revision) return { ok: false, cause: 'stale-base', message: `the continuation was issued for ${m[1]}, but the model is at ${revision}` };
    offset = Number(m[2]);
  }
  const index = indexModel(model);
  const start = startsOf(index, request.target);
  if (!start) return { ok: false, cause: 'unresolved-context', message: 'the context target names no record in the model' };
  const graph = new DependencyGraph(index);
  const entries = closure(graph, start.starts, start.depth);
  const base = inputs.baseline?.model;
  const items: ContextItem[] = [];
  let bytes = 0;
  let i = offset;
  for (; i < entries.length; i++) {
    const e = entries[i]!;
    const record = findRecord(index, e.ref) as Record<string, unknown>;
    const item: ContextItem = { ref: e.ref, record: record as ContextItem['record'], hash: canonicalHash(record), why: e.why };
    const owner = ownersOf(index, e.ref)[0];
    if (owner) item.owner = owner;
    const source = sourcesOf(record);
    if (source) item.source = source;
    if (base && inputs.baseline) {
      const was = recordHash(base, e.ref);
      item.baseline = was === null ? { id: inputs.baseline.record.id, status: 'new' } : { id: inputs.baseline.record.id, status: was === item.hash ? 'accepted' : 'changed', hash: was };
    }
    const size = canonicalJson(item).length;
    if (items.length >= request.budget.maxRecords || (request.budget.maxBytes !== undefined && items.length > 0 && bytes + size > request.budget.maxBytes)) break;
    items.push(item);
    bytes += size;
  }
  const remaining = entries.slice(i);
  const continuation = remaining.length ? continuationToken(revision, i) : undefined;
  const touches = (refs: readonly RecordRef[]) => refs.some((r) => entries.some((e) => refKey(e.ref) === refKey(r)) || ownersOf(index, r).some((c) => entries.some((e) => e.ref.kind === 'component' && e.ref.id === c)));
  const constraints = model.constraints.filter((c) => touches(c.appliesTo)).map((c) => c.id).sort();
  const decisions = model.decisions.filter((d) => touches(d.affects)).map((d) => d.id).sort();
  const scope = request.target.kind === 'task' && request.target.task ? resolveScope(index, request.target.task) : request.target.kind === 'component' && request.target.ref ? resolveScope(index, { mode: 'component', components: [request.target.ref.id] }) : undefined;
  const obligations = scope ? deriveObligations(model, scope, inputs) : [];
  const evidence = inputs.evidence === undefined ? obligations : evaluateEvidence(model, obligations, inputs).obligations;
  const completeness: Completeness = {
    complete: offset === 0 && remaining.length === 0,
    truncated: remaining.length > 0,
    omitted: [
      ...(offset > 0 ? entries.slice(0, offset).map((e) => ({ ref: e.ref, reason: 'not-requested' as const })) : []),
      ...remaining.map((e) => ({ ref: e.ref, reason: 'budget' as const, continuation: continuation! })),
    ],
  };
  if (continuation) completeness.continuation = continuation;
  return { ok: true, data: { target: request.target, items, required: entries.map((e) => e.ref), constraints, decisions, evidence }, completeness };
}
