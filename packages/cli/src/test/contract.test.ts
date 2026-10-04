import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTRACT_DIGEST, OPERATION_CATALOGUE, schemaErrors, unmetPresenceRules } from '@loom/core';
import type { OperationCatalogue } from '@loom/core';
import { scratch } from '@loom/workspace/testing';

const LOOM_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CORE = join(LOOM_ROOT, 'packages', 'core');

/**
 * A copy of the authored contract, its generated artifacts, the generator and
 * the files it reads and writes beside them, laid out as in the repository and
 * resolving its dependencies from this installation, so a test can break the
 * copy and run the generator on it without touching the repository.
 */
function contractCopy(t: TestContext): string {
  const dir = scratch();
  const core = join(dir, 'packages', 'core');
  const modules = join(dir, 'node_modules');
  for (const part of ['scripts', 'schema', join('src', 'generated'), join('src', 'projections', 'notice.ts')]) {
    mkdirSync(dirname(join(core, part)), { recursive: true });
    cpSync(join(CORE, part), join(core, part), { recursive: true });
  }
  mkdirSync(join(dir, 'Docs'), { recursive: true });
  cpSync(join(LOOM_ROOT, 'Docs', 'operations.md'), join(dir, 'Docs', 'operations.md'));
  symlinkSync(join(LOOM_ROOT, 'node_modules'), modules, 'junction');
  t.after(() => {
    // The junction goes first, so removing the copy can never reach the installation's modules.
    unlinkSync(modules);
    rmSync(dir, { recursive: true, force: true });
  });
  return core;
}

function generate(core: string, ...args: string[]): { status: number; output: string } {
  const r = spawnSync(process.execPath, [join(core, 'scripts', 'generate.mjs'), ...args], { encoding: 'utf8' });
  return { status: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
}

function editJson(path: string, edit: (doc: Record<string, unknown>) => void): void {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(doc);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

const digestOf = (core: string): string => /CONTRACT_DIGEST = "([^"]+)"/.exec(readFileSync(join(core, 'src', 'generated', 'digest.ts'), 'utf8'))?.[1] ?? '';

test('generate --check accepts the authored contract and refuses a generated artifact edited by hand', (t) => {
  const core = contractCopy(t);
  const clean = generate(core, '--check');
  assert.equal(clean.status, 0, clean.output);
  assert.match(clean.output, /artifacts current/);
  const registry = join(core, 'src', 'generated', 'registry.ts');
  writeFileSync(registry, `${readFileSync(registry, 'utf8')}\nexport const EDITED_BY_HAND = true;\n`);
  const drifted = generate(core, '--check');
  assert.equal(drifted.status, 1, drifted.output);
  assert.match(drifted.output, /stale: .*registry\.ts/);
});

test('the contract digest is regenerated from every authored schema, profile and interface control document', (t) => {
  const core = contractCopy(t);
  assert.equal(digestOf(core), CONTRACT_DIGEST, 'the copy starts at the digest the core was built with');
  editJson(join(core, 'schema', 'profiles', 'sql.json'), (p) => (p['description'] = `${String(p['description'])} Edited.`));
  assert.equal(generate(core, '--check').status, 1, 'a profile edit leaves the recorded digest stale');
  const written = generate(core);
  assert.equal(written.status, 0, written.output);
  assert.notEqual(digestOf(core), CONTRACT_DIGEST);
  assert.match(digestOf(core), /^sha256:[0-9a-f]{64}$/);
});

test('a schema keyword outside the qualified vocabulary fails generation instead of being dropped', (t) => {
  const core = contractCopy(t);
  editJson(join(core, 'schema', 'common.schema.json'), (s) => {
    const defs = s['$defs'] as Record<string, Record<string, unknown>>;
    defs['Id']!['minProperties'] = 1;
  });
  const r = generate(core, '--check');
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /keyword 'minProperties' is outside the qualified vocabulary/);
});

test('a hand-authored contract fixture whose valid instance the schema rejects fails generation', (t) => {
  const core = contractCopy(t);
  editJson(join(core, 'schema', 'fixtures', 'policy.json'), (fx) => {
    const valid = fx['valid'] as Array<{ trust: { ref: string } }>;
    valid[0]!.trust.ref = 'main';
  });
  const r = generate(core, '--check');
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /fixtures\/policy\.json: valid\[0\] is rejected/);
});

test('an interface control document that consumes an interface no component provides fails generation', (t) => {
  const core = contractCopy(t);
  editJson(join(core, 'schema', 'icd', 'cli.json'), (icd) => (icd['consumes'] as unknown[]).push({ component: 'core', interface: 'undeclaredInterface' }));
  const r = generate(core, '--check');
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /consumes 'core:undeclaredInterface', which no ICD provides/);
});

