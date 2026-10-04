import {
  CONTRACT_DIGEST,
  MCP_TOOLS,
  SCHEMA_BUNDLE,
  asFinding,
  checkReadinessTool,
  compareBaselineTool,
  contextTool,
  defaultStates,
  describeTool,
  diffTool,
  envelope,
  exportTool,
  importTool,
  mutateTool,
  planChangeTool,
  projectAllTool,
  projectTool,
  refusal,
  schemaErrors,
  selfTest,
  structuralFindings,
  unmetPresenceRules,
  validate,
  validateTool,
  withArtifactHashes,
} from '@loom/core';
import type { CatalogueTool, EvaluationInputs, Finding, Model, ProjectionTarget, ResultEnvelope } from '@loom/core';
import { mutateWorkspace, openSession, stampSession, type Session, type WorkspaceChange } from '@loom/workspace';

/** One tool: its operation, input definition, the definition of its result's `data`, its generated description and its presence rules. */
export type ToolContract = CatalogueTool;

/** The tools of the operation catalogue, in the order tools/list returns them. */
export const TOOL_CONTRACTS: readonly ToolContract[] = MCP_TOOLS;

type Json = Record<string, unknown>;
const DEFS = SCHEMA_BUNDLE.$defs as unknown as Record<string, Json>;
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** The resource that holds the full contract of one definition. */
export const schemaUri = (definition: string): string => `loom://schema/${definition}`;

const refName = (ref: string): string => ref.slice('#/$defs/'.length);
const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Every definition a definition reaches through $ref. */
function closure(name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return seen;
  seen.add(name);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') closure(refName(v), seen);
        else walk(v);
      }
    }
  };
  walk(DEFS[name]);
  return seen;
}

/** The contract's annotation keywords are for Loom's generator, not for a protocol client's validator. */
function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).filter(([k]) => !k.startsWith('x-loom-')).map(([k, v]) => [k, strip(v)]));
  return node;
}

function standalone(root: Json, names: Iterable<string>): Json {
  const $defs = Object.fromEntries([...names].sort().map((n) => [n, strip(DEFS[n])]));
  return { $schema: DRAFT, ...(strip(root) as Json), $defs };
}

const ROOT_COMBINATORS = ['oneOf', 'anyOf', 'allOf'];

/** True for a combinator branch that states only which members must be present. */
function presenceOnly(branch: unknown): boolean {
  return Boolean(branch) && typeof branch === 'object' && Object.entries(branch as Json).every(([k, v]) => k === 'required' || (ROOT_COMBINATORS.includes(k) && Array.isArray(v) && v.every(presenceOnly)));
}

/**
 * The full contract of a tool's result: the result envelope with `data` bound to the tool's
 * payload definition and every definition both reach. The server's results conform to it, and
 * the smoke test validates every result against it.
 */
export function contractOutputSchemaOf(data: string): Json {
  const envelopeDef = DEFS['ResultEnvelope'] as Json;
  const root: Json = { ...envelopeDef, properties: { ...(envelopeDef['properties'] as Json), data: { $ref: `#/$defs/${data}` } } };
  const names = new Set([...closure('ResultEnvelope'), ...closure(data)]);
  names.delete('ResultEnvelope');
  return standalone(root, names);
}

/** The full contract of one definition, as its schema resource serves it: the definition, its $defs closure and the contract digest. */
export function schemaResource(definition: string): Json | null {
  if (!Object.hasOwn(DEFS, definition)) return null;
  return { $schema: DRAFT, $id: schemaUri(definition), $comment: `Contract digest ${CONTRACT_DIGEST}.`, $ref: `#/$defs/${definition}`, ...standaloneDefs(closure(definition)) };
}

const standaloneDefs = (names: Iterable<string>): Json => ({ $defs: Object.fromEntries([...names].sort().map((n) => [n, strip(DEFS[n])])) });

// The compact view a tool advertises. A member of one of these shapes is stated inline, exactly as
// the contract states it; anything deeper becomes an opaque value that admits every value of its
// JSON type, so the advertised schema accepts every valid value, and whose description names the
// resource holding its full contract.
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);
/** The longest enumeration stated inline; a longer vocabulary is named by its resource. */
const INLINE_ENUM_LIMIT = 32;
/** The most members of a small object of simple members stated inline. */
const INLINE_OBJECT_LIMIT = 8;

/** The definition a schema refers to and the schema it resolves to. */
function resolve(schema: Json): { schema: Json; name: string | null } {
  return typeof schema['$ref'] === 'string' ? { schema: DEFS[refName(schema['$ref'])] as Json, name: refName(schema['$ref']) } : { schema, name: null };
}

const valueType = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);

