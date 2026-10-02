import type { ItemShape, Model, Property, RecordRef, TypeDef } from '../generated/types.js';
import { splitQualified } from '../refs.js';
import { SOURCE_NOTICE } from './notice.js';
import type { RenderContext } from './context.js';

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

/**
 * JSON Schema of one value shape. `refPrefix` is '#/$defs/' for the JSON
 * Schema projection and '#/components/schemas/' for OpenAPI, so the two share
 * one mapping and cannot drift.
 */
export function valueSchema(s: ValueShape, nullable: boolean, refPrefix: string, owner: RecordRef, ctx: RenderContext, openapi: boolean): Json {
  const b = s.bounds ?? {};
  const ref = (id: string): Json => {
    if (splitQualified(id)) ctx.unsupported('type.externalSchema', owner, `reference '${id}' points into a published contract`);
    return { $ref: `${refPrefix}${id}` };
  };
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
      schema = { type: 'array', items: s.items ? valueSchema(s.items, false, refPrefix, owner, ctx, openapi) : {} };
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

function propertySchema(t: TypeDef, p: Property, refPrefix: string, ctx: RenderContext, openapi: boolean): Json {
  const schema = valueSchema(p, p.nullable, refPrefix, { kind: 'type', id: t.id }, ctx, openapi);
  if (p.description !== undefined) schema['description'] = p.units ? `${p.description} (${p.units})` : p.description;
  else if (p.units !== undefined) schema['description'] = `In ${p.units}.`;
  if (p.origin === 'system' || p.origin === 'derived') schema['readOnly'] = true;
  if (p.default?.policy === 'literal' && p.default.value !== undefined) schema['default'] = p.default.value;
  return schema;
}

/** Object schema of a type: every property, the required set, nothing undeclared. */
export function typeSchema(t: TypeDef, refPrefix: string, ctx: RenderContext, openapi: boolean): Json {
  const properties: Json = {};
  const required: string[] = [];
  for (const p of t.properties) {
    properties[p.name] = propertySchema(t, p, refPrefix, ctx, openapi);
    if (p.required) required.push(p.name);
  }
  const schema: Json = { type: 'object', properties, additionalProperties: false };
  if (t.description !== undefined) schema['description'] = t.description;
  if (required.length) schema['required'] = required;
  if (t.externalSchema) ctx.unsupported('type.externalSchema', { kind: 'type', id: t.id }, `type '${t.id}' takes its shape from a pinned external schema`);
  return schema;
}

/** JSON Schema 2020-12 document with one $defs entry per type. */
export function projectJsonSchema(model: Model, ctx: RenderContext): Json {
  const defs: Json = {};
  for (const t of model.types) defs[t.id] = typeSchema(t, '#/$defs/', ctx, false);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: JSON_SCHEMA_ID,
    $comment: SOURCE_NOTICE,
    title: 'Loom projected type schemas',
    $defs: defs,
  };
}