test('generate --check refuses a hand edit of the generated operation reference', (t) => {
  const core = contractCopy(t);
  const reference = join(core, '..', '..', 'Docs', 'operations.md');
  writeFileSync(reference, `${readFileSync(reference, 'utf8')}\nEdited by hand.\n`);
  const r = generate(core, '--check');
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stale: .*operations\.md/);
});

test('every MCP example of the operation catalogue satisfies the input definition of its tool', () => {
  let checked = 0;
  for (const op of OPERATION_CATALOGUE.operations) {
    if (op.exposure.mcp === 'none') continue;
    for (const example of op.exposure.mcp.examples) {
      assert.deepEqual(schemaErrors(op.exposure.mcp.input, example.input), [], `${op.id}: ${example.description}`);
      checked++;
    }
  }
  assert.ok(checked >= 5, `checked ${checked} examples`);
});

const presenceRule = (id: string): OperationCatalogue['presenceRules'][number] => OPERATION_CATALOGUE.presenceRules.find((r) => r.id === id) as OperationCatalogue['presenceRules'][number];

test('every example of the operation catalogue keeps the presence rules of its tool, and every agent-tool example satisfies its input and selects its own action', () => {
  let checked = 0;
  for (const op of OPERATION_CATALOGUE.operations) {
    const contracts = [op.exposure.mcp === 'none' ? null : op.exposure.mcp, op.agentTool ?? null].filter((c) => c !== null);
    for (const contract of contracts) {
      const rules = contract.presence.map(presenceRule);
      for (const example of contract.examples) {
        assert.deepEqual(schemaErrors(contract.input, example.input), [], `${op.id}: ${example.description}`);
        assert.deepEqual(unmetPresenceRules(rules, example.input).map((r) => r.id), [], `${op.id}: ${example.description}`);
        checked++;
      }
    }
    const agent = op.agentTool;
    if (agent === undefined) continue;
    assert.equal(op.exposure.mcp, 'none', `${op.id}: an agent tool is catalogued only for an operation the server does not advertise`);
    for (const example of agent.examples) assert.equal((example.input as Record<string, unknown>)['action'], agent.action, `${op.id}: ${example.description} selects the operation's action`);
  }
  assert.ok(checked >= 20, `checked ${checked} examples`);
});

test('a presence rule conditioned on a member value applies only under that value, and an action sending another action\'s member is refused', () => {
  const unmet = (ids: string[], args: Record<string, unknown>): string[] => unmetPresenceRules(ids.map(presenceRule), args).map((r) => r.id);
  const workspace = ['workspace-inspect', 'workspace-initialize', 'workspace-initialize-apply', 'workspace-open', 'workspace-handle'];
  const declaration = { configVersion: 1, model: 'model.json', scope: { payments: ['src'] }, outputs: {}, gates: {} };
  const vector = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(unmet(workspace, { action: 'inspect', path: 'services/payments' }), []);
  assert.deepEqual(unmet(workspace, { action: 'inspect', path: 'services/payments', workspaceId: 'ws_3f9a1c7d' }), ['workspace-inspect'], 'inspect refuses a member of another action');
  assert.deepEqual(unmet(workspace, { action: 'initialize', path: 'services/payments', declaration, dryRun: true }), [], 'a dry run needs no expected inspection');
  assert.deepEqual(unmet(workspace, { action: 'initialize', path: 'services/payments', declaration, dryRun: false }), ['workspace-initialize-apply'], 'an initialization that writes names its expected inspection');
  assert.deepEqual(unmet(workspace, { action: 'initialize', path: 'services/payments', declaration, dryRun: false, expectedInspection: vector }), []);
  assert.deepEqual(unmet(workspace, { action: 'open', path: 'services/payments' }), ['workspace-open'], 'open names its access');
  assert.deepEqual(unmet(workspace, { action: 'status' }), ['workspace-handle'], 'status names its handle');
  assert.deepEqual(unmet(workspace, { action: 'close', workspaceId: 'ws_3f9a1c7d', access: 'edit' }), ['workspace-handle'], 'close takes nothing but its handle');
  const federation = ['federation-inspect', 'federation-plan', 'federation-apply', 'federation-check', 'federation-publish'];
  assert.deepEqual(unmet(federation, { action: 'inspect', workspaceId: 'ws_3f9a1c7d', changes: [] }), ['federation-inspect']);
  assert.deepEqual(unmet(federation, { action: 'apply', workspaceId: 'ws_3f9a1c7d', proposalId: 'prop-1' }), ['federation-apply'], 'apply names the vector it was planned against');
  assert.deepEqual(unmet(federation, { action: 'check', workspaceId: 'ws_3f9a1c7d', snapshotDigest: vector }), []);
  const qualify = ['qualify-start', 'qualify-status', 'qualify-cancel'];
  assert.deepEqual(unmet(qualify, { action: 'start', workspaceId: 'ws_3f9a1c7d', checks: ['sql.behavior'], target: { kind: 'workspace' }, expectedVector: vector }), ['qualify-start'], 'start names its execution policy');
  assert.deepEqual(unmet(qualify, { action: 'status', workspaceId: 'ws_3f9a1c7d', runId: 'run-1', checks: ['sql.behavior'] }), ['qualify-status']);
  assert.deepEqual(unmet(qualify, { action: 'cancel', workspaceId: 'ws_3f9a1c7d', runId: 'run-1', cursor: 'run-1.page.2' }), ['qualify-cancel']);
  assert.deepEqual(unmet(['model-or-workspace'], { action: 'inspect' }), ['model-or-workspace'], 'a rule without conditions always applies');
});

