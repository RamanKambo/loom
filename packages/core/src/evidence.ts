import type {
  EvidenceInvalidation,
  EvidenceKind,
  EvidenceObligation,
  EvidenceRecord,
  Finding,
  FindingCode,
  Model,
  QualificationState,
  Reason,
  RecordRef,
} from './generated/types.js';
import { PROFILES } from './generated/contracts.js';
import { FINDING, FINDING_RULES } from './codes.js';
import { indexModel, type ModelIndex } from './records.js';
import { recordHash } from './hash.js';
import { effectiveGates, type EvaluationInputs } from './inputs.js';
import { ownersOf, parseRefKey, resolveScope, type Scope } from './scope.js';

type Status = EvidenceObligation['status'];
type EvidenceInput = NonNullable<EvaluationInputs['evidence']>[number];

/** Evidence kinds that need the real boundary: a substitute never satisfies them. */
const REAL_BOUNDARY: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['integration', 'e2e']);
/** Kinds an engine self-test can never satisfy for an adopting system. */
const ADOPTING_ONLY: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['integration', 'e2e', 'operational']);

/** Evidence of Loom's own self-test, which qualifies the engine and never an adopting system. */
export const isEngineSelfTest = (e: EvidenceRecord): boolean => e.environment.kind === 'process' && e.check.id.startsWith('loom.');

const VERIFICATION_KIND: Record<string, EvidenceKind> = { scenario: 'behavior', check: 'conformance', review: 'review' };

/** The evidence kind a check produces; a policy check the profiles do not define is matched by id, whatever kind it records. */
const checkEvidenceKind = (id: string): EvidenceKind => PROFILES.flatMap((p) => p.checks).find((c) => c.id === id)?.evidence ?? 'conformance';

/**
 * Every evidence obligation of a scope: one per required criterion, retained
 * behavior and migration, the release evidence kinds of the effective gates
 * per component, and each check the trusted policy requires.
 */
export function deriveObligations(model: Model, scope: Scope | undefined, inputs: EvaluationInputs = {}): EvidenceObligation[] {
  const index = indexModel(model);
  const s = scope ?? resolveScope(index);
  const inScope = (r: RecordRef): boolean => s.keys.has(`${r.kind}:${r.id}`);
  const out: EvidenceObligation[] = [];
  for (const req of model.requirements) {
    if (req.status !== 'active' || !inScope({ kind: 'requirement', id: req.id })) continue;
    for (const c of req.criteria) {
      if (!c.required) continue;
      const kinds = c.evidence.length ? [...c.evidence] : [VERIFICATION_KIND[c.verification] ?? 'behavior'];
      out.push({ id: `criterion:${c.id}`, claim: { kind: 'criterion', ref: c.id }, kinds, required: true, status: 'absent' });
    }
  }
  for (const rb of model.retainedBehaviors) {
    if (rb.status !== 'retained' || !inScope({ kind: 'retainedBehavior', id: rb.id })) continue;
    out.push({ id: `retainedBehavior:${rb.id}`, claim: { kind: 'retainedBehavior', ref: rb.id }, kinds: [...rb.evidence], required: true, status: 'absent' });
  }
  for (const mig of model.migrations) {
    if (!inScope({ kind: 'migration', id: mig.id })) continue;
    out.push({ id: `migration:${mig.id}`, claim: { kind: 'migration', ref: mig.id }, kinds: [...mig.evidence], required: true, status: 'absent' });
  }
  const gates = effectiveGates(inputs);
  const external = new Set(model.components.filter((c) => c.kind === 'external').map((c) => c.id));
  for (const component of s.components) {
    if (external.has(component)) continue;
    for (const kind of gates.releaseEvidence) {
      out.push({ id: `release:${component}:${kind}`, claim: { kind: 'release', ref: component }, kinds: [kind], required: true, status: 'absent' });
    }
  }
  for (const id of inputs.policy?.qualification.required ?? []) {
    out.push({ id: `check:${id}`, claim: { kind: 'check', ref: id }, kinds: [checkEvidenceKind(id)], required: true, status: 'absent' });
  }
  for (const id of inputs.policy?.qualification.optional ?? []) {
    out.push({ id: `check:${id}`, claim: { kind: 'check', ref: id }, kinds: [checkEvidenceKind(id)], required: false, status: 'absent' });
  }
  return out;
}

