import { join } from 'node:path';
import { canonicalHash, envelope, importPinsOf, modelRevision, mutateTool, nextAction, revisionsOf, schemaErrors, structuralFindings, textHash, validate } from '@loom/core';
import type { Finding, LoomConfig, Model, MutateData, MutationExpectation, ResultEnvelope, RevisionSet, WorkflowState } from '@loom/core';
import { CACHE_DIR, LOOM_DIR, STATE_FILE, loomDirOf, readConfig, type Workspace } from './config.js';
import { finding, refusal } from './findings.js';
import { documentText, readJson, toPosix, writeFileAtomic } from './fsx.js';
import { withLock } from './lock.js';
import { containsPath, realPathOf, relativeTo } from './paths.js';
import { stampSession, type Session } from './session.js';
import { currentPolicy, policyHash } from './trust.js';

/**
 * Whether `target`'s real path still resolves inside `root`'s real path,
 * checked again immediately before the write it guards: a link or a reparse
 * point swapped in since the path was first resolved must not redirect a
 * write outside the workspace it was granted for.
 */
function stillContained(root: string, target: string): Finding | null {
  if (containsPath(realPathOf(root), realPathOf(target))) return null;
  const rel = toPosix(relativeTo(root, target));
  return finding('WRITE_OUTSIDE_WORKSPACE', rel, `the write target '${rel}' resolves outside the workspace root through a link or a reparse point`, 're-open the workspace; the write target must stay inside the workspace root');
}

/** Revision of the model document on disk: the model revision when it loads, otherwise the hash of its exact text. */
function currentModelRevision(path: string): string | null {
  const r = readJson(path);
  if (!r.ok) return r.missing ? null : textHash('unreadable');
  return structuralFindings(r.value).length ? textHash(r.text) : modelRevision(r.value as Model);
}

/** Every input a workspace write is judged against, read fresh. */
export interface CurrentInputs {
  model: string | null;
  config: { hash: string; configVersion: number };
  policy: { ref: string; revision: number; hash: string } | null;
  imports: string;
}

/** Read the model, configuration, trusted policy and import pins fresh from disk, the way a workspace write recheck does; reused by the handle registry to report current revisions. */
export function currentInputs(root: string, loomDir: string, config: LoomConfig): { current: CurrentInputs; findings: Finding[] } {
  const path = join(loomDir, ...toPosix(config.model).split('/'));
  const policy = currentPolicy(root, config);
  const imports = importPinsOf(config);
  return {
    current: {
      model: currentModelRevision(path),
      config: { hash: canonicalHash(config), configVersion: config.configVersion },
      policy: policy.policy ? { ref: config.gates.policyRef as string, revision: policy.policy.revision, hash: policyHash(policy.policy) } : null,
      imports: canonicalHash(imports),
    },
    findings: policy.findings,
  };
}

export const currentRevisions = (current: CurrentInputs): RevisionSet => ({
  ...revisionsOf(null),
  ...(current.model !== null ? { model: current.model } : {}),
  config: current.config,
  ...(current.policy ? { policy: current.policy } : {}),
  imports: current.imports,
});

/** Which of model, config, policy and imports differ from the expectation they were prepared against. */
function mismatches(current: CurrentInputs, expectation: MutationExpectation): string[] {
  const out: string[] = [];
  if (current.model !== expectation.model) out.push('model');
  if (current.config.hash !== expectation.config) out.push('config');
  if ((current.policy?.hash ?? null) !== expectation.policy) out.push('policy');
  if (current.imports !== expectation.imports) out.push('imports');
  return out;
}

/**
 * Persist a model only while every input that changes how it is interpreted
 * (the model itself, the configuration, the trusted policy and the import
 * pins) is still at the hash it was prepared against. The check and the write
 * happen under one exclusive lock, so of two writers holding the same
 * expectation exactly one succeeds and the other is refused as stale; neither
 * can silently overwrite the other.
 */
