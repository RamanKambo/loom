import type {
  AppliedSubstitute,
  DesignOrder,
  EvidenceKind,
  EvidenceObligation,
  Finding,
  Maturity,
  Model,
  OrderedItem,
  Prerequisite,
  ReadinessData,
  ReadinessState,
  Reason,
  RecordRef,
  SubstituteKind,
  TaskClass,
  TaskSpec,
  WorkPackage,
} from './generated/types.js';
import { FINDING } from './codes.js';
import { validate } from './validate.js';
import { indexModel, findRecord, type ModelIndex } from './records.js';
import { DependencyGraph } from './graph.js';
import { canonicalHash, recordHash } from './hash.js';
import { effectiveGates, type EvaluationInputs } from './inputs.js';
import { CONTRACT_KINDS, makeAcceptanceCheck, ownersOf, refKey, resolveScope, type Scope } from './scope.js';
import { changedInputs, deriveObligations, evaluateEvidence } from './evidence.js';
import { bundleFor } from './rules/versions.js';
import { collectReferences, splitQualified } from './refs.js';
import { findCycles } from './rules/structure.js';
import { derivedSeal } from './baseline.js';

const MATURITY_RANK: Record<Maturity, number> = { proposed: 0, accepted: 1, implemented: 2, qualified: 3 };
const TASK_CLASSES: readonly TaskClass[] = ['discovery', 'specification', 'implementation', 'integration', 'release', 'operations'];
const IMPLEMENTATION_EVIDENCE: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['build', 'unit', 'conformance', 'behavior', 'integration', 'e2e']);
const LATE_CLASSES: ReadonlySet<TaskClass> = new Set<TaskClass>(['implementation', 'integration', 'release', 'operations']);
/** Model-level prerequisites name the system profile, the one record every model has a slot for. */
const SYSTEM: RecordRef = { kind: 'systemProfile', id: 'system' };

interface Eval {
  model: Model;
  index: ModelIndex;
  graph: DependencyGraph;
  scope: Scope;
  inputs: EvaluationInputs;
  task: TaskSpec;
  errors: Finding[];
  maturity: (ref: RecordRef) => Maturity | undefined;
  acceptanceSupplied: boolean;
}

interface ClassResult {
  blocking: Prerequisite[];
  missing: Prerequisite[];
  substitutes: AppliedSubstitute[];
}

const prereq = (ref: RecordRef, requirement: Prerequisite['requirement'], code: Prerequisite['code'], message: string, extra: Partial<Prerequisite> = {}): Prerequisite => ({ ref, requirement, code, message, ...extra });

/**
 * Contract maturity of a record, from supplied records only: proposed when it
 * is in the model, accepted when trusted acceptance covers its current
 * content, implemented when trusted current evidence exercised it, qualified
 * when every required obligation of its components passes. A component's
 * maturity is the lowest of the contracts it owns.
 */
export function makeMaturity(model: Model, inputs: EvaluationInputs): (ref: RecordRef) => Maturity | undefined {
  const index = indexModel(model);
  const accepted = makeAcceptanceCheck(model, inputs);
  const evidence = (inputs.evidence ?? []).filter((e) => e.trusted && e.record.result === 'PASS' && IMPLEMENTATION_EVIDENCE.has(e.record.kind) && changedInputs(model, e.record, inputs, index).length === 0);
  const qualifiedComponents = new Map<string, boolean>();
  const componentQualified = (c: string): boolean => {
    let q = qualifiedComponents.get(c);
    if (q === undefined) {
      const scope = resolveScope(index, { mode: 'component', components: [c] });
      q = inputs.evidence !== undefined && evaluateEvidence(model, deriveObligations(model, scope, inputs), inputs).qualification.state === 'qualified';
      qualifiedComponents.set(c, q);
    }
    return q;
  };
  const exercised = (ref: RecordRef): boolean => {
    const key = refKey(ref);
    return evidence.some((e) => e.record.claims.some((c) => c.kind === 'contract' && c.ref === key) || e.record.inputs.some((i) => i.ref === key));
  };
  const recordMaturity = (ref: RecordRef): Maturity | undefined => {
    if (findRecord(index, ref) === undefined) return undefined;
    if (!accepted(ref)) return 'proposed';
    if (!exercised(ref)) return 'accepted';
    const owners = ownersOf(index, ref);
    return owners.length && owners.every(componentQualified) ? 'qualified' : 'implemented';
  };
  return (ref) => {
    if (ref.kind !== 'component') return recordMaturity(ref);
    if (findRecord(index, ref) === undefined) return undefined;
    const owned = resolveScope(index, { mode: 'component', components: [ref.id] }).records.filter((r) => CONTRACT_KINDS.has(r.kind));
    if (!owned.length) return accepted(ref) ? 'accepted' : 'proposed';
    return owned.map(recordMaturity).reduce<Maturity>((low, m) => (m && MATURITY_RANK[m] < MATURITY_RANK[low] ? m : low), 'qualified');
  };
}