/** The JSON types a schema admits, when they can be read off it; undefined when it admits any value. */
function jsonTypes(schema: Json, seen = new Set<string>()): string[] | undefined {
  const { schema: s, name } = resolve(schema);
  if (name !== null) {
    if (seen.has(name)) return undefined;
    seen.add(name);
    return jsonTypes(s, seen);
  }
  const t = s['type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t as string[];
  if ('const' in s) return [valueType(s['const'])];
  if (Array.isArray(s['enum'])) return [...new Set((s['enum'] as unknown[]).map(valueType))];
  for (const k of ['oneOf', 'anyOf']) {
    if (!Array.isArray(s[k])) continue;
    const branches = (s[k] as Json[]).map((b) => jsonTypes(b, new Set(seen)));
    return branches.some((b) => b === undefined) ? undefined : [...new Set(branches.flat() as string[])];
  }
  return undefined;
}

function isScalar(schema: Json): boolean {
  const s = resolve(schema).schema;
  if (['properties', 'items', 'additionalProperties', 'propertyNames', '$ref', ...ROOT_COMBINATORS].some((k) => k in s)) return false;
  if (Array.isArray(s['enum']) && s['enum'].length > INLINE_ENUM_LIMIT) return false;
  const types = jsonTypes(s);
  return types !== undefined && types.every((t) => SCALAR_TYPES.has(t));
}

function isSmallObject(s: Json): boolean {
  if (s['type'] !== 'object' || !isObject(s['properties']) || ROOT_COMBINATORS.some((k) => k in s)) return false;
  const members = Object.values(s['properties'] as Record<string, Json>);
  return members.length <= INLINE_OBJECT_LIMIT && members.every(isScalar);
}

/** A value the compact schema leaves to its resource: its JSON type and a description naming the resource. */
function opaque(schema: Json, owner: string, refs: Set<string>, own?: unknown): Json {
  refs.add(owner);
  const types = jsonTypes(schema);
  const pointer = `Full contract: ${schemaUri(owner)}.`;
  return { ...(types ? { type: types.length === 1 ? types[0] : types } : {}), description: typeof own === 'string' ? `${own} ${pointer}` : pointer };
}

/** One member of a compact schema; `owner` is the definition whose resource holds an inline member's full contract. */
function member(schema: Json, owner: string, refs: Set<string>): Json {
  const { schema: s, name } = resolve(schema);
  const own = schema['description'];
  const holder = name ?? owner;
  if (isScalar(s)) {
    const { description: _d, ...shape } = strip(s) as Json;
    return name === null ? (strip(s) as Json) : { ...shape, ...(typeof own === 'string' ? { description: own } : {}) };
  }
  if (s['type'] === 'array' && isObject(s['items'])) {
    const kept = Object.fromEntries(['minItems', 'maxItems', 'uniqueItems'].filter((k) => k in s).map((k) => [k, s[k]]));
    return { type: 'array', ...kept, items: member(s['items'] as Json, holder, refs), ...(typeof (own ?? s['description']) === 'string' ? { description: own ?? s['description'] } : {}) };
  }
  if (isSmallObject(s)) return { ...shapeOf(s, holder, refs), ...(typeof own === 'string' ? { description: own } : {}) };
  return opaque(s, holder, refs, own);
}

/** The top level of an object definition: its members as compact members, its requirements, its closure and its remaining root combinators. */
function shapeOf(def: Json, owner: string, refs: Set<string>, replace: Record<string, Json> = {}): Json {
  const properties = Object.fromEntries(Object.entries((def['properties'] ?? {}) as Record<string, Json>).map(([k, v]) => [k, replace[k] ?? member(v, owner, refs)]));
  const out: Json = { type: 'object', properties };
  if (Array.isArray(def['required'])) out['required'] = def['required'];
  if ('additionalProperties' in def) out['additionalProperties'] = isObject(def['additionalProperties']) ? member(def['additionalProperties'], owner, refs) : def['additionalProperties'];
  // Claude-family clients drop a tool whose input schema has oneOf, anyOf or allOf at its root, so a
  // presence-only combinator is left out: the tool description states it, and the server checks it.
  // A combinator that constrains shape stays, and the smoke test fails on it.
  for (const k of ROOT_COMBINATORS) if (Array.isArray(def[k]) && !(def[k] as unknown[]).every(presenceOnly)) out[k] = strip(def[k]);
  return out;
}

const described = (schema: Json, text: string): Json => ({ $schema: DRAFT, description: text, ...schema });

/**
 * A tool's advertised input schema: the compact top level of its input definition. The server
 * validates every call against the full definition before anything runs.
 */
export function inputSchemaOf(definition: string, refs = new Set<string>()): Json {
  const def = DEFS[definition] as Json;
  refs.add(definition);
  const text = `${typeof def['description'] === 'string' ? `${def['description']} ` : ''}Full contract: ${schemaUri(definition)}.`;
  return described(shapeOf(def, definition, refs), text);
}

/** A tool's advertised output schema: the compact result envelope with the compact top level of the tool's payload as `data`. */
export function outputSchemaOf(data: string, refs = new Set<string>()): Json {
  refs.add('ResultEnvelope');
  refs.add(data);
  const payload = { description: `Full contract: ${schemaUri(data)}.`, ...shapeOf(DEFS[data] as Json, data, refs) };
  const envelopeDef = DEFS['ResultEnvelope'] as Json;
  return described(shapeOf(envelopeDef, 'ResultEnvelope', refs, { data: payload }), `${String(envelopeDef['description'])} Full contract: ${schemaUri('ResultEnvelope')}.`);
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Json;
  outputSchema?: Json;
}

/** Tool definitions; output schemas only for a client whose protocol version carries structured tool results. */
export function toolDefinitions(structured: boolean): ToolDefinition[] {
  return TOOL_CONTRACTS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: inputSchemaOf(t.input),
    ...(structured ? { outputSchema: outputSchemaOf(t.data) } : {}),
  }));
}