export async function writeModel(root: string, model: Model, expectation: MutationExpectation): Promise<ResultEnvelope> {
  const tool = 'workspace.writeModel';
  const loomDir = loomDirOf(root);
  const config = readConfig(loomDir);
  if (!config.value) return envelope(tool, { model: null, findings: config.findings, refusal: refusal('unresolved-context', 'loom.json cannot be read') });
  const errors = validate(model).filter((f) => f.severity === 'error');
  if (errors.length) return envelope(tool, { model, findings: errors, refusal: refusal('invalid-input', `the model has ${errors.length} error finding(s); nothing was written`) });
  const path = join(loomDir, ...toPosix(config.value.model).split('/'));
  type LockOutcome =
    | { kind: 'blocked'; blocking: Finding }
    | { kind: 'stale'; changed: string[]; current: CurrentInputs | null; findings: Finding[] }
    | { kind: 'written'; current: CurrentInputs };
  const locked = await withLock(join(loomDir, CACHE_DIR, 'model.lock'), (): LockOutcome => {
    const fresh = readConfig(loomDir);
    if (!fresh.value) return { kind: 'stale', changed: ['config'], current: null, findings: fresh.findings };
    const { current, findings } = currentInputs(root, loomDir, fresh.value);
    const changed = mismatches(current, expectation);
    if (changed.length) return { kind: 'stale', changed, current, findings };
    const blocking = stillContained(root, path);
    if (blocking) return { kind: 'blocked', blocking };
    writeFileAtomic(path, documentText(model));
    return { kind: 'written', current };
  });
  if (!locked.ok) {
    return envelope(tool, { model: null, findings: [], refusal: refusal('unresolved-context', `the model is locked by ${locked.holder}`) });
  }
  if (locked.value.kind === 'blocked') {
    return envelope(tool, { model: null, findings: [locked.value.blocking], refusal: refusal('policy-failure', 'the write target no longer resolves inside the workspace root; nothing was written') });
  }
  if (locked.value.kind === 'stale') {
    const named = locked.value.changed.join(', ');
    const f: Finding = finding('STALE_BASE_REVISION', `${LOOM_DIR}/${toPosix(config.value.model)}`, `the write was prepared against an expectation that no longer holds: ${named} changed`, 're-read the current revisions, re-plan the change against them and write again');
    const revisions = locked.value.current ? currentRevisions(locked.value.current) : revisionsOf(null);
    return { ...envelope(tool, { model: null, findings: [f, ...locked.value.findings], refusal: refusal('stale-base', `${named} changed since the expectation this write was prepared against; nothing was written`) }), revisions };
  }
  const revisions = currentRevisions({ ...locked.value.current, model: modelRevision(model) });
  return envelope(tool, { model, findings: [], revisions, data: { revision: modelRevision(model) } });
}

/** The change a persistent mutation applies: one patch or a batch, its breaking-change acknowledgements and whether it only previews. */
export interface WorkspaceChange {
  patch?: unknown;
  patches?: unknown;
  acknowledgeBreaking?: string[];
  dryRun?: boolean;
}

/** The re-plan action a stale persistent write offers: the same change, addressed to the workspace, against the model's current revision. */
function replanAction(request: WorkspaceChange, baseRevision: string): ReturnType<typeof nextAction> {
  const args: Record<string, unknown> = { workspace: true, baseRevision, ...(request.patch !== undefined ? { patch: request.patch } : { patches: request.patches }) };
  if (request.acknowledgeBreaking) args['acknowledgeBreaking'] = request.acknowledgeBreaking;
  return nextAction('Re-plan the change against the model as it is now.', 'loom.planChange', args);
}

/**
 * A persistent mutation of the workspace model, the one the CLI and the MCP
 * server both perform: refused as stale unless every input the caller's
 * expectation names is still current, computed by the pure core, then written
 * by writeModel, which rechecks the expectation under the workspace lock. A
 * refused change or a dry run writes nothing. The session must hold a
 * workspace and its model.
 */