/** The inputs of an evidence record whose current hash differs from the recorded one. */
export function changedInputs(model: Model, record: EvidenceRecord, inputs: EvaluationInputs = {}, index: ModelIndex = indexModel(model)): string[] {
  const changed: string[] = [];
  for (const i of record.inputs) {
    if (i.ref.startsWith('artifact:')) {
      const now = inputs.artifacts?.[i.ref.slice('artifact:'.length)];
      if (now !== undefined && now !== i.hash) changed.push(i.ref);
      continue;
    }
    const ref = parseRefKey(i.ref, index);
    if (!ref) continue;
    const now = recordHash(model, ref);
    if (now !== i.hash) changed.push(i.ref);
  }
  return changed;
}

/** True when evidence speaks to an obligation: it claims the obligation, or for release evidence, a record of the component. */
function addresses(index: ModelIndex, e: EvidenceRecord, o: EvidenceObligation): boolean {
  if (e.claims.some((c) => c.kind === o.claim.kind && c.ref === o.claim.ref)) return true;
  if (o.claim.kind === 'check') return e.check.id === o.claim.ref;
  if (o.claim.kind !== 'release') return false;
  return e.claims.some((c) => {
    if (c.kind === 'release') return c.ref === o.claim.ref;
    const ref: RecordRef | null = c.kind === 'criterion' ? { kind: 'criterion', id: c.ref } : c.kind === 'retainedBehavior' ? { kind: 'retainedBehavior', id: c.ref } : c.kind === 'migration' ? { kind: 'migration', id: c.ref } : parseRefKey(c.ref, index);
    return ref !== null && ownersOf(index, ref).includes(o.claim.ref);
  });
}

type Verdict = Status | 'substitute';

interface Judged {
  evidence: EvidenceInput;
  verdict: Verdict;
  changed: string[];
}

function judge(model: Model, index: ModelIndex, ev: EvidenceInput, kind: EvidenceKind, inputs: EvaluationInputs): Judged {
  const e = ev.record;
  const changed = changedInputs(model, e, inputs, index);
  let verdict: Verdict;
  if (!ev.trusted) verdict = 'untrusted';
  else if (changed.length) verdict = 'stale';
  else if (e.result === 'NOT_APPLICABLE') verdict = e.reason?.trim() ? 'not-applicable' : 'unknown';
  else if (e.result === 'FAIL') verdict = 'failing';
  else if (e.result === 'UNKNOWN') verdict = 'unknown';
  else if (REAL_BOUNDARY.has(kind) && e.boundaries.some((b) => b.actual === 'substitute')) verdict = 'substitute';
  else verdict = 'passing';
  return { evidence: ev, verdict, changed };
}

const BEST: readonly Verdict[] = ['passing', 'not-applicable', 'failing', 'stale', 'untrusted', 'unknown', 'substitute', 'absent'];
const WORST: readonly Status[] = ['failing', 'stale', 'untrusted', 'unknown', 'absent', 'not-applicable', 'passing'];

export interface EvidenceEvaluation {
  obligations: EvidenceObligation[];
  qualification: QualificationState;
  invalidated: EvidenceInvalidation[];
  /** Evidence whose inputs are unchanged, kept with that reason. */
  retained: Array<{ evidence: string; reason: string }>;
  findings: Finding[];
}

