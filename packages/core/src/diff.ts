import type { Change, Model, RecordRef, AffectedElement } from './generated/types.js';
import { SCHEMA_BUNDLE } from './generated/schemas.js';
import { canonicalJson, deepEqual } from './canonical.js';
import { KIND_OF_COLLECTION, keyOf, type CollectionName } from './records.js';
import { DependencyGraph, dependencyGraph } from './graph.js';
import { DIFF_RULES, FIELD_POLICY, type Delta, type DiffRuleId, type FieldPolicy } from './field-policy.js';

export { DIFF_RULES, FIELD_POLICY } from './field-policy.js';
export type { DiffRule, DiffRuleId, FieldPolicy, Delta } from './field-policy.js';

type SchemaNode = Record<string, unknown>;
const DEFS = SCHEMA_BUNDLE.$defs as unknown as Record<string, SchemaNode>;

/** Value objects compared and replaced as a whole. */
const isAtomic = (def: string): boolean => DEFS[def]?.['x-loom-atomic'] === true;
const defOf = (node: SchemaNode): string | undefined => (typeof node['$ref'] === 'string' ? (node['$ref'] as string).slice('#/$defs/'.length) : undefined);
const keyFields = (node: SchemaNode): string[] | undefined => {
  const k = node['x-loom-key'];
  return k === undefined ? undefined : Array.isArray(k) ? (k as string[]) : [k as string];
};

/** How a schema node is compared. */
type Shape =
  | { kind: 'leaf' }
  | { kind: 'object'; def: string; props: Record<string, SchemaNode> }
  | { kind: 'keyed'; key: string[]; ordered: boolean; item: SchemaNode }
  | { kind: 'paired'; item: SchemaNode }
  | { kind: 'set' }
  | { kind: 'sequence' };

function shapeOf(node: SchemaNode, stack: readonly string[]): { shape: Shape; def?: string } {
  const def = defOf(node);
  if (def) {
    const target = DEFS[def] as SchemaNode;
    if (isAtomic(def) || stack.includes(def) || !target['properties']) return { shape: { kind: 'leaf' } };
    return { shape: { kind: 'object', def, props: target['properties'] as Record<string, SchemaNode> }, def };
  }
  if (node['type'] === 'array') {
    const item = node['items'] as SchemaNode;
    const key = keyFields(node);
    if (key) return { shape: { kind: 'keyed', key, ordered: node['x-loom-ordered'] === true, item } };
    const itemDef = defOf(item);
    if (itemDef && !isAtomic(itemDef) && (DEFS[itemDef] as SchemaNode)['properties']) return { shape: { kind: 'paired', item } };
    return { shape: { kind: node['x-loom-ordered'] === true ? 'sequence' : 'set' } };
  }
  if (node['type'] === 'object' && node['properties'] && node['additionalProperties'] === false) {
    return { shape: { kind: 'object', def: '', props: node['properties'] as Record<string, SchemaNode> } };
  }
  return { shape: { kind: 'leaf' } };
}

interface WalkSink {
  delta(key: string, event: Delta['event'], before: unknown, after: unknown, path: string, item: ItemContext): void;
  /** Every policy key the walk reaches, with the registry path that reaches it; used for coverage. */
  reach?(key: string, registryPath: string): void;
}

interface ItemContext {
  before: unknown;
  after: unknown;
  field: string | undefined;
}

