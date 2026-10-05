import type { Diagram, DiagramKind, Model } from './generated/types.js';
import { buildDiagram, diagramSemanticTable, resolveRenderingBudget, toMermaid } from './diagram.js';
import { canonicalHash } from './hash.js';
import { utf8Bytes } from './discovery.js';
import { MARKDOWN_NOTICE } from './projections/notice.js';
import { indexModel } from './records.js';
import { ownersOf } from './scope.js';

export interface SystemViewMember {
  modelId: string;
  model: Model;
  /** Child-owned artifacts are references only, never written by a parent view. */
  artifactReferences?: readonly { path: string; owner: string }[];
}

export function systemDiagram(members: readonly SystemViewMember[], kind: DiagramKind, snapshotDigest: string): Diagram {
  const sorted = [...members].sort((a, b) => a.modelId.localeCompare(b.modelId));
  if (new Set(sorted.map((m) => m.modelId)).size !== sorted.length) throw new Error('system view contains duplicate owning model identities');
  const graphs = sorted.map((m) => buildDiagram(m.model, kind, { modelId: m.modelId, sourceVectorDigest: snapshotDigest, budget: { maxNodes: 2000, maxBytes: 65536 } }));
  const budget = resolveRenderingBudget();
  const graph: Diagram = { diagramId: `diagram.system.${kind}.${canonicalHash({ members: sorted.map((m) => m.modelId), snapshotDigest }).slice(7, 31)}`, kind, sourceVectorDigest: snapshotDigest, scope: { target: { kind: 'workspace' }, depth: 8 }, nodes: graphs.flatMap((g) => g.nodes), edges: graphs.flatMap((g) => g.edges), groups: graphs.flatMap((g) => g.groups), coverage: { complete: graphs.every((g) => g.coverage.complete), items: graphs.flatMap((g) => g.coverage.items) }, limits: { budget, reached: [], boundaryEdges: [] } };
  if (kind === 'component-dependency') {
    const endpoint = (address: Model['agreements'][number]['providers'][number]): string[] => {
      const member = sorted.find((m) => m.modelId === address.modelId);
      const components = member && address.kind !== 'component' ? ownersOf(indexModel(member.model), address) : address.kind === 'component' ? [address.id] : [];
      const refs = components.length ? components.map((id) => ({ modelId: address.modelId, kind: 'component' as const, id })) : [address];
      return refs.map((ref) => { const key = `${ref.modelId}:${ref.kind}:${ref.id}`; if (!graph.nodes.some((n) => n.key === key)) graph.nodes.push({ key, kind: ref.kind, owner: ref, label: `${ref.modelId}: ${ref.id}` }); return key; });
    };
    for (const member of sorted) for (const a of member.model.agreements) {
      const owner = { modelId: member.modelId, kind: 'agreement' as const, id: a.id };
      const elements: string[] = [];
      for (const consumer of a.consumers) for (const provider of a.providers) for (const source of endpoint(consumer)) for (const target of endpoint(provider)) {
        const key = `edge:${canonicalHash({ owner, source, target }).slice(7)}`;
        graph.edges.push({ key, source, target, direction: 'directed', relationship: 'integration', label: `${a.id}: ${a.kind}`, owners: [owner, consumer, provider] }); elements.push(key);
      }
      graph.coverage.items.push({ ref: owner, status: elements.length ? 'drawn' : 'omitted', elements, ...(!elements.length ? { reason: 'agreement has no resolved provider-consumer interaction' } : {}) });
      if (!elements.length) graph.coverage.complete = false;
    }
  }
  graph.nodes.sort((a, b) => a.key.localeCompare(b.key));
  if (kind !== 'sequence') graph.edges.sort((a, b) => a.key.localeCompare(b.key));
  if (graph.nodes.length > budget.maxNodes) graph.limits.reached.push('nodes');
  if (utf8Bytes(toMermaid(graph)) > budget.maxBytes) graph.limits.reached.push('bytes');
  if (graph.limits.reached.length) graph.coverage.complete = false;
  return graph;
}

const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/[<>]/g, '\\$&');
/** Distinct parent-owned system documents; no child interface, SQL or OpenAPI document is emitted. */
export function renderSystemViews(members: readonly SystemViewMember[], snapshotDigest: string): Record<string, string> {
  const sorted = [...members].sort((a, b) => a.modelId.localeCompare(b.modelId));
  const references = ['## Child artifacts (references only)', '', '| Member | Owner | Artifact path |', '| --- | --- | --- |', ...sorted.flatMap((m) => (m.artifactReferences ?? []).map((a) => `| ${cell(m.modelId)} | ${cell(a.owner)} | ${cell(a.path)} |`)), ''].join('\n');
  const view = (title: string, kinds: readonly DiagramKind[]): string => {
    const sections = kinds.flatMap((kind) => {
      const graph = systemDiagram(sorted, kind, snapshotDigest);
      return [`## ${kind}`, '', '```mermaid', toMermaid(graph).trimEnd(), '```', '', diagramSemanticTable(graph), '', `Coverage: ${graph.coverage.complete ? 'complete' : 'incomplete'}${graph.limits.reached.length ? `; limits reached: ${graph.limits.reached.join(', ')}` : ''}.`, ''];
    });
    return [MARKDOWN_NOTICE, `# ${title}`, '', `System snapshot: ${snapshotDigest}.`, '', ...sections, references].join('\n');
  };
  const agreementRows = sorted.flatMap((m) => m.model.agreements.map((a) => `| ${cell(m.modelId)} | ${cell(a.id)} | ${cell(a.kind)} | ${cell(a.constraint)} | ${cell(a.providers.map((p) => `${p.modelId}:${p.kind}:${p.id}`).join(', '))} | ${cell(a.consumers.map((p) => `${p.modelId}:${p.kind}:${p.id}`).join(', '))} |`));
  const bindingRows = sorted.flatMap((m) => m.model.consumerBindings.map((b) => `| ${cell(m.modelId)} | ${cell(b.id)} | ${cell(`${b.consumer.kind}:${b.consumer.id}`)} | ${cell(`${b.contract.kind}:${b.contract.id}`)} | ${b.version} | ${cell(b.status)} |`));
  return {
    'system-component-dependencies.md': view('Loom system component dependencies', ['component-dependency', 'ownership']),
    'system-hosting.md': view('Loom system hosting', ['hosting']),
    'system-workflows.md': view('Loom system workflows and interactions', ['workflow-dependency', 'sequence']),
    'system-agreements.md': [MARKDOWN_NOTICE, '# Loom system agreement map', '', `System snapshot: ${snapshotDigest}.`, '', '| Model | Agreement | Kind | Constraint | Providers | Consumers |', '| --- | --- | --- | --- | --- | --- |', ...agreementRows, '', '| Model | Binding | Consumer | Contract | Version | Status |', '| --- | --- | --- | --- | --- | --- |', ...bindingRows, '', references].join('\n'),
  };
}
