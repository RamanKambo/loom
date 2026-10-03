import type { Predicate, RecordRef } from '../generated/types.js';
import { FINDING } from '../codes.js';
import { recordHash } from '../hash.js';
import { makeAcceptanceCheck, refKey } from '../scope.js';
import { predicateText } from '../projections/context.js';
import { intentRepair, ref, type Rule, type RuleContext } from './context.js';

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();

/** A claim with basis 'sourced' names a source. */
function sources(ctx: RuleContext): void {
  const check = (kind: 'requirement' | 'constraint' | 'workload', id: string, basis: string, source: readonly unknown[], path: string): void => {
    if (basis !== 'sourced' || source.length > 0) return;
    ctx.report(FINDING.SOURCE_REFERENCE_MISSING, path, `${kind} '${id}' is marked sourced but names no source`, [ref(kind, id)], `add the document or artifact '${id}' comes from, with its revision or retrieval time, or change its basis to what it is`);
  };
  for (const r of ctx.model.requirements) check('requirement', r.id, r.basis, r.source, `requirements/${r.id}/source`);
  for (const c of ctx.model.constraints) check('constraint', c.id, c.basis, c.source, `constraints/${c.id}/source`);
  for (const w of ctx.model.workloads) check('workload', w.id, w.basis, w.source, `workloads/${w.id}/source`);
}

/**
 * A stored 'accepted' grants nothing: it holds only when a trusted acceptance
 * covers the record. Without acceptance inputs acceptance is not evaluated,
 * which the result's acceptance state reports, so no finding is raised.
 */
function acceptanceClaims(ctx: RuleContext): void {
  if (ctx.inputs.acceptances === undefined && ctx.inputs.baseline === undefined) return;
  const accepted = makeAcceptanceCheck(ctx.model, ctx.inputs);
  const claims: Array<{ ref: RecordRef; path: string }> = [];
  for (const r of ctx.model.requirements) if (r.basis === 'accepted') claims.push({ ref: ref('requirement', r.id), path: `requirements/${r.id}/basis` });
  for (const c of ctx.model.constraints) if (c.basis === 'accepted') claims.push({ ref: ref('constraint', c.id), path: `constraints/${c.id}/basis` });
  for (const w of ctx.model.workloads) if (w.basis === 'accepted') claims.push({ ref: ref('workload', w.id), path: `workloads/${w.id}/basis` });
  for (const d of ctx.model.decisions) if (d.status === 'accepted') claims.push({ ref: ref('decision', d.id), path: `decisions/${d.id}/status` });
  for (const c of claims) {
    if (accepted(c.ref)) continue;
    ctx.report(FINDING.CLAIM_ACCEPTANCE_UNVERIFIED, c.path, `${c.ref.kind} '${c.ref.id}' is marked accepted, but no trusted acceptance covers its current content`, [c.ref], `obtain acceptance of '${c.ref.id}' under the configured policy, or mark it proposed`);
  }
}

/** A scenario that restates the declaration it checks is no independent oracle. */
function selfOracle(ctx: RuleContext): void {
  for (const req of ctx.model.requirements) {
    if (req.status === 'retired') continue;
    for (const c of req.criteria) {
      const covering = ctx.model.scenarios.filter((s) => s.criteria.includes(c.id));
      if (covering.length === 0) continue;
      const declared = new Set<string>([normalize(c.statement)]);
      for (const mu of ctx.model.mutations) {
        if (!(mu.criteria ?? []).includes(c.id) && !mu.requirements.includes(req.id)) continue;
        declared.add(normalize(mu.effect));
        declared.add(normalize(predicateText(mu.guard)));
      }
      for (const op of ctx.model.operations) {
        if (!(op.criteria ?? []).includes(c.id)) continue;
        for (const p of [...(op.postconditions ?? []), ...(op.preconditions ?? [])] as Predicate[]) declared.add(normalize(predicateText(p)));
      }
      if (!covering.every((s) => declared.has(normalize(s.expected)))) continue;
      ctx.report(
        FINDING.CRITERION_SELF_ORACLE,
        `requirements/${req.id}/criteria/${c.id}`,
        `criterion '${c.id}' is covered only by scenarios whose expected outcome restates its own declaration (${covering.map((s) => s.id).join(', ')})`,
        [ref('criterion', c.id), ...covering.map((s) => ref('scenario', s.id))],
        `author the expected outcome of ${covering.map((s) => `'${s.id}'`).join(', ')} independently of the declaration, as an observable result`,
      );
    }
  }
}

