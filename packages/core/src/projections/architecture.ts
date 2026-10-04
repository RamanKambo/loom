import type { Model, TrustBoundary } from '../generated/types.js';
import { indexModel } from '../records.js';
import { toText } from './notice.js';
import type { RenderContext } from './context.js';
import { agreementLocation, agreementRows, cell, code, label, ownersOfId, viewHeader } from './views.js';

export const ARCHITECTURE_FILE = 'architecture.md';

/**
 * Architecture view: component dependencies (model edges lifted to the
 * components that own their endpoints, labelled by edge kind), ownership
 * (each component and the records it owns) and hosting (deployment units on
 * hosts inside trust boundaries, each boundary drawn inside the one it lies
 * within, co-hosting marked), then the boundary agreements across owners.
 * Node ids are positional,
 * so a label may hold any character; the tables beneath each diagram list
 * every element the diagram shows.
 */
export function projectArchitecture(model: Model, ctx: RenderContext): Record<string, string> {
  const index = indexModel(model);
  const L = viewHeader(model, 'Loom architecture', ctx.inputs);
  const node = new Map(model.components.map((c, i) => [c.id, `c${i}`]));

  L.push('## Component dependencies', '', '```mermaid', 'flowchart LR');
  model.components.forEach((c, i) => L.push(`    c${i}["${label(`${c.id} (${c.kind ?? 'component'})`)}"]`));
  const lifted = new Set<string>();
  for (const e of model.edges) {
    const from = node.has(e.from) ? [e.from] : ownersOfId(index, e.from);
    const to = node.has(e.to) ? [e.to] : ownersOfId(index, e.to);
    for (const f of from) {
      for (const t of to) {
        if (f === t) continue;
        const line = `    ${node.get(f)} -->|${label(e.kind)}| ${node.get(t)}`;
        if (!lifted.has(line)) lifted.add(line);
      }
    }
  }
  L.push(...[...lifted].sort(), '```', '');
  L.push('| From | To | Kind | Rationale |', '| --- | --- | --- | --- |');
  for (const e of model.edges) {
    L.push(`| ${code(e.from)} | ${code(e.to)} | ${e.kind} | ${e.rationale ? cell(e.rationale) : ''} |`);
    ctx.covered({ kind: 'edge', id: `${e.from}|${e.to}|${e.kind}` }, ARCHITECTURE_FILE, `| ${code(e.from)} | ${code(e.to)} | ${e.kind} |`);
  }
  if (!model.edges.length) L.push('| (none) | | | |');

  L.push('', '## Ownership', '', '```mermaid', 'flowchart LR');
  model.components.forEach((c, i) => L.push(`    c${i}["${label(c.id)}"]`));
  let n = 0;
  const owned: Array<[string, string, string]> = [];
  for (const t of model.types) owned.push([t.owner, 'type', t.id]);
  for (const o of model.operations) owned.push([o.owner, 'operation', o.id]);
  for (const r of model.routines) owned.push([r.owner, 'routine', r.id]);
  for (const s of model.storage) owned.push([s.owner, 'storage', s.id]);
  for (const m of model.mutations) owned.push([m.owner, 'mutation', m.id]);
  for (const [owner, kind, id] of owned) {
    const from = node.get(owner);
    if (!from) continue;
    L.push(`    r${n}(["${label(`${kind} ${id}`)}"])`, `    ${from} --- r${n}`);
    n++;
  }
  L.push('```', '');
  L.push('| Component | Kind | Owner | Purpose |', '| --- | --- | --- | --- |');
  for (const c of model.components) {
    L.push(`| ${code(c.id)} | ${c.kind ?? ''} | ${c.owner ? code(c.owner) : ''} | ${cell(c.purpose)} |`);
    ctx.covered({ kind: 'component', id: c.id }, ARCHITECTURE_FILE, `| ${code(c.id)} | ${c.kind ?? ''} |`);
  }

  L.push('', '## Hosting', '');
  if (!model.deploymentUnits.length && !model.hosts.length) L.push('No deployment unit or host is declared.', '');
  else {
    L.push('```mermaid', 'flowchart TB');
    const hostNode = new Map(model.hosts.map((h, i) => [h.id, `h${i}`]));
    const boundaryIndex = new Map(model.trustBoundaries.map((b, i) => [b.id, i]));
    const parentOf = (b: TrustBoundary): string | undefined => (b.within !== undefined && boundaryIndex.has(b.within) ? b.within : undefined);
    const drawn = new Set<string>();
    // A boundary is drawn inside the one it lies within; one in a nesting cycle is drawn once, at the top level.
    const drawBoundary = (b: TrustBoundary, depth: number): void => {
      if (drawn.has(b.id)) return;
      drawn.add(b.id);
      const pad = '    '.repeat(depth);
      L.push(`${pad}subgraph b${boundaryIndex.get(b.id)}["${label(`${b.id} (${b.kind})`)}"]`);
      model.deploymentUnits.forEach((u, j) => {
        if (u.trustBoundary !== b.id) return;
        const shared = u.components.length > 1 ? ', co-hosted' : '';
        L.push(`${pad}    u${j}["${label(`${u.id}: ${u.components.join(', ')}${shared}`)}"]`);
      });
      for (const child of model.trustBoundaries) if (parentOf(child) === b.id) drawBoundary(child, depth + 1);
      L.push(`${pad}end`);
    };
    for (const b of model.trustBoundaries) if (parentOf(b) === undefined) drawBoundary(b, 1);
    for (const b of model.trustBoundaries) drawBoundary(b, 1);
    model.hosts.forEach((h, i) => L.push(`    h${i}(["${label(`${h.id} (${h.kind})`)}"])`));
    model.deploymentUnits.forEach((u, j) => {
      const h = hostNode.get(u.host);
      if (h) L.push(`    u${j} --> ${h}`);
    });
    L.push('```', '');
  }
  L.push('| Deployment unit | Components | Host | Trust boundary | Co-hosting decision |', '| --- | --- | --- | --- | --- |');
  for (const u of model.deploymentUnits) {
    L.push(`| ${code(u.id)} | ${u.components.map(code).join(', ')} | ${code(u.host)} | ${code(u.trustBoundary)} | ${u.decision ? code(u.decision) : u.components.length > 1 ? '(none)' : ''} |`);
    ctx.covered({ kind: 'deploymentUnit', id: u.id }, ARCHITECTURE_FILE, `| ${code(u.id)} |`);
  }
  L.push('', '| Host | Kind | Triggers | Max timeout | Scaling |', '| --- | --- | --- | --- | --- |');
  for (const h of model.hosts) {
    L.push(`| ${code(h.id)} | ${h.kind} | ${h.capabilities.triggers.join(', ')} | ${h.capabilities.maxTimeout ?? ''} | ${h.capabilities.scaling} |`);
    ctx.covered({ kind: 'host', id: h.id }, ARCHITECTURE_FILE, `| ${code(h.id)} | ${h.kind} |`);
  }
  L.push('', '| Trust boundary | Kind | Description | Within |', '| --- | --- | --- | --- |');
  for (const b of model.trustBoundaries) {
    L.push(`| ${code(b.id)} | ${b.kind} | ${cell(b.description)} | ${b.within ? code(b.within) : ''} |`);
    ctx.covered({ kind: 'trustBoundary', id: b.id }, ARCHITECTURE_FILE, `| ${code(b.id)} | ${b.kind} |`);
  }

  L.push('', '## Boundary agreements', '', ...agreementRows(model.agreements));
  for (const a of model.agreements) ctx.covered({ kind: 'agreement', id: a.id }, ARCHITECTURE_FILE, agreementLocation(a));
  return { [ARCHITECTURE_FILE]: toText(L) };
}
