import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { canonicalStringify, checkReadinessTool, compareBaselineTool, modelRevision, planChangeTool, sampleModel, textHash } from '@loom/core';
import type { LoomConfig, Model, Patch, Policy, ResultEnvelope, TaskSpec } from '@loom/core';
import { gatherEvaluationInputs } from '@loom/workspace';
import { commitAll, gitInit, scratch, writeJson } from '@loom/workspace/testing';
import { createLoomServer } from '../server.js';

const SERVER = fileURLToPath(new URL('../index.js', import.meta.url));
const LOOM_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CLI = join(LOOM_ROOT, 'packages', 'cli', 'dist', 'index.js');

function cli(cwd: string, ...args: string[]): ResultEnvelope {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd, encoding: 'utf8' });
  return JSON.parse(r.stdout) as ResultEnvelope;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ResultEnvelope> {
  const res = await client.callTool({ name, arguments: args });
  return res.structuredContent as unknown as ResultEnvelope;
}

async function inMemory(workspace?: string): Promise<Client> {
  const loom = createLoomServer(workspace ? { workspace } : {});
  const [c, s] = InMemoryTransport.createLinkedPair();
  await loom.connect(s);
  const client = new Client({ name: 'loom-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(c);
  return client;
}

function workspace(model: Model = sampleModel(), gates: LoomConfig['gates'] = {}): string {
  const dir = gitInit(scratch());
  const init = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stdout);
  writeFileSync(join(dir, '.loom', 'model.json'), `${JSON.stringify(model, null, 2)}\n`);
  for (const c of model.components) mkdirSync(join(dir, c.id), { recursive: true });
  const configPath = join(dir, '.loom', 'loom.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as LoomConfig;
  writeJson(configPath, { ...config, scope: Object.fromEntries(model.components.map((c) => [c.id, [c.id]])), gates });
  return dir;
}

const POLICY: Policy = {
  policyVersion: 1,
  id: 'engineering',
  revision: 1,
  trust: { ref: 'refs/heads/main', acceptanceVia: 'trusted-ref', acceptanceKeys: [], evidenceKeys: [] },
  changeClasses: [{ id: 'docs', description: 'Edits with no semantic effect.', match: { kinds: ['nonSemantic'] }, approval: 'pre-authorized' }],
  readiness: { implementation: { requires: 'accepted-contract' }, integration: { evidence: [] }, release: { evidence: [] } },
  substitutes: [],
  qualification: { required: [], optional: [] },
  environments: [],
};

/** A workspace whose policy, accepted baseline and acceptance are committed to the trusted ref. */
function governed(): string {
  const dir = workspace(sampleModel(), { policyRef: 'engineering' });
  writeJson(join(dir, '.loom', 'policies', 'engineering.json'), POLICY);
  commitAll(dir, 'policy');
  cli(dir, 'accept', '--id', 'acc-1', '--authority', 'team-architecture', '--subject', 'baseline', '--baseline', 'bl-1');
  commitAll(dir, 'acceptance');
  const created = cli(dir, 'baseline', 'create', '--id', 'bl-1', '--acceptance', 'acc-1');
  assert.equal(created.outcome, 'ok', JSON.stringify(created.findings));
  commitAll(dir, 'baseline');
  return dir;
}

const states = (e: ResultEnvelope): string => [e.states.validation.state, e.states.readiness.state, e.states.qualification.state, e.states.acceptance.state].join('/');
const reasons = (e: ResultEnvelope): string => e.states.readiness.reasons.map((r) => r.code).sort().join(',');

test('two server processes on one workspace: of two writers on one base revision exactly one succeeds', async () => {
  const dir = workspace();
  const base = modelRevision(JSON.parse(readFileSync(join(dir, '.loom', 'model.json'), 'utf8')) as Model);
  const clients: Client[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: `writer-${i}`, version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, '--workspace', dir], stderr: 'ignore' }));
      clients.push(client);
    }
    const edit = (text: string): Record<string, unknown> => ({ workspace: true, expectedRevision: base, patch: { op: 'update', collection: 'operations', id: 'order.get', set: { description: text } } });
    const results = await Promise.all(clients.map((c, i) => call(c, 'loom.mutate', edit(`Written by writer ${i}.`))));
    assert.equal(results.filter((r) => r.outcome === 'ok').length, 1, JSON.stringify(results.map((r) => r.refusal)));
    const loser = results.find((r) => r.outcome === 'refused') as ResultEnvelope;
    assert.equal(loser.refusal?.cause, 'stale-base');
    assert.ok(loser.findings.some((f) => f.code === 'STALE_BASE_REVISION'));
  } finally {
    for (const c of clients) await c.close();
  }
});

test('a workspace mutation without its expected revision is refused before anything runs', async () => {
  const client = await inMemory(workspace());
  const r = await call(client, 'loom.mutate', { workspace: true, patch: { op: 'clearSystemProfile' } });
  assert.equal(r.outcome, 'refused');
  assert.ok(r.findings.some((f) => f.path === 'expectedRevision'));
});