export async function mutateWorkspace(s: Session, expectation: MutationExpectation, change: () => WorkspaceChange): Promise<ResultEnvelope> {
  const model = s.model as Model;
  const current = modelRevision(model);
  if (current !== expectation.model) {
    const stale = finding('STALE_BASE_REVISION', '(root)', `the model is at ${current}, not the expected ${expectation.model}`, 're-read the model, re-apply the change against it and send the new expectation');
    const request = change();
    return stampSession(envelope('loom.mutate', { model, findings: [stale], refusal: refusal('stale-base', 'the model changed since the expectation this write was prepared against; nothing was written', [replanAction(request, current)]) }), s);
  }
  const request = change();
  const env = mutateTool({ ...request, model }, s.inputs);
  if (env.outcome === 'refused' || request.dryRun === true) return stampSession(env, s);
  const data = env.data as MutateData;
  const written = await writeModel((s.workspace as Workspace).root, data.model as Model, expectation);
  if (written.outcome === 'refused') {
    const refusedEnv = written.refusal?.cause === 'stale-base' ? { ...written, refusal: refusal('stale-base', written.refusal.message, [replanAction(request, current)]) } : written;
    return stampSession({ ...refusedEnv, tool: 'loom.mutate' }, s);
  }
  return stampSession({ ...env, data: { ...data, committed: true } }, s);
}

/** Revision of state.json: the canonical hash when it parses, otherwise the hash of its text. */
export function stateRevision(root: string): string | null {
  const r = readJson(join(loomDirOf(root), STATE_FILE));
  if (!r.ok) return r.missing ? null : textHash('unreadable');
  return canonicalHash(r.value);
}

/** Persist workflow state under the same expected-revision rule; state never carries acceptance authority. */
export async function writeState(root: string, state: WorkflowState, expectedRevision: string): Promise<ResultEnvelope> {
  const tool = 'workspace.writeState';
  const loomDir = loomDirOf(root);
  const errs = schemaErrors('WorkflowState', state);
  if (errs.length) {
    return envelope(tool, {
      model: null,
      findings: errs.map((e) => finding('CONFIG_INVALID', `${LOOM_DIR}/${STATE_FILE}#${e.pointer}`, e.message, 'correct the state to satisfy the state.json contract')),
      refusal: refusal('invalid-input', 'the state does not satisfy its contract'),
    });
  }
  const statePath = join(loomDir, STATE_FILE);
  type LockOutcome = { kind: 'blocked'; blocking: Finding } | { kind: 'stale'; current: string | null } | { kind: 'written' };
  const locked = await withLock(join(loomDir, CACHE_DIR, 'state.lock'), (): LockOutcome => {
    const current = stateRevision(root);
    if (current !== expectedRevision) return { kind: 'stale', current };
    const blocking = stillContained(root, statePath);
    if (blocking) return { kind: 'blocked', blocking };
    writeFileAtomic(statePath, documentText(state));
    return { kind: 'written' };
  });
  if (!locked.ok) return envelope(tool, { model: null, findings: [], refusal: refusal('unresolved-context', `the state is locked by ${locked.holder}`) });
  if (locked.value.kind === 'blocked') {
    return envelope(tool, { model: null, findings: [locked.value.blocking], refusal: refusal('policy-failure', 'the write target no longer resolves inside the workspace root; nothing was written') });
  }
  if (locked.value.kind === 'stale') {
    return envelope(tool, {
      model: null,
      findings: [finding('STALE_BASE_REVISION', `${LOOM_DIR}/${STATE_FILE}`, `expected state revision ${expectedRevision}, but it is at ${locked.value.current ?? 'absent'}`, 're-read the state and write again')],
      refusal: refusal('stale-base', 'the state changed since the expected revision; nothing was written'),
    });
  }
  return envelope(tool, { model: null, findings: [], data: { baseRevision: expectedRevision, revision: canonicalHash(state) } });
}
