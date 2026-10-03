import type { EvidenceObligation, Model, TaskClass } from '../generated/types.js';
import { checkReadiness } from '../readiness.js';
import { deriveObligations, evaluateEvidence } from '../evidence.js';
import { toText } from './notice.js';
import type { RenderContext } from './context.js';
import { cell, code, codes, refText, viewHeader } from './views.js';

export const READINESS_FILE = 'readiness.md';
export const COVERAGE_FILE = 'coverage.md';
export const EVIDENCE_FILE = 'evidence.md';

const CLASSES: readonly TaskClass[] = ['discovery', 'specification', 'implementation', 'integration', 'release', 'operations'];
const NOT_EVALUATED = 'not evaluated';

/** Obligation claims that name a model record; check and release claims name a check id or a component release. */
export const EVIDENCE_CLAIM_KINDS: ReadonlySet<string> = new Set(['criterion', 'retainedBehavior', 'migration']);

/** The model records the evidence index lists, one per obligation claim that names a record. */
export function evidenceIndexScope(model: Model): Array<{ kind: 'criterion' | 'retainedBehavior' | 'migration'; id: string }> {
  const seen = new Set<string>();
  const out: Array<{ kind: 'criterion' | 'retainedBehavior' | 'migration'; id: string }> = [];
  for (const o of deriveObligations(model, undefined, {})) {
    if (!EVIDENCE_CLAIM_KINDS.has(o.claim.kind)) continue;
    const key = `${o.claim.kind}:${o.claim.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: o.claim.kind as 'criterion', id: o.claim.ref });
  }
  return out;
}

/**
 * Readiness of every component for every task class, with the reasons a class
 * is not ready. Without evaluation inputs nothing is evaluated and the view
 * says so: a missing input is never shown as readiness.
 */
export function projectReadinessReport(model: Model, ctx: RenderContext): Record<string, string> {
  const L = viewHeader(model, 'Loom readiness', ctx.inputs);
  L.push('## Components', '', `| Component | ${CLASSES.join(' | ')} |`, `| --- | ${CLASSES.map(() => '---').join(' | ')} |`);
  const details: string[] = [];
  for (const c of model.components) {
    const states = CLASSES.map((k) => {
      if (!ctx.inputs) return NOT_EVALUATED;
      const r = checkReadiness(model, { class: k, mode: 'component', components: [c.id] }, ctx.inputs);
      if (r.state.state !== 'ready') {
        const reasons = r.state.reasons.map((x) => `${x.code}: ${cell(x.message)}`);
        details.push(`- ${code(c.id)} ${k} is ${r.state.state}${reasons.length ? `: ${reasons.join('; ')}` : '.'}`);
      }
      return r.state.state;
    });
    L.push(`| ${code(c.id)} | ${states.join(' | ')} |`);
    ctx.covered({ kind: 'component', id: c.id }, READINESS_FILE, `| ${code(c.id)} |`);
  }
  L.push('');
  if (!ctx.inputs) L.push('Readiness is not evaluated: no evaluation inputs were supplied.', '');
  else if (details.length) L.push('## Reasons', '', ...details, '');

  L.push('## Migrations', '', '| Migration | Contract | Evidence obligations | Status |', '| --- | --- | --- | --- |');
  const obligations = migrationObligations(model, ctx);
  for (const m of model.migrations) {
    const own = obligations.filter((o) => o.claim.ref === m.id);
    L.push(`| ${code(m.id)} | ${refText(m.contract)} | ${[...new Set(own.flatMap((o) => o.kinds))].join(', ') || m.evidence.join(', ')} | ${ctx.inputs ? own.map((o) => o.status).join(', ') || 'absent' : NOT_EVALUATED} |`);
    ctx.covered({ kind: 'migration', id: m.id }, READINESS_FILE, `| ${code(m.id)} |`);
  }
  if (!model.migrations.length) L.push('| (none) | | | |');
  return { [READINESS_FILE]: toText(L) };
}

function migrationObligations(model: Model, ctx: RenderContext): EvidenceObligation[] {
  const derived = deriveObligations(model, undefined, ctx.inputs ?? {}).filter((o) => o.claim.kind === 'migration');
  return ctx.inputs ? evaluateEvidence(model, derived, ctx.inputs).obligations : derived;
}

/** Obligations with their evaluated status, or as derived (status unevaluated) when no inputs were supplied. */
function evaluatedObligations(model: Model, ctx: RenderContext): EvidenceObligation[] {
  const derived = deriveObligations(model, undefined, ctx.inputs ?? {});
  return ctx.inputs ? evaluateEvidence(model, derived, ctx.inputs).obligations : derived;
}

/**
 * Acceptance coverage: requirement, then each criterion with the independently
 * authored scenarios and the contract checks that cover it, then the status of
 * its evidence obligation. A criterion without coverage stays visible as such.
 */
export function projectCoverageMatrix(model: Model, ctx: RenderContext): Record<string, string> {
  const L = viewHeader(model, 'Loom acceptance coverage', ctx.inputs);
  const obligations = evaluatedObligations(model, ctx);
  L.push('| Requirement | Criterion | Verification | Scenarios | Checks | Evidence |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of model.requirements) {
    ctx.covered({ kind: 'requirement', id: r.id }, COVERAGE_FILE, `| ${code(r.id)} | `);
    if (!r.criteria.length) L.push(`| ${code(r.id)} | (no criteria) | | | | |`);
    for (const c of r.criteria) {
      const scenarios = model.scenarios.filter((s) => s.criteria.includes(c.id)).map((s) => s.id);
      const checks = [...model.operations.filter((o) => o.criteria?.includes(c.id)).map((o) => `operation ${code(o.id)}`), ...model.mutations.filter((m) => m.criteria?.includes(c.id)).map((m) => `mutation ${code(m.id)}`)];
      const owed = obligations.filter((o) => o.claim.kind === 'criterion' && o.claim.ref === c.id);
      const evidence = owed.length ? owed.map((o) => `${o.kinds.join('+')}: ${ctx.inputs ? o.status : NOT_EVALUATED}`).join('; ') : c.required ? 'no obligation' : 'not required';
      L.push(`| ${code(r.id)} | ${code(c.id)} | ${c.verification} | ${codes(scenarios)} | ${checks.join(', ') || '(none)'} | ${evidence} |`);
      ctx.covered({ kind: 'criterion', id: c.id }, COVERAGE_FILE, `| ${code(c.id)} | ${c.verification} |`);
    }
  }
  if (!model.requirements.length) L.push('| (none) | | | | | |');
  L.push('', '## Scenarios', '', '| Scenario | Kind | Criteria | Expected |', '| --- | --- | --- | --- |');
  for (const s of model.scenarios) {
    L.push(`| ${code(s.id)} | ${s.kind} | ${codes(s.criteria)} | ${cell(s.expected)} |`);
    ctx.covered({ kind: 'scenario', id: s.id }, COVERAGE_FILE, `| ${code(s.id)} | ${s.kind} |`);
  }
  if (!model.scenarios.length) L.push('| (none) | | | |');
  return { [COVERAGE_FILE]: toText(L) };
}

/**
 * Evidence index: every evidence obligation with its status, then every
 * supplied evidence record with its claims, kind, result, trust, staleness
 * and exercised boundaries. Without evidence inputs the index says that
 * nothing was evaluated rather than reporting the evidence as absent.
 */
export function projectEvidenceIndex(model: Model, ctx: RenderContext): Record<string, string> {
  const L = viewHeader(model, 'Loom evidence index', ctx.inputs);
  const derived = deriveObligations(model, undefined, ctx.inputs ?? {});
  const evaluation = ctx.inputs ? evaluateEvidence(model, derived, ctx.inputs) : null;
  const obligations = evaluation ? evaluation.obligations : derived;
  L.push('## Obligations', '', '| Claim | Kinds | Required | Status | Evidence |', '| --- | --- | --- | --- | --- |');
  for (const o of obligations) {
    L.push(`| ${o.claim.kind} ${code(o.claim.ref)} | ${o.kinds.join(', ')} | ${o.required ? 'yes' : 'no'} | ${evaluation ? o.status : NOT_EVALUATED} | ${codes(o.evidence ?? [])} |`);
    if (EVIDENCE_CLAIM_KINDS.has(o.claim.kind)) ctx.covered({ kind: o.claim.kind as 'criterion', id: o.claim.ref }, EVIDENCE_FILE, `| ${o.claim.kind} ${code(o.claim.ref)} |`);
  }
  if (!obligations.length) L.push('| (none) | | | | |');

  L.push('', '## Evidence records', '');
  const records = ctx.inputs?.evidence ?? [];
  if (!ctx.inputs?.evidence) L.push('No evidence records were supplied; nothing is evaluated.');
  else {
    const stale = new Set((evaluation?.invalidated ?? []).map((x) => x.evidence));
    L.push('| Evidence | Claims | Kind | Result | Trusted | Stale | Boundaries |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const e of records) {
      const r = e.record;
      const boundaries = r.boundaries.map((b) => `${cell(b.boundary)}: ${b.actual}${b.substitute ? ` (${b.substitute})` : ''}`).join('; ') || '(none)';
      L.push(`| ${code(r.id)} | ${r.claims.map((c) => `${c.kind} ${code(c.ref)}`).join(', ')} | ${r.kind} | ${r.result} | ${e.trusted ? 'yes' : `no${e.reason ? ` (${cell(e.reason)})` : ''}`} | ${stale.has(r.id) ? 'yes' : 'no'} | ${boundaries} |`);
    }
    if (!records.length) L.push('| (none) | | | | | | |');
  }
  return { [EVIDENCE_FILE]: toText(L) };
}
