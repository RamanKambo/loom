import { join } from 'node:path';
import { canonicalHash, envelope, modelRevision, mutateTool, revisionsOf, schemaErrors, structuralFindings, textHash, validate } from '@loom/core';
import type { Finding, Model, MutateData, ResultEnvelope, WorkflowState } from '@loom/core';
import { CACHE_DIR, LOOM_DIR, STATE_FILE, loomDirOf, readConfig, type Workspace } from './config.js';
import { finding, refusal } from './findings.js';
import { documentText, readJson, toPosix, writeFileAtomic } from './fsx.js';
import { withLock } from './lock.js';
import { stampSession, type Session } from './session.js';

/** Revision of the model document on disk: the model revision when it loads, otherwise the hash of its exact text. */
function currentModelRevision(path: string): string | null {
  const r = readJson(path);
  if (!r.ok) return r.missing ? null : textHash('unreadable');
  return structuralFindings(r.value).length ? textHash(r.text) : modelRevision(r.value as Model);
}

/**
 * Persist a model only onto the revision it was prepared against. The check
 * and the write happen under one exclusive lock, so of two writers holding the
 * same base revision exactly one succeeds and the other is refused as stale;
 * neither can silently overwrite the other.
 */
export function writeModel(root: string, model: Model, expectedRevision: string): ResultEnvelope {
  const tool = 'workspace.writeModel';
  const loomDir = loomDirOf(root);
  const config = readConfig(loomDir);
  if (!config.value) return envelope(tool, { model: null, findings: config.findings, refusal: refusal('unresolved-context', 'loom.json cannot be read') });
  const path = join(loomDir, ...toPosix(config.value.model).split('/'));
  const errors = validate(model).filter((f) => f.severity === 'error');
  if (errors.length) return envelope(tool, { model, findings: errors, refusal: refusal('invalid-input', `the model has ${errors.length} error finding(s); nothing was written`) });
  const locked = withLock(join(loomDir, CACHE_DIR, 'model.lock'), () => {
    const current = currentModelRevision(path);
    if (current !== expectedRevision) return { stale: true as const, current };
    writeFileAtomic(path, documentText(model));
    return { stale: false as const, current };
  });
  if (!locked.ok) {
    return envelope(tool, { model: null, findings: [], refusal: refusal('unresolved-context', `the model is locked by ${locked.holder}`) });
  }
  if (locked.value.stale) {
    const f: Finding = finding('STALE_BASE_REVISION', `${LOOM_DIR}/${toPosix(config.value.model)}`, `expected base revision ${expectedRevision}, but the model is at ${locked.value.current ?? 'absent'}`, 're-read the model, re-apply the change to the current revision and write again');
    return envelope(tool, { model: null, findings: [f], refusal: refusal('stale-base', 'the model changed since the expected revision; nothing was written') });
  }
  return envelope(tool, { model, findings: [], revisions: revisionsOf(model), data: { baseRevision: expectedRevision, revision: modelRevision(model) } });
}

/** The change a persistent mutation applies: one patch or a batch, its breaking-change acknowledgements and whether it only previews. */
export interface WorkspaceChange {
  patch?: unknown;
  patches?: unknown;
  acknowledgeBreaking?: string[];
  dryRun?: boolean;
}

/**
 * A persistent mutation of the workspace model, the one the CLI and the MCP
 * server both perform: refused as stale unless the model is still at the
 * expected revision, computed by the pure core, then written by writeModel,
 * which rechecks the revision under the workspace lock. A refused change or a
 * dry run writes nothing. The change is read only once the revision holds, so
 * a stale request is refused before its patch is parsed. The session must hold
 * a workspace and its model.
 */
export function mutateWorkspace(s: Session, expectedRevision: string, change: () => WorkspaceChange): ResultEnvelope {
  const model = s.model as Model;
  const current = modelRevision(model);
  if (current !== expectedRevision) {
    const stale = finding('STALE_BASE_REVISION', '(root)', `the model is at ${current}, not the expected ${expectedRevision}`, 're-read the model, re-apply the change against it and send the new expected revision');
    return stampSession(envelope('loom.mutate', { model, findings: [stale], refusal: refusal('stale-base', 'the model changed since the expected revision; nothing was written') }), s);
  }
  const request = change();
  const env = mutateTool({ ...request, model }, s.inputs);
  if (env.outcome === 'refused' || request.dryRun === true) return stampSession(env, s);
  const data = env.data as MutateData;
  const written = writeModel((s.workspace as Workspace).root, data.model as Model, expectedRevision);
  if (written.outcome === 'refused') return stampSession({ ...written, tool: 'loom.mutate' }, s);
  return stampSession({ ...env, data: { ...data, committed: true } }, s);
}

/** Revision of state.json: the canonical hash when it parses, otherwise the hash of its text. */
export function stateRevision(root: string): string | null {
  const r = readJson(join(loomDirOf(root), STATE_FILE));
  if (!r.ok) return r.missing ? null : textHash('unreadable');
  return canonicalHash(r.value);
}

/** Persist workflow state under the same expected-revision rule; state never carries acceptance authority. */
export function writeState(root: string, state: WorkflowState, expectedRevision: string): ResultEnvelope {
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
  const locked = withLock(join(loomDir, CACHE_DIR, 'state.lock'), () => {
    const current = stateRevision(root);
    if (current !== expectedRevision) return { stale: true as const, current };
    writeFileAtomic(join(loomDir, STATE_FILE), documentText(state));
    return { stale: false as const, current };
  });
  if (!locked.ok) return envelope(tool, { model: null, findings: [], refusal: refusal('unresolved-context', `the state is locked by ${locked.holder}`) });
  if (locked.value.stale) {
    return envelope(tool, {
      model: null,
      findings: [finding('STALE_BASE_REVISION', `${LOOM_DIR}/${STATE_FILE}`, `expected state revision ${expectedRevision}, but it is at ${locked.value.current ?? 'absent'}`, 're-read the state and write again')],
      refusal: refusal('stale-base', 'the state changed since the expected revision; nothing was written'),
    });
  }
  return envelope(tool, { model: null, findings: [], data: { baseRevision: expectedRevision, revision: canonicalHash(state) } });
}
