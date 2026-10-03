import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTRACT_DIGEST,
  canonicalJson,
  changeImpact,
  checkReadiness,
  compareBaseline,
  deriveObligations,
  diff,
  evaluateEvidence,
  invalidatedBy,
  modelRevision,
  mutate,
  needsAcknowledgement,
  resolveProperty,
  indexModel,
  validate,
} from '@loom/core';
import type { Acceptance, Baseline, ChangeKind, Dimension, EvaluationInputs, EvidenceRecord, Finding, Model, Patch, Policy, PublishedContract, RecordRef, TaskSpec } from '@loom/core';
import { signRecord, verifyRecord } from '@loom/workspace';

/** The independent adoption fixtures; their format is stated in conventions.json there. */
export const FIXTURES_DIR = 'qualification/fixtures';

/** The evaluation date of every case, so expiry rules give the same answer on every run. */
export const FIXTURE_AS_OF = '2026-10-03';

/** The policy evidence key whose placeholder public key each run replaces with its own. */
const LISTED_KEY = 'test-ci-runner';

export interface ReadinessExpectation {
  task: TaskSpec;
  state?: 'ready' | 'blocked' | 'unresolved' | 'notEvaluated';
  mustIncludeReasons?: string[];
  mustExcludeReasons?: string[];
  workPackage?: {
    scopeIncludes?: string[];
    scopeEquals?: string[];
    exitEvidenceIncludes?: Array<{ claim: { kind: string; ref: string }; kinds: string[] }>;
    requiredContractsInclude?: RecordRef[];
  };
}

export interface CheckExpectation {
  id: string;
  result: string;
  inputs: { previousModel: string; rows: string; migration: string };
  afterwards: { rows: number; currency?: string; amounts?: string[] };
}

export interface Expectation {
  validation: 'valid' | 'invalid';
  qualification?: 'qualified' | 'unqualified' | 'unknown' | null;
  mustInclude?: string[];
  mustExclude?: string[];
  mustIncludeFindings?: Array<{ code: string; ref: RecordRef; concern?: string }>;
  readiness?: ReadinessExpectation[];
  changes?: { kinds?: ChangeKind[]; dimensionsAnyOf?: Dimension[]; affectedInclude?: RecordRef[] };
  invalidatedEvidence?: string[];
  acceptanceRequired?: boolean;
  stateAssertions?: Array<{ record: RecordRef; column?: string; absent: string[] }>;
  checks?: CheckExpectation[];
}

export interface FixtureCase {
  id: string;
  description: string;
  model: string;
  baseline?: string;
  patches?: string;
  policy?: string;
  acceptance?: string[];
  evidence?: string[];
  publishedBundles?: string[];
  expect: Expectation;
}

export interface EvidenceTrust {
  file: string;
  signWith: 'test-ci-runner' | 'unlisted-key' | 'none';
  expect: 'trusted' | 'untrusted';
}

export interface FixtureSet {
  id: string;
  /** Repository-relative directory of the set. */
  dir: string;
  cases: FixtureCase[];
  evidenceTrust: EvidenceTrust[];
}

/** Every fixture set, in name order, with its cases in authored order. */
export function readFixtureSets(root: string): FixtureSet[] {
  const base = join(root, ...FIXTURES_DIR.split('/'));
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(base, d.name, 'expected.json')))
    .map((d) => d.name)
    .sort()
    .map((id) => {
      const expected = JSON.parse(readFileSync(join(base, id, 'expected.json'), 'utf8')) as { cases: FixtureCase[]; evidenceTrust?: EvidenceTrust[] };
      return { id, dir: `${FIXTURES_DIR}/${id}`, cases: expected.cases, evidenceTrust: expected.evidenceTrust ?? [] };
    });
}

/** Ed25519 key pairs generated per run: one the case policies list, one they do not. */
export interface FixtureKeys {
  listed: { privateKey: string; spki: string };
  unlisted: { privateKey: string; spki: string };
}

export function fixtureKeys(): FixtureKeys {
  const pair = (): { privateKey: string; spki: string } => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
  };
  return { listed: pair(), unlisted: pair() };
}

/** Evidence of a case as it is stored, with the trust its signature establishes under the case policy. */
export interface PreparedEvidence {
  file: string;
  record: EvidenceRecord;
  trusted: boolean;
  reason?: string;
  /** The trust the set's evidenceTrust table states for the file. */
  expected: boolean;
}

