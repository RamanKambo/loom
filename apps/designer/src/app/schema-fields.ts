import { COLLECTIONS, SCHEMA_BUNDLE, type CollectionName } from '@loom/core';

/** A JSON Schema node as the contract bundle holds it. */
type SchemaNode = Readonly<Record<string, unknown>>;

const DEFS = SCHEMA_BUNDLE.$defs as unknown as Readonly<Record<string, SchemaNode>>;

/** How a field is edited. Anything the form cannot render as one control is edited as validated JSON. */
export type Control =
  | { kind: 'text' }
  | { kind: 'number'; integer: boolean }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'const'; value: unknown }
  | { kind: 'json' };

export interface FieldSpec {
  name: string;
  required: boolean;
  /** A key field identifies the record and is changed only by a rename. */
  key: boolean;
  description?: string;
  control: Control;
  /** The JSON container a 'json' field holds, used for the starting value of a new record. */
  container?: 'array' | 'object';
}

export interface CollectionSpec {
  collection: CollectionName;
  kind: string;
  /** Contract definition name of one record, for example 'TypeDef'. */
  definition: string;
  key: readonly string[];
}

/** Every top-level record collection the contract defines, in contract order. */
export const COLLECTION_SPECS: readonly CollectionSpec[] = COLLECTIONS.map((c) => ({
  collection: c.collection as CollectionName,
  kind: c.kind,
  definition: c.definition.slice(c.definition.lastIndexOf('/') + 1),
  key: c.key ?? ['id'],
}));

function resolve(node: SchemaNode): SchemaNode {
  let current = node;
  for (let depth = 0; depth < 16 && typeof current['$ref'] === 'string'; depth++) {
    const ref = current['$ref'] as string;
    const next = DEFS[ref.slice(ref.lastIndexOf('/') + 1)];
    if (!next) break;
    current = next;
  }
  return current;
}

function controlOf(node: SchemaNode): Control {
  const s = resolve(node);
  if (s['const'] !== undefined) return { kind: 'const', value: s['const'] };
  const values = s['enum'];
  if (Array.isArray(values) && values.every((v) => typeof v === 'string')) return { kind: 'enum', values: values as string[] };
  switch (s['type']) {
    case 'string':
      return { kind: 'text' };
    case 'integer':
      return { kind: 'number', integer: true };
    case 'number':
      return { kind: 'number', integer: false };
    case 'boolean':
      return { kind: 'boolean' };
    default:
      return { kind: 'json' };
  }
}

/** The editable fields of one record definition, read from the contract bundle. */
export function fieldsOf(definition: string, keyFields: readonly string[] = []): FieldSpec[] {
  const def = DEFS[definition];
  if (!def) throw new Error(`the contract defines no '${definition}'`);
  const properties = (def['properties'] ?? {}) as Readonly<Record<string, SchemaNode>>;
  const required = new Set((def['required'] ?? []) as readonly string[]);
  return Object.entries(properties).map(([name, schema]) => {
    const spec: FieldSpec = { name, required: required.has(name), key: keyFields.includes(name), control: controlOf(schema) };
    const description = (schema['description'] ?? resolve(schema)['description']) as string | undefined;
    if (description) spec.description = description;
    const type = resolve(schema)['type'];
    if (type === 'array' || type === 'object') spec.container = type;
    return spec;
  });
}

/**
 * The starting value of a required field in a new record. It only fills the form; the engine
 * decides whether the record is acceptable when the add patch is applied.
 */
export function startingValue(field: FieldSpec): unknown {
  switch (field.control.kind) {
    case 'const':
      return field.control.value;
    case 'enum':
      return field.control.values[0];
    case 'number':
      return field.control.integer ? 1 : 0;
    case 'boolean':
      return false;
    case 'text':
      return '';
    case 'json':
      return field.container === 'array' ? [] : field.container === 'object' ? {} : null;
  }
}

/** Values of a top-level string enum in the contract, for example 'TaskClass'. */
export function enumOf(definition: string): readonly string[] {
  const values = DEFS[definition]?.['enum'];
  return Array.isArray(values) ? (values as string[]) : [];
}
