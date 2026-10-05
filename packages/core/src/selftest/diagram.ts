import { buildDiagram, buildDiagrams, escapeDiagramLabel, renderDiagram, toMermaid } from '../diagram.js';
import { sampleModel } from '../sample.js';
import { canonicalStringify } from '../canonical.js';
import { schemaErrors } from '../schema-runtime.js';
import { assert, type Tally } from './harness.js';
interface Section { name: string; run(t: Tally): void }

export const DIAGRAM_SECTIONS: readonly Section[] = [{ name: 'structured diagrams', run: (t) => {
  for (const graph of buildDiagrams(sampleModel())) {
    assert(t, schemaErrors('Diagram', graph).length === 0, `${graph.kind} graph satisfies Diagram: ${JSON.stringify(schemaErrors('Diagram', graph))}`);
    assert(t, canonicalStringify(graph) === canonicalStringify(buildDiagram(sampleModel(), graph.kind)), `${graph.kind} graph is deterministic`);
    assert(t, schemaErrors('RenderResult', renderDiagram(sampleModel(), graph.kind)).length === 0, `${graph.kind} result satisfies the rendering contract`);
    const mermaid = toMermaid(graph);
    const relationshipLines = mermaid.split('\n').filter((line) => /-->|---|<-->|->>/.test(line));
    assert(t, relationshipLines.length === graph.edges.length, `${graph.kind} Mermaid and semantic graph account for the same ${graph.edges.length} relationships`);
    assert(t, graph.coverage.items.every((i) => i.status !== 'drawn' || i.elements.length > 0), `${graph.kind} drawn coverage has actual element keys`);
  }
  const model = sampleModel();
  model.components.push({ id: 'isolated', purpose: 'Standalone library.', responsibilities: [], kind: 'library' });
  model.edges.push({ from: 'ordering', to: 'ordering', kind: 'runtime', cycle: { behavior: 'Repeat with a bounded retry.' } }, { from: 'ordering', to: 'billing', kind: 'semantic' }, { from: 'ordering', to: 'billing', kind: 'runtime' });
  const graph = buildDiagram(model, 'component-dependency');
  assert(t, graph.nodes.some((n) => n.owner.id === 'isolated'), 'isolated component is retained');
  assert(t, graph.edges.some((e) => e.source === e.target), 'component self-loops are retained');
  assert(t, graph.edges.filter((e) => e.source.endsWith(':ordering') && e.target.endsWith(':billing')).length === 2, 'parallel relationships retain separate keys');
  const reordered = structuredCloneModel(model); reordered.components.reverse(); reordered.edges.reverse();
  assert(t, canonicalStringify(buildDiagram(model, 'component-dependency', { sourceVectorDigest: graph.sourceVectorDigest })) === canonicalStringify(buildDiagram(reordered, 'component-dependency', { sourceVectorDigest: graph.sourceVectorDigest })), 'unordered record order cannot change diagram layout semantics');
  const hostile = '` #quot; | [x] " <script> Ω';
  assert(t, escapeDiagramLabel(hostile).includes('#35;quot#59;') && !escapeDiagramLabel(hostile).includes('`') && !escapeDiagramLabel(hostile).includes('<script>'), 'authored entities, markup and delimiters are escaped as data and Unicode retained');
  const paged = buildDiagram(model, 'component-dependency', { budget: { maxNodes: 1 }, page: 1 });
  assert(t, paged.scope.page?.count === graph.nodes.length && paged.limits.reached.includes('nodes') && !paged.coverage.complete, 'pagination declares its complete scope and reached budget');
  assert(t, paged.limits.boundaryEdges.every((key) => paged.edges.some((e) => e.key === key)), 'every declared page boundary edge is shown');
  const unresolved = structuredCloneModel(model); unresolved.types[0]!.owner = 'missing-owner';
  const ownership = buildDiagram(unresolved, 'ownership');
  assert(t, ownership.nodes.some((n) => n.owner.id === 'missing-owner') && ownership.coverage.items.some((i) => i.reason?.includes('unresolved')), 'unmatched owners remain visible and are reported');
  const unbounded = structuredCloneModel(model); unbounded.deploymentUnits[0]!.trustBoundary = 'missing-boundary';
  const hosting = buildDiagram(unbounded, 'hosting');
  assert(t, hosting.nodes.some((n) => n.owner.id === unbounded.deploymentUnits[0]!.id) && hosting.coverage.items.some((i) => i.reason?.includes('unknown trust boundary')), 'unbounded units remain visible and are reported');
} }];
function structuredCloneModel<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