/** Every input of one case, read and prepared exactly as the conventions describe. */
export interface PreparedCase {
  set: FixtureSet;
  case: FixtureCase;
  model: Model;
  /** The state the step's patches apply to: the previous step's model, or the baseline for the first step. */
  previous?: Model;
  baseline?: Model;
  policy?: Policy;
  acceptances: Acceptance[];
  /** The acceptance of the baseline itself: the supplied record that accepts its revision, or one this harness records because a baseline is accepted by definition. */
  baselineAcceptance?: Acceptance;
  evidence: PreparedEvidence[];
  bundles?: PublishedContract[];
  inputs: EvaluationInputs;
}

const readAt = <T>(root: string, rel: string): T => JSON.parse(readFileSync(join(root, ...rel.split('/')), 'utf8')) as T;

/** The policy with the placeholder public key of the listed evidence key replaced by this run's. */
function policyFor(policy: Policy, keys: FixtureKeys): Policy {
  return { ...policy, trust: { ...policy.trust, evidenceKeys: policy.trust.evidenceKeys.map((k) => (k.id === LISTED_KEY ? { ...k, spki: keys.listed.spki } : k)) } };
}

function signEvidence(record: EvidenceRecord, trust: EvidenceTrust | undefined, keys: FixtureKeys): EvidenceRecord {
  const { signature: _placeholder, ...unsigned } = record;
  if (!trust || trust.signWith === 'none') return record;
  if (trust.signWith === LISTED_KEY) return signRecord(unsigned, keys.listed.privateKey, LISTED_KEY) as EvidenceRecord;
  return signRecord(unsigned, keys.unlisted.privateKey, 'unlisted-key') as EvidenceRecord;
}

/** The baseline record the workspace adapter would hold for an accepted baseline model under the case policy. */
export function baselineRecord(model: Model, id: string, acceptance: string, policy: Policy | undefined): Baseline {
  const zero = (c: string): string => `sha256:${c.repeat(64)}`;
  return {
    baselineVersion: 1,
    id,
    model: { hash: modelRevision(model), formatVersion: model.version, snapshot: `baselines/${id}.model.json` },
    config: { hash: zero('1'), configVersion: 1 },
    policy: { ref: policy?.id ?? 'none', revision: policy?.revision ?? 1, hash: zero('2') },
    generator: { version: '1.0.0', contractDigest: CONTRACT_DIGEST },
    contracts: [],
    components: model.components.map((c) => ({ id: c.id, hash: zero('3'), frozen: policy?.freeze?.onAcceptance === true })),
    artifacts: [],
    sources: [],
    commitments: [],
    acceptance,
  };
}

export function prepareCase(root: string, set: FixtureSet, c: FixtureCase, keys: FixtureKeys, previous?: Model): PreparedCase {
  const at = (rel: string): string => `${set.dir}/${rel}`;
  const model = readAt<Model>(root, at(c.model));
  const policy = c.policy ? policyFor(readAt<Policy>(root, at(c.policy)), keys) : undefined;
  const acceptances = (c.acceptance ?? []).map((f) => readAt<Acceptance>(root, at(f)));
  const evidence: PreparedEvidence[] = (c.evidence ?? []).map((file) => {
    const trust = set.evidenceTrust.find((t) => t.file === file);
    const record = signEvidence(readAt<EvidenceRecord>(root, at(file)), trust, keys);
    const key = policy?.trust.evidenceKeys.find((k) => k.id === record.signature?.keyId);
    const trusted = key !== undefined && verifyRecord(record, key.spki);
    const out: PreparedEvidence = { file, record, trusted, expected: trust?.expect !== 'untrusted' };
    if (!trusted) out.reason = key ? 'the signature does not verify' : 'no evidence key of the policy signs this record';
    return out;
  });
  const prepared: PreparedCase = { set, case: c, model, acceptances, evidence, inputs: { asOf: FIXTURE_AS_OF } };
  const inputs = prepared.inputs;
  if (policy) {
    prepared.policy = policy;
    inputs.policy = policy;
  }
  // An absent list means no bundle was resolved, which is itself an evaluated input.
  prepared.bundles = (c.publishedBundles ?? []).map((f) => readAt<PublishedContract>(root, at(f)));
  inputs.publishedContracts = prepared.bundles;
  if (c.baseline) {
    const baseline = readAt<Model>(root, at(c.baseline));
    prepared.baseline = baseline;
    const revision = modelRevision(baseline);
    const accepted =
      acceptances.find((a) => a.subject.candidate === revision) ??
      ({
        acceptanceVersion: 1,
        id: `acc.${set.id}.baseline`,
        subject: { kind: 'baseline', baseline: `bl.${set.id}.baseline`, candidate: revision },
        decision: 'accepted',
        authority: 'fixture-harness',
        policy: { ref: policy?.id ?? 'none', revision: policy?.revision ?? 1 },
        scope: [],
        changeClasses: [],
        at: `${FIXTURE_AS_OF}T00:00:00Z`,
      } satisfies Acceptance);
    prepared.baselineAcceptance = accepted;
    inputs.baseline = { record: baselineRecord(baseline, accepted.subject.baseline ?? `bl.${set.id}.baseline`, accepted.id, policy), model: baseline, verified: true };
  }
  // A workspace always reads its acceptance and evidence stores, so a case that names none evaluates empty lists, never absent ones.
  const allAcceptances = prepared.baselineAcceptance && !acceptances.includes(prepared.baselineAcceptance) ? [prepared.baselineAcceptance, ...acceptances] : acceptances;
  inputs.acceptances = allAcceptances.map((record) => ({ record, trusted: true }));
  inputs.evidence = evidence.map((e) => (e.reason ? { record: e.record, trusted: e.trusted, reason: e.reason } : { record: e.record, trusted: e.trusted }));
  if (c.patches) prepared.previous = previous ?? prepared.baseline;
  return prepared;
}