function walk(
  node: SchemaNode,
  owner: string,
  inline: string,
  before: unknown,
  after: unknown,
  path: string,
  registryPath: string,
  item: ItemContext,
  stack: readonly string[],
  sink: WalkSink,
): void {
  const { shape, def } = shapeOf(node, stack);
  const key = `${owner}.${inline}`;
  if (shape.kind === 'object') {
    const nextOwner = def ?? owner;
    const nextStack = def ? [...stack, def] : stack;
    for (const [prop, sub] of Object.entries(shape.props)) {
      const b = (before as Record<string, unknown> | undefined)?.[prop];
      const a = (after as Record<string, unknown> | undefined)?.[prop];
      const nextInline = def ? prop : `${inline}.${prop}`;
      walk(sub, nextOwner, nextInline, b, a, `${path}/${prop}`, `${registryPath}.${prop}`, item, nextStack, sink);
    }
    return;
  }
  sink.reach?.(shape.kind === 'leaf' ? key : `${key}[]`, shape.kind === 'leaf' ? registryPath : `${registryPath}[]`);
  if (shape.kind === 'leaf') {
    if (!deepEqual(before, after)) sink.delta(key, 'changed', before, after, path, item);
    return;
  }
  const bArr = Array.isArray(before) ? before : [];
  const aArr = Array.isArray(after) ? after : [];
  const arrKey = `${key}[]`;
  if (shape.kind === 'sequence') {
    if (!deepEqual(bArr, aArr)) sink.delta(arrKey, 'changed', before, after, path, item);
    return;
  }
  if (shape.kind === 'set') {
    const bSet = new Map(bArr.map((v) => [canonicalJson(v), v]));
    const aSet = new Map(aArr.map((v) => [canonicalJson(v), v]));
    for (const [k, v] of bSet) if (!aSet.has(k)) sink.delta(arrKey, 'removed', v, undefined, path, item);
    for (const [k, v] of aSet) if (!bSet.has(k)) sink.delta(arrKey, 'added', undefined, v, path, item);
    return;
  }
  const field = inline.split('.').pop();
  if (shape.kind === 'paired') {
    const n = Math.max(bArr.length, aArr.length);
    for (let i = 0; i < n; i++) {
      const b = bArr[i];
      const a = aArr[i];
      const p = `${path}/${i}`;
      if (b === undefined) sink.delta(arrKey, 'added', undefined, a, p, item);
      else if (a === undefined) sink.delta(arrKey, 'removed', b, undefined, p, item);
      else walk(shape.item, owner, `${inline}[]`, b, a, p, `${registryPath}[]`, item, stack, sink);
    }
    if (n === 0) walk(shape.item, owner, `${inline}[]`, undefined, undefined, `${path}/0`, `${registryPath}[]`, item, stack, { delta: () => undefined, reach: sink.reach });
    return;
  }
  const bMap = new Map(bArr.map((v) => [keyOf(v, shape.key), v]));
  const aMap = new Map(aArr.map((v) => [keyOf(v, shape.key), v]));
  for (const [k, v] of bMap) if (!aMap.has(k)) sink.delta(arrKey, 'removed', v, undefined, `${path}/${k}`, item);
  for (const [k, v] of aMap) if (!bMap.has(k)) sink.delta(arrKey, 'added', undefined, v, `${path}/${k}`, item);
  if (shape.ordered) {
    const common = [...aMap.keys()].filter((k) => bMap.has(k));
    const beforeOrder = [...bMap.keys()].filter((k) => aMap.has(k));
    common.forEach((k, i) => {
      if (beforeOrder[i] !== k) sink.delta(arrKey, 'moved', beforeOrder.indexOf(k), i, `${path}/${k}`, item);
    });
  }
  const recurse = (b: unknown, a: unknown, p: string, s: WalkSink): void =>
    walk(shape.item, owner, `${inline}[]`, b, a, p, `${registryPath}[]`, { before: b, after: a, field }, stack, s);
  for (const [k, b] of bMap) {
    const a = aMap.get(k);
    if (a !== undefined) recurse(b, a, `${path}/${k}`, sink);
  }
  if (sink.reach) recurse(undefined, undefined, `${path}/*`, { delta: () => undefined, reach: sink.reach });
}

/**
 * Every policy key the comparison walk reaches from the model root, with a
 * registry path that reaches it. The self-test asserts each has a FIELD_POLICY
 * entry and that every generated FIELD_PATHS entry is reached.
 */
export function reachablePolicyKeys(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const model = DEFS['Model'] as SchemaNode;
  const props = model['properties'] as Record<string, SchemaNode>;
  const reach = (key: string, registryPath: string): void => {
    const list = out.get(key) ?? [];
    if (!list.includes(registryPath)) list.push(registryPath);
    out.set(key, list);
  };
  const sink: WalkSink = { delta: () => undefined, reach };
  for (const [prop, node] of Object.entries(props)) {
    if (node['type'] === 'array') {
      reach(`Model.${prop}[]`, `${prop}[]`);
      walk(node['items'] as SchemaNode, 'Model', `${prop}[]`, undefined, undefined, prop, `${prop}[]`, { before: undefined, after: undefined, field: undefined }, [], sink);
    } else walk(node, 'Model', prop, undefined, undefined, prop, prop, { before: undefined, after: undefined, field: undefined }, [], sink);
  }
  return out;
}

export interface DiffOptions {
  /** Dependency graphs of both models, when the caller already built them. */
  graphs?: { before: DependencyGraph; after: DependencyGraph };
  /** The comparison policy; FIELD_POLICY unless a caller qualifies the differ against another table. */
  policy?: Readonly<Record<string, FieldPolicy>>;
}

function describe(rule: DiffRuleId, d: Pick<Delta, 'event' | 'before' | 'after' | 'path'>): string {
  const base = DIFF_RULES[rule].change;
  const show = (v: unknown): string => (v === undefined ? '(absent)' : typeof v === 'string' ? `'${v}'` : canonicalJson(v));
  if (d.event === 'changed') return `${base} ${show(d.before)} -> ${show(d.after)}.`;
  if (d.event === 'moved') return `${base} Position ${String(d.before)} -> ${String(d.after)}.`;
  return base;
}

