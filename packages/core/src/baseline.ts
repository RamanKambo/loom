import type { AcceptanceState, Change, ChangeClass, Finding, FindingCode, Model, Reason, RecordRef } from './generated/types.js';
import { FINDING, FINDING_RULES } from './codes.js';
import { diff } from './diff.js';
import { unbumpedContracts } from './mutate.js';
import { modelRevision } from './hash.js';
import { indexModel } from './records.js';
import { effectiveGates, type EvaluationInputs } from './inputs.js';
import { acceptanceScopeCovers, acceptsBaseline, baselineAccepted, ownersOf, trustedAcceptances } from './scope.js';

const finding = (code: FindingCode, path: string, message: string, fix: string, refs: RecordRef[] = []): Finding => {
  const f: Finding = { code, severity: FINDING_RULES[code].severity, path, message, fix };
  if (refs.length) f.refs = refs;
  return f;
};

const APPROVAL_RANK = { 'pre-authorized': 0, 'acceptance-required': 1, prohibited: 2 } as const;
export type Approval = keyof typeof APPROVAL_RANK;

const matches = (cls: ChangeClass, c: Change): boolean => {
  const m = cls.match;
  return (!m.kinds || m.kinds.includes(c.kind)) && (!m.dimensions || m.dimensions.includes(c.dimension)) && (!m.elementKinds || m.elementKinds.includes(c.elementKind)) && (!m.rules || m.rules.includes(c.rule));
};

/**
 * The approval a change needs under policy: the most restrictive matching
 * change class wins, and a change no class matches needs acceptance. Without
 * a policy every semantic change needs acceptance.
 */
export function classifyChange(c: Change, inputs: EvaluationInputs): { approval: Approval; classes: string[] } {
  const classes = (inputs.policy?.changeClasses ?? []).filter((cls) => matches(cls, c));
  if (!classes.length) return { approval: 'acceptance-required', classes: [] };
  const approval = classes.map((x) => x.approval).sort((a, b) => APPROVAL_RANK[b] - APPROVAL_RANK[a])[0]!;
  return { approval, classes: classes.map((x) => x.id) };
}

export interface BaselineComparison {
  changes: Change[];
  findings: Finding[];
  acceptance: AcceptanceState;
  /** Change classes that matched any change. */
  changeClasses: string[];
  acceptanceRequired: boolean;
}

const reason = (f: Finding): Reason => ({ code: f.code, message: f.message, refs: f.refs ?? [] });

/** Findings about the gates and the workflow state, independent of any change. */
export function gateFindings(model: Model, inputs: EvaluationInputs): Finding[] {
  const out: Finding[] = [];
  for (const w of effectiveGates(inputs).weakened) {
    out.push(finding(FINDING.POLICY_WEAKENED, 'loom.json/gates', `the workspace configuration ${w}; the policy applies`, 'remove the weaker gate from loom.json, or change the trusted policy through its own acceptance'));
  }
  if (inputs.state?.sealed && derivedSeal(model, inputs) === false) {
    out.push(finding(FINDING.SEALED_FLAG_UNBACKED, 'state.json/sealed', 'state.json says sealed, but no trusted acceptance covers the current revision', 'treat the workspace as unsealed; obtain acceptance of the current revision under the configured policy'));
  }
  return out;
}

/** True when a trusted acceptance covers exactly the current revision, whatever state.json says. */
export function derivedSeal(model: Model, inputs: EvaluationInputs): boolean {
  const revision = modelRevision(model);
  if (trustedAcceptances(inputs).some((a) => a.subject.candidate === revision && a.scope.length === 0)) return true;
  return baselineAccepted(inputs) && inputs.baseline !== undefined && modelRevision(inputs.baseline.model) === revision;
}

/**
 * Compare a candidate with the trusted accepted baseline. The result depends
 * only on the two models and the trusted records, never on how the candidate
 * was produced, so a patch, an import and a hand edit are judged alike. An
 * acknowledgement of a breaking change is never acceptance.
 */
