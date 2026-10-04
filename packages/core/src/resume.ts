import type {
  Baseline,
  Completeness,
  DiscoveryBudget,
  EvidenceObligation,
  Model,
  NextAction,
  PendingWork,
  ResumeData,
  RevisionVector,
  RunPhase,
  TaskSpec,
  Unknown,
  WorkflowOutcome,
  WorkflowPhase,
} from './generated/types.js';
import { canonicalHash } from './hash.js';
import { findRecord, indexModel } from './records.js';
import { CONTRACT_KINDS, refKey, resolveScope } from './scope.js';
import { checkContinuation, continuationToken, dataBytes, fillPage, nextAction, pageCompleteness, resolveBudget, type PageEntry } from './discovery.js';

/**
 * The recorded progress of one workspace, which the workspace adapter reads and supplies: everything
 * a resumed session restates before it continues. The core reads nothing itself and infers nothing
 * the inputs do not record.
 */
export interface ResumeInputs {
  /** The members that address the same workspace in a follow-up model-tool call, such as `{ workspace: true }`; every next action's arguments start from them. */
  address: Readonly<Record<string, unknown>>;
  /** The session's workspace handle, which an agent-tool next action such as a run's status names; without it a pending run is listed as unavailable. */
  workspaceId?: string;
  /** The outcome the workspace records, or null when it records none. */
  outcome: WorkflowOutcome | null;
  /** The phase the workspace records. */
  phase: WorkflowPhase;
  /** The source roots each component claims, with the model that owns it. */
  owningScopes: ResumeData['owningScopes'];
  /** The revision vector every fact refers to; its digest is the revision a continuation binds. */
  revisionVector: RevisionVector;
  /** The trusted accepted baseline and its model snapshot, whose frozen components' contract records are the frozen contracts; null without one. */
  baseline: { record: Baseline; model: Model } | null;
  /** The open unknowns of the workspace and of the contracts it imports. */
  openUnknowns: readonly Unknown[];
  /** The evidence obligations relevant to the resumed work, with their statuses. */
  evidence: readonly EvidenceObligation[];
  /** The work packages that are not done, each with the task it was planned as when the workspace records one. */
  pendingWork: ReadonlyArray<PendingWork & { task?: TaskSpec }>;
  /** The qualification runs that have not finished. */
  pendingRuns: ReadonlyArray<{ runId: string; phase: RunPhase }>;
}

export type ResumeResult =
  | { ok: true; data: ResumeData; completeness: Completeness }
  | { ok: false; cause: 'invalid-input' | 'stale-base'; message: string; restart: boolean };

/** The resume target, which every resume page carries as its context target. */
export const RESUME_TARGET = { kind: 'resume' } as const;

/** The contract records the baseline froze: those its frozen components own in its snapshot, with the hash and version it froze. */
function frozenContracts(baseline: ResumeInputs['baseline']): ResumeData['frozenContracts'] {
  if (!baseline) return [];
  const frozen = baseline.record.components.filter((c) => c.frozen).map((c) => c.id);
  if (!frozen.length) return [];
  const index = indexModel(baseline.model);
  return resolveScope(index, { mode: 'component', components: frozen })
    .records.filter((r) => CONTRACT_KINDS.has(r.kind))
    .map((ref) => {
      const record = findRecord(index, ref) as Record<string, unknown>;
      const entry: ResumeData['frozenContracts'][number] = { ref, baseline: baseline.record.id, hash: canonicalHash(record) };
      if (typeof record['version'] === 'number') entry.version = record['version'];
      return entry;
    });
}

/**
 * The next actions the recorded state supports, each concrete: its arguments satisfy its tool's
 * input. A blocking unknown the model holds is read in context; a pending work package recorded with
 * its task is checked for readiness, or read in context while blocked; a pending run is followed by
 * its status. Nothing is proposed from inferred progress, so recorded work without a task gets none.
 */
function nextActions(model: Model, inputs: ResumeInputs, blocking: readonly Unknown[]): { actions: NextAction[]; unaddressed: string[] } {
  const index = indexModel(model);
  const actions: NextAction[] = [];
  for (const u of blocking) {
    if (findRecord(index, { kind: 'unknown', id: u.id }) === undefined) continue;
    actions.push(nextAction(`Read the context of the open unknown '${u.id}', which blocks ${u.blocks.join(', ')} work, before relying on its answer.`, 'loom.context', { ...inputs.address, target: { kind: 'record', ref: { kind: 'unknown', id: u.id } } }));
  }
  for (const w of [...inputs.pendingWork].sort((a, b) => a.workPackage.localeCompare(b.workPackage))) {
    if (!w.task) continue;
    actions.push(
      w.status === 'blocked'
        ? nextAction(`Read the context of the blocked work package '${w.workPackage}'.`, 'loom.context', { ...inputs.address, target: { kind: 'task', task: w.task } })
        : nextAction(`Check the readiness of the ${w.status} work package '${w.workPackage}' before continuing it.`, 'loom.checkReadiness', { ...inputs.address, task: w.task }),
    );
  }
  const unaddressed: string[] = [];
  for (const r of [...inputs.pendingRuns].sort((a, b) => a.runId.localeCompare(b.runId))) {
    if (inputs.workspaceId === undefined) unaddressed.push(r.runId);
    else actions.push(nextAction(`Follow the qualification run '${r.runId}', which is ${r.phase}.`, 'loom.qualify', { action: 'status', workspaceId: inputs.workspaceId, runId: r.runId }));
  }
  return { actions, unaddressed };
}