const atLeast = (m: Maturity | undefined, required: Maturity): boolean => m !== undefined && MATURITY_RANK[m] >= MATURITY_RANK[required];

function inScope(ev: Eval, ref: RecordRef): boolean {
  return ev.scope.keys.has(refKey(ref)) || ownersOf(ev.index, ref).some((c) => ev.scope.components.includes(c));
}

function resolveId(index: ModelIndex, id: string): RecordRef | null {
  const kinds = index.kindsOfId.get(id);
  return kinds && kinds.length ? { kind: kinds[0]!, id } : null;
}

function blockingUnknowns(ev: Eval, cls: TaskClass, out: ClassResult): void {
  for (const u of ev.model.unknowns) {
    if (u.status !== 'open' || !u.blocks.includes(cls)) continue;
    const touches = u.affects.length === 0 || u.affects.some((a) => inScope(ev, a)) || (u.concerns ?? []).some((c) => inScope(ev, c.record));
    if (touches) out.blocking.push(prereq({ kind: 'unknown', id: u.id }, 'unknown', FINDING.READINESS_BLOCKED_BY_UNKNOWN, `open unknown '${u.id}' blocks ${cls}: ${u.question}`));
  }
}

function blockingAssumptions(ev: Eval, cls: TaskClass, out: ClassResult): void {
  if (cls === 'discovery' || cls === 'specification') return;
  for (const a of ev.model.assumptions) {
    const blocks = a.status === 'invalidated' || (a.status === 'open' && cls === 'release');
    if (!blocks) continue;
    const touches = a.affects.some((r) => inScope(ev, r) || (r.kind === 'decision' && (ev.model.decisions.find((d) => d.id === r.id)?.affects ?? []).some((x) => inScope(ev, x))));
    if (touches) out.blocking.push(prereq({ kind: 'assumption', id: a.id }, 'assumption', FINDING.READINESS_BLOCKED_BY_ASSUMPTION, `${a.status} assumption '${a.id}' blocks ${cls}: ${a.claim}`));
  }
}

/**
 * Contract records of the scope and every contract outside it the scope
 * depends on, transitively through other contracts: an operation invoking a
 * routine also needs the types the routine binds.
 */
function contractsOf(ev: Eval): { own: RecordRef[]; dependencies: RecordRef[] } {
  const own = ev.scope.records.filter((r) => CONTRACT_KINDS.has(r.kind));
  const deps = new Map<string, RecordRef>();
  const queue = [...ev.scope.records];
  while (queue.length) {
    const r = queue.shift()!;
    for (const d of ev.graph.dependenciesOf(r)) {
      const k = refKey(d);
      if (!CONTRACT_KINDS.has(d.kind) || ev.scope.keys.has(k) || deps.has(k)) continue;
      deps.set(k, d);
      queue.push(d);
    }
  }
  return { own, dependencies: [...deps.values()].sort((a, b) => refKey(a).localeCompare(refKey(b))) };
}

const permittedSubstituteKinds = (ev: Eval, kinds: readonly { kind: SubstituteKind; permits: TaskClass[] }[], cls: TaskClass): SubstituteKind[] => {
  const byEdge = kinds.filter((s) => s.permits.includes(cls)).map((s) => s.kind);
  const policy = ev.inputs.policy;
  return policy ? byEdge.filter((k) => policy.substitutes.some((p) => p.kind === k && p.permits.includes(cls))) : byEdge;
};

/** Dependency edges with readiness requirements whose dependent side is in scope. */
function readinessEdges(ev: Eval): Array<{ edge: Model['edges'][number]; target: RecordRef }> {
  const out: Array<{ edge: Model['edges'][number]; target: RecordRef }> = [];
  for (const e of ev.model.edges) {
    if (!e.readiness) continue;
    const from = resolveId(ev.index, e.from);
    const target = resolveId(ev.index, e.to);
    if (!from || !target || !inScope(ev, from)) continue;
    out.push({ edge: e, target });
  }
  return out;
}