/** Every definition the advertised schemas name as the resource of a member's full contract. */
export function advertisedDefinitions(): string[] {
  const refs = new Set<string>();
  for (const t of TOOL_CONTRACTS) {
    inputSchemaOf(t.input, refs);
    outputSchemaOf(t.data, refs);
  }
  return [...refs].sort();
}

/** The serialized size of one advertised tool definition, the measure the tool budget applies to. */
export const advertisedBytes = (t: ToolDefinition): number => Buffer.byteLength(JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema }), 'utf8');

/** Every tool whose advertised definition exceeds the budget, and a tool list larger than the budget times its length. */
export function budgetProblems(tools: readonly ToolDefinition[], budget: number, listBytes: number): string[] {
  const problems = tools.filter((t) => advertisedBytes(t) > budget).map((t) => `${t.name} advertises ${advertisedBytes(t)} bytes, over the budget of ${budget}`);
  if (listBytes > budget * tools.length) problems.push(`tools/list takes ${listBytes} bytes, over ${budget} times ${tools.length} tools`);
  return problems;
}

export interface ToolContext {
  /** Directory the workspace resolves from: the server's working directory or its --workspace argument. */
  workspace: string;
  trustedRef?: string;
}

const invalid = (tool: string, findings: Finding[], message: string): ResultEnvelope => envelope(tool, { model: null, findings, refusal: refusal('invalid-input', message) });

/**
 * The presence rules of the tool's catalogue entry, which the input contract's
 * root combinators state, checked first so a refusal names the actual rule
 * rather than a combinator. The core's unmetPresenceRules decides which rules
 * apply and hold, so a rule conditioned on a member value, such as one action,
 * is enforced exactly as the catalogue states it.
 */
function presenceFindings(contract: ToolContract, args: Json): Finding[] {
  return unmetPresenceRules(contract.presence, args).map((rule) => asFinding(rule.code, rule.path, rule.message, rule.fix));
}

/**
 * Validate the arguments against the tool's input contract before anything
 * runs. A model document and patches are left to the core, which reports
 * their structural errors with precise record paths.
 */
function inputRefusal(contract: ToolContract, args: Json): ResultEnvelope | null {
  const presence = presenceFindings(contract, args);
  if (presence.length) return invalid(contract.name, presence, 'The request does not satisfy the tool input contract.');
  const errors = schemaErrors(contract.input, args).filter((e) => !/^\/(model|before|after|patch|patches)(\/|$)/.test(e.pointer) && !(e.pointer === '' && ['oneOf', 'anyOf', 'allOf'].includes(e.keyword)));
  if (!errors.length) return null;
  return invalid(contract.name, errors.map((e) => asFinding('STRUCTURAL_INVALID', e.pointer || '(root)', e.message, 'send arguments that satisfy the tool input schema; loom.describe lists every contract')), 'The request does not satisfy the tool input contract.');
}

function session(ctx: ToolContext): Session {
  return openSession(ctx.workspace, ctx.trustedRef ? { trustedRef: ctx.trustedRef } : {});
}

function noWorkspaceModel(tool: string, s: Session): ResultEnvelope {
  return stampSession(envelope(tool, { model: null, findings: [], refusal: refusal('unresolved-context', 'no workspace model governs the server directory; start the server with --workspace <dir> inside a governed workspace, or send an inline model') }), s);
}

/** selfTest writes its summary with console.log; stdout is the JSON-RPC channel, so the line is held back. */
function quietSelfTest(): ReturnType<typeof selfTest> {
  const original = console.log;
  console.log = (): void => undefined;
  try {
    return selfTest();
  } finally {
    console.log = original;
  }
}

