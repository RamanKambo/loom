import type { Diagram, DiagramEdge, DiagramGroup, DiagramKind, DiagramNode, Model, RecordAddress, RecordKind, RenderingBudget, RenderResult, TargetReference } from './generated/types.js';
import { canonicalHash, modelRevision, textHash } from './hash.js';
import { SCHEMA_BUNDLE } from './generated/schemas.js';
import { utf8Bytes } from './discovery.js';
import { indexModel } from './records.js';
import { ownersOf } from './scope.js';

export interface DiagramOptions {
  target?: TargetReference;
  depth?: number;
  page?: number;
  budget?: RenderingBudget;
  sourceVectorDigest?: string;
  /** The owning model's identity, supplied by a persistent workspace. */
  modelId?: string;
}

/** Budget values have one home: the generated RenderingBudget schema. */
export function resolveRenderingBudget(input: RenderingBudget = {}): Required<RenderingBudget> {
  const keywords = SCHEMA_BUNDLE.$defs.RenderingBudget.properties;
  const out = {} as Required<RenderingBudget>;
  for (const k of Object.keys(keywords) as Array<keyof RenderingBudget>) {
    const rule = keywords[k];
    const value = input[k] ?? rule.default;
    if (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum) throw new Error(`rendering budget ${k} is outside ${rule.minimum}..${rule.maximum}`);
    out[k] = value;
  }
  return out;
}

