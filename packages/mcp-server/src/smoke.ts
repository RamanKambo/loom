import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { canonicalStringify, exportModel, modelRevision, sampleModel, textHash } from '@loom/core';
import type { LoomConfig, Model, ResultEnvelope } from '@loom/core';
import { initWorkspace } from '@loom/workspace';
import { createLoomServer } from './server.js';
import { TOOL_CONTRACTS } from './tools.js';

type FormatsPlugin = (ajv: unknown, opts?: unknown) => unknown;
const raw = addFormatsModule as unknown as FormatsPlugin | { default: FormatsPlugin };
const addFormats: FormatsPlugin = typeof raw === 'function' ? raw : raw.default;

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`mcp smoke: ${message}`);
}

async function connect(workspace?: string): Promise<Client> {
  const loom = createLoomServer(workspace ? { workspace } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await loom.connect(serverTransport);
  const client = new Client({ name: 'loom-smoke', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

/** A throwaway governed workspace holding the fixture model; its local git config never touches a real repository. */
export function fixtureWorkspace(model: Model = sampleModel()): string {
  const dir = mkdtempSync(join(tmpdir(), 'loom-mcp-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  for (const [k, v] of [['core.autocrlf', 'false'], ['commit.gpgsign', 'false'], ['user.name', 'loom-fixture'], ['user.email', 'loom-fixture@example.invalid']]) execFileSync('git', ['config', k as string, v as string], { cwd: dir });
  const init = initWorkspace(dir);
  if (init.outcome !== 'ok') throw new Error(`init refused: ${JSON.stringify(init.findings)}`);
  writeFileSync(join(dir, '.loom', 'model.json'), `${exportModel(model)}\n`);
  const configPath = join(dir, '.loom', 'loom.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as LoomConfig;
  const scope = Object.fromEntries(model.components.map((c) => [c.id, [c.id]]));
  for (const c of model.components) mkdirSync(join(dir, c.id), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ ...config, scope }, null, 2)}\n`);
  return dir;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ env: ResultEnvelope; structured: unknown; text: string }> {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
  return { env: JSON.parse(text) as ResultEnvelope, structured: res.structuredContent, text };
}

/**
 * Non-interactive proof of the server over the real protocol: every tool lists
 * a complete input and output schema, every result validates against its
 * output schema, refusals are typed, a persistent mutation cannot overwrite a
 * concurrent one, a dry run writes nothing, and a client without structured
 * results receives an explicit compatibility result.
 */
async function main(): Promise<void> {
  const client = await connect();
  const list = await client.listTools();
  expect(list.tools.length === TOOL_CONTRACTS.length, `expected ${TOOL_CONTRACTS.length} tools, got ${list.tools.length}`);
  const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const outputValidators = new Map(list.tools.map((t) => [t.name, ajv.compile(t.outputSchema as object)]));
  for (const t of list.tools) {
    expect(t.inputSchema.type === 'object' && Boolean(t.outputSchema), `${t.name} lacks a complete input or output schema`);
    ajv.compile(t.inputSchema as object);
  }
  const conform = (name: string, structured: unknown): void => {
    const validate = outputValidators.get(name);
    expect(Boolean(validate && validate(structured)), `${name} structuredContent does not match its outputSchema: ${JSON.stringify(validate?.errors?.slice(0, 3))}`);
  };

  const model = sampleModel();
  const cases: Array<[string, Record<string, unknown>]> = [
    ['loom.validate', { model }],
    ['loom.mutate', { model, patch: { op: 'update', collection: 'operations', id: 'order.get', set: { description: 'Read one order by its id.' } } }],
    ['loom.diff', { before: model, after: model }],
    ['loom.project', { model, target: 'openapi' }],
    ['loom.projectAll', { model }],
    ['loom.export', { model, format: 'yaml' }],
    ['loom.import', { text: exportModel(model) }],
    ['loom.selftest', {}],
    ['loom.describe', { sections: ['tools', 'limits'] }],
    ['loom.context', { model, target: { kind: 'component', ref: { kind: 'component', id: 'ordering' } }, budget: { maxRecords: 5 } }],
    ['loom.checkReadiness', { model, task: { class: 'implementation', mode: 'component', components: ['ordering'] } }],
    ['loom.planChange', { model, baseRevision: modelRevision(model), patch: { op: 'update', collection: 'operations', id: 'order.get', set: { description: 'Read one order.' } } }],
  ];
  for (const [name, args] of cases) {
    const r = await call(client, name, args);
    conform(name, r.structured);
    expect(canonicalStringify(r.structured) === r.text, `${name} text fallback differs from structuredContent`);
    expect(r.env.outcome === 'ok', `${name} was refused: ${JSON.stringify(r.env.refusal)} ${JSON.stringify(r.env.findings.slice(0, 2))}`);
  }
  const context = await call(client, 'loom.context', cases[9]?.[1] as Record<string, unknown>);
  expect(!context.env.completeness.complete && typeof context.env.completeness.continuation === 'string', 'a context result over its budget names its omissions and continuation');

  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ['loom.mutate', { model, patch: { op: 'update', collection: 'mutations', id: 'order.pay', set: { gaurd: { form: 'prose', text: 'x' } } } }, 'PATCH_INVALID'],
    ['loom.mutate', { model, patch: { op: 'clearSystemProfile' }, patches: [{ op: 'clearSystemProfile' }] }, 'PATCH_AMBIGUOUS'],
    ['loom.validate', { model, extra: true }, 'STRUCTURAL_INVALID'],
    ['loom.validate', { model: { version: 2 } }, 'MODEL_FORMAT_UNSUPPORTED'],
    ['loom.planChange', { model, baseRevision: textHash('another revision'), patch: { op: 'clearSystemProfile' } }, 'STALE_BASE_REVISION'],
    ['loom.context', { model, target: { kind: 'component', ref: { kind: 'component', id: 'ordering' } }, budget: { maxRecords: 5 }, continuation: `ctx1.${textHash('another')}.5` }, 'STALE_BASE_REVISION'],
  ];
  for (const [name, args, code] of refusals) {
    const r = await call(client, name, args);
    conform(name, r.structured);
    expect(r.env.outcome === 'refused' && r.env.findings.some((f) => f.code === code), `${name} should refuse with ${code}, got ${r.env.outcome} ${r.env.findings.map((f) => f.code).join(',')}`);
  }

  const ws = fixtureWorkspace();
  try {
    const modelPath = join(ws, '.loom', 'model.json');
    const a = await connect(ws);
    const b = await connect(ws);
    const v = await call(a, 'loom.validate', { workspace: true });
    conform('loom.validate', v.structured);
    expect(v.env.outcome === 'ok' && Boolean(v.env.revisions.config), 'workspace validation carries the configuration revision');
    const base = v.env.revisions.model as string;
    const before = textHash(readFileSync(modelPath, 'utf8'));
    const dry = await call(a, 'loom.mutate', { workspace: true, expectedRevision: base, dryRun: true, patch: { op: 'update', collection: 'operations', id: 'order.get', set: { description: 'Dry run only.' } } });
    conform('loom.mutate', dry.structured);
    expect(dry.env.outcome === 'ok' && textHash(readFileSync(modelPath, 'utf8')) === before, 'a dry run leaves the model file unchanged');
    const edit = (text: string): Record<string, unknown> => ({ workspace: true, expectedRevision: base, patch: { op: 'update', collection: 'operations', id: 'order.get', set: { description: text } } });
    const [first, second] = await Promise.all([call(a, 'loom.mutate', edit('The first agent wrote this.')), call(b, 'loom.mutate', edit('The second agent wrote this.'))]);
    const outcomes = [first.env, second.env];
    expect(outcomes.filter((e) => e.outcome === 'ok').length === 1, 'exactly one of two writers on one base revision succeeds');
    expect(outcomes.some((e) => e.refusal?.cause === 'stale-base' && e.findings.some((f) => f.code === 'STALE_BASE_REVISION')), 'the other writer is refused as stale');
    for (const e of outcomes) conform('loom.mutate', e);
    console.log('loom mcp: concurrent persistent mutations - one committed, one refused as stale; the dry run wrote nothing.');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }

  // A client negotiating a protocol version without structured tool results.
  const loom = createLoomServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await loom.connect(serverTransport);
  const replies = new Map<number, JSONRPCMessage>();
  clientTransport.onmessage = (m) => {
    const id = (m as { id?: number }).id;
    if (typeof id === 'number') replies.set(id, m);
  };
  await clientTransport.start();
  const send = async (id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    await clientTransport.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    for (let i = 0; i < 200 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 5));
    return (replies.get(id) as { result: Record<string, unknown> }).result;
  };
  await send(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'older-client', version: '0.0.0' } });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  const older = await send(2, 'tools/list', {});
  expect((older['tools'] as Array<Record<string, unknown>>).every((t) => !('outputSchema' in t)), 'an older client is not offered output schemas');
  const result = await send(3, 'tools/call', { name: 'loom.validate', arguments: { model } });
  const text = ((result['content'] as Array<{ text: string }>)[0] as { text: string }).text;
  expect(!('structuredContent' in result) && (JSON.parse(text) as ResultEnvelope).findings.some((f) => f.code === 'CLIENT_CAPABILITY_UNSUPPORTED'), 'an older client receives the envelope as text with an explicit compatibility finding');

  console.log(`loom mcp smoke PASS: ${list.tools.length} tools with input and output schemas; ${cases.length} results and ${refusals.length} typed refusals conform to their output schemas.`);
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
