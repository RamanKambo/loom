import type { Model, Operation, RecordRef } from '../generated/types.js';
import { splitQualified } from '../refs.js';
import { indexModel, resolveProperty, type ModelIndex } from '../records.js';
import { toText } from './notice.js';
import type { RenderContext } from './context.js';
import { cell, code, codes, ownersOfId, refText, viewHeader } from './views.js';

export const ICD_FILE = 'icd.md';

interface Consumed {
  ref: RecordRef;
  owner: string;
  through: string;
}

const bindingText = (o: Operation): string =>
  (o.bindings ?? []).map((b) => (b.transport === 'http' ? `${b.method ?? '?'} ${b.path ?? '?'}` : `${b.transport}${b.channel ? ` ${b.channel}` : ''}`)).join('; ') || '(none)';

/** Records of other components this component's records depend on, each with the relationship that makes it a dependency. */
function consumed(index: ModelIndex, model: Model, component: string): Consumed[] {
  const out = new Map<string, Consumed>();
  const add = (kind: RecordRef['kind'], id: string, owner: string | undefined, through: string): void => {
    if (!owner || owner === component) return;
    const key = `${kind}:${id}:${through}`;
    if (!out.has(key)) out.set(key, { ref: { kind, id }, owner, through });
  };
  const typeOwner = (id: string): string | undefined => (splitQualified(id) ? undefined : index.types.get(id)?.owner);
  for (const o of model.operations.filter((x) => x.owner === component)) {
    for (const inv of o.invokes ?? []) {
      const owner = ownersOfId(index, inv.id)[0];
      add(inv.kind, inv.id, owner, `invoked by operation ${code(o.id)}`);
    }
    for (const t of [o.request, o.response, o.result]) if (t) add('type', t, typeOwner(t), `exchanged by operation ${code(o.id)}`);
  }
  for (const t of model.types.filter((x) => x.owner === component)) {
    for (const p of t.properties) {
      if (p.binds) {
        const target = resolveProperty(index, p.binds);
        if (target) add('type', target.type.id, target.type.owner, `bound by ${code(`${t.id}.${p.name}`)}`);
      }
      if (p.ref) add('type', p.ref, typeOwner(p.ref), `referenced by ${code(`${t.id}.${p.name}`)}`);
    }
  }
  for (const s of model.storage.filter((x) => x.owner === component)) {
    for (const fk of s.foreignKeys ?? []) add('storage', fk.references, model.storage.find((x) => x.id === fk.references)?.owner, `foreign key ${code(`${s.id}.${fk.name}`)}`);
  }
  for (const b of model.consumerBindings.filter((x) => x.consumer.kind === 'component' && x.consumer.id === component)) {
    add(b.contract.kind, b.contract.id, ownersOfId(index, b.contract.id)[0], `consumer binding ${code(b.id)} (${b.compatibility}${b.version !== undefined ? ` version ${b.version}` : ''})`);
  }
  for (const e of model.edges) {
    if (!ownersOfId(index, e.from).includes(component) && e.from !== component) continue;
    for (const owner of e.to === component ? [] : ownersOfId(index, e.to)) {
      const kinds = index.kindsOfId.get(e.to);
      if (kinds?.length === 1) add(kinds[0]!, e.to, owner, `${e.kind} edge from ${code(e.from)}`);
    }
  }
  return [...out.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.ref.kind.localeCompare(b.ref.kind) || a.ref.id.localeCompare(b.ref.id) || a.through.localeCompare(b.through));
}

/**
 * Interface control view of one component: its responsibility, what it
 * provides (operations, routines, events), what it consumes from other
 * components and how, what it owns, where it enforces other operations'
 * concerns, where it is hosted, and the external contracts it consumes.
 */