test('the server refuses a workspace request when no workspace governs its directory', async () => {
  const client = await inMemory(scratch());
  const r = await call(client, 'loom.validate', { workspace: true });
  assert.equal(r.refusal?.cause, 'unresolved-context');
});

test('core, CLI and MCP agree on readiness, acceptance and compatibility for one governed workspace', async () => {
  const dir = governed();
  const model = JSON.parse(readFileSync(join(dir, '.loom', 'model.json'), 'utf8')) as Model;
  const { inputs } = gatherEvaluationInputs(dir, { asOf: new Date().toISOString().slice(0, 10) });
  const client = await inMemory(dir);
  const task: TaskSpec = { class: 'implementation', mode: 'component', components: ['ordering'] };

  const coreReady = checkReadinessTool({ model, task }, inputs);
  const cliReady = cli(dir, 'readiness', '--class', 'implementation', '--components', 'ordering');
  const mcpReady = await call(client, 'loom.checkReadiness', { workspace: true, task });
  assert.equal(states(cliReady), states(coreReady));
  assert.equal(states(mcpReady), states(coreReady));
  assert.equal(reasons(cliReady), reasons(coreReady));
  assert.equal(reasons(mcpReady), reasons(coreReady));

  const coreAccept = compareBaselineTool({ model }, inputs);
  const cliAccept = cli(dir, 'check');
  const mcpAccept = await call(client, 'loom.diff', { workspace: true, againstBaseline: true });
  assert.equal(coreAccept.states.acceptance.state, 'accepted');
  assert.equal(cliAccept.states.acceptance.state, coreAccept.states.acceptance.state);
  assert.equal(mcpAccept.states.acceptance.state, coreAccept.states.acceptance.state);

  const patch: Patch = { op: 'update', collection: 'operations', id: 'order.place', set: { authority: { permission: 'order.admin', scheme: 'bearer' } } };
  const patchFile = join(dir, 'patch.json');
  writeJson(patchFile, patch);
  const corePlan = planChangeTool({ model, baseRevision: modelRevision(model), patch, acknowledgeBreaking: ['order.place'] }, inputs);
  const cliPlan = cli(dir, 'plan', '--patch', patchFile, '--ack', 'order.place');
  const mcpPlan = await call(client, 'loom.planChange', { workspace: true, baseRevision: modelRevision(model), patch, acknowledgeBreaking: ['order.place'] });
  // The whole preview must agree: delta, compatibility, affected consumers, invalidated evidence, repairs and obligations.
  const compat = (e: ResultEnvelope): string => canonicalStringify(e.data ?? {});
  assert.equal(compat(cliPlan), compat(corePlan));
  assert.equal(compat(mcpPlan), compat(corePlan));
  assert.equal(states(cliPlan), states(corePlan));
  assert.equal(states(mcpPlan), states(corePlan));
});

test('core, CLI and MCP agree on the readiness cases of the independent fixtures', async () => {
  const client = await inMemory();
  const fixtures = join(LOOM_ROOT, 'qualification', 'fixtures');
  let compared = 0;
  for (const set of ['cli-library', 'api-database', 'async-workflow']) {
    const expected = JSON.parse(readFileSync(join(fixtures, set, 'expected.json'), 'utf8')) as { cases: Array<{ model?: string; baseline?: string; patches?: string; expect: { readiness?: Array<{ task: TaskSpec }> } }> };
    for (const c of expected.cases) {
      if (!c.model || c.baseline || c.patches) continue;
      const modelFile = join(fixtures, set, ...c.model.split('/'));
      const model = JSON.parse(readFileSync(modelFile, 'utf8')) as Model;
      for (const { task } of c.expect.readiness ?? []) {
        const core = checkReadinessTool({ model, task }, {});
        const viaMcp = await call(client, 'loom.checkReadiness', { model, task });
        const args = ['readiness', '--model', modelFile, '--class', task.class, '--mode', task.mode];
        if (task.components) args.push('--components', task.components.join(','));
        if (task.requirements) args.push('--requirements', task.requirements.join(','));
        const viaCli = cli(scratch(), ...args);
        assert.equal(states(viaMcp), states(core), `${set}: MCP readiness differs`);
        assert.equal(states(viaCli), states(core), `${set}: CLI readiness differs`);
        assert.equal(reasons(viaMcp), reasons(core));
        assert.equal(reasons(viaCli), reasons(core));
        compared++;
      }
    }
  }
  assert.ok(compared >= 3, `compared ${compared} readiness cases`);
});

test('an inline diff with an invalid side is marked provisional and a stale context continuation is refused', async () => {
  const client = await inMemory();
  const model = sampleModel();
  const broken = sampleModel();
  broken.mutations[0]!.from = ['$absent', 'placed'];
  const d = await call(client, 'loom.diff', { before: model, after: broken });
  assert.equal((d.data as { provisional: boolean }).provisional, true);
  const c = await call(client, 'loom.context', { model, target: { kind: 'component', ref: { kind: 'component', id: 'ordering' } }, budget: { maxRecords: 3 }, continuation: `ctx1.${textHash('other')}.3` });
  assert.equal(c.refusal?.cause, 'stale-base');
});