/** What one evaluation path observed for a case, in the terms the expectations use. */
export interface CaseObservation {
  validation: 'valid' | 'invalid';
  /** The findings of validation alone, which decide the validation state. */
  validationFindings: Finding[];
  /** Every finding the path reported: validation, comparison and evidence. */
  findings: Finding[];
  /** The codes of the acceptance and qualification reasons. */
  reasonCodes: string[];
  qualification?: string;
  readiness: Array<{ state: string; reasons: string[]; workPackage?: { scope: string[]; exitEvidence: Array<{ claim: { kind: string; ref: string }; kinds: string[] }>; requiredContracts: Array<{ ref: RecordRef }> } }>;
  changes?: Array<{ kind: string; dimension: string; element: RecordRef }>;
  affected?: RecordRef[];
  invalidatedEvidence?: string[];
  acceptanceRequired?: boolean;
}

const sameRef = (a: RecordRef, b: RecordRef): boolean => a.kind === b.kind && a.id === b.id;
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** Every way the observation departs from the expectation; an empty list is agreement. */
export function compareWithExpectation(x: Expectation, o: CaseObservation): string[] {
  const out: string[] = [];
  const codes = new Set<string>([...o.findings.map((f) => f.code), ...o.reasonCodes]);
  if (o.validation !== x.validation) out.push(`validation is ${o.validation}, expected ${x.validation}: ${o.validationFindings.filter((f) => f.severity === 'error').map((f) => `${f.code} ${f.path}`).join('; ')}`);
  for (const code of x.mustInclude ?? []) if (!codes.has(code)) out.push(`${code} is not reported`);
  for (const code of x.mustExclude ?? []) if (codes.has(code)) out.push(`${code} is reported: ${o.findings.filter((f) => f.code === code).map((f) => f.path).join(', ')}`);
  for (const m of x.mustIncludeFindings ?? []) {
    const hit = o.findings.some((f) => f.code === m.code && (f.refs ?? []).some((r) => sameRef(r, m.ref)) && (m.concern === undefined || f.message.includes(`concern '${m.concern}'`)));
    if (!hit) out.push(`no ${m.code} for ${m.ref.kind} '${m.ref.id}'${m.concern ? ` and concern ${m.concern}` : ''}`);
  }
  (x.readiness ?? []).forEach((r, i) => {
    const got = o.readiness[i];
    const label = `readiness of ${r.task.class} for ${(r.task.components ?? r.task.requirements ?? []).join(', ')}`;
    if (!got) {
      out.push(`${label} was not evaluated`);
      return;
    }
    if (r.state !== undefined && got.state !== r.state) out.push(`${label} is ${got.state}, expected ${r.state}: ${got.reasons.join(', ')}`);
    for (const code of r.mustIncludeReasons ?? []) if (!got.reasons.includes(code)) out.push(`${label} lacks reason ${code}: ${got.reasons.join(', ')}`);
    for (const code of r.mustExcludeReasons ?? []) if (got.reasons.includes(code)) out.push(`${label} carries reason ${code}`);
    const wp = r.workPackage;
    if (!wp) return;
    if (!got.workPackage) {
      out.push(`${label} returned no work package`);
      return;
    }
    const scope = got.workPackage.scope;
    for (const s of wp.scopeIncludes ?? []) if (!scope.includes(s)) out.push(`${label}: work package scope lacks ${s}: ${scope.join(', ')}`);
    if (wp.scopeEquals && canonicalJson(sorted(wp.scopeEquals)) !== canonicalJson(sorted(scope))) out.push(`${label}: work package scope is ${scope.join(', ')}, expected exactly ${wp.scopeEquals.join(', ')}`);
    for (const e of wp.exitEvidenceIncludes ?? []) {
      const ob = got.workPackage.exitEvidence.find((x) => x.claim.kind === e.claim.kind && x.claim.ref === e.claim.ref);
      if (!ob) out.push(`${label}: no exit evidence for ${e.claim.kind} ${e.claim.ref}`);
      else if (canonicalJson(sorted(ob.kinds)) !== canonicalJson(sorted(e.kinds))) out.push(`${label}: exit evidence for ${e.claim.ref} needs ${ob.kinds.join(', ')}, expected ${e.kinds.join(', ')}`);
    }
    for (const rc of wp.requiredContractsInclude ?? []) if (!got.workPackage.requiredContracts.some((q) => sameRef(q.ref, rc))) out.push(`${label}: required contracts lack ${rc.kind} '${rc.id}'`);
  });
  if (x.changes) {
    if (!o.changes) out.push('no comparison with the baseline was made');
    else {
      for (const k of x.changes.kinds ?? []) if (!o.changes.some((c) => c.kind === k)) out.push(`no ${k} change: ${sorted(o.changes.map((c) => c.kind)).join(', ')}`);
      if (x.changes.dimensionsAnyOf && !x.changes.dimensionsAnyOf.some((d) => o.changes!.some((c) => c.dimension === d))) out.push(`no change in any of ${x.changes.dimensionsAnyOf.join(', ')}: ${sorted(o.changes.map((c) => c.dimension)).join(', ')}`);
      for (const a of x.changes.affectedInclude ?? []) if (!(o.affected ?? []).some((r) => sameRef(r, a))) out.push(`${a.kind} '${a.id}' is not named among the affected elements`);
    }
  }
  for (const id of x.invalidatedEvidence ?? []) if (!(o.invalidatedEvidence ?? []).includes(id)) out.push(`evidence ${id} is not invalidated: ${(o.invalidatedEvidence ?? []).join(', ')}`);
  if (x.acceptanceRequired !== undefined && o.acceptanceRequired !== x.acceptanceRequired) out.push(`acceptance required is ${String(o.acceptanceRequired)}, expected ${String(x.acceptanceRequired)}`);
  if (x.qualification != null && o.qualification !== x.qualification) out.push(`qualification is ${o.qualification ?? 'not evaluated'}, expected ${x.qualification}`);
  return out;
}

