import type {
  CheckReadinessInput,
  Completeness,
  ContextData,
  ContextInput,
  DescribeInput,
  DiffData,
  Finding,
  Model,
  Patch,
  PlanChangeData,
  RecordRef,
  ResultEnvelope,
  States,
} from './generated/types.js';
import { MCP_TOOLS } from './generated/operations.js';
import { FINDING } from './codes.js';
import { validate } from './validate.js';
import { mutate } from './mutate.js';
import { modelRevision } from './hash.js';
import { indexModel } from './records.js';
import type { EvaluationInputs } from './inputs.js';
import { asFinding, defaultStates, envelope, loadOrRefuse, refusal, validationState, workspaceRefusal } from './envelope.js';
import { describe } from './describe.js';
import { retrieveContext, type ContextRequest } from './retrieval.js';
import { resumeContext, type ResumeInputs } from './resume.js';
import { nextAction } from './discovery.js';
import { unmetPresenceRules } from './operations.js';
import { schemaErrors } from './schema-runtime.js';
import { checkReadiness } from './readiness.js';
import { classifyChange, compareBaseline } from './baseline.js';
import { deriveObligations, evaluateEvidence, invalidatedBy } from './evidence.js';
import { ownersOf, resolveScope } from './scope.js';
import { withArtifactHashes } from './project.js';

/** States of one evaluation: each dimension filled from the inputs it was given, the rest not evaluated. */
function statesFor(model: Model, inputs: EvaluationInputs): States {
  const states = defaultStates(validationState(validate(model, inputs)));
  if (inputs.baseline || inputs.acceptances) states.acceptance = compareBaseline(model, inputs).acceptance;
  if (inputs.evidence !== undefined) states.qualification = evaluateEvidence(model, deriveObligations(model, undefined, inputs), inputs).qualification;
  return states;
}

/** The structural findings of a value against one contract definition, each at the member path of the request that holds it. */
function contractFindings(definition: string, value: unknown, at: string): Finding[] {
  return schemaErrors(definition, value).map((e) => asFinding(FINDING.STRUCTURAL_INVALID, `${at}${e.pointer}` || '(root)', e.message, `send a value that satisfies ${definition}`));
}

/** The presence rules the catalogue states for one MCP tool, which the core applies too so every adapter refuses alike. */
const presenceOf = (tool: string): NonNullable<(typeof MCP_TOOLS)[number]['presence']> => MCP_TOOLS.find((t) => t.name === tool)?.presence ?? [];

/**
 * One page of the description of this build. The request is checked against the catalogue's
 * presence rules and the input contract first, because the command line calls this without the MCP
 * server's checks; a stale or foreign cursor is refused with the request that starts again.
 */
export function describeTool(input: DescribeInput = {}): ResultEnvelope {
  const tool = 'loom.describe';
  const unmet = unmetPresenceRules(presenceOf(tool), input as Record<string, unknown>).map((r) => asFinding(r.code, r.path, r.message, r.fix));
  const findings = unmet.length ? unmet : contractFindings('DescribeInput', input, '');
  if (findings.length) return envelope(tool, { model: null, findings, refusal: refusal('invalid-input', 'The request does not satisfy the tool input contract.') });
  const r = describe(input);
  if (!r.ok) return envelope(tool, { model: null, findings: r.findings, refusal: refusal(r.cause, r.message, r.nextActions) });
  return envelope(tool, { model: null, findings: [], data: r.data, completeness: r.completeness, states: defaultStates({ state: 'notEvaluated', reasons: [] }) });
}

/** What an adapter adds to a context request beyond its arguments. */
export interface ContextOptions {
  /** The revision a page answers for and a continuation binds: the digest of the revision vector the adapter evaluated, or the model revision when absent. */
  revision?: string;
  /** The URI of the record resource that returns one record whole, where the adapter serves record resources. */
  recordResource?: (ref: RecordRef) => string;
  /** The recorded progress of the workspace, which answers a resume target. */
  resume?: ResumeInputs;
  /** The members that address the same model in a follow-up call, such as `{ workspaceId }`; without them a next action repeats the inline model. */
  address?: Readonly<Record<string, unknown>>;
}

