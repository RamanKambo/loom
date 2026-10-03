import type { Binding, HttpParameter, Model, Operation, PublishedContract, RecordRef, SecurityScheme, TypeDef } from '../generated/types.js';
import { SOURCE_NOTICE } from './notice.js';
import { coverTypes, typeSchema, valueSchema, type RefTarget } from './json.js';
import { pointer, type RenderContext } from './context.js';
import { splitQualified } from '../refs.js';
import { refKey } from '../scope.js';
import { pinnedBundle } from '../rules/versions.js';

type Json = Record<string, unknown>;
export const OPENAPI_FILE = 'openapi.json';
const REF = '#/components/schemas/';
const BODYLESS = new Set(['GET', 'HEAD', 'DELETE']);
const MEDIA = 'application/json';
/** Request media types whose body is not a JSON document of the request type. */
const FORM_MEDIA = /^(multipart\/|application\/x-www-form-urlencoded$)/;

/** A type and the references its properties make, which for a published-contract type resolve inside its bundle. */
interface Shape {
  type: TypeDef;
  refs: RefTarget;
}

/**
 * Schemas of pinned published-contract types. A '<contract>:<type>' reference
 * becomes the component '<contract>.<type>', because an OpenAPI component key
 * admits no ':'. The schema is rendered from the resolved bundle only when the
 * bundle is exactly what the pin names, together with every type it references
 * inside that bundle; the two models are never merged. Without such a bundle
 * the reference is reported unsupported, so the document can only be a draft.
 */
class PublishedSchemas {
  private readonly queue: Array<{ pin: string; bundle: PublishedContract; type: string; owner: RecordRef }> = [];
  private readonly queued = new Set<string>();
  private readonly reported = new Set<string>();

  constructor(
    private readonly model: Model,
    private readonly ctx: RenderContext,
  ) {}

  /** References from the model's own records: a local id names a model type, a qualified id a published one. */
  readonly ref: RefTarget = (id, owner) => {
    const q = splitQualified(id);
    if (!q) return `${REF}${id}`;
    this.use(q.publishedContract, q.recordId, id, owner);
    return `${REF}${q.publishedContract}.${q.recordId}`;
  };

  /** The request type an operation names, from the model or from the pinned bundle. */
  shape(id: string, owner: RecordRef): Shape | undefined {
    const q = splitQualified(id);
    if (!q) {
      const type = this.model.types.find((t) => t.id === id);
      return type && { type, refs: this.ref };
    }
    const bundle = this.use(q.publishedContract, q.recordId, id, owner);
    const type = bundle?.content.types.find((t) => t.id === q.recordId);
    return bundle && type && { type, refs: this.within(q.publishedContract, bundle, owner) };
  }

