import type { Model, WorkflowStep } from '../generated/types.js';
import { buildDiagram, escapeDiagramLabel, toMermaid } from '../diagram.js';
import { MARKDOWN_NOTICE, toText } from './notice.js';
import type { RenderContext } from './context.js';
import { renderSystemViews } from '../system-views.js';

export const label = escapeDiagramLabel;
export const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;
export function failureText(f: WorkflowStep['failure'], name: (id: string) => string = (id) => id): string {
  return f.handling === 'compensate' && f.compensation ? `compensate by ${f.compensation.kind} ${name(f.compensation.id)}` : f.handling;
}

/** Document rendering only selects a graph scope; all diagram semantics live in diagram.ts. */
export function workflowSections(model: Model, level: number): string[] {
  const h = '#'.repeat(level), lines: string[] = [`${h} State machines`, ''];
  const stateful = model.types.filter((t) => t.stateProperty !== undefined);
  if (!stateful.length) lines.push('No type declares a stateProperty.', '');
  for (const t of stateful) {
    lines.push(`${h}# Type ${code(t.id)} (${code(`${t.id}.${t.stateProperty}`)})`, '', '```mermaid', toMermaid(buildDiagram(model, 'state', { target: { kind: 'record', ref: { kind: 'type', id: t.id } }, depth: 0 })).trimEnd(), '```', '');
  }
  lines.push(`${h} Workflow dependencies`, '');
  if (!model.workflows.length) { lines.push('No workflows.', ''); return lines; }
  lines.push('```mermaid', toMermaid(buildDiagram(model, 'workflow-dependency')).trimEnd(), '```', '');
  lines.push(`${h} Workflow steps`, '');
  for (const w of model.workflows) {
    lines.push(`${h}# Steps of workflow ${code(w.id)}`, '');
    if (!w.steps.length) { lines.push('No steps are declared.', ''); continue; }
    lines.push('```mermaid', toMermaid(buildDiagram(model, 'sequence', { target: { kind: 'record', ref: { kind: 'workflow', id: w.id } }, depth: 0 })).trimEnd(), '```', '');
  }
  return lines;
}
export const WORKFLOW_FILE = 'workflows.md';
export function projectWorkflow(model: Model, ctx: RenderContext): Record<string, string> {
  for (const t of model.types) if (t.stateProperty !== undefined) ctx.covered({ kind: 'type', id: t.id }, WORKFLOW_FILE, `# Type ${code(t.id)} (`);
  for (const w of model.workflows) ctx.covered({ kind: 'workflow', id: w.id }, WORKFLOW_FILE, `["${label(`${w.id} (${w.status})`)}"]`);
  const system = ctx.inputs?.composition;
  const aggregate = system ? ['', '## Aggregate system scope', '', renderSystemViews(system.models, system.snapshotDigest)['system-workflows.md']!] : [];
  return { [WORKFLOW_FILE]: toText([MARKDOWN_NOTICE, '# Loom workflows', '', ...workflowSections(model, 2), ...aggregate]) };
}