const SITING_KINDS = new Set(['storage', 'host', 'deploymentUnit']);

/** A decision compares alternatives against what it rests on. */
function decisions(ctx: RuleContext): void {
  for (const d of ctx.model.decisions) {
    if (d.status === 'superseded') continue;
    const reasons: string[] = [];
    if (d.status === 'accepted' && d.chosen === undefined) reasons.push('it is accepted without a chosen alternative');
    if (d.chosen !== undefined) {
      if (d.alternatives.length < 2) reasons.push('it compares fewer than two alternatives');
      if (!d.alternatives.some((a) => a.id === d.chosen)) reasons.push(`its chosen alternative '${d.chosen}' is not one of its alternatives`);
      if (d.criteria.length === 0) reasons.push('it states no criteria');
      if (d.basedOn.length === 0) reasons.push('it rests on no requirement, workload, inventory, assumption or observation');
      const unexplained = d.alternatives.filter((a) => a.id !== d.chosen && a.rejectedBecause === undefined).map((a) => a.id);
      if (unexplained.length) reasons.push(`rejected alternative(s) ${unexplained.join(', ')} state no reason`);
    }
    if (d.affects.some((a) => SITING_KINDS.has(a.kind))) {
      const grounded = d.basedOn.some((b) => b.kind === 'requirement' || b.kind === 'workload');
      const inventory = d.basedOn.some((b) => b.kind === 'inventory');
      if (!grounded || !inventory) reasons.push('a storage or hosting choice rests on at least one requirement or workload and one inventory item');
    }
    if (!reasons.length) continue;
    ctx.report(FINDING.DECISION_UNJUSTIFIED, `decisions/${d.id}`, `decision '${d.id}' is not justified: ${reasons.join('; ')}`, [ref('decision', d.id)], `record the compared alternatives with their consequences and the requirements, workloads and inventory decision '${d.id}' rests on`);
  }
}

/** Brownfield inventory: replacements, retained behavior and executable baselines. */
function inventory(ctx: RuleContext): void {
  for (const item of ctx.model.inventory) {
    const about = [ref('inventory', item.id)];
    if (item.disposition === 'replaced' && item.replacedBy === undefined) {
      ctx.report(FINDING.INVENTORY_REPLACEMENT_UNDECLARED, `inventory/${item.id}/replacedBy`, `inventory item '${item.id}' is replaced but names no replacement`, about, `name the inventory item that replaces '${item.id}' in replacedBy`);
    }
    if ((item.disposition === 'retained' || item.disposition === 'adapted') && (item.executableBaseline === undefined || item.executableBaseline.status === 'unavailable')) {
      ctx.report(FINDING.BASELINE_EXECUTION_UNKNOWN, `inventory/${item.id}/executableBaseline`, `the executable behavior of ${item.disposition} item '${item.id}' is not captured${item.executableBaseline?.reason ? `: ${item.executableBaseline.reason}` : ''}`, about, `capture an executable baseline of '${item.id}' as evidence, or keep the gap as an explicit unknown`);
    }
  }
  for (const rb of ctx.model.retainedBehaviors) {
    if (rb.status !== 'retained' || rb.scenarios.length > 0) continue;
    ctx.report(FINDING.RETAINED_BEHAVIOR_UNCOVERED, `retainedBehaviors/${rb.id}/scenarios`, `retained behavior '${rb.id}' has no scenario`, [ref('retainedBehavior', rb.id)], `add a scenario that exercises retained behavior '${rb.id}' and list it in its scenarios`);
  }
}

