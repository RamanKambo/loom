import type {
  Completeness,
  DiffData,
  ExportData,
  Finding,
  ImportData,
  Model,
  MutateData,
  Patch,
  ProjectData,
  ProjectionTarget,
  Reason,
  Refusal,
  ResultEnvelope,
  RevisionSet,
  States,
  ValidationState,
} from './generated/types.js';
import { CONTRACT_DIGEST } from './generated/digest.js';
import { FINDING, FINDING_RULES } from './codes.js';
import { structuralFindings, MODEL_FORMAT } from './load.js';
import { validate, isValid } from './validate.js';
import { mutate } from './mutate.js';
import { diff } from './diff.js';
import { modelRevision } from './hash.js';
import { exportModel, importModel, exportYaml } from './exportModel.js';
import { LoomInvalidModelError, LoomStructuralError } from './errors.js';
import { renderTarget, renderAll } from './project.js';

const reason = (code: Reason['code'], message: string, refs: Reason['refs'] = []): Reason => ({ code, message, refs });

/** Validation state from findings: valid exactly when no finding is an error. */
export function validationState(findings: readonly Finding[] | null): ValidationState {
  if (findings === null) return { state: 'notEvaluated', reasons: [reason(FINDING.READINESS_INPUT_MISSING, 'No model was evaluated.')] };
  const errors = findings.filter((f) => f.severity === 'error');
  return errors.length
    ? { state: 'invalid', reasons: [reason(FINDING.VALIDATION_FINDINGS, `${errors.length} error finding(s).`, errors.flatMap((f) => f.refs ?? []).slice(0, 50))] }
    : { state: 'valid', reasons: [] };
}

/**
 * The four independent states with no readiness, qualification or acceptance
 * input: each is 'notEvaluated' with the reason it was not evaluated, never a
 * success.
 */
export function defaultStates(validation: ValidationState): States {
  return {
    validation,
    readiness: { state: 'notEvaluated', reasons: [reason(FINDING.READINESS_INPUT_MISSING, 'No task was supplied, so readiness is not evaluated.')] },
    qualification: { state: 'notEvaluated', reasons: [reason(FINDING.QUALIFICATION_NOT_ESTABLISHED, 'No external validator or qualification run contributed to this result.')] },
    acceptance: { state: 'notEvaluated', reasons: [reason(FINDING.ACCEPTANCE_MISSING, 'No trusted baseline or acceptance record was supplied.')] },
  };
}

export function revisionsOf(model: Model | null): RevisionSet {
  const r: RevisionSet = { contractDigest: CONTRACT_DIGEST, resultVersion: 1 };
  if (model) {
    r.modelFormat = MODEL_FORMAT;
    r.model = modelRevision(model);
  }
  return r;
}

const COMPLETE: Completeness = { complete: true, truncated: false, omitted: [] };

export interface EnvelopeParts {
  model: Model | null;
  findings: Finding[];
  states?: States;
  refusal?: Refusal;
  data?: unknown;
  completeness?: Completeness;
  revisions?: RevisionSet;
}

/** Assemble a result envelope; a refusal sets outcome 'refused'. */
export function envelope(tool: string, parts: EnvelopeParts): ResultEnvelope {
  const env: ResultEnvelope = {
    resultVersion: 1,
    tool,
    outcome: parts.refusal ? 'refused' : 'ok',
    revisions: parts.revisions ?? revisionsOf(parts.model),
    states: parts.states ?? defaultStates(validationState(parts.model ? parts.findings : null)),
    findings: parts.findings,
    completeness: parts.completeness ?? COMPLETE,
  };
  if (parts.refusal) env.refusal = parts.refusal;
  if (parts.data !== undefined) env.data = parts.data;
  return env;
}

const refusal = (cause: Refusal['cause'], message: string): Refusal => ({ cause, message });
const asFinding = (code: Finding['code'], path: string, message: string, fix: string): Finding => ({ code, severity: FINDING_RULES[code].severity, path, message, fix });