test('generation refuses an operation catalogue whose examples, references, vocabularies or exposures do not hold', (t) => {
  const core = contractCopy(t);
  editJson(join(core, 'schema', 'operations.json'), (doc) => {
    const catalogue = doc as unknown as OperationCatalogue;
    const op = (id: string): OperationCatalogue['operations'][number] => catalogue.operations.find((o) => o.id === id) as OperationCatalogue['operations'][number];
    const mcp = (id: string): Exclude<OperationCatalogue['operations'][number]['exposure']['mcp'], 'none'> => op(id).exposure.mcp as Exclude<OperationCatalogue['operations'][number]['exposure']['mcp'], 'none'>;
    mcp('mutate').examples.push({ description: 'A patch and a batch at once.', input: { model: {}, patch: { op: 'clearSystemProfile' }, patches: [{ op: 'clearSystemProfile' }], force: true } });
    mcp('planChange').presence.push('workspace-revision');
    mcp('projectAll').input = 'NoSuchInput';
    mcp('export').tool = 'loom.validate';
    mcp('import').presence.push('no-such-rule');
    op('init').nextAction.operation = 'nothing';
    op('owner').refusals.push({ cause: 'refused-politely', when: 'it would rather not' });
    op('coverage').effects = 'executes';
    op('describe').exposure.mcp = 'none';
    const check = op('check').exposure.cli;
    if (check !== 'none') check.examples.push({ description: 'Another command.', command: 'write' });
    catalogue.presenceRules.push({ id: 'unused', accept: [{ present: ['model'], absent: [] }], code: 'STRUCTURAL_INVALID', path: '(root)', message: 'send a model', fix: 'send a model' });
  });
  const r = generate(core, '--check');
  assert.equal(r.status, 1, r.output);
  for (const problem of [
    /operation 'mutate': MCP example 1 does not satisfy MutateInput/,
    /operation 'planChange': presence rule 'workspace-revision' names 'expectedRevision', which PlanChangeInput does not declare/,
    /operation 'projectAll': the contract defines no 'NoSuchInput'/,
    /MCP tool 'loom\.validate' is declared twice/,
    /operation 'import': names no presence rule 'no-such-rule'/,
    /operation 'init': its next action names no operation 'nothing'/,
    /operation 'owner': refusal cause 'refused-politely' is not a Refusal cause/,
    /operation 'coverage': effect 'executes' is not one of none, reads, writes/,
    /operation 'describe': a reason is given exactly when an interface does not expose the operation/,
    /operation 'check': CLI example 2 does not start with 'check'/,
    /presence rule 'unused' is named by no tool/,
  ]) assert.match(r.output, problem);
});

