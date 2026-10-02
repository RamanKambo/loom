import type { Model, Property, TypeDef } from '../types.js';
import { SOURCE_NOTICE } from './notice.js';

export const JSON_SCHEMA_ID = 'urn:loom:projection:json-schema';

function propertySchema(p: Property): Record<string, unknown> {
  if (p.kind === 'enum') {
    const values: (string | null)[] = [...(p.enumValues ?? [])];
    if (p.nullable) values.push(null);
    return { enum: values };
  }
  const schema: Record<string, unknown> = {};
  if (p.kind === 'string') {
    schema['type'] = p.nullable ? ['string', 'null'] : 'string';
    if (p.bounds?.minLength !== undefined) schema['minLength'] = p.bounds.minLength;
    if (p.bounds?.maxLength !== undefined) schema['maxLength'] = p.bounds.maxLength;
  } else if (p.kind === 'integer' || p.kind === 'number') {
    const t = p.kind;
    schema['type'] = p.nullable ? [t, 'null'] : t;
    if (p.bounds?.min !== undefined) schema['minimum'] = p.bounds.min;
    if (p.bounds?.max !== undefined) schema['maximum'] = p.bounds.max;
  } else {
    schema['type'] = p.nullable ? ['boolean', 'null'] : 'boolean';
  }
  return schema;
}

function typeSchema(t: TypeDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of t.properties) {
    properties[p.name] = propertySchema(p);
    if (p.required) required.push(p.name);
  }
  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required.length) schema['required'] = required;
  return schema;
}

/** JSON Schema 2020-12 document with one $defs entry per type. */
export function projectJsonSchema(model: Model): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (const t of model.types) defs[t.id] = typeSchema(t);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: JSON_SCHEMA_ID,
    $comment: SOURCE_NOTICE,
    title: 'Loom projected type schemas',
    $defs: defs,
  };
}

/** OpenAPI 3.1 document from the operations' HTTP bindings. */
export function projectOpenApi(model: Model): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const t of model.types) schemas[t.id] = typeSchema(t);

  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of model.operations) {
    for (const b of op.bindings ?? []) {
      if (b.transport !== 'http' || !b.path || !b.method) continue;
      const method = b.method.toLowerCase();
      const item = paths[b.path] ?? (paths[b.path] = {});
      const responseType = op.response ?? op.result;
      const statusCode = op.kind === 'async-command' ? '202' : '200';
      const authority: Record<string, unknown> = { permission: op.authority.permission };
      if (op.authority.scope !== undefined) authority['scope'] = op.authority.scope;

      const operationObject: Record<string, unknown> = {
        operationId: op.id,
        summary: `${op.kind} ${op.id}`,
        'x-authority': authority,
        responses: {
          [statusCode]: {
            description: 'OK',
            ...(responseType
              ? {
                  content: {
                    'application/json': {
                      schema: { $ref: `#/components/schemas/${responseType}` },
                    },
                  },
                }
              : {}),
          },
        },
      };
      if (op.request && method !== 'get' && method !== 'head') {
        operationObject['requestBody'] = {
          required: true,
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${op.request}` } },
          },
        };
      }
      item[method] = operationObject;
    }
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Loom projected API', version: String(model.version), description: SOURCE_NOTICE },
    paths,
    components: { schemas },
  };
}