export function compareBaseline(candidate: Model, inputs: EvaluationInputs = {}): BaselineComparison {
  const findings: Finding[] = [...gateFindings(candidate, inputs)];
  const base = inputs.baseline;
  if (!base) {
    findings.push(finding(FINDING.BASELINE_MISSING, '(baseline)', 'no accepted baseline was supplied; acceptance and compatibility with an accepted state are not established', 'select the accepted baseline at the trusted ref'));
    return { changes: [], findings, acceptance: { state: 'notEvaluated', reasons: findings.map(reason) }, changeClasses: [], acceptanceRequired: false };
  }
  if (!base.verified) findings.push(finding(FINDING.BASELINE_UNTRUSTED, `baselines/${base.record.id}`, `baseline '${base.record.id}' was not read from the trusted ref`, 'read the baseline from the trusted ref named by the policy'));
  if (base.record.model.hash !== modelRevision(base.model)) {
    findings.push(finding(FINDING.BASELINE_HASH_MISMATCH, `baselines/${base.record.id}/model/hash`, `baseline '${base.record.id}' records model hash ${base.record.model.hash}, but its snapshot hashes to ${modelRevision(base.model)}`, 'restore the accepted snapshot, or record a new accepted baseline'));
  }
  const acceptanceRecord = (inputs.acceptances ?? []).find((a) => a.record.id === base.record.acceptance);
  if (!acceptanceRecord) findings.push(finding(FINDING.ACCEPTANCE_MISSING, `baselines/${base.record.id}/acceptance`, `acceptance '${base.record.acceptance}' of baseline '${base.record.id}' was not supplied`, 'supply the acceptance record named by the baseline'));
  else if (!acceptanceRecord.trusted) findings.push(finding(FINDING.ACCEPTANCE_UNTRUSTED, `acceptance/${acceptanceRecord.record.id}`, `acceptance '${acceptanceRecord.record.id}' is not present at the trusted ref and not signed by a listed key`, 'obtain the acceptance through the configured authority'));
  else if (!acceptsBaseline(acceptanceRecord.record, base.record)) {
    findings.push(finding(FINDING.ACCEPTANCE_MISSING, `baselines/${base.record.id}/acceptance`, `acceptance '${acceptanceRecord.record.id}' accepted revision ${acceptanceRecord.record.subject.candidate ?? '(none)'}, not revision ${base.record.model.hash} that baseline '${base.record.id}' pins`, 'accept the revision the baseline pins, or record a baseline of the revision that was accepted'));
  }

  const index = indexModel(candidate);
  const baseIndex = indexModel(base.model);
  const revision = modelRevision(candidate);
  const changes = diff(base.model, candidate);
  const covering = trustedAcceptances(inputs).filter((a) => a.subject.candidate === revision);
  const covered = (ref: RecordRef): boolean => covering.some((a) => acceptanceScopeCovers(index, a, ref) || acceptanceScopeCovers(baseIndex, a, ref));
  const frozen = new Set(base.record.components.filter((c) => c.frozen || inputs.policy?.freeze?.onAcceptance === true).map((c) => c.id));
  const classes = new Set<string>();
  let acceptanceRequired = false;
  const unaccepted = new Map<string, { ref: RecordRef; rules: string[] }>();
  const prohibited = new Map<string, { ref: RecordRef; rules: string[] }>();
  const frozenHits = new Map<string, { ref: RecordRef; owners: string[] }>();
  for (const c of changes) {
    if (c.kind === 'nonSemantic') continue;
    const ref: RecordRef = { kind: c.elementKind, id: c.element };
    const key = `${ref.kind}:${ref.id}`;
    const { approval, classes: matched } = classifyChange(c, inputs);
    for (const m of matched) classes.add(m);
    if (approval === 'prohibited') (prohibited.get(key) ?? prohibited.set(key, { ref, rules: [] }).get(key)!).rules.push(c.rule);
    else if (approval === 'acceptance-required') {
      acceptanceRequired = true;
      if (!covered(ref)) (unaccepted.get(key) ?? unaccepted.set(key, { ref, rules: [] }).get(key)!).rules.push(c.rule);
    }
    const owners = [...new Set([...ownersOf(index, ref), ...ownersOf(baseIndex, ref)])].filter((o) => frozen.has(o));
    if (owners.length && !covered(ref)) frozenHits.set(key, { ref, owners });
  }
  for (const { ref, rules } of prohibited.values()) {
    findings.push(finding(FINDING.CHANGE_PROHIBITED, `${ref.kind}/${ref.id}`, `${ref.kind} '${ref.id}' changes in a way the policy prohibits (${[...new Set(rules)].join(', ')})`, `revert the change to ${ref.kind} '${ref.id}'; a prohibited class cannot be accepted or acknowledged`, [ref]));
  }
  for (const { ref, rules } of unaccepted.values()) {
    findings.push(finding(FINDING.CHANGE_UNACCEPTED, `${ref.kind}/${ref.id}`, `${ref.kind} '${ref.id}' changed against the accepted baseline (${[...new Set(rules)].join(', ')}) and no trusted acceptance of revision ${revision} covers it`, `obtain acceptance of the change to ${ref.kind} '${ref.id}' under the policy, or revert it`, [ref]));
  }
  for (const { ref, owners } of frozenHits.values()) {
    findings.push(finding(FINDING.FROZEN_COMPONENT_CHANGED, `${ref.kind}/${ref.id}`, `${ref.kind} '${ref.id}' belongs to frozen component(s) ${owners.join(', ')} and changed without an accepted delta`, `route the change to ${ref.kind} '${ref.id}' through an accepted delta, or limit the fix to code that preserves the accepted contract`, [ref]));
  }
  for (const u of unbumpedContracts(base.model, candidate, changes)) {
    findings.push(finding(FINDING.BREAKING_CHANGE_WITHOUT_VERSION_BUMP, `${u.collection}/${u.ref.id}/version`, `${u.ref.kind} '${u.ref.id}' has a breaking change against baseline '${base.record.id}' without a version bump (${u.from} -> ${u.to}): ${u.reasons.join('; ')}`, `raise ${u.ref.kind} '${u.ref.id}' version above ${u.from}, or revert the breaking change`, [u.ref]));
  }
  findings.push(...retirementFindings(base.model, candidate, inputs));

  const blocking = findings.filter((f) => f.code === 'CHANGE_UNACCEPTED' || f.code === 'CHANGE_PROHIBITED' || f.code === 'FROZEN_COMPONENT_CHANGED' || f.code === 'BASELINE_UNTRUSTED' || f.code === 'BASELINE_HASH_MISMATCH' || f.code === 'VERSION_RETIREMENT_BLOCKED');
  const baseOk = baselineAccepted(inputs);
  const acceptance: AcceptanceState = blocking.length || (!baseOk && !covering.length)
    ? { state: 'unaccepted', baseline: base.record.id, reasons: (blocking.length ? blocking : findings.filter((f) => f.code === 'ACCEPTANCE_MISSING' || f.code === 'ACCEPTANCE_UNTRUSTED')).map(reason) }
    : { state: 'accepted', baseline: base.record.id, reasons: [] };
  if (acceptance.state === 'unaccepted' && acceptance.reasons.length === 0) acceptance.reasons.push({ code: FINDING.ACCEPTANCE_MISSING, message: `No trusted acceptance covers baseline '${base.record.id}' or revision ${revision}.`, refs: [] });
  return { changes, findings, acceptance, changeClasses: [...classes].sort(), acceptanceRequired };
}

