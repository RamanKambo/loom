import type { FieldMapping, Property, TypeDef } from '../generated/types.js';
import { FINDING } from '../codes.js';
import { canonicalJson } from '../canonical.js';
import { splitQualified } from '../refs.js';
import { findCycles } from './structure.js';
import { intentRepair, ref, type Rule, type RuleContext } from './context.js';

const PUBLIC_REPRESENTATIONS = new Set(['request', 'response', 'event']);
const COPYING = new Set(['copy', 'rename']);

/** Why a source value does not fit its destination without loss, or null when it fits. */
function lossOf(src: Property, dst: Property): string | null {
  if (src.kind === 'decimal' && dst.kind === 'number') return 'an exact decimal becomes binary floating point';
  if (src.kind === 'number' && dst.kind === 'integer') return 'a fractional number becomes an integer';
  if (src.kind === 'decimal' && dst.kind === 'integer') return 'a decimal loses its fraction digits';
  if (src.kind === 'decimal' && dst.kind === 'decimal' && src.decimal && dst.decimal) {
    if (dst.decimal.scale < src.decimal.scale) return `scale ${src.decimal.scale} narrows to ${dst.decimal.scale}`;
    if (dst.decimal.precision - dst.decimal.scale < src.decimal.precision - src.decimal.scale) return `integer digits ${src.decimal.precision - src.decimal.scale} narrow to ${dst.decimal.precision - dst.decimal.scale}`;
  }
  if (src.kind === 'string' && dst.kind === 'string' && dst.bounds?.maxLength !== undefined) {
    const from = src.bounds?.maxLength;
    if (from === undefined || from > dst.bounds.maxLength) return `length ${from ?? 'unbounded'} narrows to ${dst.bounds.maxLength}`;
  }
  if (src.kind === 'enum' && dst.kind === 'enum') {
    const missing = (src.enumValues ?? []).filter((v) => !(dst.enumValues ?? []).includes(v));
    if (missing.length) return `values ${missing.join(', ')} have no destination value`;
  }
  return null;
}

const supplied = (f: FieldMapping, dst: Property): boolean => f.transform === 'default' || f.transform === 'constant' || f.value !== undefined || (dst.default !== undefined && dst.default.policy !== 'none');

/** Mappings between representations: fields, kinds, loss, nullability, exposure and trust. */
export const representationRules: Rule = (ctx: RuleContext) => {
  for (const m of ctx.model.mappings) {
    if (splitQualified(m.from) || splitQualified(m.to)) continue;
    const from = ctx.index.types.get(m.from);
    const to = ctx.index.types.get(m.to);
    if (!from || !to) continue;
    const about = [ref('mapping', m.id)];
    const prop = (t: TypeDef, name: string | undefined): Property | undefined => (name === undefined ? undefined : t.properties.find((p) => p.name === name));
    for (const f of m.fields) {
      const path = `mappings/${m.id}/fields/${f.to}`;
      const src = prop(from, f.from);
      const dst = prop(to, f.to);
      const unknown = [f.from !== undefined && !src ? `'${f.from}' on '${from.id}'` : null, !dst ? `'${f.to}' on '${to.id}'` : null].filter(Boolean);
      if (unknown.length) {
        ctx.report(FINDING.MAPPING_FIELD_UNKNOWN, path, `mapping '${m.id}' names ${unknown.join(' and ')}, which do not exist`, about, `map properties that exist on '${from.id}' and '${to.id}'`);
        continue;
      }
      if (!src || !dst) continue;
      if (COPYING.has(f.transform) && src.kind !== dst.kind) {
        ctx.report(FINDING.MAPPING_KIND_MISMATCH, path, `mapping '${m.id}' ${f.transform}s '${src.name}' (${src.kind}) into '${dst.name}' (${dst.kind})`, about, `declare the field as a conversion with its rules, or map properties of one kind`);
      }
      const loss = lossOf(src, dst);
      if (loss && !(f.conversion?.lossy === true && f.conversion.rounding !== undefined)) {
        ctx.report(FINDING.MAPPING_LOSSY_UNDECLARED, path, `mapping '${m.id}' loses information from '${src.name}' to '${dst.name}': ${loss}`, about, `declare conversion.lossy with its rounding on the '${f.to}' field, or widen '${to.id}.${dst.name}'`, {
          repairs: [intentRepair('declare-loss', `Declare the conversion of '${f.to}' as lossy with its rounding.`, ['Consumers of the destination receive rounded or truncated values; that behavior becomes part of the contract.'])],
        });
      }
      if ((src.nullable || !src.required) && dst.required && !dst.nullable && !supplied(f, dst)) {
        ctx.report(FINDING.MAPPING_NULLABILITY_NARROWED, path, `mapping '${m.id}' feeds ${src.nullable ? 'nullable' : 'optional'} '${src.name}' into required, non-nullable '${dst.name}' without a default`, about, `give '${to.id}.${dst.name}' a default, supply a value in the mapping, or make it optional`);
      }
      if (from.representation === 'request' && dst.origin === 'system') {
        ctx.report(FINDING.REPRESENTATION_TRUST_VIOLATION, path, `mapping '${m.id}' accepts server-owned '${to.id}.${dst.name}' from caller-supplied '${from.id}.${src.name}'`, about, `remove the '${f.to}' field from mapping '${m.id}'; the system assigns '${dst.name}'`, {
          repairs: [intentRepair('caller-supplied', `Change '${to.id}.${dst.name}' to a client-origin property.`, ['Callers gain control over the value; the server no longer owns it.'])],
        });
      }
      const privateSource = src.visibility === 'private' || src.visibility === 'internal' || from.representation === 'storage' || from.visibility === 'private';
      if (PUBLIC_REPRESENTATIONS.has(to.representation) && privateSource && !f.exposure) {
        ctx.report(FINDING.REPRESENTATION_EXPOSES_PRIVATE, path, `mapping '${m.id}' exposes ${src.visibility ?? from.representation} '${from.id}.${src.name}' on ${to.representation} '${to.id}' without an accepted exposure`, about, `remove the '${f.to}' field, or record the decision that permits the exposure in its exposure`);
      }
    }
    const mapped = new Set(m.fields.map((f) => f.to));
    for (const side of ['from', 'to'] as const) {
      const t = side === 'from' ? from : to;
      for (const u of (m.unmapped ?? []).filter((x) => x.side === side)) {
        if (!t.properties.some((p) => p.name === u.property)) {
          ctx.report(FINDING.MAPPING_FIELD_UNKNOWN, `mappings/${m.id}/unmapped/${side}|${u.property}`, `mapping '${m.id}' lists unmapped '${u.property}', which '${t.id}' does not declare`, about, `list only properties of '${t.id}' as unmapped`);
        }
      }
    }
    const explained = new Set((m.unmapped ?? []).filter((u) => u.side === 'to').map((u) => u.property));
    for (const p of to.properties) {
      if (!p.required || mapped.has(p.name) || explained.has(p.name)) continue;
      ctx.report(FINDING.MAPPING_INCOMPLETE, `mappings/${m.id}/fields`, `mapping '${m.id}' leaves required '${to.id}.${p.name}' neither mapped nor explained`, about, `map '${p.name}', or list it in unmapped with the reason it has no source`);
    }
  }
};