function implementation(ev: Eval, cls: TaskClass, out: ClassResult): void {
  const gate = effectiveGates(ev.inputs).implementationRequires;
  const { own, dependencies } = contractsOf(ev);
  if (gate === 'accepted-contract') {
    if (!ev.acceptanceSupplied) out.missing.push(prereq(SYSTEM, 'acceptance', FINDING.READINESS_INPUT_MISSING, 'implementation requires accepted contracts, but no baseline or acceptance record was supplied'));
    else {
      for (const r of [...own, ...dependencies]) {
        const m = ev.maturity(r);
        if (atLeast(m, 'accepted')) continue;
        out.blocking.push(prereq(r, 'contract', FINDING.READINESS_MATURITY_INSUFFICIENT, `${r.kind} '${r.id}' is ${m ?? 'undeclared'}; implementation requires accepted contracts`, { maturityRequired: 'accepted', ...(m ? { maturityActual: m } : {}) }));
      }
    }
  }
  const requested = ev.task.substitutes;
  const applied = new Set<string>();
  for (const { edge, target } of readinessEdges(ev)) {
    const r = edge.readiness!;
    const m = ev.maturity(target);
    const met = atLeast(m, r.maturity);
    const wanted = requested?.find((s) => s.dependency.kind === target.kind && s.dependency.id === target.id);
    const kinds = permittedSubstituteKinds(ev, r.substitutes ?? [], cls);
    const kind = wanted ? (kinds.includes(wanted.kind) ? wanted.kind : undefined) : r.claim !== 'contract' && !met ? kinds[0] : undefined;
    if (kind !== undefined) {
      const sub = (r.substitutes ?? []).find((s) => s.kind === kind)!;
      out.substitutes.push({ dependency: target, kind, permits: sub.permits, limits: sub.limits });
      applied.add(`${refKey(target)}#${kind}`);
    }
    if (met) continue;
    if (r.claim !== 'contract' && kind !== undefined) continue;
    if (MATURITY_RANK[r.maturity] >= MATURITY_RANK.accepted && !ev.acceptanceSupplied) {
      out.missing.push(prereq(target, 'contract', FINDING.READINESS_INPUT_MISSING, `dependency '${target.id}' must be ${r.maturity}, but no acceptance input was supplied`, { maturityRequired: r.maturity }));
      continue;
    }
    out.blocking.push(prereq(target, r.claim === 'contract' ? 'contract' : 'implementation', FINDING.READINESS_MATURITY_INSUFFICIENT, `dependency '${target.id}' is ${m ?? 'undeclared'}; ${edge.from} requires it ${r.maturity}`, { maturityRequired: r.maturity, ...(m ? { maturityActual: m } : {}) }));
  }
  for (const s of requested ?? []) {
    if (applied.has(`${refKey(s.dependency)}#${s.kind}`)) continue;
    out.blocking.push(prereq(s.dependency, 'implementation', FINDING.READINESS_PREREQUISITE_UNMET, `a ${s.kind} of '${s.dependency.id}' is not a substitute any dependency edge and the policy permit for ${cls}`));
  }
}

/** Synthetic obligations: integration evidence for each component at an integration edge of the scope. */
function integrationObligations(ev: Eval): EvidenceObligation[] {
  const kinds = [...new Set<EvidenceKind>(['integration', ...effectiveGates(ev.inputs).integrationEvidence])].sort();
  const components = new Set<string>();
  for (const e of ev.model.edges) {
    if (e.kind !== 'integration') continue;
    for (const end of [e.from, e.to]) {
      const ref = resolveId(ev.index, end);
      if (!ref) continue;
      const touches = inScope(ev, ref);
      if (!touches) continue;
      for (const c of ref.kind === 'component' ? [ref.id] : ownersOf(ev.index, ref)) components.add(c);
    }
  }
  if (!components.size && effectiveGates(ev.inputs).integrationEvidence.length) for (const c of ev.scope.components) components.add(c);
  return [...components].sort().map((c) => ({ id: `integration:${c}`, claim: { kind: 'release' as const, ref: c }, kinds, required: true, status: 'absent' as const }));
}