/** Decisions and assumptions whose inputs changed or lapsed. */
function invalidation(ctx: RuleContext): void {
  const invalid = new Set(ctx.model.assumptions.filter((a) => a.status === 'invalidated').map((a) => a.id));
  for (const d of ctx.model.decisions) {
    if (d.status === 'superseded') continue;
    const broken = d.basedOn.filter((b) => b.kind === 'assumption' && invalid.has(b.id)).map((b) => b.id);
    if (broken.length) {
      ctx.report(
        FINDING.DECISION_ASSUMPTION_INVALIDATED,
        `decisions/${d.id}/basedOn`,
        `decision '${d.id}' rests on invalidated assumption(s) ${broken.join(', ')}`,
        [ref('decision', d.id), ...d.affects],
        `revisit decision '${d.id}' and the work it affects, or supersede it`,
        { repairs: [intentRepair('revisit-decision', `Revise decision '${d.id}' against the corrected facts.`, ['The decision and every record it affects need review and renewed acceptance.'])] },
      );
    }
  }
  const asOf = ctx.inputs.asOf?.slice(0, 10);
  if (asOf) {
    for (const a of ctx.model.assumptions) {
      if (a.status !== 'open' || a.expires === undefined || a.expires >= asOf) continue;
      ctx.report(FINDING.ASSUMPTION_EXPIRED, `assumptions/${a.id}/expires`, `open assumption '${a.id}' expired on ${a.expires}`, [ref('assumption', a.id), ...a.affects], `validate assumption '${a.id}' by ${a.validation.replace(/\.$/, '').toLowerCase()}, then mark it validated or invalidated`);
    }
  }
  const base = ctx.inputs.baseline;
  if (base) {
    for (const d of ctx.model.decisions) {
      if (d.status === 'superseded') continue;
      const before = base.model.decisions.find((x) => x.id === d.id);
      if (!before || d.revision > before.revision) continue;
      const changed = d.basedOn.filter((b) => {
        const was = recordHash(base.model, b);
        const now = recordHash(ctx.model, b);
        return was !== null && now !== null && was !== now;
      });
      if (!changed.length) continue;
      ctx.report(FINDING.DECISION_INPUT_CHANGED, `decisions/${d.id}/basedOn`, `decision '${d.id}' rests on ${changed.map(refKey).join(', ')}, which changed since the accepted baseline`, [ref('decision', d.id)], `review decision '${d.id}' against its changed inputs and raise its revision`);
    }
  }
}

/** Rationale reviewed against records that have since changed. */
function attachments(ctx: RuleContext): void {
  for (const att of ctx.model.attachments) {
    const stale: string[] = [];
    for (const e of att.explains) {
      const reviewed = att.reviewedAgainst.find((r) => r.record.kind === e.kind && r.record.id === e.id);
      const now = recordHash(ctx.model, e);
      if (!reviewed) stale.push(`${refKey(e)} was never reviewed`);
      else if (now !== null && reviewed.hash !== now) stale.push(`${refKey(e)} changed since review`);
    }
    const before = ctx.inputs.baseline?.model.attachments.find((a) => a.id === att.id);
    if (before && before.digest !== att.digest) stale.push('its source content changed');
    if (!stale.length) continue;
    ctx.report(FINDING.RATIONALE_REVIEW_REQUIRED, `attachments/${att.id}`, `rationale '${att.id}' needs review: ${stale.join('; ')}`, [ref('attachment', att.id)], `review '${att.title}' against the current records and record their hashes in reviewedAgainst`);
  }
}

function unknownsOpen(ctx: RuleContext): void {
  for (const u of ctx.model.unknowns) {
    if (u.status !== 'open') continue;
    ctx.report(FINDING.UNKNOWN_OPEN, `unknowns/${u.id}`, `open unknown '${u.id}' blocks ${u.blocks.length ? u.blocks.join(', ') : 'no task class'}: ${u.question}`, [ref('unknown', u.id), ...u.affects], `resolve unknown '${u.id}' by ${u.resolution.replace(/\.$/, '').toLowerCase()}, then record its closure`);
  }
}

/** Provenance, independent acceptance, decisions, brownfield inventory and invalidation of knowledge records. */
export const knowledgeRules: Rule = (ctx) => {
  sources(ctx);
  acceptanceClaims(ctx);
  selfOracle(ctx);
  decisions(ctx);
  inventory(ctx);
  invalidation(ctx);
  attachments(ctx);
  unknownsOpen(ctx);
};
