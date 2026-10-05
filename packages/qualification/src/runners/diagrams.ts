import { buildDiagram, sampleModel, type DiagramKind } from '@loom/core';
import { renderTerminal } from '../diagram.js';
import { outcome, type Runner } from '../types.js';

/** Every supported native view, including state conversion, sequence order and nested group legends. */
export const mermaidTerminal: Runner = async (ctx) => {
  const fixture = sampleModel();
  fixture.components = fixture.components.filter((c) => c.id === 'ordering' || c.id === 'billing');
  fixture.types = fixture.types.slice(0, 1);
  fixture.operations = fixture.operations.filter((o) => o.id === 'order.place' || o.id === 'order.get');
  fixture.routines = [];
  fixture.storage = [];
  fixture.mutations = fixture.mutations.filter((m) => m.type === 'order');
  fixture.workflows = fixture.workflows.slice(0, 1);
  fixture.hosts = fixture.hosts.slice(0, 1);
  fixture.deploymentUnits = fixture.deploymentUnits.slice(0, 1);
  fixture.trustBoundaries = fixture.trustBoundaries.filter((b) => b.id === fixture.deploymentUnits[0]?.trustBoundary || b.id === 'tb.internal');
  fixture.edges = [
    { from: fixture.components[0]!.id, to: fixture.components[0]!.id, kind: 'runtime' },
    { from: fixture.components[0]!.id, to: fixture.components[1]!.id, kind: 'runtime' },
    { from: fixture.components[0]!.id, to: fixture.components[1]!.id, kind: 'semantic' },
    { from: fixture.components[1]!.id, to: fixture.components[0]!.id, kind: 'runtime' },
  ];
  const kinds: DiagramKind[] = ['state', 'state-flowchart', 'workflow-dependency', 'component-dependency', 'ownership', 'hosting', 'sequence'];
  const measurements: string[] = [];
  for (const kind of kinds) {
    const graph = buildDiagram(fixture, kind);
    const render = await renderTerminal(graph, { tool: ctx.tool, charset: 'unicode', signal: ctx.signal });
    measurements.push(`${kind}: ${render.bytes} bytes, ${render.durationMs} ms`);
    if (render.status !== 'PASS') return outcome(render.status, `${kind}: ${render.reason}; measured ${measurements.join('; ')}`);
  }
  const hostile = buildDiagram(fixture, 'component-dependency');
  hostile.nodes[0]!.label = 'Repeated [label] | #quot; `data` Ω ' + 'long text '.repeat(15);
  hostile.nodes[1]!.label = hostile.nodes[0]!.label;
  const special = await renderTerminal(hostile, { tool: ctx.tool });
  if (special.status !== 'PASS') return outcome(special.status, `escaped/Unicode/long/repeated labels: ${special.reason}`);
  // A impossible byte budget must fail even when the native tool succeeds.
  const limited = await renderTerminal(hostile, { tool: ctx.tool, budget: { maxBytes: 1024 } });
  if (limited.status === 'PASS') return outcome('FAIL', 'terminal negative control exceeded its byte budget but passed');
  return outcome('PASS', `every required diagram kind preserves node/edge token coverage and semantic legends; ${measurements.join('; ')}; Unicode/escaping/long/repeated-label control passes and over-budget control is rejected`);
};