/** Structurally load an untrusted model value, or return the refusal envelope for it. */
function loadOrRefuse(tool: string, value: unknown): { model: Model } | { refused: ResultEnvelope } {
  const findings = structuralFindings(value);
  if (findings.length) return { refused: envelope(tool, { model: null, findings, refusal: refusal('invalid-input', 'The model does not satisfy the structural contract.') }) };
  return { model: value as Model };
}

/** Workspace inputs are resolved by an adapter before the core sees them. */
function workspaceRefusal(tool: string): ResultEnvelope {
  return envelope(tool, {
    model: null,
    findings: [],
    refusal: refusal('unresolved-context', 'The workspace model is resolved by the workspace adapter; the core evaluates only a supplied model.'),
  });
}

export function validateTool(input: { model?: unknown; workspace?: boolean }): ResultEnvelope {
  if (input.workspace) return workspaceRefusal('loom.validate');
  const loaded = loadOrRefuse('loom.validate', input.model);
  if ('refused' in loaded) return loaded.refused;
  return envelope('loom.validate', { model: loaded.model, findings: validate(loaded.model), data: {} });
}

export interface MutateToolInput {
  model?: unknown;
  workspace?: boolean;
  patch?: unknown;
  patches?: unknown;
  acknowledgeBreaking?: string[];
  dryRun?: boolean;
}

/**
 * The pure mutation calculation. It never persists: a persistent workspace
 * mutation goes through the workspace adapter's expected-revision write.
 */
export function mutateTool(input: MutateToolInput): ResultEnvelope {
  if (input.workspace) return workspaceRefusal('loom.mutate');
  const hasPatch = input.patch !== undefined;
  const hasPatches = input.patches !== undefined;
  if (hasPatch === hasPatches) {
    return envelope('loom.mutate', {
      model: null,
      findings: [asFinding(FINDING.PATCH_AMBIGUOUS, '(root)', "the request must carry exactly one of 'patch' or 'patches'", "send one patch as 'patch' or a batch as 'patches'")],
      refusal: refusal('invalid-input', "The request carries both or neither of 'patch' and 'patches'."),
    });
  }
  const loaded = loadOrRefuse('loom.mutate', input.model);
  if ('refused' in loaded) return loaded.refused;
  const patches = (hasPatches ? input.patches : input.patch) as Patch | Patch[];
  if (hasPatches && !Array.isArray(patches)) {
    return envelope('loom.mutate', { model: loaded.model, findings: [asFinding(FINDING.PATCH_INVALID, 'patches', "'patches' must be an array", 'send an array of patches')], refusal: refusal('invalid-input', "'patches' is not an array.") });
  }
  const result = mutate(loaded.model, patches, { acknowledgeBreaking: input.acknowledgeBreaking ?? [] });
  const data: MutateData = {
    committed: false,
    dryRun: input.dryRun === true,
    baseRevision: modelRevision(loaded.model),
    changes: result.changes,
    impact: result.impact,
    repairs: result.repairs,
    invalidatedEvidence: [],
  };
  if (result.model) {
    if (!data.dryRun) data.model = result.model;
    data.revision = modelRevision(result.model);
  }
  const policy = result.findings.some((f) => f.code === 'BREAKING_CHANGE_UNACKNOWLEDGED' || f.code === 'BREAKING_CHANGE_WITHOUT_VERSION_BUMP');
  const parts: EnvelopeParts = { model: result.model ?? loaded.model, findings: result.findings, data };
  if (!result.model) parts.refusal = refusal(policy ? 'policy-failure' : 'invalid-input', policy ? 'A breaking or unclassified change lacks its version bump or acknowledgement.' : 'The patch or the resulting model is invalid; the model is unchanged.');
  return envelope('loom.mutate', parts);
}

/** Compare two supplied models; either side with error findings makes the comparison provisional. */
export function diffTool(input: { before?: unknown; after?: unknown }): ResultEnvelope {
  const b = loadOrRefuse('loom.diff', input.before);
  if ('refused' in b) return b.refused;
  const a = loadOrRefuse('loom.diff', input.after);
  if ('refused' in a) return a.refused;
  const bf = validate(b.model);
  const af = validate(a.model);
  const data: DiffData = { changes: diff(b.model, a.model), provisional: !isValid(bf) || !isValid(af), before: validationState(bf), after: validationState(af) };
  return envelope('loom.diff', { model: a.model, findings: [...bf, ...af], data });
}

