import type { Finding, Model } from '../generated/types.js';
import { validate } from '../validate.js';
import { deriveObligations } from '../evidence.js';
import { toText } from './notice.js';
import type { RenderContext } from './context.js';
import { cell, code, codes, refText, viewHeader } from './views.js';

export const REGISTERS_FILE = 'registers.md';

/** Finding codes that make an open item: something unresolved that a person must close. */
const OPEN_ITEM_CODES = new Set(['CONCERN_UNRESOLVED', 'OPERATION_ENFORCEMENT_MISSING', 'RATIONALE_REVIEW_REQUIRED', 'ASSUMPTION_EXPIRED', 'DECISION_ASSUMPTION_INVALIDATED', 'DECISION_INPUT_CHANGED']);

const findingSource = (f: Finding): string => (f.refs?.length ? f.refs.map(refText).join(', ') : code(f.path));

/**
 * Registers generated from their owning records: decisions, unknowns,
 * assumptions, constraints and migrations, then an open-items list derived
 * from open unknowns, unresolved concerns, review obligations and expired or
 * invalidated premises. Every row names the record that owns it, so the
 * record stays the one editable source.
 */
export function projectRegisters(model: Model, ctx: RenderContext): Record<string, string> {
  const L = viewHeader(model, 'Loom registers', ctx.inputs);
  const row = (kind: Parameters<RenderContext['covered']>[0]['kind'], id: string, rest: string): void => {
    L.push(`| ${code(id)} | ${rest} |`);
    ctx.covered({ kind, id }, REGISTERS_FILE, `| ${code(id)} |`);
  };

  L.push('## Decisions', '', '| Decision | Status | Question | Chosen | Authority | Affects |', '| --- | --- | --- | --- | --- | --- |');
  for (const d of model.decisions) row('decision', d.id, `${d.status} | ${cell(d.question)} | ${d.chosen ? code(d.chosen) : '(none)'} | ${code(d.authority)} | ${d.affects.map(refText).join(', ') || '(none)'}`);
  if (!model.decisions.length) L.push('| (none) | | | | | |');

  L.push('', '## Unknowns', '', '| Unknown | Status | Question | Blocks | Owner | Resolution |', '| --- | --- | --- | --- | --- | --- |');
  for (const u of model.unknowns) row('unknown', u.id, `${u.status} | ${cell(u.question)} | ${u.blocks.join(', ') || '(none)'} | ${code(u.owner)} | ${cell(u.resolution)}`);
  if (!model.unknowns.length) L.push('| (none) | | | | | |');

  L.push('', '## Assumptions', '', '| Assumption | Status | Claim | Expires | Owner | Validation |', '| --- | --- | --- | --- | --- | --- |');
  for (const a of model.assumptions) row('assumption', a.id, `${a.status} | ${cell(a.claim)} | ${a.expires ?? ''} | ${code(a.owner)} | ${cell(a.validation)}`);
  if (!model.assumptions.length) L.push('| (none) | | | | | |');

  L.push('', '## Constraints', '', '| Constraint | Hard | Rule | Verification | Applies to |', '| --- | --- | --- | --- | --- |');
  for (const c of model.constraints) row('constraint', c.id, `${c.hard ? 'yes' : 'no'} | ${cell(c.rule)} | ${c.verification} | ${c.appliesTo.map(refText).join(', ') || '(none)'}`);
  if (!model.constraints.length) L.push('| (none) | | | | |');

  // Migrations are authored by the implementation; the register lists each with the evidence it owes.
  const obligations = deriveObligations(model, undefined, ctx.inputs ?? {});
  L.push('', '## Migrations', '', '| Migration | Contract | Versions | Script | Transaction | Recovery | Evidence obligations |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const m of model.migrations) {
    const owed = obligations.filter((o) => o.claim.kind === 'migration' && o.claim.ref === m.id).flatMap((o) => o.kinds);
    row('migration', m.id, `${refText(m.contract)} | ${m.fromVersion} -> ${m.toVersion} | ${m.script ? code(m.script) : '(none)'} | ${m.transaction} | ${m.recovery} | ${[...new Set([...m.evidence, ...owed])].join(', ')}`);
  }
  if (!model.migrations.length) L.push('| (none) | | | | | | |');

  L.push('', '## Open items', '', 'Derived from the records above and the model\'s findings. Close an item by changing its source record; this list is never edited.', '');
  const items: string[] = [];
  for (const u of model.unknowns) if (u.status === 'open') items.push(`| open unknown | unknown ${code(u.id)} | ${cell(u.question)} | ${cell(u.resolution)} |`);
  for (const r of model.requirements) {
    for (const c of r.criteria) if (c.required && c.verification === 'review') items.push(`| review obligation | criterion ${code(c.id)} | ${cell(c.statement)} | A recorded review of the criterion. |`);
  }
  const findings = validate(model, ctx.inputs ?? {}).filter((f) => OPEN_ITEM_CODES.has(f.code));
  for (const f of findings) items.push(`| ${f.code} | ${findingSource(f)} | ${cell(f.message)} | ${cell(f.fix ?? '')} |`);
  if (!ctx.inputs?.asOf) items.push('| assumption expiry | (all assumptions) | Expiry is not evaluated: no evaluation date was supplied. | Render with evaluation inputs that carry a date. |');
  L.push('| Item | Source | Description | What would close it |', '| --- | --- | --- | --- |', ...(items.length ? items : ['| (none) | | | |']));
  L.push('', `Assumptions with no expiry: ${codes(model.assumptions.filter((a) => !a.expires).map((a) => a.id))}.`);
  return { [REGISTERS_FILE]: toText(L) };
}