/** The core's evaluation of a prepared case: validation, comparison, evidence and every readiness task. */
export function observeCore(p: PreparedCase): CaseObservation {
  const { model, inputs } = p;
  const findings = validate(model, inputs);
  const all: Finding[] = [...findings];
  const reasonCodes: string[] = [];
  const o: CaseObservation = { validation: findings.some((f) => f.severity === 'error') ? 'invalid' : 'valid', validationFindings: findings, findings: all, reasonCodes, readiness: [] };
  // Acceptance is evaluated whenever acceptance records are read, with or without a baseline, as every adapter does.
  const compared = compareBaseline(model, inputs);
  all.push(...compared.findings);
  reasonCodes.push(...compared.acceptance.reasons.map((r) => r.code));
  if (inputs.baseline) {
    const changed = [...new Map(compared.changes.map((c) => [`${c.elementKind}:${c.element}`, { kind: c.elementKind, id: c.element } as RecordRef])).values()];
    o.changes = compared.changes.map((c) => ({ kind: c.kind, dimension: c.dimension, element: { kind: c.elementKind, id: c.element } }));
    o.affected = [...changed, ...compared.changes.flatMap((c) => c.consumers.map((a) => a.ref)), ...changeImpact(inputs.baseline.model, model, changed).map((a) => a.ref)];
    o.invalidatedEvidence = invalidatedBy(inputs.baseline.model, model, inputs).map((i) => i.evidence);
    o.acceptanceRequired = compared.acceptanceRequired;
  }
  const ev = evaluateEvidence(model, deriveObligations(model, undefined, inputs), inputs);
  all.push(...ev.findings);
  reasonCodes.push(...ev.qualification.reasons.map((r) => r.code));
  o.qualification = ev.qualification.state;
  for (const r of p.case.expect.readiness ?? []) {
    const got = checkReadiness(model, r.task, inputs);
    o.readiness.push({ state: got.state.state, reasons: got.state.reasons.map((q) => q.code), workPackage: got.data.workPackage });
  }
  return o;
}

