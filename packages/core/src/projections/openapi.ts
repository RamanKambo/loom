import type { Binding, HttpParameter, Model, Operation, SecurityScheme, TypeDef } from '../generated/types.js';
import { SOURCE_NOTICE } from './notice.js';
import { typeSchema, valueSchema } from './json.js';
import type { RenderContext } from './context.js';

type Json = Record<string, unknown>;
const REF = '#/components/schemas/';
const BODYLESS = new Set(['GET', 'HEAD', 'DELETE']);
const MEDIA = 'application/json';

function content(typeId: string | undefined, mediaType: string | undefined): Json | undefined {
  return typeId === undefined ? undefined : { [mediaType ?? MEDIA]: { schema: { $ref: `${REF}${typeId}` } } };
}

function securityScheme(s: SecurityScheme): Json {
  const out: Json = { type: s.type };
  if (s.description !== undefined) out['description'] = s.description;
  if (s.type === 'http') {
    if (s.scheme !== undefined) out['scheme'] = s.scheme;
    if (s.bearerFormat !== undefined) out['bearerFormat'] = s.bearerFormat;
  } else if (s.type === 'apiKey') {
    out['in'] = s.in;
    out['name'] = s.name;
  } else if (s.type === 'openIdConnect') {
    out['openIdConnectUrl'] = s.openIdConnectUrl;
  } else if (s.type === 'oauth2') {
    const flows: Json = {};
    if (s.flows?.clientCredentials) flows['clientCredentials'] = { tokenUrl: s.flows.clientCredentials.tokenUrl, scopes: s.flows.clientCredentials.scopes };
    if (s.flows?.authorizationCode) {
      flows['authorizationCode'] = {
        authorizationUrl: s.flows.authorizationCode.authorizationUrl,
        tokenUrl: s.flows.authorizationCode.tokenUrl,
        scopes: s.flows.authorizationCode.scopes,
      };
    }
    out['flows'] = flows;
  }
  return out;
}

function parameter(op: Operation, request: TypeDef | undefined, p: HttpParameter, ctx: RenderContext): Json {
  const prop = p.property !== undefined ? request?.properties.find((x) => x.name === p.property) : undefined;
  const schema = prop
    ? valueSchema(prop, false, REF, { kind: 'operation', id: op.id }, ctx, true)
    : valueSchema({ kind: p.kind ?? 'string', enumValues: p.enumValues }, false, REF, { kind: 'operation', id: op.id }, ctx, true);
  const out: Json = { name: p.name, in: p.in, required: p.required, schema };
  const description = p.description ?? prop?.description;
  if (description !== undefined) out['description'] = description;
  return out;
}

function responses(op: Operation, b: Binding): Json {
  const out: Json = {};
  const declared = b.responses ?? [];
  if (declared.length === 0) {
    if (op.kind === 'async-command') {
      const accepted = op.async?.accepted;
      const c = content(accepted?.type ?? op.response, undefined);
      out[String(accepted?.status ?? 202)] = { description: acceptedDescription(op), ...(c ? { content: c } : {}) };
    } else {
      const c = content(op.response, undefined);
      out['200'] = { description: 'Success.', ...(c ? { content: c } : {}) };
    }
  }
  for (const r of declared) {
    const c = content(r.type, r.mediaType);
    out[String(r.status)] = { description: r.kind === 'accepted' ? `${r.description} ${acceptedDescription(op)}` : r.description, ...(c ? { content: c } : {}) };
  }
  const unplaced: string[] = [];
  for (const e of op.errors ?? []) {
    if (e.status === undefined) {
      unplaced.push(`${e.code}: ${e.description}${e.retryable ? ' (retryable)' : ''}`);
      continue;
    }
    if (out[String(e.status)] !== undefined) continue;
    const c = content(e.type, undefined);
    out[String(e.status)] = { description: `${e.code}: ${e.description}${e.retryable ? ' Retryable.' : ''}`, ...(c ? { content: c } : {}) };
  }
  if (unplaced.length) out['default'] = { description: `Failures without an HTTP status: ${unplaced.join('; ')}.` };
  return out;
}

function acceptedDescription(op: Operation): string {
  const c = op.async?.completion;
  if (!c) return 'Accepted; the work completes asynchronously.';
  const where = c.via === 'polling' && c.statusOperation ? ` by polling operation '${c.statusOperation}'` : c.event ? ` through event '${c.event}'` : ` by ${c.via}`;
  return `Accepted; the result '${c.result}' is obtained${where}.`;
}

/**
 * OpenAPI 3.1 document of every HTTP binding: parameters, request bodies,
 * every declared and failure response, security schemes and per-operation
 * security requirements. The authority stays visible as x-authority, but the
 * security requirement is the declaration a client acts on.
 */
export function projectOpenApi(model: Model, ctx: RenderContext): Json {
  const schemas: Json = {};
  for (const t of model.types) schemas[t.id] = typeSchema(t, REF, ctx, true);
  const paths: Record<string, Json> = {};
  for (const op of model.operations) {
    const http = (op.bindings ?? []).filter((b) => b.transport === 'http' && b.method && b.path);
    http.forEach((b, i) => {
      const method = (b.method as string).toLowerCase();
      const item = paths[b.path as string] ?? (paths[b.path as string] = {});
      const request = op.request ? model.types.find((t) => t.id === op.request) : undefined;
      const params = b.parameters ?? [];
      const operation: Json = { operationId: http.length > 1 ? `${op.id}.${i + 1}` : op.id, summary: `${op.kind} ${op.id} (version ${op.version})` };
      if (op.description !== undefined) operation['description'] = op.description;
      if (params.length) operation['parameters'] = params.map((p) => parameter(op, request, p, ctx));
      const carried = new Set(params.map((p) => p.property).filter((x): x is string => x !== undefined));
      if (request && !BODYLESS.has(b.method as string) && request.properties.some((p) => !carried.has(p.name))) {
        operation['requestBody'] = { required: true, content: content(request.id, b.requestMediaType) };
      }
      operation['responses'] = responses(op, b);
      if (op.authority.scheme !== undefined) operation['security'] = [{ [op.authority.scheme]: [op.authority.permission] }];
      const authority: Json = { permission: op.authority.permission };
      if (op.authority.scope !== undefined) authority['scope'] = op.authority.scope;
      operation['x-authority'] = authority;
      item[method] = operation;
    });
  }
  const components: Json = { schemas };
  if (model.securitySchemes.length) components['securitySchemes'] = Object.fromEntries(model.securitySchemes.map((s) => [s.id, securityScheme(s)]));
  return {
    openapi: '3.1.0',
    info: { title: 'Loom projected API', version: String(model.version), description: SOURCE_NOTICE },
    paths,
    components,
  };
}
