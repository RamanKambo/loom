import type {
  CheckReadinessInput,
  ContextInput,
  DescribeInput,
  DiffData,
  Model,
  Patch,
  PlanChangeData,
  ResultEnvelope,
  States,
} from './generated/types.js';
import { FINDING } from './codes.js';
import { validate } from './validate.js';
import { mutate } from './mutate.js';
import { modelRevision } from './hash.js';
import { indexModel } from './records.js';
import type { EvaluationInputs } from './inputs.js';
import { asFinding, defaultStates, envelope, loadOrRefuse, refusal, validationState, workspaceRefusal } from './envelope.js';
import { describe } from './describe.js';
import { retrieveContext } from './retrieval.js';
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

export function describeTool(input: DescribeInput = {}): ResultEnvelope {
  return envelope('loom.describe', { model: null, findings: [], data: describe(input), states: defaultStates({ state: 'notEvaluated', reasons: [] }) });
}

export function contextTool(input: Partial<ContextInput> & { model?: unknown }, inputs: EvaluationInputs = {}): ResultEnvelope {
  if (input.workspace) return workspaceRefusal('loom.context');
  const loaded = loadOrRefuse('loom.context', input.model);
  if ('refused' in loaded) return loaded.refused;
  if (!input.target || !input.budget) {
    return envelope('loom.context', { model: loaded.model, findings: [asFinding(FINDING.READINESS_INPUT_MISSING, '(root)', 'a context request names a target and a budget', 'send target and budget')], refusal: refusal('invalid-input', 'The request has no target or budget.') });
  }
  const request: Parameters<typeof retrieveContext>[1] = { target: input.target, budget: input.budget };
  if (input.continuation !== undefined) request.continuation = input.continuation;
  if (input.modelRevision !== undefined) request.modelRevision = input.modelRevision;
  const r = retrieveContext(loaded.model, request, inputs);
  if (!r.ok) {
    const findings = r.cause === 'stale-base' ? [asFinding(FINDING.STALE_BASE_REVISION, '(root)', r.message, 'request the context again without the stale continuation or revision')] : [];
    return envelope('loom.context', { model: loaded.model, findings, refusal: refusal(r.cause, r.message) });
  }
  return envelope('loom.context', { model: loaded.model, findings: [], data: r.data, completeness: r.completeness, states: statesFor(loaded.model, inputs) });
}

export function checkReadinessTool(input: Partial<CheckReadinessInput> & { model?: unknown }, inputs: EvaluationInputs = {}): ResultEnvelope {
  if (input.workspace) return workspaceRefusal('loom.checkReadiness');
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
  workspace?: boolean;
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
  if (input.workspace) return workspaceRefusal('loom.planChange');
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