test('generation refuses agent tools and resources whose actions, conditions, examples or templates do not hold', (t) => {
  const core = contractCopy(t);
  editJson(join(core, 'schema', 'operations.json'), (doc) => {
    const catalogue = doc as unknown as OperationCatalogue;
    const op = (id: string): OperationCatalogue['operations'][number] => catalogue.operations.find((o) => o.id === id) as OperationCatalogue['operations'][number];
    const agent = (id: string): NonNullable<OperationCatalogue['operations'][number]['agentTool']> => op(id).agentTool as NonNullable<OperationCatalogue['operations'][number]['agentTool']>;
    const rule = (id: string): OperationCatalogue['presenceRules'][number] => catalogue.presenceRules.find((r) => r.id === id) as OperationCatalogue['presenceRules'][number];
    agent('workspaceClose').action = 'status';
    agent('workspaceInspect').examples.push({ description: 'A path that is a number.', input: { action: 'inspect', path: 7 } });
    agent('diagram').tool = 'loom.validate';
    op('validate').agentTool = { tool: 'loom.check', input: 'ValidateInput', data: 'ValidateData', presence: [], examples: [] };
    rule('workspace-open').when = [{ member: 'mode', in: ['open'] }];
    rule('qualify-cancel').when = [{ member: 'action', in: ['abort'] }];
    catalogue.resources[0]!.contents = 'NoSuchContents';
    delete catalogue.resources[1]!.reason;
    catalogue.resources[3]!.uri = 'loom://workspaces/{workspaceId}/runs/{runId}';
  });
  const r = generate(core, '--check');
  assert.equal(r.status, 1, r.output);
  for (const problem of [
    /agent tool 'loom\.workspace': action 'status' is catalogued twice/,
    /agent tool 'loom\.workspace': action 'close' of WorkspaceInput has no operation/,
    /operation 'workspaceInspect': agent-tool example 1 does not satisfy WorkspaceInput/,
    /operation 'diagram': agent tool 'loom\.validate' is also an advertised MCP tool/,
    /operation 'validate': only an operation the MCP server does not advertise states an agent tool/,
    /operation 'workspaceOpen': presence rule 'workspace-open' applies on 'mode', which WorkspaceInput does not declare/,
    /operation 'qualifyCancel': presence rule 'qualify-cancel' applies on 'action' being "abort", which QualifyInput does not admit/,
    /resource 'loom:\/\/guide\/engineering': the contract defines no 'NoSuchContents'/,
    /resource 'loom:\/\/guide\/workflow': a reason is given exactly when the server does not list the resource/,
    /resource 'loom:\/\/workspaces\/\{workspaceId\}\/runs\/\{runId\}': its variable '\{runId\}' names no required member of WorkspaceStatus/,
  ]) assert.match(r.output, problem);
});

test('generation refuses a default that its own schema rejects, such as a rendering default above its maximum', (t) => {
  const core = contractCopy(t);
  editJson(join(core, 'schema', 'diagram.schema.json'), (s) => {
    const budget = (s['$defs'] as Record<string, { properties: Record<string, Record<string, unknown>> }>)['RenderingBudget']!;
    budget.properties['maxNodes']!['default'] = 5000;
    budget.properties['maxDurationMs']!['default'] = 50;
  });
  const r = generate(core, '--check');
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /\/\$defs\/RenderingBudget\/properties\/maxNodes: the default 5000 does not satisfy its own schema/);
  assert.match(r.output, /\/\$defs\/RenderingBudget\/properties\/maxDurationMs: the default 50 does not satisfy its own schema/);
});

const ALLOWED_IMPORTS = /^(?:\.{1,2}\/|ajv(?:\/|$)|ajv-formats$|yaml$)/;
const IMPURE = /\bprocess\.(?:env|argv|exit|cwd|platform)\b|\bDate\.now\(|\bnew Date\(|\bMath\.random\(|\bfetch\(|\brequire\(|\bsetTimeout\(|\bsetInterval\(|\bwindow\.|\blocalStorage\b|\bXMLHttpRequest\b/;

/** Imports outside the pure dependencies and uses of a host facility, ignoring string literals and comments. */
function impurities(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^(?:import|export)\s[^'"`;]*?from\s+'([^']+)'/gm)) if (!ALLOWED_IMPORTS.test(m[1] as string)) out.push(`imports '${m[1]}'`);
  for (const m of text.matchAll(/\bimport\(\s*'([^']+)'/g)) out.push(`loads '${m[1]}' at run time`);
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\/\/.*$/g, "''");
    if (IMPURE.test(code) && !/^\s*\*/.test(line)) out.push(`line ${i + 1}: ${line.trim()}`);
  });
  return out;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('the core imports only its pure dependencies and reaches no process, clock, timer, network or random source', () => {
  const negative = "import { readFileSync } from 'node:fs';\nconst now = Date.now();\nconst text = 'Date.now() inside a string is data';\n";
  assert.deepEqual(impurities(negative), ["imports 'node:fs'", 'line 2: const now = Date.now();'], 'the scan fires on an impure import and an impure call');
  const files = sources(join(CORE, 'src'));
  assert.ok(files.length > 50, `scanned ${files.length} files`);
  const problems = files.flatMap((file) => impurities(readFileSync(file, 'utf8')).map((p) => `${file}: ${p}`));
  assert.deepEqual(problems, []);
  const manifest = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['ajv', 'ajv-formats', 'yaml']);
});