/**
 * The states of a context page. A truncated page establishes neither coverage nor readiness, so its
 * readiness and qualification stay not evaluated whatever the supplied evidence would give.
 */
function pageStates(model: Model, inputs: EvaluationInputs, completeness: Completeness): States {
  const states = statesFor(model, inputs);
  if (!completeness.truncated) return states;
  states.readiness = { state: 'notEvaluated', reasons: [{ code: FINDING.READINESS_INPUT_MISSING, message: 'The context is truncated, so it establishes no readiness; follow its continuation, then check readiness for the task.', refs: [] }] };
  states.qualification = { state: 'notEvaluated', reasons: [{ code: FINDING.QUALIFICATION_NOT_ESTABLISHED, message: 'The context is truncated, so it establishes neither coverage nor qualification; follow its continuation.', refs: [] }] };
  return states;
}

/**
 * One page of the required context of a target, or for a resume target the recorded progress the
 * adapter supplies. A continuation or revision that no longer applies is refused with the current
 * revisions in the envelope and the request that starts again as the refusal's next action.
 */
export function contextTool(input: Partial<ContextInput> & { model?: unknown }, inputs: EvaluationInputs = {}, options: ContextOptions = {}): ResultEnvelope {
  const tool = 'loom.context';
  if (input.workspaceId) return workspaceRefusal(tool);
  const loaded = loadOrRefuse(tool, input.model);
  if ('refused' in loaded) return loaded.refused;
  const model = loaded.model;
  const target = input.target;
  if (!target) {
    return envelope(tool, { model, findings: [asFinding(FINDING.READINESS_INPUT_MISSING, '(root)', 'a context request names a target', 'send the target of the context')], refusal: refusal('invalid-input', 'The request has no target.') });
  }
  const structural = [...(input.budget !== undefined ? contractFindings('DiscoveryBudget', input.budget, '/budget') : []), ...(input.continuation !== undefined ? contractFindings('Cursor', input.continuation, '/continuation') : [])];
  if (structural.length) return envelope(tool, { model, findings: structural, refusal: refusal('invalid-input', 'The request does not satisfy the tool input contract.') });
  const address = options.address ?? (target.kind === 'resume' ? options.resume?.address : undefined) ?? { model };
  const again = nextAction('Retrieve the context again from its first page at the current revision.', tool, { ...address, target, ...(input.budget !== undefined ? { budget: input.budget } : {}) });
  // A refusal the same request without its continuation would not repeat concerns the continuation; any other invalid input is a budget too small for the page.
  const refused = (cause: 'stale-base' | 'unresolved-context' | 'invalid-input', message: string, restart: boolean): ResultEnvelope => {
    const findings =
      cause === 'stale-base'
        ? [asFinding(FINDING.STALE_BASE_REVISION, '(root)', message, 'request the context again from its first page, as the refusal names it')]
        : cause === 'invalid-input'
          ? restart
            ? [asFinding(FINDING.STRUCTURAL_INVALID, 'continuation', message, 'send the continuation of the page before with the same target and budget, or start again without one')]
            : [asFinding(FINDING.STRUCTURAL_INVALID, 'budget', message, 'raise maxBytes of the budget, up to its maximum')]
          : [];
    return envelope(tool, { model, findings, refusal: refusal(cause, message, restart ? [again] : []) });
  };
  let data: ContextData;
  let completeness: Completeness;
  if (target.kind === 'resume') {
    if (!options.resume) return refused('unresolved-context', 'A resume target is answered from the recorded progress of a workspace, which the workspace adapter supplies; none was supplied for this request.', false);
    const r = resumeContext(model, options.resume, { ...(input.budget !== undefined ? { budget: input.budget } : {}), ...(input.continuation !== undefined ? { continuation: input.continuation } : {}) });
    if (!r.ok) return refused(r.cause, r.message, r.restart);
    data = { target, resume: r.data };
    completeness = r.completeness;
  } else {
    const request: ContextRequest = { target };
    if (input.budget !== undefined) request.budget = input.budget;
    if (input.continuation !== undefined) request.continuation = input.continuation;
    if (input.modelRevision !== undefined) request.modelRevision = input.modelRevision;
    if (options.revision !== undefined) request.revision = options.revision;
    if (options.recordResource !== undefined) request.recordResource = options.recordResource;
    const r = retrieveContext(model, request, inputs);
    if (!r.ok) return refused(r.cause, r.message, r.restart);
    data = r.data;
    completeness = r.completeness;
  }
  return envelope(tool, { model, findings: [], data, completeness, states: pageStates(model, inputs, completeness) });
}

