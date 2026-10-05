import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalHash, canonicalJson, modelRevision, schemaErrors, structuralFindings, withArtifactHashes } from '@loom/core';
import type { Acceptance, Baseline, EvaluationInputs, EvidenceRecord, Finding, Model, Policy, PublicKey, Signature, SourceRevision } from '@loom/core';
import { LOOM_DIR, loomDirOf, openWorkspace } from './config.js';
import { listEvidence } from './evidence.js';
import { finding } from './findings.js';
import { readJson, toPosix } from './fsx.js';
import { realPathOf, relativeTo } from './paths.js';
import { resolvePublishedContracts } from './published.js';
import { findRepositoryRoot, headRevision, isDirty, listAt, refExists, showAt, tryGit } from './repo.js';

export type { EvaluationInputs };

interface RepoContext {
  repo: string;
  /** Path of the .loom directory relative to the repository, forward slashes. */
  loomRel: string;
}

function repoContext(root: string): RepoContext | null {
  const repo = findRepositoryRoot(root);
  if (!repo) return null;
  return { repo, loomRel: relativeTo(realPathOf(repo), realPathOf(loomDirOf(root))) };
}

/**
 * The ref whose committed content is trusted: an explicit ref, else the remote
 * default branch, else refs/heads/main. The working tree is never trusted for
 * policy, baselines or acceptance, because the candidate under review lives
 * there and could otherwise authorize itself.
 */
export function resolveTrustedRef(root: string, explicit?: string): { ref: string | null; findings: Finding[] } {
  const ctx = repoContext(root);
  if (!ctx) return { ref: null, findings: [finding('POLICY_UNRESOLVED', LOOM_DIR, 'the workspace is not inside a Git repository, so no trusted ref exists', 'initialize the workspace inside its repository')] };
  if (explicit) {
    if (refExists(ctx.repo, explicit)) return { ref: explicit, findings: [] };
    return { ref: null, findings: [finding('POLICY_UNRESOLVED', LOOM_DIR, `trusted ref '${explicit}' does not exist`, 'fetch the trusted ref or name an existing one')] };
  }
  const origin = tryGit(ctx.repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])?.trim();
  if (origin && refExists(ctx.repo, origin)) return { ref: origin, findings: [] };
  if (refExists(ctx.repo, 'refs/heads/main')) return { ref: 'refs/heads/main', findings: [] };
  return { ref: null, findings: [] };
}

