import {
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

/** Every definition a definition reaches through $ref. */
function closure(name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return seen;
  seen.add(name);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') closure(v.slice('#/$defs/'.length), seen);
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
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...(strip(root) as Json), $defs };
}

const ROOT_COMBINATORS = ['oneOf', 'anyOf', 'allOf'];

/** True for a combinator branch that states only which members must be present. */
function presenceOnly(branch: unknown): boolean {
  return Boolean(branch) && typeof branch === 'object' && Object.entries(branch as Json).every(([k, v]) => k === 'required' || (ROOT_COMBINATORS.includes(k) && Array.isArray(v) && v.every(presenceOnly)));
}

/**
 * A tool's complete input schema: the definition with only the definitions it references.
 * Claude-family clients drop a tool whose input schema has oneOf, anyOf or allOf at its root,
 * so the contract's root exactly-one combinators are left out of the advertised schema; the
 * tool description states them and presenceFindings plus the contract validator enforce them
 * on every call. A root combinator that constrains shape rather than presence is kept, and the
 * smoke test fails on it.
 */
export function inputSchemaOf(definition: string): Json {
  const names = closure(definition);
  names.delete(definition);
  const root = Object.fromEntries(Object.entries(DEFS[definition] as Json).filter(([k, v]) => !(ROOT_COMBINATORS.includes(k) && Array.isArray(v) && v.every(presenceOnly))));
  return standalone(root, [...names]);
}

/** A tool's output schema: the result envelope with `data` bound to the tool's payload definition. */
export function outputSchemaOf(data: string): Json {
  const envelopeDef = DEFS['ResultEnvelope'] as Json;
  const root: Json = { ...envelopeDef, properties: { ...(envelopeDef['properties'] as Json), data: { $ref: `#/$defs/${data}` } } };
  const names = new Set([...closure('ResultEnvelope'), ...closure(data)]);
  names.delete('ResultEnvelope');
  return standalone(root, names);
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

export interface ToolContext {
  /** Directory the workspace resolves from: the server's working directory or its --workspace argument. */
  workspace: string;
  trustedRef?: string;
}

const invalid = (tool: string, findings: Finding[], message: string): ResultEnvelope => envelope(tool, { model: null, findings, refusal: refusal('invalid-input', message) });

/**
 * The presence rules of the tool's catalogue entry, which the input contract's
 * root combinators state, checked first so a refusal names the actual rule
 * rather than a combinator. A rule holds when one of its accepted combinations
 * has every member it lists as present sent and every member it lists as
 * absent left out.
 */
function presenceFindings(contract: ToolContract, args: Json): Finding[] {
  const has = (k: string): boolean => args[k] !== undefined;
  return contract.presence
    .filter((rule) => !rule.accept.some((a) => a.present.every(has) && a.absent.every((k) => !has(k))))
    .map((rule) => asFinding(rule.code, rule.path, rule.message, rule.fix));
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
  'loom.context': (c) => c.stamp(contextTool(c.local(), c.inputs)),
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