/** Departures of the state the expectation requires to be absent. */
export function stateMismatches(p: PreparedCase): string[] {
  const out: string[] = [];
  const index = indexModel(p.model);
  for (const s of p.case.expect.stateAssertions ?? []) {
    let holder: Record<string, unknown> | undefined;
    if (s.record.kind === 'property') holder = resolveProperty(index, s.record.id)?.property as Record<string, unknown> | undefined;
    else if (s.record.kind === 'storage') {
      const table = p.model.storage.find((x) => x.id === s.record.id);
      holder = (s.column ? table?.columns.find((c) => c.name === s.column) : table) as Record<string, unknown> | undefined;
    }
    const where = `${s.record.kind} '${s.record.id}'${s.column ? ` column ${s.column}` : ''}`;
    if (!holder) out.push(`${where} does not exist`);
    else for (const member of s.absent) if (member in holder) out.push(`${where} holds ${member}, which no tool may infer`);
  }
  return out;
}

/**
 * Departures of the step from its stated result: the patches applied to the
 * previous state must give exactly the case model. A refused step is in
 * agreement only when every error it reports is one the case model itself
 * raises and its comparison equals the comparison of the two states.
 */
export function stepMismatches(root: string, p: PreparedCase): string[] {
  if (!p.case.patches || !p.previous) return p.case.patches ? ['the step has no previous state to apply to'] : [];
  const step = readAt<{ patches: Patch[] }>(root, `${p.set.dir}/${p.case.patches}`);
  const first = mutate(p.previous, step.patches);
  const acknowledge = sorted(first.changes.filter(needsAcknowledgement).map((c) => c.element));
  const r = first.model || acknowledge.length === 0 ? first : mutate(p.previous, step.patches, { acknowledgeBreaking: acknowledge });
  if (r.model) return canonicalJson(r.model) === canonicalJson(p.model) ? [] : [`the patches of ${p.case.patches} do not give ${p.case.model}`];
  const key = (f: Finding): string => `${f.code} ${f.path}`;
  const own = sorted(validate(p.model).filter((f) => f.severity === 'error').map(key));
  const refused = sorted(r.findings.filter((f) => f.severity === 'error').map(key));
  const out: string[] = [];
  if (canonicalJson(refused) !== canonicalJson(own)) out.push(`the step is refused with ${refused.join('; ')}, beyond the case model's own errors ${own.join('; ') || '(none)'}`);
  if (canonicalJson(r.changes) !== canonicalJson(diff(p.previous, p.model))) out.push(`the refused step reports other changes than ${p.case.model} differs by`);
  return out;
}

/** Evidence whose established trust differs from the trust the set's table states. */
export function trustMismatches(p: PreparedCase): string[] {
  return p.evidence.filter((e) => e.trusted !== e.expected).map((e) => `${e.file} is ${e.trusted ? 'trusted' : 'untrusted'}, expected ${e.expected ? 'trusted' : 'untrusted'}${e.reason ? ` (${e.reason})` : ''}`);
}

export interface CaseOutcome {
  /** '<set>/<case id>'. */
  id: string;
  prepared: PreparedCase;
  observation: CaseObservation;
  mismatches: string[];
}

/**
 * Every case of every set through the core, steps in authored order so each
 * one applies to the state the previous step produced. Native-tool checks are
 * not run here; they need the qualification adapter.
 */
export function evaluateFixtures(root: string, keys: FixtureKeys = fixtureKeys()): CaseOutcome[] {
  const out: CaseOutcome[] = [];
  for (const set of readFixtureSets(root)) {
    let previous: Model | undefined;
    for (const c of set.cases) {
      const prepared = prepareCase(root, set, c, keys, previous);
      if (c.patches) previous = prepared.model;
      const observation = observeCore(prepared);
      const mismatches = [...compareWithExpectation(c.expect, observation), ...stateMismatches(prepared), ...stepMismatches(root, prepared), ...trustMismatches(prepared)];
      out.push({ id: `${set.id}/${c.id}`, prepared, observation, mismatches });
    }
  }
  return out;
}