export function checkReadinessTool(input: Partial<CheckReadinessInput> & { model?: unknown }, inputs: EvaluationInputs = {}): ResultEnvelope {
  if (input.workspaceId) return workspaceRefusal('loom.checkReadiness');
  const loaded = loadOrRefuse('loom.checkReadiness', input.model);
  if ('refused' in loaded) return loaded.refused;
  if (!input.task) {
    return envelope('loom.checkReadiness', { model: loaded.model, findings: [asFinding(FINDING.READINESS_INPUT_MISSING, 'task', 'a readiness request names its task', 'send the task class, mode and scope')], refusal: refusal('invalid-input', 'The request has no task.') });
  }
  if (input.candidateRevision !== undefined && input.candidateRevision !== modelRevision(loaded.model)) {
    return envelope('loom.checkReadiness', { model: loaded.model, findings: [asFinding(FINDING.STALE_BASE_REVISION, 'candidateRevision', `the model is not at candidate revision ${input.candidateRevision}`, 'evaluate the current revision')], refusal: refusal('stale-base', 'The model is not at the requested candidate revision.') });
  }
  const r = checkReadiness(loaded.model, input.task, inputs);
  const states = statesFor(loaded.model, inputs);
  states.readiness = r.state;
  return envelope('loom.checkReadiness', { model: loaded.model, findings: validate(loaded.model, inputs), data: r.data, states });
}

export interface PlanChangeToolInput {
  model?: unknown;
  workspaceId?: string;
  baseRevision?: string;
  patch?: unknown;
  patches?: unknown;
  acknowledgeBreaking?: string[];
}

/**
 * Preview a change against a base revision without persisting anything: the
 * delta, its compatibility by dimension, affected consumers, evidence it
 * invalidates, repair alternatives, the obligations of what it touches and
 * whether policy requires acceptance. A stale base is refused.
 */