/** A policy naming refs/heads/<b> is satisfied by that branch or by its remote-tracking copy refs/remotes/<remote>/<b>. */
function refsMatch(named: string, used: string): boolean {
  if (named === used) return true;
  const branch = /^refs\/heads\/(.+)$/.exec(named)?.[1];
  return branch !== undefined && new RegExp(`^refs/remotes/[^/]+/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(used);
}

function parseAt<T>(ctx: RepoContext, ref: string, rel: string, definition: string): { value: T | null; problem?: string } {
  const text = showAt(ctx.repo, ref, rel);
  if (text === null) return { value: null, problem: `absent at ${ref}` };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { value: null, problem: `not JSON at ${ref}: ${(err as Error).message}` };
  }
  const errs = schemaErrors(definition, value);
  if (errs.length) return { value: null, problem: `does not satisfy ${definition}: ${errs.map((e) => `${e.pointer} ${e.message}`).join('; ')}` };
  return { value: value as T };
}

export function readPolicy(root: string, policyRef: string, ref: string): { policy: Policy | null; findings: Finding[] } {
  const ctx = repoContext(root);
  const rel = `${ctx?.loomRel ?? LOOM_DIR}/policies/${policyRef}.json`;
  if (!ctx) return { policy: null, findings: [finding('POLICY_UNRESOLVED', rel, 'no repository holds the workspace', 'initialize the workspace inside its repository')] };
  const r = parseAt<Policy>(ctx, ref, rel, 'Policy');
  if (!r.value) return { policy: null, findings: [finding('POLICY_UNRESOLVED', rel, `policy '${policyRef}' is ${r.problem}`, `commit the accepted policy at ${rel} on the trusted ref`)] };
  if (!refsMatch(r.value.trust.ref, ref)) {
    return { policy: null, findings: [finding('POLICY_UNTRUSTED', rel, `policy '${policyRef}' names trusted ref '${r.value.trust.ref}' but was read from '${ref}'`, 'read the policy from the ref it names, or correct trust.ref through the accepted change path')] };
  }
  return { policy: r.value, findings: [] };
}

const payload = (record: object): Buffer => {
  const { signature: _omitted, ...rest } = record as { signature?: unknown };
  return Buffer.from(canonicalJson(rest), 'utf8');
};

/** Sign the canonical JSON of a record (without its signature member) with an Ed25519 private key. */
export function signRecord<T extends object>(record: T, privateKeyPem: string, keyId: string): T & { signature: Signature } {
  const value = sign(null, payload(record), createPrivateKey(privateKeyPem)).toString('base64');
  return { ...record, signature: { keyId, algorithm: 'ed25519', value } };
}

/** Whether a record's signature verifies under a base64 DER SubjectPublicKeyInfo Ed25519 key. */
export function verifyRecord(record: { signature?: Signature }, spki: string): boolean {
  if (!record.signature || record.signature.algorithm !== 'ed25519') return false;
  try {
    const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
    return verify(null, payload(record), key, Buffer.from(record.signature.value, 'base64'));
  } catch {
    return false;
  }
}

function verifiedBy(record: { signature?: Signature }, keys: readonly PublicKey[]): { trusted: boolean; reason?: string } {
  if (!record.signature) return { trusted: false, reason: 'unsigned' };
  const key = keys.find((k) => k.id === record.signature?.keyId);
  if (!key) return { trusted: false, reason: `signed by '${record.signature.keyId}', which the trusted policy does not list` };
  return verifyRecord(record, key.spki) ? { trusted: true } : { trusted: false, reason: `the signature does not verify under key '${key.id}'` };
}

export interface TrustedBaseline {
  record: Baseline;
  model: Model;
  verified: boolean;
}

/**
 * Baselines committed at the trusted ref, each checked against the snapshot it
 * pins. The current baseline is the head of the predecessor chain; two heads
 * mean two competing accepted states, which is an error, not a choice.
 */
export function readBaselines(root: string, ref: string): { baselines: TrustedBaseline[]; head: TrustedBaseline | null; findings: Finding[] } {
  const ctx = repoContext(root);
  if (!ctx) return { baselines: [], head: null, findings: [] };
  const findings: Finding[] = [];
  const baselines: TrustedBaseline[] = [];
  for (const file of listAt(ctx.repo, ref, `${ctx.loomRel}/baselines`).filter((f) => f.endsWith('.json'))) {
    const text = showAt(ctx.repo, ref, file);
    if (text === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (schemaErrors('Baseline', value).length) continue;
    const record = value as Baseline;
    const snap = showAt(ctx.repo, ref, `${ctx.loomRel}/${toPosix(record.model.snapshot)}`);
    let model: Model | null = null;
    try {
      model = snap === null ? null : (JSON.parse(snap) as Model);
    } catch {
      model = null;
    }
    if (!model || structuralFindings(model).length) {
      findings.push(finding('BASELINE_UNTRUSTED', file, `baseline '${record.id}' pins snapshot ${record.model.snapshot}, which is absent or malformed at ${ref}`, 'commit the snapshot with its baseline record'));
      continue;
    }
    const verified = modelRevision(model) === record.model.hash;
    if (!verified) findings.push(finding('BASELINE_HASH_MISMATCH', file, `baseline '${record.id}' records model hash ${record.model.hash}, but its snapshot hashes to ${modelRevision(model)}`, 'recreate the baseline from the accepted snapshot'));
    baselines.push({ record, model, verified });
  }
  const named = new Set(baselines.map((b) => b.record.predecessor).filter((p): p is string => !!p));
  const heads = baselines.filter((b) => !named.has(b.record.id));
  if (heads.length > 1) {
    findings.push(finding('BASELINE_UNTRUSTED', `${ctx.loomRel}/baselines`, `the trusted ref holds ${heads.length} baseline heads (${heads.map((h) => h.record.id).join(', ')}); exactly one accepted state is current`, 'link the baselines through predecessor so one head remains'));
    return { baselines, head: null, findings };
  }
  if (heads.length === 0) findings.push(finding('BASELINE_MISSING', `${ctx.loomRel}/baselines`, `no baseline is committed at ${ref}`, 'accept a baseline through the configured policy'));
  return { baselines, head: heads[0] ?? null, findings };
}

/**
 * Acceptance records with their trust. A record committed at the trusted ref is
 * trusted when the policy accepts trusted-ref provenance; any record, committed
 * or not, is trusted when its signature verifies under a key the policy lists.
 * A record present only in the working tree and unsigned is a claim, not an
 * acceptance.
 */
export function readAcceptances(root: string, ref: string | null, policy: Policy | null): { acceptances: { record: Acceptance; trusted: boolean; reason?: string }[]; findings: Finding[] } {
  const ctx = repoContext(root);
  const via = policy?.trust.acceptanceVia ?? 'trusted-ref';
  const keys = policy?.trust.acceptanceKeys ?? [];
  const out: { record: Acceptance; trusted: boolean; reason?: string }[] = [];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  if (ctx && ref) {
    for (const file of listAt(ctx.repo, ref, `${ctx.loomRel}/acceptance`).filter((f) => f.endsWith('.json'))) {
      const r = parseAt<Acceptance>(ctx, ref, file, 'Acceptance');
      if (!r.value) continue;
      seen.add(r.value.id);
      if (via === 'trusted-ref' || via === 'either') out.push({ record: r.value, trusted: true });
      else out.push({ record: r.value, ...verifiedBy(r.value, keys) });
    }
  }
  const dir = join(loomDirOf(root), 'acceptance');
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      const r = readJson(join(dir, name));
      if (!r.ok || schemaErrors('Acceptance', r.value).length) continue;
      const record = r.value as Acceptance;
      if (seen.has(record.id)) continue;
      const v = via === 'signature' || via === 'either' ? verifiedBy(record, keys) : { trusted: false, reason: 'policy accepts only records committed at the trusted ref' };
      const entry: { record: Acceptance; trusted: boolean; reason?: string } = { record, trusted: v.trusted };
      if (!v.trusted) {
        entry.reason = `not committed at the trusted ref; ${v.reason ?? 'untrusted'}`;
        findings.push(finding('ACCEPTANCE_UNTRUSTED', `${LOOM_DIR}/acceptance/${name}`, `acceptance '${record.id}' is not trusted: ${entry.reason}`, 'obtain acceptance through the configured policy'));
      }
      out.push(entry);
    }
  }
  return { acceptances: out, findings };
}

/** Evidence records with their trust: only a run signed by a runner key the trusted policy lists is evidence. */
export function readTrustedEvidence(root: string, policy: Policy | null): { evidence: { record: EvidenceRecord; trusted: boolean; reason?: string }[]; findings: Finding[] } {
  const listed = listEvidence(root);
  const keys = policy?.trust.evidenceKeys ?? [];
  const evidence = (listed.value ?? []).map((record) => {
    const v = verifiedBy(record, keys);
    const entry: { record: EvidenceRecord; trusted: boolean; reason?: string } = { record, trusted: v.trusted };
    if (v.reason) entry.reason = v.reason;
    return entry;
  });
  return { evidence, findings: listed.findings };
}

/** Supported versions name the baseline that holds their accepted shape. */
function supportedBaselineIds(model: Model): string[] {
  const ids = new Set<string>();
  for (const r of [...model.types, ...model.operations, ...model.routines]) for (const s of r.supported ?? []) ids.add(s.baseline);
  return [...ids].sort();
}

/**
 * Retrieve and verify everything the core's readiness, baseline and evidence
 * evaluation needs. Provenance is decided here, against the trusted ref and the
 * keys of the trusted policy; the core then evaluates the verified records.
 */
export function gatherEvaluationInputs(root: string, options: { trustedRef?: string; asOf?: string } = {}): { inputs: EvaluationInputs; ref: string | null; findings: Finding[] } {
  const ws = openWorkspace(root);
  if (!ws.value) return { inputs: {}, ref: null, findings: ws.findings };
  const findings: Finding[] = [];
  const inputs: EvaluationInputs = { gates: ws.value.config.gates };
  if (ws.value.state) inputs.state = ws.value.state;
  if (options.asOf) inputs.asOf = options.asOf;
  const resolved = resolveTrustedRef(root, options.trustedRef);
  findings.push(...resolved.findings);
  const ref = resolved.ref;
  let policy: Policy | null = null;
  const policyRef = ws.value.config.gates.policyRef;
  if (policyRef) {
    if (ref) {
      const p = readPolicy(root, policyRef, ref);
      findings.push(...p.findings);
      policy = p.policy;
      if (policy) inputs.policy = policy;
    } else {
      findings.push(finding('POLICY_UNRESOLVED', `${LOOM_DIR}/loom.json#/gates/policyRef`, `policy '${policyRef}' cannot be resolved without a trusted ref`, 'fetch the trusted ref or name it explicitly'));
    }
  }
  if (ref) {
    const b = readBaselines(root, ref);
    findings.push(...b.findings);
    if (b.head) inputs.baseline = { record: b.head.record, model: b.head.model, verified: b.head.verified };
    const wanted = supportedBaselineIds(ws.value.model);
    inputs.supportedBaselines = b.baselines.filter((x) => x.verified && wanted.includes(x.record.id)).map((x) => ({ record: x.record, model: x.model }));
  }
  const a = readAcceptances(root, ref, policy);
  findings.push(...a.findings);
  inputs.acceptances = a.acceptances.map((x) => ({ record: x.record, trusted: x.trusted }));
  const e = readTrustedEvidence(root, policy);
  findings.push(...e.findings);
  inputs.evidence = e.evidence;
  const pc = resolvePublishedContracts(root, ws.value.model);
  findings.push(...pc.findings);
  inputs.publishedContracts = pc.bundles;
  return { inputs: withArtifactHashes(ws.value.model, inputs), ref, findings };
}