/** One validated tool call: its arguments and, in workspace mode or for a baseline comparison, the session that resolved its model. */
interface Call {
  args: Json;
  session: Session | null;
  inWorkspace: boolean;
  /** The workspace model of a workspace call, otherwise null. */
  model: Model | null;
  inputs: EvaluationInputs;
  /** The arguments with the workspace flag replaced by the workspace model. */
  local(): Json;
  stamp(env: ResultEnvelope): ResultEnvelope;
}

function diffCall(c: Call): ResultEnvelope {
  if (c.args['againstBaseline'] !== true) return diffTool(c.args);
  const ss = c.session as Session;
  if (!ss.inputs.baseline) {
    return c.stamp(envelope('loom.diff', { model: null, findings: [asFinding('BASELINE_MISSING', '(baseline)', 'no trusted accepted baseline is available at the trusted ref', 'accept a baseline and merge it to the trusted ref, or compare two inline models')], refusal: refusal('unresolved-context', 'There is no trusted accepted baseline to compare against.') }));
  }
  const after = c.inWorkspace ? ss.model : c.args['after'];
  // The session hashed the workspace model's artifacts; an inline candidate is judged by its own.
  const judged = c.inWorkspace || structuralFindings(after).length ? ss.inputs : withArtifactHashes(after as Model, ss.inputs);
  return c.stamp({ ...compareBaselineTool({ model: after }, judged), tool: 'loom.diff' });
}

/** A workspace mutation goes through the workspace adapter's persistent mutation, the one the CLI performs too. */
function mutateCall(c: Call): ResultEnvelope {
  if (!c.inWorkspace) return mutateTool(c.args);
  const { workspace: _w, expectedRevision, ...change } = c.args;
  return mutateWorkspace(c.session as Session, String(expectedRevision), () => change as WorkspaceChange);
}

/** The handler of every tool the operation catalogue exposes on the MCP server. */
const HANDLERS: Record<string, (c: Call) => ResultEnvelope> = {
  'loom.validate': (c) => (c.model ? c.stamp(envelope('loom.validate', { model: c.model, findings: validate(c.model, c.inputs), data: {} })) : validateTool(c.args)),
  'loom.mutate': mutateCall,
  'loom.diff': diffCall,
  'loom.project': (c) => c.stamp(projectTool(c.local() as { model: unknown; target: ProjectionTarget; draft?: boolean }, c.session ? c.inputs : undefined)),
  'loom.projectAll': (c) => c.stamp(projectAllTool(c.local() as { model: unknown; draft?: boolean }, c.session ? c.inputs : undefined)),
  'loom.export': (c) => exportTool(c.args as { model?: unknown; format?: 'json' | 'yaml' }),
  'loom.import': (c) => importTool(c.args),
  'loom.selftest': () => envelope('loom.selftest', { model: null, findings: [], states: defaultStates({ state: 'notEvaluated', reasons: [] }), data: quietSelfTest() }),
  'loom.describe': (c) => describeTool(c.args),
  // A follow-up action addresses the workspace the way this call did, never by repeating its model.
  'loom.context': (c) => c.stamp(contextTool(c.local(), c.inputs, c.inWorkspace ? { address: { workspace: true } } : {})),
  'loom.checkReadiness': (c) => c.stamp(checkReadinessTool(c.local(), c.inputs)),
  'loom.planChange': (c) => c.stamp(planChangeTool(c.local(), c.inputs)),
};

/** Every tool this server handles, for the check that the catalogue and the handlers agree. */
export const HANDLED_TOOLS: readonly string[] = Object.keys(HANDLERS);

/** Execute one tool. Never throws for a bad request: every outcome is a result envelope. */
export function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): ResultEnvelope {
  const contract = TOOL_CONTRACTS.find((t) => t.name === name);
  if (!contract) return invalid(name.replace(/[^A-Za-z.]/g, '') || 'loom.unknown', [asFinding('STRUCTURAL_INVALID', '(tool)', `no tool is named '${name}'`, 'call one of the tools the server lists')], 'Unknown tool.');
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Json;
  const refused = inputRefusal(contract, args);
  if (refused) return refused;
  const inWorkspace = args['workspace'] === true;
  const s = inWorkspace || (name === 'loom.diff' && args['againstBaseline'] === true) ? session(ctx) : null;
  if (inWorkspace && (!s || !s.model || !s.workspace)) return noWorkspaceModel(name, s as Session);
  const model = inWorkspace ? (s as Session).model : null;
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
  if (!handler) return invalid(name, [], 'Unknown tool.');
  return handler({
    args,
    session: s,
    inWorkspace,
    model,
    inputs: s?.inputs ?? {},
    local: () => {
      const { workspace: _w, ...rest } = args;
      return model ? { ...rest, model } : rest;
    },
    stamp: (env) => (s ? stampSession(env, s) : env),
  });
}