const STATUS_CODE: Partial<Record<Status, FindingCode>> = {
  absent: FINDING.EVIDENCE_MISSING,
  failing: FINDING.EVIDENCE_FAILED,
  unknown: FINDING.EVIDENCE_UNKNOWN,
  stale: FINDING.EVIDENCE_STALE,
  untrusted: FINDING.EVIDENCE_UNTRUSTED,
};

const finding = (code: FindingCode, path: string, message: string, fix: string, refs: RecordRef[] = []): Finding => {
  const f: Finding = { code, severity: FINDING_RULES[code].severity, path, message, fix };
  if (refs.length) f.refs = refs;
  return f;
};

function claimRef(index: ModelIndex, o: EvidenceObligation): RecordRef[] {
  const kind = o.claim.kind === 'release' ? 'component' : o.claim.kind === 'check' ? null : o.claim.kind;
  if (!kind) return [];
  return index.byKind.get(kind)?.has(o.claim.ref) || index.criteria.has(o.claim.ref) ? [{ kind, id: o.claim.ref }] : [];
}

/**
 * Evaluate evidence against obligations. Absent, failing, unknown, stale,
 * untrusted and passing evidence stay distinct; a required obligation that is
 * not passing never yields 'qualified'. Without evidence inputs qualification
 * is not evaluated.
 */
export function evaluateEvidence(model: Model, obligations: readonly EvidenceObligation[], inputs: EvaluationInputs = {}): EvidenceEvaluation {
  const index = indexModel(model);
  const evidence = inputs.evidence ?? [];
  const findings: Finding[] = [];
  const result: EvidenceObligation[] = [];
  const used: EvidenceRecord[] = [];
  let substituted = false;
  for (const o of obligations) {
    const perKind: Status[] = [];
    const ids = new Set<string>();
    let substitutedHere = false;
    for (const kind of o.kinds) {
      const judged = evidence
        .filter((ev) => (o.claim.kind === 'check' || ev.record.kind === kind) && addresses(index, ev.record, o))
        .filter((ev) => !(ADOPTING_ONLY.has(ev.record.kind) && isEngineSelfTest(ev.record)))
        .map((ev) => judge(model, index, ev, ev.record.kind, inputs));
      for (const j of judged) ids.add(j.evidence.record.id);
      const best = judged.length ? judged.map((j) => j.verdict).sort((a, b) => BEST.indexOf(a) - BEST.indexOf(b))[0]! : 'absent';
      if (best === 'passing') used.push(...judged.filter((j) => j.verdict === 'passing').map((j) => j.evidence.record));
      if (best === 'substitute') {
        substituted = true;
        substitutedHere = true;
        findings.push(finding(FINDING.EVIDENCE_SUBSTITUTE_NOT_PERMITTED, `evidence/${o.id}`, `the only ${kind} evidence for ${o.id} ran against a substitute (${judged.filter((j) => j.verdict === 'substitute').map((j) => j.evidence.record.id).join(', ')}); ${kind} needs the real boundary`, `run the ${kind} check against the real boundary`, claimRef(index, o)));
        perKind.push('absent');
        continue;
      }
      if (best === 'unknown' && judged.some((j) => j.evidence.record.result === 'NOT_APPLICABLE')) {
        findings.push(finding(FINDING.EVIDENCE_NOT_APPLICABLE_UNJUSTIFIED, `evidence/${o.id}`, `NOT_APPLICABLE ${kind} evidence for ${o.id} carries no justification`, 'record why the check does not apply, or run it', claimRef(index, o)));
      }
      perKind.push(best as Status);
    }
    const status = perKind.length ? perKind.sort((a, b) => WORST.indexOf(a) - WORST.indexOf(b))[0]! : 'absent';
    const entry: EvidenceObligation = { ...o, status };
    if (ids.size) entry.evidence = [...ids].sort();
    result.push(entry);
    const code = STATUS_CODE[status];
    if (code && o.required && !(code === FINDING.EVIDENCE_MISSING && substitutedHere)) {
      findings.push(finding(code, `evidence/${o.id}`, `required obligation ${o.id} (${o.kinds.join(', ')}) is ${status}`, status === 'absent' ? `run the ${o.kinds.join(' and ')} check(s) for ${o.claim.kind} '${o.claim.ref}' and record trusted evidence` : `re-run the check for ${o.claim.kind} '${o.claim.ref}' at the current revision`, claimRef(index, o)));
    }
  }

  const invalidated: EvidenceInvalidation[] = [];
  const retained: Array<{ evidence: string; reason: string }> = [];
  for (const ev of evidence) {
    const changed = changedInputs(model, ev.record, inputs, index);
    if (changed.length) invalidated.push({ evidence: ev.record.id, reason: `input(s) ${changed.join(', ')} changed since the run`, inputs: changed });
    else retained.push({ evidence: ev.record.id, reason: 'every recorded input is unchanged' });
  }

  const inconsistent = revisionSetProblems(used);
  for (const p of inconsistent) findings.push(finding(FINDING.EVIDENCE_REVISION_SET_INCONSISTENT, 'evidence', p, 'qualify every component from one coordinated revision set'));

  const reasons: Reason[] = findings.map((f) => ({ code: f.code, message: f.message, refs: f.refs ?? [] }));
  let qualification: QualificationState;
  if (inputs.evidence === undefined) {
    qualification = { state: 'notEvaluated', reasons: [{ code: FINDING.QUALIFICATION_NOT_ESTABLISHED, message: 'No evidence was supplied.', refs: [] }] };
  } else {
    const required = result.filter((o) => o.required);
    const unmet = required.filter((o) => o.status !== 'passing' && o.status !== 'not-applicable');
    const hard = unmet.some((o) => o.status === 'failing' || o.status === 'stale' || o.status === 'untrusted') || substituted || inconsistent.length > 0;
    qualification = unmet.length === 0 && inconsistent.length === 0 ? { state: 'qualified', reasons: [] } : { state: hard ? 'unqualified' : 'unknown', reasons };
  }
  return { obligations: result, qualification, invalidated, retained, findings };
}