/**
 * The exact revision of the workspace repository and of every repository that
 * holds a scope root, with a dirty flag. Separately green repositories at other
 * revisions do not form this set, so evidence pinned to it identifies one
 * coordinated assembly.
 */
export function pinRevisionSet(root: string, scopeRepos?: readonly string[]): { sources: SourceRevision[]; findings: Finding[] } {
  const repos = new Set<string>();
  const top = findRepositoryRoot(root);
  if (top) repos.add(top);
  if (scopeRepos) {
    for (const r of scopeRepos) repos.add(join(root, ...toPosix(r).split('/')));
  } else {
    const ws = openWorkspace(root);
    for (const r of ws.value?.roots ?? []) {
      const repo = findRepositoryRoot(r.exists ? r.abs : realPathOf(r.abs));
      if (repo) repos.add(repo);
    }
  }
  const sources: SourceRevision[] = [];
  const findings: Finding[] = [];
  for (const repo of [...repos].sort()) {
    const rel = relativeTo(root, repo);
    const revision = headRevision(repo);
    if (!revision) {
      findings.push(finding('EVIDENCE_REVISION_SET_INCONSISTENT', rel, `repository '${rel}' has no commit to pin`, 'commit the repository before qualifying it'));
      continue;
    }
    sources.push({ repository: rel, revision, dirty: isDirty(repo) });
  }
  return { sources, findings };
}

