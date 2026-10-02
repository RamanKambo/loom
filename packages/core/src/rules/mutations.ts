import type { Mutation, TypeDef } from '../generated/types.js';
import { FINDING } from '../codes.js';
import { ABSENT_STATE } from '../records.js';
import { intentRepair, mechanicalRepair, ref, type Rule } from './context.js';

/** A creation starts only from '$absent'. */
export const isCreation = (m: Mutation): boolean => m.from.length === 1 && m.from[0] === ABSENT_STATE;

/** Whether the mutation changes the state property: a creation always sets it; an update changes it unless every origin is the target. */
export const changesState = (m: Mutation): boolean => isCreation(m) || m.from.some((f) => f !== m.to);

/**
 * The effective write set: the declared writes plus the state property
 * whenever the transition changes it, so an empty declaration cannot hide a
 * state change from the immutability and ownership checks.
 */
export function effectiveWrites(m: Mutation, t: TypeDef): string[] {
  const out = [...m.writes];
  if (t.stateProperty !== undefined && changesState(m) && !out.includes(t.stateProperty)) out.push(t.stateProperty);
  return out;
}

/** Ownership, legal states, effective writes, creation completeness and traceability of mutations. */
export const mutationRules: Rule = (ctx) => {
  for (const m of ctx.model.mutations) {
    const about = [ref('mutation', m.id)];
    const base = `mutations/${m.id}`;
    const t = ctx.index.types.get(m.type);
    if (t && m.owner !== t.owner) {
      ctx.report(FINDING.MUTATION_NONOWNER, `${base}/owner`, `mutation '${m.id}' owner '${m.owner}' must equal the owner of type '${t.id}' ('${t.owner}')`, about, `move mutation '${m.id}' to component '${t.owner}'`);
    }
    const mixed = m.from.includes(ABSENT_STATE) && m.from.length > 1;
    if (mixed) {
      ctx.report(FINDING.MUTATION_MIXED_ORIGIN, `${base}/from`, `mutation '${m.id}' mixes '${ABSENT_STATE}' with existing states (${m.from.filter((f) => f !== ABSENT_STATE).join(', ')}); a creation and an update are different transitions`, about, `split mutation '${m.id}' into a creation from '${ABSENT_STATE}' and an update from the existing states`, {
        repairs: [intentRepair('split-transition', `Split '${m.id}' into a creation and an update.`, ['Each transition is checked separately; the update loses the creation exemption for immutable writes.'])],
      });
    }
    if (!t) continue;
    const props = new Map(t.properties.map((p) => [p.name, p]));
    if (t.stateProperty === undefined) {
      ctx.report(FINDING.MUTATION_NO_STATE_PROPERTY, base, `mutation '${m.id}' targets type '${t.id}', which declares no stateProperty`, about, `declare a stateProperty on type '${t.id}'`);
    } else {
      const sp = props.get(t.stateProperty);
      const legal = sp && sp.kind === 'enum' ? (sp.enumValues ?? []) : [];
      for (const [field, state] of [...m.from.filter((f) => f !== ABSENT_STATE).map((f) => ['from', f] as const), ['to', m.to] as const]) {
        if (legal.includes(state)) continue;
        ctx.report(FINDING.MUTATION_ILLEGAL_STATE, `${base}/${field}`, `mutation '${m.id}' ${field}-state '${state}' is not a legal state of '${t.id}.${t.stateProperty}'`, about, `use a legal state (${legal.join(', ')})`, {
          repairs: [
            intentRepair('add-state', `Add '${state}' to the states of '${t.id}.${t.stateProperty}'.`, ['A new state enters the contract; every consumer of the state property sees an enum addition.']),
            intentRepair('use-legal-state', `Use one of ${legal.join(', ')} instead of '${state}'.`, ['The transition changes meaning.']),
          ],
        });
      }
      if (changesState(m) && !m.writes.includes(t.stateProperty)) {
        ctx.report(FINDING.MUTATION_STATE_WRITE_UNDECLARED, `${base}/writes`, `mutation '${m.id}' changes '${t.id}.${t.stateProperty}' but does not declare it in writes`, about, `add '${t.stateProperty}' to mutation '${m.id}' writes`, {
          repairs: [
            mechanicalRepair(
              'declare-state-write',
              `Declare '${t.stateProperty}' in the writes of '${m.id}'.`,
              [{ op: 'update', collection: 'mutations', id: m.id, set: { writes: [...m.writes, t.stateProperty] } }],
              ['The transition already changes the state property, so the effective write set is unchanged.'],
            ),
          ],
        });
      }
    }
    const creation = isCreation(m);
    for (const w of m.writes) {
      if (!props.has(w)) {
        ctx.report(FINDING.MUTATION_WRITE_UNKNOWN_PROPERTY, `${base}/writes`, `mutation '${m.id}' writes unknown property '${w}' on type '${t.id}'`, about, `remove '${w}' from mutation '${m.id}' writes`);
      }
    }
    for (const w of effectiveWrites(m, t)) {
      const p = props.get(w);
      if (!p) continue;
      if (p.immutable && !creation) {
        ctx.report(FINDING.MUTATION_IMMUTABLE_WRITE, `${base}/writes`, `mutation '${m.id}' writes immutable property '${t.id}.${w}' outside creation`, about, `stop writing '${w}' in mutation '${m.id}', or make '${t.id}.${w}' mutable`, {
          repairs: [
            intentRepair('remove-write', `Remove '${w}' from the writes of '${m.id}'.`, ['The mutation no longer changes the property; behavior that relied on it breaks.']),
            intentRepair('make-mutable', `Make '${t.id}.${w}' mutable.`, ['Every consumer that relied on the value never changing breaks.']),
          ],
        });
      }
      if (p.writers && !p.writers.includes(m.owner)) {
        ctx.report(FINDING.MUTATION_NONOWNER, `${base}/writes`, `mutation '${m.id}' (owner '${m.owner}') writes '${t.id}.${w}', which only ${p.writers.join(', ')} may write`, about, `perform the write through a mutation owned by ${p.writers.join(' or ')}`);
      }
    }
    if (creation) {
      const written = new Set(effectiveWrites(m, t));
      const missing = t.properties.filter((p) => p.required && !written.has(p.name)).map((p) => p.name);
      if (missing.length) {
        ctx.report(FINDING.MUTATION_CREATION_MISSING_REQUIRED, `${base}/writes`, `creation mutation '${m.id}' must write every required property of '${t.id}'; missing: ${missing.join(', ')}`, about, `add ${missing.map((x) => `'${x}'`).join(', ')} to mutation '${m.id}' writes`);
      }
    }
    if (m.requirements.length === 0) {
      ctx.report(FINDING.MUTATION_NO_REQUIREMENT, `${base}/requirements`, `mutation '${m.id}' has no requirement`, about, `add the requirement mutation '${m.id}' fulfils to its requirements`);
    }
    if (m.scenarios.length === 0) {
      ctx.report(FINDING.MUTATION_NO_SCENARIO, `${base}/scenarios`, `mutation '${m.id}' has no scenario`, about, `add a scenario that exercises mutation '${m.id}' to its scenarios`);
    }
  }
};