/**
 * Every semantic delta between two models, classified by rule, kind and
 * compatibility dimension. A delta without a policy entry is 'requiresReview'
 * under CHANGE_REQUIRES_REVIEW: never empty, never assumed compatible. A
 * nonSemantic policy suppresses the delta with its stated reason.
 */
export function diff(before: Model, after: Model, options: DiffOptions = {}): Change[] {
  const changes: Change[] = [];
  const graphs = options.graphs ?? { before: dependencyGraph(before), after: dependencyGraph(after) };
  const consumerCache = new Map<string, AffectedElement[]>();
  const consumersOf = (ref: RecordRef): AffectedElement[] => {
    const k = `${ref.kind}:${ref.id}`;
    const cached = consumerCache.get(k);
    if (cached) return cached;
    const b = graphs.before.consumersOf([ref]);
    const a = graphs.after.consumersOf([ref]);
    const out: AffectedElement[] = [];
    for (const [key, c] of b) out.push({ ref: c.ref, reason: a.has(key) ? 'depends-on' : 'former-consumer', path: c.path, edgeKinds: c.edgeKinds });
    for (const [key, c] of a) if (!b.has(key)) out.push({ ref: c.ref, reason: 'new-consumer', path: c.path, edgeKinds: c.edgeKinds });
    out.sort((x, y) => x.ref.kind.localeCompare(y.ref.kind) || x.ref.id.localeCompare(y.ref.id));
    consumerCache.set(k, out);
    return out;
  };

  const record = (element: RecordRef, recordBefore: unknown, recordAfter: unknown) => (key: string, event: Delta['event'], b: unknown, a: unknown, path: string, item: ItemContext): void => {
    const d: Delta = {
      key,
      event,
      before: b,
      after: a,
      path,
      element,
      recordBefore,
      recordAfter,
      itemBefore: item.before,
      itemAfter: item.after,
      itemField: item.field,
      modelBefore: before,
      modelAfter: after,
    };
    const policy = (options.policy ?? FIELD_POLICY)[key];
    if (policy && 'nonSemantic' in policy) return;
    if (!policy) {
      changes.push({ path, kind: 'requiresReview', dimension: 'none', rule: 'CHANGE_REQUIRES_REVIEW', reason: `No comparison rule classifies ${key} (${event}); the change requires review.`, element: element.id, elementKind: element.kind, consumers: consumersOf(element), before: b, after: a });
      return;
    }
    const v = policy.classify(d);
    if (v.kind === 'nonSemantic') return;
    const change: Change = { path, kind: v.kind, dimension: v.dimension, rule: v.rule, reason: describe(v.rule, d), element: element.id, elementKind: element.kind, consumers: consumersOf(element) };
    if (b !== undefined) change.before = b;
    if (a !== undefined) change.after = a;
    changes.push(change);
  };

  const modelDef = DEFS['Model'] as SchemaNode;
  for (const [prop, node] of Object.entries(modelDef['properties'] as Record<string, SchemaNode>)) {
    const b = (before as unknown as Record<string, unknown>)[prop];
    const a = (after as unknown as Record<string, unknown>)[prop];
    if (node['type'] !== 'array') {
      const element: RecordRef = { kind: 'systemProfile', id: 'system' };
      walk(node, 'Model', prop, b, a, prop, prop, { before: undefined, after: undefined, field: undefined }, [], { delta: record(element, b, a) });
      continue;
    }
    const kind = KIND_OF_COLLECTION[prop as CollectionName];
    const key = keyFields(node) ?? ['id'];
    const bMap = new Map(((b as unknown[]) ?? []).map((r) => [keyOf(r, key), r]));
    const aMap = new Map(((a as unknown[]) ?? []).map((r) => [keyOf(r, key), r]));
    for (const [id, r] of bMap) {
      if (!aMap.has(id)) record({ kind, id }, r, undefined)(`Model.${prop}[]`, 'removed', r, undefined, `${prop}/${id}`, { before: undefined, after: undefined, field: undefined });
    }
    for (const [id, r] of aMap) {
      if (!bMap.has(id)) record({ kind, id }, undefined, r)(`Model.${prop}[]`, 'added', undefined, r, `${prop}/${id}`, { before: undefined, after: undefined, field: undefined });
    }
    for (const [id, rb] of bMap) {
      const ra = aMap.get(id);
      if (ra === undefined) continue;
      walk(node['items'] as SchemaNode, 'Model', `${prop}[]`, rb, ra, `${prop}/${id}`, `${prop}[]`, { before: undefined, after: undefined, field: undefined }, [], { delta: record({ kind, id }, rb, ra) });
    }
  }
  return changes;
}

/** True when a change needs acknowledgement: breaking, or unclassified. */
export const needsAcknowledgement = (c: Change): boolean => c.kind === 'breaking' || c.kind === 'requiresReview';