/** Every pinned repository must still be at its pinned, clean revision. */
export function verifyRevisionSet(pinned: readonly SourceRevision[], current: readonly SourceRevision[]): Finding[] {
  const out: Finding[] = [];
  for (const p of pinned) {
    const c = current.find((x) => x.repository === p.repository);
    if (!c) out.push(finding('EVIDENCE_REVISION_SET_INCONSISTENT', p.repository, `repository '${p.repository}' is pinned at ${p.revision} but absent now`, 'restore the checkout or qualify the new revision set'));
    else if (c.revision !== p.revision) out.push(finding('EVIDENCE_REVISION_SET_INCONSISTENT', p.repository, `repository '${p.repository}' is at ${c.revision}, not the pinned ${p.revision}`, 'qualify the current revision set; evidence of another revision does not carry over'));
    else if (c.dirty) out.push(finding('EVIDENCE_REVISION_SET_INCONSISTENT', p.repository, `repository '${p.repository}' has uncommitted changes against the pinned ${p.revision}`, 'commit or discard the changes before relying on the pinned evidence'));
  }
  return out;
}

export const policyHash = (policy: Policy): string => canonicalHash(policy);

/** The trusted policy a configuration names, read fresh from the trusted ref; null and no findings when it names none. */
export function currentPolicy(root: string, config: { gates: { policyRef?: string } }): { policy: Policy | null; findings: Finding[] } {
  const policyRef = config.gates.policyRef;
  if (!policyRef) return { policy: null, findings: [] };
  const resolved = resolveTrustedRef(root);
  if (!resolved.ref) return { policy: null, findings: resolved.findings };
  const read = readPolicy(root, policyRef, resolved.ref);
  return { policy: read.policy, findings: read.findings };
}