function integration(ev: Eval, out: ClassResult): void {
  if (ev.inputs.evidence === undefined) {
    out.missing.push(prereq(SYSTEM, 'evidence', FINDING.READINESS_INPUT_MISSING, 'integration requires implementation and integration evidence, but no evidence was supplied'));
    return;
  }
  const { own } = contractsOf(ev);
  for (const r of own) {
    const m = ev.maturity(r);
    if (atLeast(m, 'implemented')) continue;
    out.blocking.push(prereq(r, 'implementation', FINDING.READINESS_MATURITY_INSUFFICIENT, `${r.kind} '${r.id}' is ${m ?? 'undeclared'}; integration requires implemented contracts`, { maturityRequired: 'implemented', ...(m ? { maturityActual: m } : {}) }));
  }
  const evaluated = evaluateEvidence(ev.model, integrationObligations(ev), ev.inputs);
  for (const o of evaluated.obligations) {
    if (o.status === 'passing' || o.status === 'not-applicable') continue;
    out.blocking.push(prereq({ kind: 'component', id: o.claim.ref }, 'evidence', FINDING.READINESS_PREREQUISITE_UNMET, `real-boundary ${o.kinds.join(' and ')} evidence for component '${o.claim.ref}' is ${o.status}; a substitute never satisfies it`));
  }
}

function release(ev: Eval, out: ClassResult): void {
  if (ev.inputs.evidence === undefined) out.missing.push(prereq(SYSTEM, 'evidence', FINDING.READINESS_INPUT_MISSING, 'release requires evidence for every obligation, but no evidence was supplied'));
  else {
    const evaluated = evaluateEvidence(ev.model, deriveObligations(ev.model, ev.scope, ev.inputs), ev.inputs);
    for (const o of evaluated.obligations) {
      if (!o.required || o.status === 'passing' || o.status === 'not-applicable') continue;
      out.blocking.push(prereq(o.claim.kind === 'release' ? { kind: 'component', id: o.claim.ref } : o.claim.kind === 'check' ? SYSTEM : { kind: o.claim.kind, id: o.claim.ref }, 'evidence', FINDING.READINESS_PREREQUISITE_UNMET, `obligation ${o.id} is ${o.status}`));
    }
  }
  const accepted = makeAcceptanceCheck(ev.model, ev.inputs);
  for (const r of ev.scope.records.filter((x) => x.kind === 'decision')) {
    const d = ev.model.decisions.find((x) => x.id === r.id);
    if (!d || d.status === 'superseded') continue;
    if (!ev.acceptanceSupplied) {
      out.missing.push(prereq(r, 'decision', FINDING.READINESS_INPUT_MISSING, `decision '${d.id}' must be accepted, but no acceptance input was supplied`));
      continue;
    }
    if (d.status !== 'accepted' || !accepted(r)) out.blocking.push(prereq(r, 'decision', FINDING.READINESS_PREREQUISITE_UNMET, `decision '${d.id}' is ${d.status === 'accepted' ? 'marked accepted without trusted acceptance' : d.status}`));
  }
  if (!ev.acceptanceSupplied) out.missing.push(prereq(SYSTEM, 'acceptance', FINDING.READINESS_INPUT_MISSING, 'release requires acceptance of the released revision, but no acceptance input was supplied'));
  else if (!derivedSeal(ev.model, ev.inputs)) {
    const unaccepted = ev.scope.records.filter((r) => (CONTRACT_KINDS.has(r.kind) || r.kind === 'requirement') && !accepted(r));
    if (unaccepted.length) out.blocking.push(prereq(unaccepted[0]!, 'acceptance', FINDING.ACCEPTANCE_MISSING, `no trusted acceptance covers the released revision of ${unaccepted.map(refKey).join(', ')}`));
  }
}

/**
 * Pinned published contracts the scope consumes or references: an unresolved
 * bundle leaves dependent work unresolved; a bundle that does not match its
 * pin blocks it.
 */