  /** Render every queued published type into `schemas`, including the bundle types each one references. */
  renderInto(schemas: Json): void {
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      const { pin, bundle, type, owner } = next;
      const def = bundle.content.types.find((t) => t.id === type) as TypeDef;
      schemas[`${pin}.${type}`] = typeSchema(def, this.within(pin, bundle, owner), this.ctx, true, owner);
    }
  }

  /** References made inside a bundle name its own types; one that leaves the bundle has nothing to resolve against. */
  private within(pin: string, bundle: PublishedContract, owner: RecordRef): RefTarget {
    return (id) => {
      if (splitQualified(id)) {
        this.unsupported(owner, id, `published contract '${pin}' references '${id}', which lies outside its bundle`);
        return `${REF}${id.replace(':', '.')}`;
      }
      this.enqueue(pin, bundle, id, `${pin}:${id}`, owner);
      return `${REF}${pin}.${id}`;
    };
  }

  private use(pinId: string, typeId: string, id: string, owner: RecordRef): PublishedContract | undefined {
    const pin = this.model.publishedContracts.find((p) => p.id === pinId);
    const bundle = pin && pinnedBundle(pin, this.ctx.inputs?.publishedContracts ?? []);
    if (!bundle) {
      this.unsupported(owner, id, `'${id}' points into published contract '${pinId}', and no resolved bundle matches its pin`);
      return undefined;
    }
    return this.enqueue(pinId, bundle, typeId, id, owner) ? bundle : undefined;
  }

  private enqueue(pin: string, bundle: PublishedContract, typeId: string, id: string, owner: RecordRef): boolean {
    const key = `${pin}.${typeId}`;
    if (this.model.types.some((t) => t.id === key)) {
      this.unsupported(owner, id, `the component key '${key}' of '${id}' is already the id of a model type`);
      return false;
    }
    if (!bundle.content.types.some((t) => t.id === typeId)) {
      this.unsupported(owner, id, `the pinned bundle of '${pin}' holds no type '${typeId}'`);
      return false;
    }
    if (!this.queued.has(key)) {
      this.queued.add(key);
      this.queue.push({ pin, bundle, type: typeId, owner });
    }
    return true;
  }

  private unsupported(owner: RecordRef, id: string, reason: string): void {
    const key = `${refKey(owner)}|${id}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.ctx.unsupported('type.externalSchema', owner, reason);
  }
}

function content(typeId: string | undefined, mediaType: string | undefined, refs: RefTarget, owner: RecordRef): Json | undefined {
  return typeId === undefined ? undefined : { [mediaType ?? MEDIA]: { schema: { $ref: refs(typeId, owner) } } };
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

function parameter(op: Operation, request: Shape | undefined, p: HttpParameter, refs: RefTarget, ctx: RenderContext): Json {
  const prop = p.property !== undefined ? request?.type.properties.find((x) => x.name === p.property) : undefined;
  const owner: RecordRef = { kind: 'operation', id: op.id };
  const schema = prop
    ? valueSchema(prop, false, request!.refs, owner, ctx, true)
    : valueSchema({ kind: p.kind ?? 'string', enumValues: p.enumValues }, false, refs, owner, ctx, true);
  const out: Json = { name: p.name, in: p.in, required: p.required, schema };
  const description = p.description ?? prop?.description;
  if (description !== undefined) out['description'] = description;
  return out;
}

function responses(op: Operation, b: Binding, refs: RefTarget): Json {
  const owner: RecordRef = { kind: 'operation', id: op.id };
  const out: Json = {};
  const declared = b.responses ?? [];
  if (declared.length === 0) {
    if (op.kind === 'async-command') {
      const accepted = op.async?.accepted;
      const c = content(accepted?.type ?? op.response, undefined, refs, owner);
      out[String(accepted?.status ?? 202)] = { description: acceptedDescription(op), ...(c ? { content: c } : {}) };
    } else {
      const c = content(op.response, undefined, refs, owner);
      out['200'] = { description: 'Success.', ...(c ? { content: c } : {}) };
    }
  }
  for (const r of declared) {
    const c = content(r.type, r.mediaType, refs, owner);
    out[String(r.status)] = { description: r.kind === 'accepted' ? `${r.description} ${acceptedDescription(op)}` : r.description, ...(c ? { content: c } : {}) };
  }
  const unplaced: string[] = [];
  for (const e of op.errors ?? []) {
    if (e.status === undefined) {
      unplaced.push(`${e.code}: ${e.description}${e.retryable ? ' (retryable)' : ''}`);
      continue;
    }
    if (out[String(e.status)] !== undefined) continue;
    const c = content(e.type, undefined, refs, owner);
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
export function projectOpenApi(model: Model, ctx: RenderContext): Record<string, Json> {
  const published = new PublishedSchemas(model, ctx);
  const refs = published.ref;
  const schemas: Json = {};
  for (const t of model.types) schemas[t.id] = typeSchema(t, refs, ctx, true);
  coverTypes(model, ctx, OPENAPI_FILE, ['components', 'schemas']);
  const paths: Record<string, Json> = {};
  for (const op of model.operations) {
    const http = (op.bindings ?? []).filter((b) => b.transport === 'http' && b.method && b.path);
    if (http.length) ctx.covered({ kind: 'operation', id: op.id }, OPENAPI_FILE, ...http.map((b) => pointer('paths', b.path as string, (b.method as string).toLowerCase())));
    const owner: RecordRef = { kind: 'operation', id: op.id };
    http.forEach((b, i) => {
      if (b.requestMediaType !== undefined && FORM_MEDIA.test(b.requestMediaType)) {
        ctx.unsupported('http.multipart', { kind: 'operation', id: op.id }, `operation '${op.id}' takes a ${b.requestMediaType} body, which this profile does not represent`);
      }
      const method = (b.method as string).toLowerCase();
      const item = paths[b.path as string] ?? (paths[b.path as string] = {});
      const request = op.request !== undefined ? published.shape(op.request, owner) : undefined;
      const params = b.parameters ?? [];
      const operation: Json = { operationId: http.length > 1 ? `${op.id}.${i + 1}` : op.id, summary: `${op.kind} ${op.id} (version ${op.version})` };
      if (op.description !== undefined) operation['description'] = op.description;
      if (params.length) operation['parameters'] = params.map((p) => parameter(op, request, p, refs, ctx));
      const carried = new Set(params.map((p) => p.property).filter((x): x is string => x !== undefined));
      if (request && !BODYLESS.has(b.method as string) && request.type.properties.some((p) => !carried.has(p.name))) {
        operation['requestBody'] = { required: true, content: content(op.request, b.requestMediaType, refs, owner) };
      }
      operation['responses'] = responses(op, b, refs);
      if (op.authority.scheme !== undefined) operation['security'] = [{ [op.authority.scheme]: [op.authority.permission] }];
      const authority: Json = { permission: op.authority.permission };
      if (op.authority.scope !== undefined) authority['scope'] = op.authority.scope;
      operation['x-authority'] = authority;
      item[method] = operation;
    });
  }
  published.renderInto(schemas);
  const components: Json = { schemas };
  if (model.securitySchemes.length) components['securitySchemes'] = Object.fromEntries(model.securitySchemes.map((s) => [s.id, securityScheme(s)]));
  for (const s of model.securitySchemes) ctx.covered({ kind: 'securityScheme', id: s.id }, OPENAPI_FILE, pointer('components', 'securitySchemes', s.id));
  return {
    [OPENAPI_FILE]: {
      openapi: '3.1.0',
      info: { title: 'Loom projected API', version: String(model.version), description: SOURCE_NOTICE },
      paths,
      components,
    },
  };
}