/**
 * The resume state of a workspace from its recorded progress: the outcome, the phase, the owning
 * scopes, the revision vector, the contracts the accepted baseline froze, the open unknowns that
 * block work, the relevant evidence, the pending work and the next actions, one page at a time
 * within the budget. Only recorded progress is reported, never inferred progress. The completeness
 * names what the page leaves out, a pending run the session holds no handle for, and the
 * continuation, which binds the budget and the digest of the revision vector.
 */
export function resumeContext(model: Model, inputs: ResumeInputs, page: { budget?: DiscoveryBudget; continuation?: string } = {}): ResumeResult {
  const budget = resolveBudget(page.budget);
  const revision = canonicalHash(inputs.revisionVector);
  const blocking = inputs.openUnknowns.filter((u) => u.status === 'open' && u.blocks.length > 0).sort((a, b) => a.id.localeCompare(b.id));
  const { actions, unaddressed } = nextActions(model, inputs, blocking);
  const scopes = [...inputs.owningScopes].sort((a, b) => a.modelId.localeCompare(b.modelId) || a.component.localeCompare(b.component));
  const sequence: PageEntry[] = [
    ...scopes.map((s) => ({ member: 'owningScopes', section: 'owningScopes', key: `${s.modelId}/${s.component}`, value: s })),
    ...blocking.map((u) => ({ member: 'blockingUnknowns', section: 'blockingUnknowns', key: u.id, value: u, ref: { kind: 'unknown' as const, id: u.id } })),
    ...[...inputs.pendingWork].sort((a, b) => a.workPackage.localeCompare(b.workPackage)).map((w) => ({ member: 'pendingWork', section: 'pendingWork', key: w.workPackage, value: { workPackage: w.workPackage, status: w.status } })),
    ...frozenContracts(inputs.baseline).map((f) => ({ member: 'frozenContracts', section: 'frozenContracts', key: refKey(f.ref), value: f, ref: f.ref })),
    ...[...inputs.evidence].sort((a, b) => a.id.localeCompare(b.id)).map((o) => ({ member: 'evidence', section: 'evidence', key: o.id, value: o })),
    ...actions.map((a, i) => ({ member: 'nextActions', section: 'nextActions', key: String(i + 1), value: a })),
  ];
  const filters = { target: RESUME_TARGET, budget };
  let offset = 0;
  if (page.continuation !== undefined) {
    const check = checkContinuation(page.continuation, 'context', revision, filters, sequence.length);
    if (!check.ok) return { ok: false, cause: check.cause, message: check.message, restart: true };
    offset = check.offset;
  }
  const head: ResumeData = { outcome: inputs.outcome, phase: inputs.phase, owningScopes: [], revisionVector: inputs.revisionVector, frozenContracts: [], blockingUnknowns: [], evidence: [], pendingWork: [], nextActions: [] };
  // The budget counts the data the context result carries: the resume state under the resume target.
  const measure = (data: Record<string, unknown>): number => dataBytes({ target: RESUME_TARGET, resume: data });
  if (measure(head as unknown as Record<string, unknown>) > budget.maxBytes) {
    return { ok: false, cause: 'invalid-input', message: `a page of ${budget.maxBytes} bytes cannot hold the ${measure(head as unknown as Record<string, unknown>)} bytes of the outcome, phase and revision vector every resume page repeats; raise maxBytes`, restart: false };
  }
  const filled = fillPage(head as unknown as Record<string, unknown>, sequence, offset, budget, measure);
  const continuation = filled.next < sequence.length ? continuationToken('context', revision, filters, filled.next) : undefined;
  const completeness = pageCompleteness(sequence, offset, filled, continuation);
  for (const runId of unaddressed) completeness.omitted.push({ section: `pendingRuns/${runId}`, reason: 'unavailable' });
  if (unaddressed.length) completeness.complete = false;
  return { ok: true, data: filled.data as unknown as ResumeData, completeness };
}