function publishedContracts(ev: Eval, out: ClassResult): void {
  const used = new Set(ev.scope.records.filter((x) => x.kind === 'publishedContract').map((x) => x.id));
  for (const r of collectReferences(ev.model)) {
    if (!ev.scope.keys.has(refKey(r.holder)) || typeof r.value !== 'string') continue;
    const q = splitQualified(r.value);
    if (q) used.add(q.publishedContract);
  }
  for (const id of [...used].sort()) {
    const pin = ev.model.publishedContracts.find((p) => p.id === id);
    if (!pin) continue;
    const ref: RecordRef = { kind: 'publishedContract', id };
    const bundle = ev.inputs.publishedContracts && bundleFor(pin, ev.inputs.publishedContracts);
    if (!bundle) {
      out.missing.push(prereq(ref, 'contract', FINDING.PUBLISHED_CONTRACT_UNRESOLVED, `published contract '${pin.id}' is not resolved`));
      continue;
    }
    if (canonicalHash(bundle.content) !== pin.digest) out.blocking.push(prereq(ref, 'contract', FINDING.PUBLISHED_CONTRACT_DIGEST_MISMATCH, `published contract '${pin.id}' does not match its pinned digest`));
  }
}

function evaluateClass(ev: Eval, cls: TaskClass): ClassResult {
  const out: ClassResult = { blocking: [], missing: [], substitutes: [] };
  if (ev.inputs.state?.phase === 'unplanned' && LATE_CLASSES.has(cls)) {
    out.blocking.push(prereq(SYSTEM, 'policy', FINDING.WORKSPACE_UNPLANNED, `the workspace is unplanned; ${cls} needs planned requirements, contracts and accepted baselines`));
  }
  if (ev.errors.length && LATE_CLASSES.has(cls)) {
    out.blocking.push(prereq(SYSTEM, 'validation', FINDING.VALIDATION_FINDINGS, `${cls} requires a valid model; ${ev.errors.length} error finding(s) remain`));
  }
  blockingUnknowns(ev, cls, out);
  blockingAssumptions(ev, cls, out);
  if (cls !== 'discovery') {
    if (!ev.model.systemProfile) out.missing.push(prereq(SYSTEM, 'validation', FINDING.READINESS_INPUT_MISSING, 'no system profile is declared, so applicable concerns are not evaluated'));
  }
  if (cls === 'specification') {
    for (const r of ev.model.requirements) {
      if (r.status === 'retired' || !ev.scope.keys.has(`requirement:${r.id}`) || r.criteria.length) continue;
      out.blocking.push(prereq({ kind: 'requirement', id: r.id }, 'validation', FINDING.READINESS_PREREQUISITE_UNMET, `requirement '${r.id}' states no acceptance criterion`));
    }
  }
  if (cls === 'implementation' || cls === 'integration' || cls === 'release') publishedContracts(ev, out);
  if (cls === 'implementation') implementation(ev, cls, out);
  if (cls === 'integration') integration(ev, out);
  if (cls === 'release') release(ev, out);
  if (cls === 'operations') {
    const observed = ev.model.observations.some((o) => o.about.some((a) => inScope(ev, a)));
    if (!observed) out.blocking.push(prereq(SYSTEM, 'evidence', FINDING.READINESS_PREREQUISITE_UNMET, 'operational investigation needs observations of the scope; none is recorded'));
  }
  return out;
}

function stateOf(cls: TaskClass, r: ClassResult): ReadinessState {
  const reasons: Reason[] = [
    ...r.blocking.map((p) => ({ code: p.code, message: p.message, refs: [p.ref] })),
    ...r.missing.map((p) => ({ code: p.code, message: p.message, refs: [p.ref] })),
    ...r.substitutes.map((s) => ({ code: FINDING.READINESS_SUBSTITUTE_APPLIED, message: `a ${s.kind} stands in for '${s.dependency.id}' within its limits: ${s.limits}`, refs: [s.dependency] })),
  ];
  return { state: r.blocking.length ? 'blocked' : r.missing.length ? 'unresolved' : 'ready', task: cls, reasons };
}

function makeEval(model: Model, task: TaskSpec, inputs: EvaluationInputs): Eval {
  const index = indexModel(model);
  return {
    model,
    index,
    graph: new DependencyGraph(index),
    scope: resolveScope(index, task),
    inputs,
    task,
    errors: validate(model, inputs).filter((f) => f.severity === 'error'),
    maturity: makeMaturity(model, inputs),
    acceptanceSupplied: inputs.acceptances !== undefined || inputs.baseline !== undefined,
  };
}

const VERIFICATION_KIND: Record<string, EvidenceKind> = { scenario: 'behavior', check: 'conformance', review: 'review' };

