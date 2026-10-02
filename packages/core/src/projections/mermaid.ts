import type { Model } from '../types.js';
import { ABSENT_STATE } from '../types.js';
import { MARKDOWN_NOTICE, toText } from './notice.js';

/** Mermaid label text: a double quote would end the label, so it becomes an entity. */
function label(s: string): string {
  return s.replace(/"/g, '#quot;').replace(/\r?\n/g, ' ');
}

const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;

/**
 * Markdown sections holding the Mermaid diagrams: one stateDiagram-v2 per
 * stateful type (transitions from its mutations, [*] for $absent, labelled by
 * mutation id) and one flowchart of workflows (dependsOn edges plus the
 * operations and mutations each uses). Node ids are positional, so a label may
 * hold any character.
 */
export function workflowSections(model: Model, level: number): string[] {
  const h = '#'.repeat(level);
  const lines: string[] = [`${h} State machines`, ''];
  const stateful = model.types.filter((t) => t.stateProperty !== undefined);
  if (stateful.length === 0) lines.push('No type declares a stateProperty.', '');
  for (const t of stateful) {
    const sp = t.properties.find((p) => p.name === t.stateProperty);
    const states = sp?.enumValues ?? [];
    const idOf = new Map(states.map((s, i) => [s, `s${i}`]));
    lines.push(`${h}# Type ${code(t.id)} (${code(`${t.id}.${t.stateProperty}`)})`, '', '```mermaid', 'stateDiagram-v2');
    states.forEach((s, i) => lines.push(`    state "${label(s)}" as s${i}`));
    for (const m of model.mutations) {
      if (m.type !== t.id) continue;
      const to = idOf.get(m.to);
      if (to === undefined) continue;
      for (const f of m.from) {
        const from = f === ABSENT_STATE ? '[*]' : idOf.get(f);
        if (from !== undefined) lines.push(`    ${from} --> ${to} : ${label(m.id)}`);
      }
    }
    lines.push('```', '');
  }

  lines.push(`${h} Workflow dependencies`, '');
  if (model.workflows.length === 0) {
    lines.push('No workflows.', '');
    return lines;
  }
  const workflowId = new Map(model.workflows.map((w, i) => [w.id, `w${i}`]));
  const usedOps = model.operations.filter((o) => model.workflows.some((w) => (w.operations ?? []).includes(o.id)));
  const usedMutations = model.mutations.filter((m) => model.workflows.some((w) => (w.mutations ?? []).includes(m.id)));
  const opId = new Map(usedOps.map((o, i) => [o.id, `o${i}`]));
  const mutationId = new Map(usedMutations.map((m, i) => [m.id, `m${i}`]));
  lines.push('```mermaid', 'flowchart LR');
  model.workflows.forEach((w, i) => lines.push(`    w${i}["${label(`${w.id} (${w.status})`)}"]`));
  usedOps.forEach((o, i) => lines.push(`    o${i}(["${label(o.id)}"])`));
  usedMutations.forEach((m, i) => lines.push(`    m${i}{{"${label(m.id)}"}}`));
  for (const w of model.workflows) {
    const from = workflowId.get(w.id) as string;
    for (const d of w.dependsOn) {
      const to = workflowId.get(d);
      if (to !== undefined) lines.push(`    ${from} -->|depends on| ${to}`);
    }
    for (const o of w.operations ?? []) {
      const to = opId.get(o);
      if (to !== undefined) lines.push(`    ${from} -.->|uses| ${to}`);
    }
    for (const m of w.mutations ?? []) {
      const to = mutationId.get(m);
      if (to !== undefined) lines.push(`    ${from} -.->|performs| ${to}`);
    }
  }
  lines.push('```', '');
  return lines;
}

/** Markdown file of the workflow and state-machine diagrams. */
export function projectWorkflow(model: Model): string {
  return toText([MARKDOWN_NOTICE, '# Loom workflows', '', ...workflowSections(model, 2)]);
}