/** Escape each special character before entity interpretation, including authored entity syntax. */
export function escapeDiagramLabel(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[#"`|\[\]<>;&]/g, (c) => `#${c.charCodeAt(0)};`);
}
const encoded = (text: string): string => Array.from(text).map((c) => c.codePointAt(0)!.toString(16)).join('-');
const addressKey = (a: RecordAddress): string => `${a.modelId}:${a.kind}:${a.id}`;
const stable = <T extends { key: string }>(items: T[]): T[] => items.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Build semantics once; browser Mermaid and native layout consume this same graph. */
export function buildDiagram(model: Model, kind: DiagramKind, options: DiagramOptions = {}): Diagram {
  const modelId = options.modelId ?? 'inline';
  const budget = resolveRenderingBudget(options.budget);
  const target = options.target ?? { kind: 'workspace' };
  const depth = options.depth ?? 2;
  if (!Number.isInteger(depth) || depth < 0 || depth > 8) throw new Error('diagram depth is outside 0..8');
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  const groups: DiagramGroup[] = [];
  const gaps = new Map<string, { ref: RecordAddress; reason: string }>();
  const index = indexModel(model);
  const addr = (recordKind: RecordKind, id: string): RecordAddress => {
    const split = id.indexOf(':');
    return split < 0 ? { modelId, kind: recordKind, id } : { modelId: id.slice(0, split), kind: recordKind, id: id.slice(split + 1) };
  };
  const add = (recordKind: DiagramNode['kind'], id: string, label: string = id, owner?: RecordAddress): string => {
    const ref = owner ?? addr(recordKind as RecordKind, id);
    const key = ['state', 'start', 'end'].includes(recordKind) ? `${addressKey(ref)}:${recordKind}:${textHash(id).slice(7, 39)}` : addressKey(ref);
    if (!nodes.has(key)) nodes.set(key, { key, label: label.slice(0, 512) || id, kind: recordKind, owner: ref });
    if (label.length > 512) gaps.set(addressKey(ref), { ref, reason: 'label exceeds the representation limit of 512 characters' });
    return key;
  };
  const edge = (source: string, destination: string, relationship: DiagramEdge['relationship'], label: string, owner: RecordAddress, identity: string, direction: DiagramEdge['direction'] = 'directed'): void => {
    edges.push({ key: `edge:${canonicalHash({ owner, identity, source, destination }).slice(7)}`, source, target: destination, direction, relationship, label: label.slice(0, 512), owners: [owner] });
    if (label.length > 512) gaps.set(addressKey(owner), { ref: owner, reason: 'relationship label exceeds the representation limit of 512 characters' });
  };
  const ensure = (recordKind: RecordKind, id: string): string => {
    const key = add(recordKind, id);
    if (!index.kindsOfId.get(id)?.includes(recordKind)) {
      const ref = addr(recordKind, id);
      gaps.set(addressKey(ref), { ref, reason: `unresolved ${recordKind} '${id}'; its endpoint is shown explicitly` });
    }
    return key;
  };
  if (kind === 'state' || kind === 'state-flowchart') {
    for (const t of model.types.filter((t) => t.stateProperty !== undefined)) {
      const owner = addr('type', t.id);
      const state = (s: string): string => add('state', `${t.id}.${s}`, s, owner);
      for (const s of t.properties.find((p) => p.name === t.stateProperty)?.enumValues ?? []) state(s);
      for (const m of model.mutations.filter((m) => m.type === t.id)) {
        for (const from of m.from) {
          const source = from === '$absent' ? add('start', t.id, 'Start', owner) : state(from);
          edge(source, state(m.to), 'transition', m.id, addr('mutation', m.id), from);
        }
      }
      for (const s of t.terminalStates ?? []) edge(state(s), add('end', t.id, 'End', owner), 'transition', '', owner, `end:${s}`);
    }
  } else if (kind === 'workflow-dependency') {
    for (const w of model.workflows) add('workflow', w.id, `${w.id} (${w.status})`);
    for (const w of model.workflows) {
      const source = add('workflow', w.id, `${w.id} (${w.status})`);
      for (const id of w.dependsOn) edge(source, ensure('workflow', id), 'depends-on', 'depends on', addr('workflow', w.id), `dependency:${id}`);
      for (const id of w.operations ?? []) edge(source, ensure('operation', id), 'uses', 'uses', addr('workflow', w.id), `operation:${id}`);
      for (const id of w.mutations ?? []) edge(source, ensure('mutation', id), 'performs', 'performs', addr('workflow', w.id), `mutation:${id}`);
      for (const step of w.steps) edge(source, ensure(step.action.kind, step.action.id), 'uses', `${step.id}: ${step.action.kind}`, addr('workflow', w.id), `step:${step.id}`);
    }
  } else if (kind === 'component-dependency') {
    for (const c of model.components) add('component', c.id, `${c.id} (${c.kind ?? 'component'})`);
    const endpoints = (id: string): string[] => {
      if (model.components.some((c) => c.id === id)) return [add('component', id, `${id} (${model.components.find((c) => c.id === id)?.kind ?? 'component'})`)];
      const recordKind = index.kindsOfId.get(id)?.[0];
      const owners = recordKind ? ownersOf(index, { kind: recordKind, id }) : [];
      return owners.length ? owners.map((o) => ensure('component', o)) : [ensure(recordKind ?? 'component', id)];
    };
    const occurrences = new Map<string, number>();
    model.edges.forEach((e) => {
      const owner = addr('edge', `${e.from}|${e.to}|${e.kind}`);
      const hash = canonicalHash(e).slice(7), occurrence = occurrences.get(hash) ?? 0;
      occurrences.set(hash, occurrence + 1);
      for (const from of endpoints(e.from)) for (const to of endpoints(e.to)) edge(from, to, e.kind, e.kind, owner, `${hash}:${occurrence}:${from}:${to}`);
    });
  } else if (kind === 'ownership') {
    for (const c of model.components) add('component', c.id);
    const collections = [['type', model.types], ['operation', model.operations], ['routine', model.routines], ['storage', model.storage], ['mutation', model.mutations]] as const;
    for (const [recordKind, records] of collections) for (const r of records) {
      edge(ensure('component', r.owner), add(recordKind, r.id, `${recordKind} ${r.id}`), 'owns', 'owns', addr(recordKind, r.id), 'owner');
    }
  } else if (kind === 'hosting') {
    for (const h of model.hosts) add('host', h.id, `${h.id} (${h.kind})`);
    for (const b of model.trustBoundaries) groups.push({ key: addressKey(addr('trustBoundary', b.id)), label: `${b.id} (${b.kind})`, meaning: 'trust-boundary', members: [], owner: addr('trustBoundary', b.id), ...(b.within ? { parent: addressKey(addr('trustBoundary', b.within)) } : {}) });
    for (const u of model.deploymentUnits) {
      const unit = add('deploymentUnit', u.id, `${u.id}${u.components.length > 1 ? ' (co-hosted)' : ''}`);
      const boundary = groups.find((g) => g.owner.id === u.trustBoundary);
      if (boundary) boundary.members.push(unit);
      else gaps.set(addressKey(addr('deploymentUnit', u.id)), { ref: addr('deploymentUnit', u.id), reason: `unknown trust boundary '${u.trustBoundary}'; unit remains visible` });
      edge(unit, ensure('host', u.host), 'hosted-on', 'hosted on', addr('deploymentUnit', u.id), 'host');
      const members = u.components.map((c) => ensure('component', c));
      groups.push({ key: `${addressKey(addr('deploymentUnit', u.id))}:group`, label: u.id, meaning: 'hosting', members, owner: addr('deploymentUnit', u.id), ...(boundary ? { parent: boundary.key } : {}) });
      for (const c of members) edge(c, unit, 'hosted-on', 'deployed in', addr('deploymentUnit', u.id), c);
    }
  } else {
    for (const w of model.workflows) {
      if (target.kind === 'record' && target.ref.kind === 'workflow' && target.ref.id !== w.id) continue;
      w.steps.forEach((s, i) => {
        const actor = ensure('component', s.actor), destination = ensure('component', s.target);
        const failure = s.failure.handling === 'compensate' && s.failure.compensation ? `compensate by ${s.failure.compensation.kind} ${s.failure.compensation.id}` : s.failure.handling;
        const crossed = workflowTrustCrossings(model, s.actor, s.target);
        edge(actor, destination, 'message', `${i + 1} ${s.id}: ${s.action.kind} ${s.action.id}, on failure ${failure}${crossed.length ? `; trust ${crossed.join(', ')}` : ''}`, addr('workflow', w.id), `${String(i).padStart(6, '0')}:${s.id}`);
      });
    }
  }
  let allNodes = stable([...nodes.values()]);
  let allEdges = kind === 'sequence' ? edges : stable(edges);
  const allGroups = stable(groups);
  const selected = new Set(allNodes.map((n) => n.key));
  if (target.kind === 'record') {
    selected.clear();
    for (const n of allNodes) if (n.owner.kind === target.ref.kind && n.owner.id === target.ref.id) selected.add(n.key);
    for (const e of allEdges) if (e.owners.some((o) => o.kind === target.ref.kind && o.id === target.ref.id)) { selected.add(e.source); selected.add(e.target); }
    for (let d = 0; d < depth; d++) {
      const previous = new Set(selected);
      for (const e of allEdges) if (previous.has(e.source) || previous.has(e.target)) { selected.add(e.source); selected.add(e.target); }
    }
  }
  const inScope = allNodes.filter((n) => selected.has(n.key));
  const count = Math.max(1, Math.ceil(inScope.length / budget.maxNodes));
  const page = options.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > count) throw new Error(`diagram page is outside 1..${count}`);
  const primary = new Set(inScope.slice((page - 1) * budget.maxNodes, page * budget.maxNodes).map((n) => n.key));
  // Boundary endpoints remain explicit: they are marked in limits and the semantic table.
  const pageEdges = allEdges.filter((e) => primary.has(e.source) || primary.has(e.target));
  const boundaryEdges = pageEdges.filter((e) => !primary.has(e.source) || !primary.has(e.target)).map((e) => e.key);
  const visible = new Set([...primary, ...pageEdges.flatMap((e) => [e.source, e.target])]);
  const drawn = allNodes.filter((n) => visible.has(n.key));
  const coverage = new Map<string, Diagram['coverage']['items'][number]>();
  const recordCoverage = (owner: RecordAddress, key: string, isDrawn: boolean, inScope: boolean): void => {
    const k = addressKey(owner), prev = coverage.get(k);
    const status = isDrawn ? 'drawn' : inScope ? 'omitted' : 'out-of-scope';
    if (prev?.status === 'drawn' && !isDrawn) return;
    coverage.set(k, { ref: owner, status, elements: isDrawn ? [...new Set([...(prev?.elements ?? []), key])] : [], ...(!isDrawn ? { reason: inScope ? 'record is on another declared page' : 'record is outside the requested scope' } : {}) });
  };
  for (const n of allNodes) recordCoverage(n.owner, n.key, visible.has(n.key), selected.has(n.key));
  for (const e of allEdges) for (const o of e.owners) recordCoverage(o, e.key, pageEdges.includes(e), selected.has(e.source) || selected.has(e.target));
  for (const g of allGroups) recordCoverage(g.owner, g.key, target.kind === 'workspace' || g.members.some((k) => visible.has(k)), target.kind === 'workspace' || g.members.some((k) => selected.has(k)));
  for (const { ref, reason } of gaps.values()) coverage.set(addressKey(ref), { ref, status: 'omitted', elements: [], reason });
  const diagram: Diagram = { diagramId: `diagram.${kind}.${canonicalHash({ target, depth, page, revision: options.sourceVectorDigest ?? modelRevision(model) }).slice(7, 31)}`, kind, scope: { target, depth, ...(count > 1 ? { page: { index: page, count } } : {}) }, sourceVectorDigest: options.sourceVectorDigest ?? modelRevision(model), nodes: drawn, edges: pageEdges, groups: allGroups.filter((g) => target.kind === 'workspace' || g.members.some((k) => visible.has(k))).map((g) => ({ ...g, members: g.members.filter((k) => visible.has(k)) })), coverage: { complete: count === 1 && gaps.size === 0, items: [...coverage.values()].sort((a, b) => addressKey(a.ref).localeCompare(addressKey(b.ref))) }, limits: { budget, reached: count > 1 || drawn.length > budget.maxNodes ? ['nodes'] : [], boundaryEdges } };
  if (utf8Bytes(toMermaid(diagram)) > budget.maxBytes) { diagram.limits.reached.push('bytes'); diagram.coverage.complete = false; }
  return diagram;
}