function workPackageOf(ev: Eval, cls: TaskClass, r: ClassResult, state: ReadinessState): WorkPackage {
  const s = ev.scope;
  const subject = s.mode === 'slice' ? s.requirements : s.components;
  const id = ev.task.id ?? `wp.${cls}.${s.mode}.${subject.join('+') || 'all'}`;
  const versionOf = (ref: RecordRef): number | undefined => (findRecord(ev.index, ref) as { version?: number } | undefined)?.version;
  const inputs = s.records
    .map((ref) => ({ ref, hash: recordHash(ev.model, ref), version: CONTRACT_KINDS.has(ref.kind) ? versionOf(ref) : undefined }))
    .filter((x): x is { ref: RecordRef; hash: string; version: number | undefined } => x.hash !== null)
    .map((x) => (x.version === undefined ? { ref: x.ref, hash: x.hash } : { ref: x.ref, hash: x.hash, version: x.version }));
  const gate = effectiveGates(ev.inputs).implementationRequires;
  const required: Maturity = cls === 'integration' || cls === 'release' ? 'implemented' : gate === 'accepted-contract' ? 'accepted' : 'proposed';
  const { dependencies } = contractsOf(ev);
  const own = s.records.filter((ref) => CONTRACT_KINDS.has(ref.kind));
  const requiredContracts = [
    ...own.map((ref) => ({ ref, maturity: required, version: versionOf(ref) })),
    ...dependencies.map((ref) => ({ ref, maturity: required, version: versionOf(ref) })),
    ...readinessEdges(ev).map(({ edge, target }) => ({ ref: target, maturity: edge.readiness!.maturity, version: edge.readiness!.revision })),
  ].map((x) => (x.version === undefined ? { ref: x.ref, maturity: x.maturity } : { ref: x.ref, maturity: x.maturity, version: x.version }));
  const criteria = ev.model.requirements.flatMap((q) => q.criteria.filter((c) => s.keys.has(`criterion:${c.id}`)));
  const tests = [
    ...criteria.map((c) => ({ kind: c.evidence[0] ?? VERIFICATION_KIND[c.verification] ?? 'behavior', ref: { kind: 'criterion' as const, id: c.id }, description: c.statement })),
    ...ev.model.scenarios.filter((x) => s.keys.has(`scenario:${x.id}`)).map((x) => ({ kind: 'behavior' as EvidenceKind, ref: { kind: 'scenario' as const, id: x.id }, description: x.expected })),
  ];
  const obligations = deriveObligations(ev.model, s, ev.inputs);
  const exitEvidence = ev.inputs.evidence === undefined ? obligations : evaluateEvidence(ev.model, obligations, ev.inputs).obligations;
  const allowedEdits = s.records.filter((ref) => ownersOf(ev.index, ref).some((c) => s.components.includes(c))).map((ref) => ({ kind: 'record' as const, ref }));
  return {
    id,
    objective: `${cls} of ${s.mode === 'slice' ? `the slice for ${subject.join(', ') || 'no requirement'}` : `component(s) ${subject.join(', ') || 'none'}`}`,
    class: cls,
    mode: s.mode,
    scope: s.components,
    inputs,
    allowedEdits,
    requiredContracts,
    tests,
    exitEvidence,
    blockedBy: [...r.blocking, ...r.missing],
    readiness: state,
  };
}

export interface ReadinessResult {
  data: ReadinessData;
  state: ReadinessState;
}

/**
 * Readiness of one task, evaluated from the task, the model and the supplied
 * baselines, acceptance, evidence and policy. A phase string or a stored
 * status never makes a task ready. Identical inputs give identical results in
 * every adapter, because this is the one implementation.
 */
export function checkReadiness(model: Model, task: TaskSpec, inputs: EvaluationInputs = {}): ReadinessResult {
  const ev = makeEval(model, task, inputs);
  const results = new Map(TASK_CLASSES.map((c) => [c, evaluateClass(ev, c)] as const));
  const own = results.get(task.class)!;
  const state = stateOf(task.class, own);
  const allowedNext = TASK_CLASSES.filter((c) => stateOf(c, results.get(c)!).state === 'ready');
  return {
    state,
    data: { task, missing: [...own.blocking, ...own.missing], substitutes: own.substitutes, allowedNext, workPackage: workPackageOf(ev, task.class, own, state) },
  };
}

export interface Recompute {
  affected: Array<{ workPackage: WorkPackage; changed: RecordRef[]; previous: ReadinessState }>;
  unaffected: WorkPackage[];
}

