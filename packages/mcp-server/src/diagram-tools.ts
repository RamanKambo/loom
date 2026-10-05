import { asFinding, canonicalHash, canonicalStringify, envelope, modelRevision, renderDiagram, refusal, resolveRenderingBudget, type DiagramInput, type DiagramResource, type EvaluationInputs, type Model, type ResultEnvelope } from '@loom/core';
import { defaultToolLocator, renderTerminal, TERMINAL_RENDERER_PIN } from '@loom/qualification';
import type { HandleRegistry, Session } from '@loom/workspace';

interface DiagramCall {
  args: Record<string, unknown>;
  session: Session | null;
  model: Model | null;
  inputs: EvaluationInputs;
  context: { handles?: HandleRegistry };
  signal?: AbortSignal;
  stamp(env: ResultEnvelope): ResultEnvelope;
}
const resources = new WeakMap<object, Map<string, DiagramResource>>();

/** Resources are scoped to the connection and exact revision vector; another handle cannot retrieve them. */
export function readDiagramResource(context: { handles?: HandleRegistry }, workspaceId: string, diagramId: string): DiagramResource | null {
  const resource = resources.get(context)?.get(`${workspaceId}:${diagramId}`);
  const resume = context.handles?.resumeInputs(workspaceId);
  if (!resource || !resume || canonicalHash(resume.revisionVector) !== resource.sourceVectorDigest) return null;
  return resource;
}

export async function diagramCall(c: DiagramCall): Promise<ResultEnvelope> {
  const args = c.args as unknown as DiagramInput;
  if (!c.model || !c.session?.workspace) return c.stamp(envelope('loom.diagram', { model: null, findings: [], refusal: refusal('unresolved-context', 'open a readable workspace before drawing its graph') }));
  const resume = c.context.handles?.resumeInputs(args.workspaceId);
  const vector = resume ? canonicalHash(resume.revisionVector) : c.inputs.composition?.snapshotDigest ?? modelRevision(c.model);
  if (args.snapshotDigest && args.snapshotDigest !== vector) return c.stamp(envelope('loom.diagram', { model: c.model, findings: [asFinding('STALE_BASE_REVISION', 'snapshotDigest', 'the requested diagram snapshot is no longer current', 'read current workspace status and request its snapshot')], refusal: refusal('stale-base', 'the requested source vector is stale') }));
  const result = renderDiagram(c.model, args.scope.kind, { target: args.target, depth: args.scope.depth, budget: args.budget, sourceVectorDigest: vector, modelId: c.session.workspace.config.modelId });
  const findings = [];
  if (args.formats.includes('terminal-ascii') && args.formats.includes('terminal-unicode')) return c.stamp(envelope('loom.diagram', { model: c.model, findings: [], refusal: refusal('invalid-input', 'choose one terminal character set per render') }));
  const terminal = args.formats.find((f) => f.startsWith('terminal-'));
  if (terminal && 'nodes' in result.diagram) {
    const tool = await defaultToolLocator()('mermaid-ascii', { exact: TERMINAL_RENDERER_PIN.version, digest: TERMINAL_RENDERER_PIN.digest });
    if (tool.status === 'found') {
      const rendered = await renderTerminal(result.diagram, { tool: tool.tool, budget: args.budget, charset: terminal === 'terminal-ascii' ? 'ascii' : 'unicode', signal: c.signal });
      Object.assign(result, rendered.result);
      if (rendered.finding) findings.push(rendered.finding);
    } else {
      result.fidelity.level = 'unsupported';
      findings.push(asFinding('DIAGRAM_TERMINAL_UNFAITHFUL', 'renderer', tool.reason, 'provision the pinned mermaid-ascii renderer, or request Mermaid'));
    }
  }
  const graph = result.diagram;
  if (!('nodes' in graph) || typeof result.mermaid !== 'string') throw new Error('a fresh diagram render must contain its semantic graph and Mermaid');
  const resource: DiagramResource = { workspaceId: args.workspaceId, diagramId: graph.diagramId, sourceVectorDigest: vector, diagram: graph, mermaid: result.mermaid };
  const cache = resources.get(c.context) ?? new Map<string, DiagramResource>();
  resources.set(c.context, cache); cache.set(`${args.workspaceId}:${graph.diagramId}`, resource);
  while (cache.size > 128) cache.delete(cache.keys().next().value!);
  const text = canonicalStringify(resource), budget = resolveRenderingBudget(args.budget);
  const reference = { uri: `loom://workspaces/${args.workspaceId}/diagrams/${graph.diagramId}`, revision: vector, digest: canonicalHash(resource), bytes: Buffer.byteLength(text) };
  if (!args.formats.includes('graph') || Buffer.byteLength(canonicalStringify(result)) > budget.maxBytes) result.diagram = reference;
  if (!args.formats.includes('mermaid') || Buffer.byteLength(canonicalStringify(result)) > budget.maxBytes) result.mermaid = reference;
  if (Buffer.byteLength(canonicalStringify(result)) > budget.maxBytes) return c.stamp(envelope('loom.diagram', { model: c.model, findings, refusal: refusal('unresolved-context', 'diagram coverage metadata exceeds the requested byte budget; increase maxBytes or narrow the record scope') }));
  return c.stamp(envelope('loom.diagram', { model: c.model, findings, data: { result } }));
}
