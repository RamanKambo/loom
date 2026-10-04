import type { AffectedElement, Completeness, ContextData, ContextItem, ContextTarget, DiscoveryBudget, Model, OversizedRecord, RecordRef, SourceRef } from './generated/types.js';
import { canonicalHash, modelRevision, recordHash } from './hash.js';
import { indexModel, findRecord, type ModelIndex } from './records.js';
import { DependencyGraph } from './graph.js';
import type { EvaluationInputs } from './inputs.js';
import { ownersOf, refKey, resolveScope } from './scope.js';
import { deriveObligations, evaluateEvidence } from './evidence.js';
import { checkContinuation, continuationToken, dataBytes, fillPage, pageCompleteness, resolveBudget, type PageEntry, type ResolvedBudget } from './discovery.js';

export interface ContextRequest {
  target: ContextTarget;
  /** The page budget; a member left out takes its default. */
  budget?: DiscoveryBudget;
  continuation?: string;
  modelRevision?: string;
  /**
   * The revision the page answers for, which a continuation binds: the digest of the revision vector
   * the adapter evaluated the model under, or the model revision when absent, as in inline mode.
   */
  revision?: string;
  /** The URI of the record resource that returns one record whole, where the adapter serves one; an oversized record is then summarized with it. */
  recordResource?: (ref: RecordRef) => string;
}

/** One page, or a refusal; `restart` marks a refusal the same request without its continuation or revision would not repeat. */
export type ContextResult =
  | { ok: true; data: ContextData; completeness: Completeness }
  | { ok: false; cause: 'stale-base' | 'unresolved-context' | 'invalid-input'; message: string; restart: boolean };

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

/** The summary of a record too large for any page: its size and the resource that returns it whole. */
function oversized(item: ContextItem, budget: ResolvedBudget, resource: string, revision: string): OversizedRecord {
  const bytes = dataBytes(item.record);
  return { ref: item.ref, hash: item.hash, bytes, summary: `The ${item.ref.kind} '${item.ref.id}' takes ${bytes} bytes of canonical JSON, more than a page of ${budget.maxBytes} bytes holds; its record resource returns it whole.`, resource, revision };
}

/**
 * One page of the required context of a component, record, claim or task: the constraints and
 * decisions that apply, the records of its dependency closure nearest first with sources, owners and
 * baseline status, and the evidence obligations of its scope, within the budget. The completeness
 * names every section the page leaves for later pages with the continuation that retrieves it, and
 * every record too large for any page, which the record resource returns whole where the adapter
 * serves one. A continuation binds the target, the budget and the revision; a changed one is
 * refused. Record text is returned as data.
 */
export function retrieveContext(model: Model, request: ContextRequest, inputs: EvaluationInputs = {}): ContextResult {
  const current = modelRevision(model);
  if (request.modelRevision !== undefined && request.modelRevision !== current) {
    return { ok: false, cause: 'stale-base', message: `the model is at ${current}, not the requested ${request.modelRevision}`, restart: true };
  }
  const revision = request.revision ?? current;
  const budget = resolveBudget(request.budget);
  const index = indexModel(model);
  const start = startsOf(index, request.target);
  if (!start) return { ok: false, cause: 'unresolved-context', message: 'the context target names no record in the model', restart: false };
  const graph = new DependencyGraph(index);
  const entries = closure(graph, start.starts, start.depth);
  const base = inputs.baseline?.model;
  const items: ContextItem[] = entries.map((e) => {
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
    return item;
  });
  const touches = (refs: readonly RecordRef[]) => refs.some((r) => entries.some((e) => refKey(e.ref) === refKey(r)) || ownersOf(index, r).some((c) => entries.some((e) => e.ref.kind === 'component' && e.ref.id === c)));
  const constraints = model.constraints.filter((c) => touches(c.appliesTo)).map((c) => c.id).sort();
  const decisions = model.decisions.filter((d) => touches(d.affects)).map((d) => d.id).sort();
  const scope = request.target.kind === 'task' && request.target.task ? resolveScope(index, request.target.task) : request.target.kind === 'component' && request.target.ref ? resolveScope(index, { mode: 'component', components: [request.target.ref.id] }) : undefined;
  const obligations = scope ? deriveObligations(model, scope, inputs) : [];
  const evidence = inputs.evidence === undefined ? obligations : evaluateEvidence(model, obligations, inputs).obligations;
  // The small entries that frame the records come first, the obligations last, so the first page names what applies.
  const sequence: PageEntry[] = [
    ...constraints.map((id) => ({ member: 'constraints', section: 'constraints', key: id, value: id })),
    ...decisions.map((id) => ({ member: 'decisions', section: 'decisions', key: id, value: id })),
    ...items.map((item) => ({ member: 'items', section: 'items', key: refKey(item.ref), value: item, ref: item.ref })),
    ...evidence.map((o) => ({ member: 'evidence', section: 'evidence', key: o.id, value: o })),
  ];
  const filters = { target: request.target, budget };
  let offset = 0;
  if (request.continuation !== undefined) {
    const check = checkContinuation(request.continuation, 'context', revision, filters, sequence.length);
    if (!check.ok) return { ok: false, cause: check.cause, message: check.message, restart: true };
    offset = check.offset;
  }
  const head = { target: request.target, total: entries.length, items: [], oversized: [], constraints: [], decisions: [], evidence: [] };
  if (dataBytes(head) > budget.maxBytes) return { ok: false, cause: 'invalid-input', message: `a page of ${budget.maxBytes} bytes cannot hold the ${dataBytes(head)} bytes every page of this target repeats; raise maxBytes`, restart: false };
  const resource = request.recordResource;
  const standIn = resource
    ? (e: PageEntry): PageEntry | null => (e.member === 'items' && e.ref ? { member: 'oversized', section: 'items', key: e.key, ref: e.ref, value: oversized(e.value as ContextItem, budget, resource(e.ref), current) } : null)
    : undefined;
  const page = fillPage(head, sequence, offset, budget, undefined, standIn);
  const continuation = page.next < sequence.length ? continuationToken('context', revision, filters, page.next) : undefined;
  return { ok: true, data: page.data as unknown as ContextData, completeness: pageCompleteness(sequence, offset, page, continuation) };
}