/**
 * Re-evaluate tasks after a change. A task whose input records changed, or
 * whose readiness changed, is affected; every other task keeps its completed
 * work and is reported unaffected.
 */
export function recomputeReadiness(before: Model, after: Model, tasks: readonly TaskSpec[], inputs: EvaluationInputs = {}): Recompute {
  const out: Recompute = { affected: [], unaffected: [] };
  for (const task of tasks) {
    const was = checkReadiness(before, task, inputs);
    const now = checkReadiness(after, task, inputs);
    const hashes = (wp: WorkPackage) => new Map(wp.inputs.map((i) => [refKey(i.ref), i.hash]));
    const b = hashes(was.data.workPackage);
    const a = hashes(now.data.workPackage);
    const recorded = inputs.state?.tasks?.find((t) => t.workPackage === now.data.workPackage.id)?.inputs ?? [];
    const changed = new Map<string, RecordRef>();
    for (const i of now.data.workPackage.inputs) if (b.get(refKey(i.ref)) !== i.hash) changed.set(refKey(i.ref), i.ref);
    for (const i of was.data.workPackage.inputs) if (!a.has(refKey(i.ref))) changed.set(refKey(i.ref), i.ref);
    for (const i of recorded) if (a.get(refKey(i.ref)) !== i.hash) changed.set(refKey(i.ref), i.ref);
    if (changed.size || was.state.state !== now.state.state) out.affected.push({ workPackage: now.data.workPackage, changed: [...changed.values()], previous: was.state });
    else out.unaffected.push(now.data.workPackage);
  }
  return out;
}

const RANKED_KINDS: ReadonlySet<string> = new Set(['component', 'type', 'operation', 'routine', 'mutation', 'storage', 'mapping', 'decision', 'publishedContract']);
const CENTRAL_ARCS = new Set(['reference', 'semantic', 'structural', 'integration']);

/**
 * Design, implementation, deployment and runtime orders, kept separate. Design
 * order ranks by change propagation, centrality, uncertainty and reversal
 * cost, each exposed with its value; no fixed layer comes first by rule.
 */
