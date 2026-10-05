import type { Model } from '../generated/types.js';
import { buildDiagram, toMermaid } from '../diagram.js';
import { renderSystemViews } from '../system-views.js';
import { toText } from './notice.js';
import type { RenderContext } from './context.js';
import { agreementLocation, agreementRows, cell, code, viewHeader } from './views.js';

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

  const L = viewHeader(model, 'Loom architecture', ctx.inputs);


  L.push('## Component dependencies', '', '```mermaid', toMermaid(buildDiagram(model, 'component-dependency')).trimEnd(), '```', '');
  L.push('| From | To | Kind | Rationale |', '| --- | --- | --- | --- |');
  for (const e of model.edges) {
    L.push(`| ${code(e.from)} | ${code(e.to)} | ${e.kind} | ${e.rationale ? cell(e.rationale) : ''} |`);
    ctx.covered({ kind: 'edge', id: `${e.from}|${e.to}|${e.kind}` }, ARCHITECTURE_FILE, `| ${code(e.from)} | ${code(e.to)} | ${e.kind} |`);
  }
  if (!model.edges.length) L.push('| (none) | | | |');

  L.push('', '## Ownership', '', '```mermaid', toMermaid(buildDiagram(model, 'ownership')).trimEnd(), '```', '');
  L.push('| Component | Kind | Owner | Purpose |', '| --- | --- | --- | --- |');
  for (const c of model.components) {
    L.push(`| ${code(c.id)} | ${c.kind ?? ''} | ${c.owner ? code(c.owner) : ''} | ${cell(c.purpose)} |`);
    ctx.covered({ kind: 'component', id: c.id }, ARCHITECTURE_FILE, `| ${code(c.id)} | ${c.kind ?? ''} |`);
  }

  L.push('', '## Hosting', '', '```mermaid', toMermaid(buildDiagram(model, 'hosting')).trimEnd(), '```', '');
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
  if (ctx.inputs?.composition) {
    const { models, snapshotDigest } = ctx.inputs.composition;
    const system = renderSystemViews(models, snapshotDigest);
    L.push('', '## Aggregate system scope', '', system['system-component-dependencies.md']!, system['system-hosting.md']!, system['system-agreements.md']!);
  }
  return { [ARCHITECTURE_FILE]: toText(L) };
}