const VERSIONED = new Set(['type', 'operation', 'routine']);

/** Migration contracts: versions, dependency order and their presence for changed storage. */
export const migrationRules: Rule = (ctx: RuleContext) => {
  const ids = new Set(ctx.model.migrations.map((m) => m.id));
  for (const m of ctx.model.migrations) {
    const problems: string[] = [];
    if (m.toVersion <= m.fromVersion) problems.push(`it moves from version ${m.fromVersion} to ${m.toVersion}`);
    if (VERSIONED.has(m.contract.kind)) {
      const current = (ctx.index.byKind.get(m.contract.kind)?.get(m.contract.id) as { version?: number } | undefined)?.version;
      if (current !== undefined && m.toVersion > current) problems.push(`its target version ${m.toVersion} is above the contract's current version ${current}`);
    }
    if (problems.length) {
      ctx.report(FINDING.MIGRATION_VERSION_INVALID, `migrations/${m.id}`, `migration '${m.id}' is inconsistent: ${problems.join('; ')}`, [ref('migration', m.id)], `make migration '${m.id}' move its contract from a lower version to the current one`);
    }
  }
  const deps = new Map(ctx.model.migrations.map((m) => [m.id, m.dependsOn.filter((d) => ids.has(d))]));
  for (const cycle of findCycles([...ids].sort(), (n) => deps.get(n) ?? [])) {
    ctx.report(FINDING.MIGRATION_DEPENDENCY_CYCLE, `migrations: ${cycle.join(' -> ')}`, `migration dependency cycle: ${cycle.join(' -> ')}`, cycle.map((id) => ref('migration', id)), `remove one dependsOn link in ${cycle.join(' -> ')}`);
  }
  const base = ctx.inputs.baseline?.model;
  if (!base) return;
  for (const s of ctx.model.storage) {
    const before = base.storage.find((x) => x.id === s.id);
    if (!before) continue;
    const shape = (cols: typeof s.columns): string => canonicalJson(cols.map((c) => ({ name: c.name, sqlType: c.sqlType, nullable: c.nullable })).sort((a, b) => a.name.localeCompare(b.name)));
    if (shape(before.columns) === shape(s.columns)) continue;
    const covered = ctx.model.migrations.some((m) => (m.contract.kind === 'storage' && m.contract.id === s.id) || (m.contract.kind === 'type' && m.contract.id === s.type));
    if (covered) continue;
    // An open unknown about the stored record stands in for its migration explicitly; it blocks the task classes it names.
    const pending = ctx.model.unknowns.some((u) => u.status === 'open' && u.affects.some((a) => (a.kind === 'storage' && a.id === s.id) || (a.kind === 'type' && a.id === s.type)));
    if (pending) continue;
    ctx.report(FINDING.MIGRATION_MISSING, `storage/${s.id}/columns`, `the columns of storage '${s.id}' changed since the accepted baseline, but no migration covers it`, [ref('storage', s.id)], `declare a migration whose contract is storage '${s.id}' or type '${s.type}', with its readers, writers, backfill and recovery`);
  }
};
