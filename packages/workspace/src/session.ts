import { PROJECTION_PROFILES, canonicalHash, revisionsOf } from '@loom/core';
import type { EvaluationInputs, Finding, Model, ResultEnvelope, RevisionSet } from '@loom/core';
import { profileOf, type Workspace } from './config.js';
import { resolveModel, type ModelResolution } from './discover.js';
import { gatherEvaluationInputs, policyHash } from './trust.js';

/**
 * Everything a command or a tool call evaluates: the selected model, the
 * workspace that governs it, and the verified inputs read from the trusted ref.
 * The CLI and the MCP server both start here, so they cannot resolve a model or
 * its trust context differently.
 */
export interface Session {
  mode: ModelResolution['mode'];
  model: Model | null;
  modelPath: string | null;
  workspace: Workspace | null;
  ownership: ModelResolution['ownership'];
  inputs: EvaluationInputs;
  trustedRef: string | null;
  findings: Finding[];
}

export interface SessionOptions {
  /** An explicit model document; it selects the document, never an exemption from the governing workspace. */
  model?: string;
  boundary?: string;
  trustedRef?: string;
  /** ISO date for expiry rules; the core has no clock. */
  asOf?: string;
}

export function openSession(cwd: string, options: SessionOptions = {}): Session {
  const resolution = resolveModel(cwd, {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.boundary !== undefined ? { boundary: options.boundary } : {}),
  });
  const findings = [...resolution.findings];
  let inputs: EvaluationInputs = {};
  let trustedRef: string | null = null;
  if (resolution.workspace) {
    const gathered = gatherEvaluationInputs(resolution.workspace.root, {
      ...(options.trustedRef !== undefined ? { trustedRef: options.trustedRef } : {}),
      asOf: options.asOf ?? new Date().toISOString().slice(0, 10),
    });
    inputs = gathered.inputs;
    trustedRef = gathered.ref;
    findings.push(...gathered.findings);
  }
  return {
    mode: resolution.mode,
    model: resolution.model,
    modelPath: resolution.modelPath,
    workspace: resolution.workspace,
    ownership: resolution.ownership,
    inputs,
    trustedRef,
    findings,
  };
}

/**
 * Attach the session to a core result: the configuration, profile, policy and
 * baseline revisions, and the findings met while resolving the model and its
 * trust context. The core computed the states; they are left as it set them.
 */
export function stampSession(env: ResultEnvelope, session: Pick<Session, 'workspace' | 'inputs' | 'findings'>): ResultEnvelope {
  const extra = sessionRevisions(null, session);
  const revisions: RevisionSet = { ...env.revisions };
  if (extra.config) revisions.config = extra.config;
  if (extra.profile) revisions.profile = extra.profile;
  if (extra.policy) revisions.policy = extra.policy;
  if (extra.baseline) revisions.baseline = extra.baseline;
  const seen = new Set(env.findings.map((f) => `${f.code}|${f.path}|${f.message}`));
  const added = session.findings.filter((f) => !seen.has(`${f.code}|${f.path}|${f.message}`));
  return { ...env, revisions, findings: [...added, ...env.findings] };
}

/** The revision set of a result: the model plus the configuration, profile, policy and baseline it was evaluated under. */
export function sessionRevisions(model: Model | null, session: Pick<Session, 'workspace' | 'inputs'>): RevisionSet {
  const r = revisionsOf(model);
  const ws = session.workspace;
  if (ws) {
    r.config = { hash: canonicalHash(ws.config), configVersion: ws.config.configVersion };
    const profile = PROJECTION_PROFILES.find((p) => p.id === profileOf(ws.config));
    if (profile) r.profile = { id: profile.id, version: profile.version };
  }
  const policy = session.inputs.policy;
  if (policy) r.policy = { ref: policy.id, revision: policy.revision, hash: policyHash(policy) };
  const baseline = session.inputs.baseline;
  if (baseline) r.baseline = { id: baseline.record.id, hash: canonicalHash(baseline.record) };
  return r;
}
