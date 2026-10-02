import type {
  Model,
  RecordKind,
  RecordRef,
  TypeDef,
  Property,
  Requirement,
  Criterion,
  Storage,
  StorageColumn,
} from './generated/types.js';
import { COLLECTIONS, KEYED_ARRAYS } from './generated/registry.js';

/** The origin state of a creation. */
export const ABSENT_STATE = '$absent';

/** Joins the values of a composite key, as RecordRef ids and patch ids write them. */
export const KEY_SEPARATOR = '|';

export type CollectionName = (typeof COLLECTIONS)[number]['collection'];

/** Record kind of each top-level collection, and the reverse. */
export const KIND_OF_COLLECTION = Object.fromEntries(COLLECTIONS.map((c) => [c.collection, c.kind])) as Record<
  CollectionName,
  RecordKind
>;
export const COLLECTION_OF_KIND = Object.fromEntries(COLLECTIONS.map((c) => [c.kind, c.collection])) as Partial<
  Record<RecordKind, CollectionName>
>;

/** Kinds whose records carry a contract version. */
export const VERSIONED_KINDS: ReadonlySet<RecordKind> = new Set<RecordKind>(['type', 'operation', 'routine']);

const KEY_OF_PATH = new Map<string, readonly string[]>(KEYED_ARRAYS.map((k) => [k.path, k.key as readonly string[]]));

/** Key fields of the keyed array at a registry path such as 'types[].properties[]'. */
export function keyFieldsAt(registryPath: string): readonly string[] | undefined {
  return KEY_OF_PATH.get(registryPath);
}

/** Key string of an element: its key field values joined with '|'. */
export function keyOf(element: unknown, fields: readonly string[]): string {
  const e = element as Record<string, unknown>;
  return fields.map((f) => String(e[f])).join(KEY_SEPARATOR);
}

/** Key string of a top-level record. */
export function recordKey(collection: CollectionName, record: unknown): string {
  return keyOf(record, keyFieldsAt(`${collection}[]`) ?? ['id']);
}

export interface CriterionEntry {
  requirement: Requirement;
  criterion: Criterion;
}

export interface ModelIndex {
  model: Model;
  /** Records by kind and key; 'criterion' and 'systemProfile' included. */
  byKind: Map<RecordKind, Map<string, unknown>>;
  /** Kinds declaring each id, for diagnosing a reference to the wrong kind. */
  kindsOfId: Map<string, RecordKind[]>;
  types: Map<string, TypeDef>;
  criteria: Map<string, CriterionEntry>;
  storageByType: Map<string, Storage[]>;
  /** The id of every declared record and criterion. */
  ids: Set<string>;
}

/** Index of every record by kind and key. Pure; rebuilt per model. */
export function indexModel(model: Model): ModelIndex {
  const byKind = new Map<RecordKind, Map<string, unknown>>();
  const kindsOfId = new Map<string, RecordKind[]>();
  const ids = new Set<string>();
  const put = (kind: RecordKind, key: string, record: unknown, isId: boolean): void => {
    let m = byKind.get(kind);
    if (!m) byKind.set(kind, (m = new Map()));
    if (!m.has(key)) m.set(key, record);
    if (isId) {
      ids.add(key);
      const kinds = kindsOfId.get(key) ?? [];
      if (!kinds.includes(kind)) kinds.push(kind);
      kindsOfId.set(key, kinds);
    }
  };
  for (const c of COLLECTIONS) {
    const list = (model as unknown as Record<string, unknown[]>)[c.collection] ?? [];
    for (const r of list) put(c.kind, recordKey(c.collection, r), r, c.kind !== 'edge');
  }
  const criteria = new Map<string, CriterionEntry>();
  for (const requirement of model.requirements ?? []) {
    for (const criterion of requirement.criteria ?? []) {
      put('criterion', criterion.id, criterion, true);
      if (!criteria.has(criterion.id)) criteria.set(criterion.id, { requirement, criterion });
    }
  }
  if (model.systemProfile) put('systemProfile', 'system', model.systemProfile, false);
  const types = new Map<string, TypeDef>();
  for (const t of model.types ?? []) if (!types.has(t.id)) types.set(t.id, t);
  const storageByType = new Map<string, Storage[]>();
  for (const s of model.storage ?? []) {
    const list = storageByType.get(s.type) ?? [];
    list.push(s);
    storageByType.set(s.type, list);
  }
  return { model, byKind, kindsOfId, types, criteria, storageByType, ids };
}

/** The longest id in `ids` that prefixes `value` followed by a dot; ids may contain dots, property names may not. */
export function longestIdPrefix(value: string, ids: Iterable<string>): string | null {
  let best: string | null = null;
  for (const id of ids) {
    if (value.length > id.length + 1 && value.startsWith(`${id}.`) && (best === null || id.length > best.length)) best = id;
  }
  return best;
}

export interface PropertyRef {
  type: TypeDef;
  property: Property | undefined;
  name: string;
}

/** Resolve '<typeId>.<propertyName>'; null when no type id prefixes it. */
export function resolveProperty(index: ModelIndex, ref: string): PropertyRef | null {
  const typeId = longestIdPrefix(ref, index.types.keys());
  if (typeId === null) return null;
  const type = index.types.get(typeId) as TypeDef;
  const name = ref.slice(typeId.length + 1);
  return { type, property: type.properties.find((p) => p.name === name), name };
}

/** The record a typed reference names, or undefined. */
export function findRecord(index: ModelIndex, ref: RecordRef): unknown {
  if (ref.kind === 'property') return resolveProperty(index, ref.id)?.property;
  if (ref.kind === 'systemProfile') return index.model.systemProfile;
  return index.byKind.get(ref.kind)?.get(ref.id);
}

/** The storage column that stores a property, when the property's type is stored. */
export function columnOf(index: ModelIndex, typeId: string, property: string): { storage: Storage; column: StorageColumn } | null {
  for (const storage of index.storageByType.get(typeId) ?? []) {
    const column = storage.columns.find((c) => c.property === property);
    if (column) return { storage, column };
  }
  return null;
}

/** The model's top-level record list of a collection. */
export function recordsOf(model: Model, collection: CollectionName): unknown[] {
  return ((model as unknown as Record<string, unknown[]>)[collection] ?? []) as unknown[];
}
