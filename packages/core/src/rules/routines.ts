import type { Kind, RecordRef } from '../generated/types.js';
import { FINDING } from '../codes.js';
import { columnOf, resolveProperty } from '../records.js';
import { effectiveWrites } from './mutations.js';
import { intentRepair, ref, type Rule, type RuleContext } from './context.js';

const sameDecimal = (a?: { precision: number; scale: number }, b?: { precision: number; scale: number }): boolean =>
  (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.precision === b.precision && a.scale === b.scale);

function checkSlot(
  ctx: RuleContext,
  routineId: string,
  role: 'param' | 'result column',
  slot: { name: string; kind: Kind; nullable: boolean; binds?: string; decimal?: { precision: number; scale: number } },
  path: string,
  about: RecordRef[],
): void {
  if (slot.binds === undefined) {
    if (slot.kind === 'enum') {
      ctx.report(FINDING.ENUM_PARAM_UNBOUND, path, `routine '${routineId}' ${role} '${slot.name}' is an enum but binds no enum property, so its values are unknown`, about, `set binds on ${role} '${slot.name}' to the enum property whose values it carries`);
    }
    return;
  }
  const target = resolveProperty(ctx.index, slot.binds);
  if (!target || !target.property) return;
  const p = target.property;
  const step = `bump routine '${routineId}' version and acknowledge it`;
  if (p.kind !== slot.kind || !sameDecimal(p.decimal, slot.decimal)) {
    ctx.report(FINDING.BINDING_KIND_MISMATCH, path, `routine '${routineId}' ${role} '${slot.name}' is '${slot.kind}' but binds '${slot.binds}', which is '${p.kind}'`, about, `give ${role} '${slot.name}' the kind and shape of '${slot.binds}', then ${step}`);
  }
  if (p.nullable !== slot.nullable) {
    ctx.report(
      FINDING.BINDING_NULLABILITY_MISMATCH,
      path,
      `routine '${routineId}' ${role} '${slot.name}' is ${slot.nullable ? 'nullable' : 'non-nullable'} but binds '${slot.binds}', which is ${p.nullable ? 'nullable' : 'non-nullable'}`,
      about,
      `set ${role} '${slot.name}' nullable to ${String(p.nullable)}, then ${step}`,
    );
  }
}

/** Routine ownership, result sets, write sets, transaction scope and slot bindings. */
export const routineRules: Rule = (ctx) => {
  const storageById = new Map(ctx.model.storage.map((s) => [s.id, s]));
  for (const r of ctx.model.routines) {
    const about = [ref('routine', r.id)];
    const base = `routines/${r.id}`;
    if (r.resultSet.length === 0) {
      ctx.report(FINDING.ROUTINE_EMPTY_RESULTSET, `${base}/resultSet`, `routine '${r.id}' has an empty resultSet`, about, `declare at least one result column on routine '${r.id}'`);
    }
    for (const mid of r.performsMutations) {
      const m = ctx.model.mutations.find((x) => x.id === mid);
      if (m && m.owner !== r.owner) {
        ctx.report(FINDING.ROUTINE_MUTATION_OWNER_MISMATCH, `${base}/performsMutations`, `routine '${r.id}' (owner '${r.owner}') performs mutation '${mid}' owned by '${m.owner}'`, about, `remove '${mid}' from routine '${r.id}' performsMutations and invoke a routine owned by '${m.owner}'`);
      }
    }
    const writes = r.writes ?? [];
    const scope = r.transactionScope ?? [];
    for (const w of writes) {
      const s = storageById.get(w.storage);
      const wpath = `${base}/writes/${w.storage}`;
      if (!s) continue;
      if (s.owner !== r.owner) {
        ctx.report(FINDING.ROUTINE_NONOWNER_STORAGE_WRITE, wpath, `routine '${r.id}' (owner '${r.owner}') writes storage '${s.id}' owned by '${s.owner}'`, about, `remove storage '${s.id}' from routine '${r.id}' writes and invoke a routine owned by '${s.owner}'`);
      }
      for (const c of w.columns) {
        if (!s.columns.some((x) => x.name === c)) {
          ctx.report(FINDING.ROUTINE_WRITES_UNKNOWN_COLUMN, wpath, `routine '${r.id}' writes column '${c}', which storage '${s.id}' does not declare`, about, `write a column of storage '${s.id}': ${s.columns.map((x) => x.name).join(', ')}`);
        }
      }
      if (scope.length && !scope.includes(w.storage)) {
        ctx.report(FINDING.ROUTINE_WRITE_OUTSIDE_TRANSACTION, wpath, `routine '${r.id}' writes storage '${s.id}' outside its declared transaction scope (${scope.join(', ')})`, about, `add '${s.id}' to the transaction scope of routine '${r.id}', or stop writing it`, {
          repairs: [
            intentRepair('widen-scope', `Add '${s.id}' to the transaction scope.`, ['The routine holds locks on one more table inside the same transaction.']),
            intentRepair('remove-write', `Remove the write of '${s.id}'.`, ['The routine no longer changes that table; callers relying on it break.']),
          ],
        });
      }
    }
    // Write-set completeness: every column a performed mutation writes is declared.
    for (const mid of r.performsMutations) {
      const m = ctx.model.mutations.find((x) => x.id === mid);
      const t = m ? ctx.index.types.get(m.type) : undefined;
      if (!m || !t) continue;
      const missing: string[] = [];
      for (const prop of effectiveWrites(m, t)) {
        const stored = columnOf(ctx.index, t.id, prop);
        if (!stored) continue;
        const declared = writes.find((w) => w.storage === stored.storage.id);
        if (!declared || !declared.columns.includes(stored.column.name)) missing.push(`${stored.storage.id}.${stored.column.name}`);
      }
      if (missing.length) {
        ctx.report(FINDING.ROUTINE_WRITE_SET_INCOMPLETE, `${base}/writes`, `routine '${r.id}' performs mutation '${mid}' but does not declare writing ${missing.join(', ')}`, about, `declare ${missing.join(', ')} in routine '${r.id}' writes`);
      }
    }
    for (const p of r.params) checkSlot(ctx, r.id, 'param', p, `${base}/params/${p.name}/binds`, about);
    for (const c of r.resultSet) checkSlot(ctx, r.id, 'result column', c, `${base}/resultSet/${c.name}/binds`, about);
  }
};