/** Disagreements inside the evidence a qualification rests on. */
function revisionSetProblems(used: readonly EvidenceRecord[]): string[] {
  const problems: string[] = [];
  const revisions = new Map<string, Set<string>>();
  const artifacts = new Map<string, Set<string>>();
  for (const e of used) {
    for (const s of e.sources) (revisions.get(s.repository) ?? revisions.set(s.repository, new Set()).get(s.repository)!).add(s.revision);
    for (const a of e.artifacts) {
      const key = a.instance ?? a.path;
      if (key) (artifacts.get(key) ?? artifacts.set(key, new Set()).get(key)!).add(a.hash);
    }
  }
  for (const [repo, set] of revisions) if (set.size > 1) problems.push(`repository '${repo}' was qualified at ${set.size} revisions: ${[...set].sort().join(', ')}`);
  for (const [artifact, set] of artifacts) if (set.size > 1) problems.push(`artifact '${artifact}' was qualified at ${set.size} different hashes`);
  return problems;
}

/**
 * Evidence a change invalidates: every record whose recorded inputs differ
 * between the base and the candidate model.
 */
export function invalidatedBy(before: Model, after: Model, inputs: EvaluationInputs = {}): EvidenceInvalidation[] {
  const bi = indexModel(before);
  const ai = indexModel(after);
  const out: EvidenceInvalidation[] = [];
  for (const ev of inputs.evidence ?? []) {
    const was = new Set(changedInputs(before, ev.record, inputs, bi));
    const now = changedInputs(after, ev.record, inputs, ai).filter((r) => !was.has(r));
    if (now.length) out.push({ evidence: ev.record.id, reason: `the change alters input(s) ${now.join(', ')}`, inputs: now });
  }
  return out;
}
