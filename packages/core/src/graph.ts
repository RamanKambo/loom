import type { AffectedElement, Model, RecordKind, RecordRef } from './generated/types.js';
import { collectReferences, resolveReference } from './refs.js';
import { indexModel, resolveProperty, type ModelIndex } from './records.js';

type EdgeKind = NonNullable<AffectedElement['edgeKinds']>[number];

const nodeKey = (ref: RecordRef): string => `${ref.kind}\u0000${ref.id}`;
const parseKey = (key: string): RecordRef => {
  const [kind, id] = key.split('\u0000') as [RecordKind, string];
  return { kind, id };
};

/**
 * The record dependency graph. An arc X -> Y means "X depends on Y": when Y
 * changes, X is in its blast radius. Arcs come from every contract reference
 * (a property reference makes the holder depend on the type), from declared
 * edges (edge.from depends on edge.to), and from containment (a criterion
 * depends on its requirement).
 */
export class DependencyGraph {
  private readonly forward = new Map<string, Map<string, Set<EdgeKind>>>();
  private readonly reverse = new Map<string, Map<string, Set<EdgeKind>>>();

  constructor(readonly index: ModelIndex) {
    const model = index.model;
    for (const r of collectReferences(model)) {
      if (r.holder.kind === 'edge') continue;
      const res = resolveReference(index, r);
      if (res.status !== 'resolved') continue;
      this.link(r.holder, this.recordLevel(res.ref), 'reference');
    }
    for (const e of model.edges ?? []) {
      const from = this.resolveAny(e.from);
      const to = this.resolveAny(e.to);
      if (from && to) this.link(from, to, e.kind);
    }
    for (const [id, entry] of index.criteria) {
      this.link({ kind: 'criterion', id }, { kind: 'requirement', id: entry.requirement.id }, 'reference');
    }
  }

  private recordLevel(ref: RecordRef): RecordRef {
    if (ref.kind !== 'property') return ref;
    const p = resolveProperty(this.index, ref.id);
    return p ? { kind: 'type', id: p.type.id } : ref;
  }

  private resolveAny(id: string): RecordRef | null {
    const kinds = this.index.kindsOfId.get(id);
    return kinds && kinds.length ? { kind: kinds[0] as RecordKind, id } : null;
  }

  private link(from: RecordRef, to: RecordRef, kind: EdgeKind): void {
    const f = nodeKey(from);
    const t = nodeKey(to);
    if (f === t) return;
    const add = (map: Map<string, Map<string, Set<EdgeKind>>>, a: string, b: string): void => {
      let out = map.get(a);
      if (!out) map.set(a, (out = new Map()));
      let kinds = out.get(b);
      if (!kinds) out.set(b, (kinds = new Set()));
      kinds.add(kind);
    };
    add(this.forward, f, t);
    add(this.reverse, t, f);
  }

  /** Direct dependencies of a record. */
  dependenciesOf(ref: RecordRef): RecordRef[] {
    return [...(this.forward.get(nodeKey(ref))?.keys() ?? [])].map(parseKey);
  }

  /**
   * Every transitive consumer of the targets, each with the dependency path
   * from the nearest target and the arc kinds on that path. Breadth-first, so
   * each path is a shortest one; targets themselves are excluded.
   */
  consumersOf(targets: readonly RecordRef[]): Map<string, { ref: RecordRef; path: string[]; edgeKinds: EdgeKind[] }> {
    const out = new Map<string, { ref: RecordRef; path: string[]; edgeKinds: EdgeKind[] }>();
    const seen = new Set(targets.map(nodeKey));
    const queue: Array<{ key: string; path: string[]; kinds: EdgeKind[] }> = targets.map((t) => ({ key: nodeKey(t), path: [t.id], kinds: [] }));
    while (queue.length) {
      const cur = queue.shift() as { key: string; path: string[]; kinds: EdgeKind[] };
      for (const [consumer, kinds] of this.reverse.get(cur.key) ?? []) {
        if (seen.has(consumer)) continue;
        seen.add(consumer);
        const ref = parseKey(consumer);
        const entry = { ref, path: [...cur.path, ref.id], edgeKinds: [...new Set([...cur.kinds, ...kinds])].sort() };
        out.set(consumer, entry);
        queue.push({ key: consumer, path: entry.path, kinds: entry.edgeKinds });
      }
    }
    return out;
  }

  /** Consumers of the targets as affected elements, in a deterministic order. */
  affected(targets: readonly RecordRef[]): AffectedElement[] {
    return [...this.consumersOf(targets).values()]
      .map((c) => ({ ref: c.ref, reason: 'depends-on' as const, path: c.path, edgeKinds: c.edgeKinds }))
      .sort(compareAffected);
  }
}

export function compareAffected(a: AffectedElement, b: AffectedElement): number {
  return a.ref.kind.localeCompare(b.ref.kind) || a.ref.id.localeCompare(b.ref.id);
}

/** Dependency graph of a model. */
export function dependencyGraph(model: Model): DependencyGraph {
  return new DependencyGraph(indexModel(model));
}

/**
 * Change impact over the relationships of both models: a consumer present only
 * before the change is a former consumer, one present only after it is a new
 * consumer, and each changed element is itself a direct change.
 */
export function changeImpact(before: Model, after: Model, changed: readonly RecordRef[]): AffectedElement[] {
  const b = dependencyGraph(before).consumersOf(changed);
  const a = dependencyGraph(after).consumersOf(changed);
  const out: AffectedElement[] = [];
  const seen = new Set<string>();
  for (const ref of changed) {
    const key = nodeKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref, reason: 'direct-change', path: [ref.id] });
  }
  for (const [key, c] of b) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref: c.ref, reason: a.has(key) ? 'depends-on' : 'former-consumer', path: c.path, edgeKinds: c.edgeKinds });
  }
  for (const [key, c] of a) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref: c.ref, reason: 'new-consumer', path: c.path, edgeKinds: c.edgeKinds });
  }
  const direct = out.filter((x) => x.reason === 'direct-change');
  return [...direct, ...out.filter((x) => x.reason !== 'direct-change').sort(compareAffected)];
}