function projectionRefusal(tool: string, model: Model, e: unknown): ResultEnvelope {
  if (e instanceof LoomInvalidModelError) {
    const unsupported = e.findings.some((f) => f.code === 'PROFILE_UNSUPPORTED_CONSTRUCT');
    return envelope(tool, { model, findings: e.findings, refusal: refusal(unsupported ? 'policy-failure' : 'invalid-input', e.message) });
  }
  throw e;
}

export function projectTool(input: { model?: unknown; workspace?: boolean; target: ProjectionTarget; draft?: boolean }): ResultEnvelope {
  if (input.workspace) return workspaceRefusal('loom.project');
  const loaded = loadOrRefuse('loom.project', input.model);
  if ('refused' in loaded) return loaded.refused;
  try {
    const r = renderTarget(loaded.model, input.target, { draft: input.draft === true });
    const data: ProjectData = { files: r.files, draft: r.draft, coverage: [] };
    return envelope('loom.project', { model: loaded.model, findings: r.findings, data });
  } catch (e) {
    return projectionRefusal('loom.project', loaded.model, e);
  }
}

export function projectAllTool(input: { model?: unknown; workspace?: boolean; draft?: boolean }): ResultEnvelope {
  if (input.workspace) return workspaceRefusal('loom.projectAll');
  const loaded = loadOrRefuse('loom.projectAll', input.model);
  if ('refused' in loaded) return loaded.refused;
  try {
    const r = renderAll(loaded.model, { draft: input.draft === true });
    const data: ProjectData = { files: r.files, draft: r.draft, coverage: [] };
    return envelope('loom.projectAll', { model: loaded.model, findings: r.findings, data });
  } catch (e) {
    return projectionRefusal('loom.projectAll', loaded.model, e);
  }
}

export function exportTool(input: { model?: unknown; format?: 'json' | 'yaml' }): ResultEnvelope {
  const loaded = loadOrRefuse('loom.export', input.model);
  if ('refused' in loaded) return loaded.refused;
  const format = input.format ?? 'json';
  try {
    const data: ExportData = { format, text: format === 'yaml' ? exportYaml(loaded.model) : exportModel(loaded.model) };
    return envelope('loom.export', { model: loaded.model, findings: validate(loaded.model), data });
  } catch (e) {
    return projectionRefusal('loom.export', loaded.model, e);
  }
}

export function importTool(input: { text?: unknown }): ResultEnvelope {
  try {
    const model = importModel(String(input.text ?? ''));
    const data: ImportData = { model };
    return envelope('loom.import', { model, findings: validate(model), data });
  } catch (e) {
    if (e instanceof LoomStructuralError) {
      const findings = (e.errors as Finding[]).filter((x) => typeof x === 'object' && x !== null && 'code' in x);
      return envelope('loom.import', {
        model: null,
        findings: findings.length ? findings : [asFinding(FINDING.STRUCTURAL_INVALID, '(root)', e.message, 'supply JSON or YAML that satisfies the model contract')],
        refusal: refusal('invalid-input', e.message),
      });
    }
    throw e;
  }
}

/**
 * Compare an expected base revision with the model's current revision. A
 * persistent write proceeds only on 'ok'; a mismatch is a stale base.
 */
export function checkRevision(model: Model, expected: string): ResultEnvelope {
  const current = modelRevision(model);
  if (current === expected) return envelope('loom.checkRevision', { model, findings: [], data: {} });
  return envelope('loom.checkRevision', {
    model,
    findings: [asFinding(FINDING.STALE_BASE_REVISION, '(root)', `the model is at ${current}, not the expected ${expected}`, 'read the current model, re-apply the change against it, and send the new expected revision')],
    refusal: refusal('stale-base', 'The model changed since the expected revision.'),
  });
}