/** Boundaries crossed by an interaction, derived from hosting rather than component names. */
export function workflowTrustCrossings(model: Model, actor: string, target: string): string[] {
  const locations = (id: string): string[] => model.deploymentUnits.filter((u) => u.components.includes(id)).map((u) => u.trustBoundary);
  const pairs: string[] = [];
  for (const a of locations(actor)) for (const b of locations(target)) if (a !== b) pairs.push(`${a} -> ${b}`);
  return [...new Set(pairs)].sort();
}

/** Every Mermaid view uses positional aliases only at the final syntax boundary. */
export function toMermaid(graph: Diagram, options: { terminal?: boolean } = {}): string {
  const ids = new Map(graph.nodes.map((n, i) => [n.key, `n${i}`]));
  const label = escapeDiagramLabel;
  const lines: string[] = [];
  if (graph.kind === 'sequence' && !options.terminal) {
    lines.push('sequenceDiagram');
    for (const n of graph.nodes) lines.push(`    participant ${ids.get(n.key)} as ${label(n.label)}`);
    for (const e of graph.edges) lines.push(`    ${ids.get(e.source)}->>${ids.get(e.target)}: ${label(e.label)}`);
  } else if (graph.kind === 'state' && !options.terminal) {
    lines.push('stateDiagram-v2');
    for (const n of graph.nodes) if (n.kind !== 'start' && n.kind !== 'end') lines.push(`    state "${label(n.label)}" as ${ids.get(n.key)}`);
    const endpoint = (key: string): string => ['start', 'end'].includes(graph.nodes.find((n) => n.key === key)?.kind ?? '') ? '[*]' : ids.get(key)!;
    for (const e of graph.edges) lines.push(`    ${endpoint(e.source)} --> ${endpoint(e.target)}${e.label ? ` : ${label(e.label)}` : ''}`);
  } else {
    lines.push(`flowchart ${graph.kind === 'hosting' ? 'TB' : 'LR'}`);
    const emitted = new Set<string>(), active = new Set<string>();
    const node = (key: string, pad: string): void => { if (emitted.has(key)) return; const n = graph.nodes.find((n) => n.key === key); if (!n) return; emitted.add(key); lines.push(`${pad}${ids.get(key)}["${label(n.label)}"]`); };
    const groupIds = new Map(graph.groups.map((g, i) => [g.key, `g${i}`]));
    const groups = options.terminal ? [] : graph.groups;
    const drawGroup = (g: DiagramGroup, pad: string): void => { if (active.has(g.key)) return; active.add(g.key); lines.push(`${pad}subgraph ${groupIds.get(g.key)}["${label(g.label)}"]`); for (const k of g.members) node(k, `${pad}    `); for (const child of groups.filter((c) => c.parent === g.key)) drawGroup(child, `${pad}    `); lines.push(`${pad}end`); };
    for (const g of groups.filter((g) => !g.parent || !groupIds.has(g.parent))) drawGroup(g, '    ');
    for (const g of groups) drawGroup(g, '    ');
    for (const n of graph.nodes) node(n.key, '    ');
    for (const e of graph.edges) lines.push(`    ${ids.get(e.source)} ${e.direction === 'undirected' ? '---' : e.direction === 'bidirectional' ? '<-->' : '-->'}${e.label ? `|"${label(e.label)}"|` : ''} ${ids.get(e.target)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** A complete semantic ledger accompanies layouts, including flattened groups and boundary edges. */
export function diagramSemanticTable(graph: Diagram): string {
  const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/[<>]/g, '\\$&');
  return ['| Element | Meaning | Owner |', '| --- | --- | --- |', ...graph.nodes.map((n) => `| ${cell(n.key)} | ${cell(n.label)} | ${cell(addressKey(n.owner))} |`), ...graph.edges.map((e) => `| ${cell(e.key)} | ${cell(`${e.source} ${e.direction} ${e.target}: ${e.label}`)} | ${e.owners.map(addressKey).map(cell).join(', ')} |`), ...graph.groups.map((g) => `| ${cell(g.key)} | ${cell(`${g.meaning}: ${g.label}; members ${g.members.join(', ')}${g.parent ? `; within ${g.parent}` : ''}`)} | ${cell(addressKey(g.owner))} |`)].join('\n') + '\n';
}

export function renderDiagram(model: Model, kind: DiagramKind, options: DiagramOptions = {}): RenderResult {
  const diagram = buildDiagram(model, kind, options), mermaid = toMermaid(diagram);
  return { diagram, sourceVectorDigest: diagram.sourceVectorDigest, graphDigest: canonicalHash(diagram), mermaidDigest: textHash(mermaid), mermaid, fidelity: { level: 'exact-semantics', transformations: [] }, coverage: diagram.coverage, completeness: { complete: diagram.coverage.complete, truncated: diagram.limits.reached.length > 0, omitted: diagram.coverage.items.filter((i) => i.status !== 'drawn').map((i) => ({ owner: i.ref, reason: i.status === 'out-of-scope' ? 'out-of-scope' : diagram.limits.reached.length ? 'budget' : 'unsupported' })) } };
}

export function buildDiagrams(model: Model, options: DiagramOptions = {}): Diagram[] {
  return (SCHEMA_BUNDLE.$defs.DiagramKind.enum as readonly DiagramKind[]).map((kind) => buildDiagram(model, kind, options));
}