export function projectIcd(model: Model, ctx: RenderContext): Record<string, string> {
  const id = ctx.component as string;
  const index = indexModel(model);
  const c = model.components.find((x) => x.id === id)!;
  const L = viewHeader(model, `Interface control: component ${code(id)}`, ctx.inputs);
  ctx.covered({ kind: 'component', id }, ICD_FILE, `# Interface control: component ${code(id)}`);
  L.push('## Responsibility', '', cell(c.purpose), '');
  if (c.responsibilities.length) L.push(...c.responsibilities.map((r) => `- ${cell(r)}`), '');
  L.push(`Kind ${c.kind ?? '(undeclared)'}; owner ${c.owner ? code(c.owner) : '(undeclared)'}; implementations ${c.implementations?.length ? c.implementations.map((i) => `${i.language} ${code(i.module)}`).join(', ') : '(none)'}.`, '');

  const operations = model.operations.filter((o) => o.owner === id);
  L.push('## Provides', '', '### Operations', '');
  if (operations.length) {
    L.push('| Operation | Kind | Version | Bindings | Request | Response | Authority |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const o of operations) {
      L.push(`| ${code(o.id)} | ${o.kind} | ${o.version} | ${cell(bindingText(o))} | ${o.request ? code(o.request) : ''} | ${o.response ? code(o.response) : ''} | ${code(o.authority.permission)}${o.authority.scheme ? ` via ${code(o.authority.scheme)}` : ''} |`);
      ctx.covered({ kind: 'operation', id: o.id }, ICD_FILE, `| ${code(o.id)} | ${o.kind} |`);
    }
  } else L.push('None.');
  const routines = model.routines.filter((r) => r.owner === id);
  L.push('', '### Routines', '');
  if (routines.length) {
    L.push('| Routine | Host | Version | Parameters | Result columns |', '| --- | --- | --- | --- | --- |');
    for (const r of routines) {
      L.push(`| ${code(r.id)} | ${r.host} | ${r.version} | ${codes(r.params.map((p) => p.name))} (${r.parameterPassing}) | ${codes(r.resultSet.map((x) => x.name))} |`);
      ctx.covered({ kind: 'routine', id: r.id }, ICD_FILE, `| ${code(r.id)} | ${r.host} |`);
    }
  } else L.push('None.');
  const events = model.types.filter((t) => t.owner === id && t.representation === 'event');
  L.push('', '### Events', '', events.length ? events.map((t) => `- ${code(t.id)} version ${t.version}`).join('\n') : 'None.', '');

  const deps = consumed(index, model, id);
  L.push('## Consumes', '');
  if (deps.length) {
    L.push('| Record | Owner | Through |', '| --- | --- | --- |');
    for (const d of deps) L.push(`| ${refText(d.ref)} | ${code(d.owner)} | ${d.through} |`);
  } else L.push('None.');

  L.push('', '## Owns', '');
  const types = model.types.filter((t) => t.owner === id);
  const storage = model.storage.filter((s) => s.owner === id);
  const mutations = model.mutations.filter((m) => m.owner === id);
  L.push('| Record | Kind | Detail |', '| --- | --- | --- |');
  for (const t of types) {
    L.push(`| ${code(t.id)} | type | ${t.representation}, version ${t.version}, ${t.properties.length} properties |`);
    ctx.covered({ kind: 'type', id: t.id }, ICD_FILE, `| ${code(t.id)} | type |`);
  }
  for (const s of storage) {
    L.push(`| ${code(s.id)} | storage | ${code(`${s.schema}.${s.table}`)} on ${s.platform}, type ${code(s.type)} |`);
    ctx.covered({ kind: 'storage', id: s.id }, ICD_FILE, `| ${code(s.id)} | storage |`);
  }
  for (const m of mutations) {
    L.push(`| ${code(m.id)} | mutation | ${code(m.type)}: ${cell(m.from.join(', '))} -> ${cell(m.to)} |`);
    ctx.covered({ kind: 'mutation', id: m.id }, ICD_FILE, `| ${code(m.id)} | mutation |`);
  }
  if (!types.length && !storage.length && !mutations.length) L.push('| (none) | | |');

  const enforced: string[] = [];
  for (const o of model.operations) {
    const e = o.enforcement;
    if (!e) continue;
    for (const concern of ['authorization', 'validation', 'persistence', 'transport', 'orchestration'] as const) {
      if (e[concern] === id) enforced.push(`| ${code(o.id)} | ${concern} |`);
    }
  }
  L.push('', '## Enforcement', '', enforced.length ? ['| Operation | Concern |', '| --- | --- |', ...enforced].join('\n') : 'This component is named as no operation\'s enforcement owner.', '');

  const units = model.deploymentUnits.filter((u) => u.components.includes(id));
  L.push('## Hosting', '');
  if (units.length) {
    L.push('| Deployment unit | Host | Trust boundary | Co-hosted with |', '| --- | --- | --- | --- |');
    for (const u of units) L.push(`| ${code(u.id)} | ${code(u.host)} | ${code(u.trustBoundary)} | ${codes(u.components.filter((x) => x !== id))} |`);
  } else L.push('No deployment unit hosts this component.');

  const pins = model.publishedContracts.filter((p) => p.consumers.includes(id));
  L.push('', '## External contracts', '');
  if (pins.length) {
    L.push('| Pin | Publisher | Contract | Version | Digest |', '| --- | --- | --- | --- | --- |');
    for (const p of pins) L.push(`| ${code(p.id)} | ${code(p.publisher)} | ${code(p.contract)} | ${p.version} | ${code(p.digest)} |`);
  } else L.push('None.');
  return { [ICD_FILE]: toText(L) };
}