export function planChangeTool(input: PlanChangeToolInput, inputs: EvaluationInputs = {}): ResultEnvelope {
  if (input.workspaceId) return workspaceRefusal('loom.planChange');
  const loaded = loadOrRefuse('loom.planChange', input.model);
  if ('refused' in loaded) return loaded.refused;
  const base = loaded.model;
  const baseRevision = modelRevision(base);
  if (input.baseRevision !== baseRevision) {
    return envelope('loom.planChange', {
      model: base,
      findings: [asFinding(FINDING.STALE_BASE_REVISION, 'baseRevision', `the model is at ${baseRevision}, not the base revision ${input.baseRevision ?? '(none)'}`, 'read the current model and plan the change against its revision')],
      refusal: refusal('stale-base', 'The change was planned against another revision.'),
    });
  }
  if ((input.patch === undefined) === (input.patches === undefined)) {
    return envelope('loom.planChange', { model: base, findings: [asFinding(FINDING.PATCH_AMBIGUOUS, '(root)', "the request must carry exactly one of 'patch' or 'patches'", "send one patch as 'patch' or a batch as 'patches'")], refusal: refusal('invalid-input', "The request carries both or neither of 'patch' and 'patches'.") });
  }
  const patches = (input.patches ?? input.patch) as Patch | Patch[];
  const result = mutate(base, patches, { acknowledgeBreaking: input.acknowledgeBreaking ?? [] });
  const candidate = result.model;
  const compatibility = new Map<string, { dimension: PlanChangeData['compatibility'][number]['dimension']; kind: PlanChangeData['compatibility'][number]['kind']; changes: number }>();
  const classes = new Set<string>();
  let acceptanceRequired = false;
  for (const c of result.changes) {
    const k = `${c.dimension}|${c.kind}`;
    const entry = compatibility.get(k) ?? { dimension: c.dimension, kind: c.kind, changes: 0 };
    entry.changes++;
    compatibility.set(k, entry);
    if (c.kind === 'nonSemantic') continue;
    const cls = classifyChange(c, inputs);
    for (const id of cls.classes) classes.add(id);
    if (cls.approval !== 'pre-authorized') acceptanceRequired = true;
  }
  const after = candidate ?? base;
  // The supplied artifact hashes are the base model's; the candidate is judged by its own, rendered the same way.
  const afterInputs = candidate && inputs.artifacts !== undefined ? withArtifactHashes(candidate, inputs) : inputs;
  const index = indexModel(after);
  const owners = [...new Set(result.impact.flatMap((a) => ownersOf(index, a.ref)))].sort();
  const obligations = owners.length ? deriveObligations(after, resolveScope(index, { mode: 'component', components: owners }), inputs) : [];
  const data: PlanChangeData = {
    baseRevision,
    changes: result.changes,
    compatibility: [...compatibility.values()].sort((a, b) => a.dimension.localeCompare(b.dimension) || a.kind.localeCompare(b.kind)),
    affected: result.impact,
    invalidatedEvidence: candidate ? invalidatedBy(base, candidate, inputs, afterInputs) : [],
    repairs: result.repairs,
    obligations: inputs.evidence === undefined ? obligations : evaluateEvidence(after, obligations, afterInputs).obligations,
    acceptanceRequired,
    changeClasses: [...classes].sort(),
  };
  if (candidate) {
    data.candidateRevision = modelRevision(candidate);
    data.candidate = candidate;
  }
  const policy = result.findings.some((f) => f.code === 'BREAKING_CHANGE_UNACKNOWLEDGED' || f.code === 'BREAKING_CHANGE_WITHOUT_VERSION_BUMP');
  const parts: Parameters<typeof envelope>[1] = { model: after, findings: result.findings, data, states: statesFor(after, afterInputs) };
  if (!candidate) parts.refusal = refusal(policy ? 'policy-failure' : 'invalid-input', policy ? 'A breaking or unclassified change lacks its version bump or acknowledgement.' : 'The patch or the resulting model is invalid.');
  return envelope('loom.planChange', parts);
}

/** The candidate against the trusted accepted baseline, with the same policy every adapter applies. */
export function compareBaselineTool(input: { model?: unknown }, inputs: EvaluationInputs = {}): ResultEnvelope {
  const loaded = loadOrRefuse('loom.compareBaseline', input.model);
  if ('refused' in loaded) return loaded.refused;
  const r = compareBaseline(loaded.model, inputs);
  const before = inputs.baseline ? validate(inputs.baseline.model) : null;
  const afterFindings = validate(loaded.model, inputs);
  const data: DiffData = {
    changes: r.changes,
    provisional: before === null || before.some((f) => f.severity === 'error') || afterFindings.some((f) => f.severity === 'error'),
    before: validationState(before),
    after: validationState(afterFindings),
  };
  if (inputs.baseline) data.baseline = { id: inputs.baseline.record.id, trusted: inputs.baseline.verified };
  const states = statesFor(loaded.model, inputs);
  states.acceptance = r.acceptance;
  return envelope('loom.compareBaseline', { model: loaded.model, findings: [...afterFindings, ...r.findings], data, states });
}

/** Evidence obligations of a scope and their statuses under the supplied evidence. */
export function evaluateEvidenceTool(input: { model?: unknown; task?: CheckReadinessInput['task'] }, inputs: EvaluationInputs = {}): ResultEnvelope {
  const loaded = loadOrRefuse('loom.evaluateEvidence', input.model);
  if ('refused' in loaded) return loaded.refused;
  const scope = input.task ? resolveScope(indexModel(loaded.model), input.task) : undefined;
  const r = evaluateEvidence(loaded.model, deriveObligations(loaded.model, scope, inputs), inputs);
  const states = statesFor(loaded.model, inputs);
  states.qualification = r.qualification;
  return envelope('loom.evaluateEvidence', { model: loaded.model, findings: r.findings, data: { obligations: r.obligations, invalidated: r.invalidated, retained: r.retained }, states });
}
