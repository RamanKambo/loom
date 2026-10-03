import { join } from 'node:path';
import { canonicalHash, envelope, modelRevision, revisionsOf, schemaErrors, structuralFindings, textHash, validate } from '@loom/core';
import type { Finding, Model, ResultEnvelope, WorkflowState } from '@loom/core';
import { CACHE_DIR, LOOM_DIR, STATE_FILE, loomDirOf, readConfig } from './config.js';
import { finding, refusal } from './findings.js';
import { documentText, readJson, toPosix, writeFileAtomic } from './fsx.js';
import { withLock } from './lock.js';

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
