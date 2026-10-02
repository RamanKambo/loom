import type { Model } from './types.js';
import { resolveBinding } from './refs.js';

/** Every element id in the model (edges are relations, not elements). */
export function allElementIds(model: Model): Set<string> {
  const ids = new Set<string>();
  for (const c of model.components) ids.add(c.id);
  for (const t of model.types) ids.add(t.id);
  for (const o of model.operations) ids.add(o.id);
  for (const r of model.routines) ids.add(r.id);
  for (const m of model.mutations) ids.add(m.id);
  for (const w of model.workflows) ids.add(w.id);
  for (const req of model.requirements) ids.add(req.id);
  for (const s of model.scenarios) ids.add(s.id);
  return ids;
}

/**
 * Forward reference graph. A directed edge X -> Y means "X depends on / consumes
 * Y": if Y changes, X is in the blast radius. Reverse-reachability from Y over
 * this graph therefore yields every consumer of Y, which is how cascade impact
 * and diff consumer sets are computed. Typed model edges are honoured as-is
 * (edge.from depends on edge.to).
 */
export function forwardAdjacency(model: Model): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const id of allElementIds(model)) adj.set(id, new Set());
  const link = (from: string, to: string): void => {
    if (!from || !to) return;
    let s = adj.get(from);
    if (!s) {
      s = new Set();
      adj.set(from, s);
    }
    s.add(to);
  };

  for (const t of model.types) link(t.id, t.owner);
  for (const o of model.operations) {
    link(o.id, o.owner);
    if (o.request) link(o.id, o.request);
    if (o.response) link(o.id, o.response);
    if (o.result) link(o.id, o.result);
  }
  const typeIds = model.types.map((t) => t.id);
  for (const r of model.routines) {
    link(r.id, r.owner);
    for (const m of r.performsMutations) link(r.id, m);
    // A bound param/column makes the routine a consumer of the producer type,
    // even when the routine performs no mutation on it (a cross-component read).
    for (const slot of [...r.params, ...r.resultSet]) {
      if (slot.binds === undefined) continue;
      const ref = resolveBinding(slot.binds, typeIds);
      if (ref) link(r.id, ref.typeId);
    }
  }
  for (const m of model.mutations) {
    link(m.id, m.type);
    link(m.id, m.owner);
    for (const req of m.requirements) link(m.id, req);
    for (const s of m.scenarios) link(m.id, s);
  }
  for (const w of model.workflows) {
    for (const d of w.dependsOn) link(w.id, d);
    for (const im of w.imports) link(w.id, im.typeId);
    for (const op of w.operations ?? []) link(w.id, op);
    for (const mu of w.mutations ?? []) link(w.id, mu);
    for (const req of w.requirements) link(w.id, req);
  }
  for (const s of model.scenarios) {
    for (const req of s.requirements) link(s.id, req);
  }
  for (const e of model.edges) link(e.from, e.to);
  return adj;
}

/**
 * Returns a resolver that, given target ids, yields the sorted set of their
 * consumers via reverse-reachability. The graph is built once and reused across
 * calls so validate() can annotate many findings cheaply.
 */
export function makeConsumerResolver(model: Model): (targets: string[]) => string[] {
  const adj = forwardAdjacency(model);
  const rev = new Map<string, Set<string>>();
  for (const [from, tos] of adj) {
    for (const to of tos) {
      let s = rev.get(to);
      if (!s) {
        s = new Set();
        rev.set(to, s);
      }
      s.add(from);
    }
  }
  return (targets: string[]): string[] => {
    const seen = new Set<string>();
    const queue = [...targets];
    while (queue.length) {
      const cur = queue.shift() as string;
      const consumers = rev.get(cur);
      if (!consumers) continue;
      for (const c of consumers) {
        if (!seen.has(c)) {
          seen.add(c);
          queue.push(c);
        }
      }
    }
    for (const t of targets) seen.delete(t);
    return [...seen].sort();
  };
}

/** Convenience: consumers of the given targets (reverse-reachability). */
export function reverseReachable(model: Model, targets: string[]): string[] {
  return makeConsumerResolver(model)(targets);
}
