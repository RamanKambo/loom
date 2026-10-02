import type { Model, RecordKind, RecordRef } from './generated/types.js';
import { REFERENCE_FIELDS } from './generated/registry.js';
import { findRecord, resolveProperty, type ModelIndex } from './records.js';
import { visitPath } from './walk.js';

/** A reference as the contract declares it: a field and the record kind it names. */
export interface Reference {
  /** Registry path of the field, for example 'types[].owner'. */
  field: string;
  /** 'record' for a typed RecordRef, 'property' for '<typeId>.<name>', 'any' for an edge endpoint, 'invocation' for a sibling-kind reference, else a record kind. */
  target: string;
  value: unknown;
  path: string;
  holder: RecordRef;
  /** The object that holds the field. */
  parent: unknown;
}

/** Every reference value in the model, in registry order. */
export function collectReferences(model: Model): Reference[] {
  const out: Reference[] = [];
  for (const f of REFERENCE_FIELDS) {
    visitPath(model, f.path, (v) => {
      out.push({ field: f.path, target: f.target, value: v.value, path: v.path, holder: v.holder, parent: v.parents[v.parents.length - 1] });
    });
  }
  return out;
}

export type Resolution =
  | { status: 'resolved'; ref: RecordRef }
  | { status: 'external'; publishedContract: string; recordId: string }
  | { status: 'dangling'; reason: string }
  | { status: 'wrong-kind'; expected: string; actual: RecordKind[] };

/** Split '<publishedContractId>:<recordId>'; null for a local id. */
export function splitQualified(value: string): { publishedContract: string; recordId: string } | null {
  const colon = value.indexOf(':');
  if (colon < 0) return null;
  return { publishedContract: value.slice(0, colon), recordId: value.slice(colon + 1) };
}

/** The record kind a reference expects, resolving 'invocation' by its sibling `kind`. */
export function expectedKind(r: Reference): string {
  if (r.target === 'invocation') return String((r.parent as { kind?: string } | undefined)?.kind ?? 'operation');
  return r.target;
}

/** Resolve one reference against the model index. Never throws. */
export function resolveReference(index: ModelIndex, r: Reference): Resolution {
  if (r.target === 'record') {
    const ref = r.value as RecordRef;
    if (findRecord(index, ref) !== undefined) return { status: 'resolved', ref };
    const kinds = index.kindsOfId.get(ref.id);
    if (kinds && kinds.length && !kinds.includes(ref.kind)) return { status: 'wrong-kind', expected: ref.kind, actual: kinds };
    return { status: 'dangling', reason: `no ${ref.kind} '${ref.id}' is declared` };
  }
  const value = String(r.value);
  if (r.target === 'property') {
    const p = resolveProperty(index, value);
    if (!p) return { status: 'dangling', reason: `'${value}' names no known type` };
    if (!p.property) return { status: 'dangling', reason: `type '${p.type.id}' has no property '${p.name}'` };
    return { status: 'resolved', ref: { kind: 'property', id: value } };
  }
  const qualified = splitQualified(value);
  if (qualified) {
    if (!index.byKind.get('publishedContract')?.has(qualified.publishedContract)) {
      return { status: 'dangling', reason: `'${qualified.publishedContract}' is not a declared published contract` };
    }
    return { status: 'external', ...qualified };
  }
  const kind = expectedKind(r);
  if (kind === 'any') {
    const kinds = index.kindsOfId.get(value);
    if (kinds && kinds.length) return { status: 'resolved', ref: { kind: kinds[0] as RecordKind, id: value } };
    return { status: 'dangling', reason: `'${value}' names no declared record` };
  }
  if (index.byKind.get(kind as RecordKind)?.has(value)) return { status: 'resolved', ref: { kind: kind as RecordKind, id: value } };
  const kinds = index.kindsOfId.get(value);
  if (kinds && kinds.length) return { status: 'wrong-kind', expected: kind, actual: kinds };
  return { status: 'dangling', reason: `no ${kind} '${value}' is declared` };
}

/**
 * Rewrite every reference to `from` (a record of `kind`) so it names `to`.
 * Mutates `model` in place; the caller passes a clone. Property references
 * '<from>.<name>' follow a renamed type.
 */
export function renameReferences(model: Model, kind: RecordKind, from: string, to: string): void {
  for (const f of REFERENCE_FIELDS) {
    visitPath(model, f.path, (v) => {
      const parent = v.parents[v.parents.length - 1] as Record<string, unknown> | unknown[] | undefined;
      if (!parent) return;
      const fieldName = lastFieldName(f.path);
      const rewrite = (current: unknown): unknown => {
        if (f.target === 'record') {
          const ref = current as RecordRef;
          if (ref.kind === kind && ref.id === from) return { ...ref, id: to };
          if (kind === 'type' && ref.kind === 'property' && ref.id.startsWith(`${from}.`)) return { ...ref, id: `${to}${ref.id.slice(from.length)}` };
          return current;
        }
        const s = String(current);
        if (f.target === 'property') return kind === 'type' && s.startsWith(`${from}.`) ? `${to}${s.slice(from.length)}` : current;
        const expected = f.target === 'invocation' ? String((parent as { kind?: string }).kind) : f.target;
        if ((expected === kind || expected === 'any') && s === from) return to;
        return current;
      };
      if (f.path.endsWith('[]')) {
        const arr = (Array.isArray(parent) ? parent : (parent as Record<string, unknown>)[fieldName]) as unknown[];
        const i = arr.indexOf(v.value);
        if (i >= 0) arr[i] = rewrite(v.value);
      } else {
        (parent as Record<string, unknown>)[fieldName] = rewrite(v.value);
      }
    });
  }
}

function lastFieldName(registryPath: string): string {
  const last = registryPath.split('.').pop() as string;
  return last.endsWith('[]') ? last.slice(0, -2) : last;
}