/**
 * A supported version present in the baseline and gone from the candidate
 * while an active, required consumer still binds it, unless its retirement
 * condition is an accepted decision.
 */
export function retirementFindings(before: Model, after: Model, inputs: EvaluationInputs): Finding[] {
  const out: Finding[] = [];
  const index = indexModel(after);
  const trusted = trustedAcceptances(inputs);
  const decisionAccepted = (id: string): boolean => {
    const d = after.decisions.find((x) => x.id === id);
    return d?.status === 'accepted' && trusted.some((a) => acceptanceScopeCovers(index, a, { kind: 'decision', id }));
  };
  for (const kind of ['type', 'operation', 'routine'] as const) {
    const list = (m: Model) => (kind === 'type' ? m.types : kind === 'operation' ? m.operations : m.routines) as Array<{ id: string; version: number; supported?: Array<{ version: number; retirement: { condition: string; decision?: string } }> }>;
    for (const was of list(before)) {
      const now = list(after).find((x) => x.id === was.id);
      for (const s of was.supported ?? []) {
        if (now && (now.version === s.version || (now.supported ?? []).some((x) => x.version === s.version))) continue;
        const binders = after.consumerBindings.filter((b) => b.contract.kind === kind && b.contract.id === was.id && b.version === s.version && b.required && b.status === 'active');
        if (!binders.length) continue;
        if (s.retirement.condition === 'decision' && s.retirement.decision && decisionAccepted(s.retirement.decision)) continue;
        out.push(finding(FINDING.VERSION_RETIREMENT_BLOCKED, `${kind}s/${was.id}/supported/${s.version}`, `version ${s.version} of ${kind} '${was.id}' is retired while ${binders.map((b) => `'${b.id}'`).join(', ')} still bind it`, `keep version ${s.version} supported until the consumers migrate, or retire it under an accepted decision`, [{ kind, id: was.id }, ...binders.map((b) => ({ kind: 'consumerBinding' as const, id: b.id }))]));
      }
    }
  }
  return out;
}