export function designOrder(model: Model, inputs: EvaluationInputs = {}): DesignOrder {
  const index = indexModel(model);
  const graph = new DependencyGraph(index);
  const accepted = makeAcceptanceCheck(model, inputs);
  const acceptanceSupplied = inputs.acceptances !== undefined || inputs.baseline !== undefined;
  const nodes: RecordRef[] = [];
  for (const [kind, records] of index.byKind) if (RANKED_KINDS.has(kind)) for (const id of records.keys()) nodes.push({ kind, id });
  const scored = nodes.map((ref) => {
    const propagation = graph.consumersOf([ref]).size;
    const adj = graph.adjacent(ref);
    const centrality = [...adj.dependencies, ...adj.consumers].filter((a) => a.kinds.some((k) => CENTRAL_ARCS.has(k))).length;
    const uncertainty =
      model.unknowns.filter((u) => u.status === 'open' && (u.affects.some((a) => a.kind === ref.kind && a.id === ref.id) || (u.concerns ?? []).some((c) => c.record.kind === ref.kind && c.record.id === ref.id))).length +
      model.assumptions.filter((a) => a.status !== 'validated' && a.affects.some((x) => x.kind === ref.kind && x.id === ref.id)).length;
    const stored = ref.kind === 'storage' || (ref.kind === 'type' && index.storageByType.has(ref.id)) ? 2 : 0;
    const bound = model.consumerBindings.filter((b) => b.contract.kind === ref.kind && b.contract.id === ref.id).length;
    const published = ref.kind === 'publishedContract' ? 2 : 0;
    const frozen = acceptanceSupplied && accepted(ref) ? 2 : 0;
    const reversal = stored + bound + published + frozen;
    const score = propagation + 0.5 * centrality + 2 * uncertainty + 1.5 * reversal;
    const reasons: OrderedItem['reasons'] = [
      { factor: 'propagation', value: propagation, explanation: `${propagation} record(s) transitively depend on it` },
      { factor: 'centrality', value: centrality, explanation: `${centrality} direct semantic, structural, integration or reference link(s)` },
      { factor: 'uncertainty', value: uncertainty, explanation: `${uncertainty} open unknown(s) or unvalidated assumption(s) bear on it` },
      { factor: 'reversal-cost', value: reversal, explanation: [stored ? 'persisted' : '', bound ? `${bound} consumer binding(s)` : '', published ? 'published' : '', frozen ? 'accepted' : ''].filter(Boolean).join(', ') || 'no persisted, bound, published or accepted state' },
    ];
    return { ref, score, reasons };
  });
  scored.sort((a, b) => b.score - a.score || refKey(a.ref).localeCompare(refKey(b.ref)));
  const design: OrderedItem[] = scored.map((s, i) => ({ ref: s.ref, rank: i + 1, score: Math.round(s.score * 100) / 100, reasons: s.reasons }));

  const components = model.components.map((c) => c.id).sort();
  const dependsOn = new Map<string, Set<string>>(components.map((c) => [c, new Set<string>()]));
  for (const [kind, records] of index.byKind) {
    for (const id of records.keys()) {
      const ref = { kind, id } as RecordRef;
      const from = ownersOf(index, ref);
      for (const dep of graph.dependenciesOf(ref)) for (const to of ownersOf(index, dep)) for (const f of from) if (f !== to) dependsOn.get(f)?.add(to);
    }
  }
  for (const e of model.edges) {
    if (e.kind !== 'build' && e.kind !== 'structural') continue;
    const from = resolveId(index, e.from);
    const to = resolveId(index, e.to);
    if (!from || !to) continue;
    for (const f of from.kind === 'component' ? [from.id] : ownersOf(index, from)) for (const t of to.kind === 'component' ? [to.id] : ownersOf(index, to)) if (f !== t) dependsOn.get(f)?.add(t);
  }
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (c: string): number => {
    const known = level.get(c);
    if (known !== undefined) return known;
    if (visiting.has(c)) return 0;
    visiting.add(c);
    const d = Math.max(0, ...[...(dependsOn.get(c) ?? [])].map((x) => depth(x) + 1));
    visiting.delete(c);
    level.set(c, d);
    return d;
  };
  const implementation: OrderedItem[] = components
    .map((c) => ({ c, d: depth(c) }))
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
    .map(({ c, d }, i) => ({ ref: { kind: 'component', id: c }, rank: i + 1, score: d, reasons: [{ factor: 'dependency', value: d, explanation: dependsOn.get(c)!.size ? `builds after ${[...dependsOn.get(c)!].sort().join(', ')}` : 'depends on no other component' }] }));

  const deployment: OrderedItem[] = [];
  const placed = new Set<string>();
  const place = (ref: RecordRef, why: string): void => {
    if (placed.has(refKey(ref))) return;
    placed.add(refKey(ref));
    deployment.push({ ref, rank: deployment.length + 1, score: deployment.length + 1, reasons: [{ factor: 'dependency', value: deployment.length + 1, explanation: why }] });
  };
  const migrationIds = model.migrations.map((m) => m.id);
  const migDeps = new Map(model.migrations.map((m) => [m.id, m.dependsOn.filter((d) => migrationIds.includes(d))]));
  const migOrder: string[] = [];
  const seen = new Set<string>();
  const visitMig = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of migDeps.get(id) ?? []) visitMig(d);
    migOrder.push(id);
  };
  for (const id of [...migrationIds].sort()) visitMig(id);
  for (const id of migOrder) {
    const mig = model.migrations.find((m) => m.id === id)!;
    for (const r of mig.deploymentOrder ?? []) place(r, `deployment order of migration '${id}'`);
  }
  for (const r of [...model.types, ...model.operations, ...model.routines]) for (const s of r.supported ?? []) for (const x of s.rollout?.order ?? []) place(x, `rollout of ${r.id} version ${s.version}`);
  for (const item of implementation) {
    for (const u of model.deploymentUnits.filter((x) => x.components.includes(item.ref.id))) place({ kind: 'deploymentUnit', id: u.id }, `hosts ${u.components.join(', ')}, in implementation order`);
  }

  const runtimeEdges = model.edges.filter((e) => e.kind === 'runtime');
  const nodesRt = [...new Set(runtimeEdges.flatMap((e) => [e.from, e.to]))].sort();
  const cyclic = new Set(findCycles(nodesRt, (n) => runtimeEdges.filter((e) => e.from === n).map((e) => e.to)).flatMap((c) => c));
  const runtime = runtimeEdges.map((e) => ({ from: e.from, to: e.to, cycle: cyclic.has(e.from) && cyclic.has(e.to) }));
  return { design, implementation, deployment, runtime };
}
