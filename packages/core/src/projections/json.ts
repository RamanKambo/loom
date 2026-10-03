import type { ItemShape, Model, Property, RecordRef, TypeDef } from '../generated/types.js';
import { splitQualified } from '../refs.js';
import { SOURCE_NOTICE } from './notice.js';
import { pointer, type RenderContext } from './context.js';

export const JSON_SCHEMA_ID = 'urn:loom:projection:json-schema';

type Json = Record<string, unknown>;

interface ValueShape {
  kind: Property['kind'];
  enumValues?: string[];
  bounds?: Property['bounds'];
  decimal?: Property['decimal'];
  ref?: string;
  variants?: string[];
  discriminator?: string;
  items?: ItemShape;
}

/** A decimal travels as a string, so no digit is lost to binary floating point. */
function decimalPattern(precision: number, scale: number, signed: boolean): string {
  const intDigits = Math.max(1, precision - scale);
  const fraction = scale > 0 ? `(\\.\\d{1,${scale}})?` : '';
  return `^${signed ? '-?' : ''}\\d{1,${intDigits}}${fraction}$`;
}

function withNull(schema: Json, nullable: boolean): Json {
  if (!nullable) return schema;
  if (typeof schema['type'] === 'string') return { ...schema, type: [schema['type'], 'null'] };
  return { anyOf: [schema, { type: 'null' }] };
}

/** The $ref of the schema of a type id, as one document places it; `owner` is the record that holds the reference. */
export type RefTarget = (id: string, owner: RecordRef) => string;

/** References into one document under `prefix`, which holds no schema of a published-contract type. */
export const localRefs = (prefix: string, ctx: RenderContext): RefTarget => (id, owner) => {
  if (splitQualified(id)) ctx.unsupported('type.externalSchema', owner, `reference '${id}' points into a published contract`);
  return `${prefix}${id}`;
};

/**
 * JSON Schema of one value shape. The JSON Schema and OpenAPI projections
 * differ only in where `refs` places a referenced type, so the two share one
 * mapping and cannot drift.
 */
export function valueSchema(s: ValueShape, nullable: boolean, refs: RefTarget, owner: RecordRef, ctx: RenderContext, openapi: boolean): Json {
  const b = s.bounds ?? {};
  const ref = (id: string): Json => ({ $ref: refs(id, owner) });
  let schema: Json;
  switch (s.kind) {
    case 'enum': {
      const values: Array<string | null> = [...(s.enumValues ?? [])];
      if (nullable) values.push(null);
      return { enum: values };
    }
    case 'string':
      schema = { type: 'string' };
      if (b.minLength !== undefined) schema['minLength'] = b.minLength;
      if (b.maxLength !== undefined) schema['maxLength'] = b.maxLength;
      if (b.pattern !== undefined) schema['pattern'] = b.pattern;
      break;
    case 'integer':
    case 'number':
      schema = { type: s.kind };
      if (b.min !== undefined) schema['minimum'] = b.min;
      if (b.max !== undefined) schema['maximum'] = b.max;
      break;
    case 'decimal': {
      const d = s.decimal ?? { precision: 18, scale: 0 };
      const nonNegative = b.min !== undefined && b.min >= 0;
      if ((b.min !== undefined && b.min !== 0) || b.max !== undefined) {
        ctx.unsupported('type.decimalRange', owner, `decimal bounds ${JSON.stringify(b)} cannot be expressed on a decimal string`);
      }
      schema = { type: 'string', pattern: decimalPattern(d.precision, d.scale, !nonNegative) };
      if (openapi) schema['format'] = 'decimal';
      break;
    }
    case 'boolean':
      schema = { type: 'boolean' };
      break;
    case 'date':
      schema = { type: 'string', format: 'date' };
      break;
    case 'datetime':
      schema = { type: 'string', format: 'date-time' };
      break;
    case 'uuid':
      schema = { type: 'string', format: 'uuid' };
      break;
    case 'ref':
      schema = ref(s.ref ?? '');
      break;
    case 'array':
      schema = { type: 'array', items: s.items ? valueSchema(s.items, false, refs, owner, ctx, openapi) : {} };
      if (b.minItems !== undefined) schema['minItems'] = b.minItems;
      if (b.maxItems !== undefined) schema['maxItems'] = b.maxItems;
      break;
    case 'union':
      schema = { oneOf: (s.variants ?? []).map(ref) };
      if (openapi && s.discriminator) schema['discriminator'] = { propertyName: s.discriminator };
      break;
  }
  return withNull(schema, nullable);
}

function propertySchema(p: Property, refs: RefTarget, owner: RecordRef, ctx: RenderContext, openapi: boolean): Json {
  const schema = valueSchema(p, p.nullable, refs, owner, ctx, openapi);
  if (p.description !== undefined) schema['description'] = p.units ? `${p.description} (${p.units})` : p.description;
  else if (p.units !== undefined) schema['description'] = `In ${p.units}.`;
  if (p.origin === 'system' || p.origin === 'derived') schema['readOnly'] = true;
  if (p.default?.policy === 'literal' && p.default.value !== undefined) schema['default'] = p.default.value;
  return schema;
}

/**
 * Object schema of a type: every property, the required set, nothing
 * undeclared. `owner` is the in-scope record an unsupported construct is
 * reported against; a type of a published contract is no record of the model.
 */
export function typeSchema(t: TypeDef, refs: RefTarget, ctx: RenderContext, openapi: boolean, owner: RecordRef = { kind: 'type', id: t.id }): Json {
  const properties: Json = {};
  const required: string[] = [];
  for (const p of t.properties) {
    properties[p.name] = propertySchema(p, refs, owner, ctx, openapi);
    if (p.required) required.push(p.name);
  }
  const schema: Json = { type: 'object', properties, additionalProperties: false };
  if (t.description !== undefined) schema['description'] = t.description;
  if (required.length) schema['required'] = required;
  if (t.externalSchema) ctx.unsupported('type.externalSchema', owner, `type '${t.id}' takes its shape from a pinned external schema`);
  return schema;
}

export const JSON_SCHEMA_FILE = 'schema.json';

/** Record every type and property of the model as projected at `base` (a JSON Pointer prefix ending in the type map). */
export function coverTypes(model: Model, ctx: RenderContext, file: string, base: string[]): void {
  for (const t of model.types) {
    ctx.covered({ kind: 'type', id: t.id }, file, pointer(...base, t.id));
    for (const p of t.properties) ctx.covered({ kind: 'property', id: `${t.id}.${p.name}` }, file, pointer(...base, t.id, 'properties', p.name));
  }
}

/** JSON Schema 2020-12 document with one $defs entry per type. */
export function projectJsonSchema(model: Model, ctx: RenderContext): Record<string, Json> {
  const defs: Json = {};
  const refs = localRefs('#/$defs/', ctx);
  for (const t of model.types) defs[t.id] = typeSchema(t, refs, ctx, false);
  coverTypes(model, ctx, JSON_SCHEMA_FILE, ['$defs']);
  return {
    [JSON_SCHEMA_FILE]: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: JSON_SCHEMA_ID,
      $comment: SOURCE_NOTICE,
      title: 'Loom projected type schemas',
      $defs: defs,
    },
  };
}
