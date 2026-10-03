import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { schemaErrors, validate } from '@loom/core';
import type { FindingCode, Refusal, ResultEnvelope, WorkflowState } from '@loom/core';
import { INIT_STEPS, initWorkspace, type InitSteps } from '../init.js';
import { openWorkspace } from '../config.js';
import { codes, fileHash, gitInit, scratch, withCode } from '../testing/helpers.js';

test('init at a repository root writes exactly the four files, which validate and stay untracked', () => {
  const root = gitInit(scratch());
  const env = initWorkspace(root);
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  assert.deepEqual(readdirSync(join(root, '.loom')).sort(), ['.gitignore', 'loom.json', 'model.json', 'state.json']);
  assert.equal(readFileSync(join(root, '.loom', '.gitignore'), 'utf8'), '/cache\n');
  const ws = openWorkspace(root);
  assert.ok(ws.value, JSON.stringify(ws.findings));
  assert.equal(ws.findings.filter((f) => f.severity === 'error').length, 0, JSON.stringify(ws.findings));
  assert.equal(validate(ws.value.model).filter((f) => f.severity === 'error').length, 0);
  assert.deepEqual(ws.value.config.scope, { workspace: ['.'] });
  assert.equal(ws.value.config.projectionProfile, 'none');
  assert.deepEqual(ws.value.state, { stateVersion: 1, phase: 'unplanned', sealed: false });
  assert.deepEqual(ws.value.model.components, [{ id: 'workspace', purpose: 'Responsibilities are unspecified.', responsibilities: [] }]);
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' });
  assert.equal(staged.trim(), '', 'init never stages');
  assert.equal(readdirSync(root).filter((n) => n.startsWith('.loom-staging')).length, 0, 'no staging directory is left behind');
});

test('init below the repository root is refused and names the root', () => {
  const root = gitInit(scratch());
  const sub = join(root, 'src');
  mkdirSync(sub);
  const env = initWorkspace(sub);
  assert.equal(env.outcome, 'refused');
  const f = withCode(env.findings, 'INIT_NOT_REPOSITORY_ROOT');
  assert.equal(f.length, 1);
  assert.match(f[0]?.message ?? '', /'\.\.'/);
  assert.equal(existsSync(join(sub, '.loom')), false);
  assert.equal(existsSync(join(root, '.loom')), false);
});

test('init where an ancestor model claims the path is refused with the ancestor named, and writes nothing', () => {
  const parent = gitInit(scratch());
  assert.equal(initWorkspace(parent).outcome, 'ok');
  const child = gitInit(join(parent, 'child'));
  const env = initWorkspace(child);
  assert.equal(env.outcome, 'refused');
  const overlap = withCode(env.findings, 'SCOPE_OVERLAP');
  assert.equal(overlap.length, 1);
  assert.match(overlap[0]?.message ?? '', /in \.loom/);
  assert.equal(existsSync(join(child, '.loom')), false);
});

test('init detects a descendant model instead of ignoring it', () => {
  const parent = gitInit(scratch());
  const lib = gitInit(join(parent, 'lib'));
  assert.equal(initWorkspace(lib).outcome, 'ok');
  const env = initWorkspace(parent);
  assert.equal(env.outcome, 'refused');
  const overlap = withCode(env.findings, 'SCOPE_OVERLAP');
  assert.equal(overlap.length, 1);
  assert.match(overlap[0]?.message ?? '', /lib\/\.loom/);
  assert.equal(existsSync(join(parent, '.loom')), false);
});

test('an existing .loom is refused and every file keeps its content', () => {
  const root = gitInit(scratch());
  initWorkspace(root);
  const files = ['loom.json', 'model.json', 'state.json', '.gitignore'].map((f) => join(root, '.loom', f));
  const before = files.map(fileHash);
  const env = initWorkspace(root);
  assert.equal(env.outcome, 'refused');
  assert.deepEqual(codes(env.findings), ['INIT_ALREADY_INITIALIZED']);
  assert.deepEqual(files.map(fileHash), before);
});

test('force restores a missing .gitignore and nothing else', () => {
  const root = gitInit(scratch());
  initWorkspace(root);
  rmSync(join(root, '.loom', '.gitignore'));
  const authority = ['loom.json', 'model.json', 'state.json'].map((f) => join(root, '.loom', f));
  const before = authority.map(fileHash);
  const env = initWorkspace(root, { force: true });
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  assert.deepEqual((env.data as { written: string[] }).written, ['.loom/.gitignore']);
  assert.equal(readFileSync(join(root, '.loom', '.gitignore'), 'utf8'), '/cache\n');
  assert.deepEqual(authority.map(fileHash), before);
});

test('an incomplete .loom needs repair by its owner; force never invents an authority file', () => {
  const root = gitInit(scratch());
  initWorkspace(root);
  rmSync(join(root, '.loom', 'state.json'));
  const env = initWorkspace(root, { force: true });
  assert.equal(env.outcome, 'refused');
  assert.ok(codes(env.findings).every((c) => c === 'INIT_REPAIR_REQUIRED'));
  assert.ok(env.findings.length >= 1);
  assert.equal(existsSync(join(root, '.loom', 'state.json')), false);
});

const injected = (step: string): never => {
  throw new Error(`EPERM: ${step} failed for the test`);
};

/** Init with one step replaced; the result, and every entry the repository root holds afterwards. */
function initWith(steps: Partial<InitSteps>): { env: ResultEnvelope; left: string[]; staged: number } {
  const root = gitInit(scratch());
  let staged = 0;
  const env = initWorkspace(root, {}, { ...INIT_STEPS, stage: (parent) => (staged++, INIT_STEPS.stage(parent)), ...steps });
  return { env, left: readdirSync(root).sort(), staged };
}

/** Typed: a refusal with its cause and finding code, in an envelope that satisfies the result contract. */
function assertTypedRefusal(env: ResultEnvelope, cause: Refusal['cause'], code: FindingCode): void {
  assert.equal(env.outcome, 'refused');
  assert.equal(env.refusal?.cause, cause, JSON.stringify(env.refusal));
  assert.ok(codes(env.findings).includes(code), JSON.stringify(env.findings));
  assert.deepEqual(schemaErrors('ResultEnvelope', env), []);
  assert.deepEqual((env.data as { written: string[] }).written, []);
}

test('a staging failure leaves no .loom and nothing staged, and is refused as typed', () => {
  const { env, left } = initWith({ stage: () => injected('creating the staging directory') });
  assertTypedRefusal(env, 'unresolved-context', 'INIT_REPAIR_REQUIRED');
  assert.match(env.findings[0]?.message ?? '', /creating the staging directory failed/);
  assert.deepEqual(left, ['.git'], 'the repository root holds nothing of the failed init');
});

test('a write failure part-way through staging leaves no .loom and no partial scaffold, and is refused as typed', () => {
  let writes = 0;
  const { env, left } = initWith({ write: (path, text) => (++writes === 3 ? injected(`writing ${path}`) : INIT_STEPS.write(path, text)) });
  assertTypedRefusal(env, 'unresolved-context', 'INIT_REPAIR_REQUIRED');
  assert.equal(writes, 3, 'the failure struck after two files were staged');
  assert.deepEqual(left, ['.git'], 'no staging directory with an unsealed state or a model is left');
});

test('an installation failure leaves no .loom and no staging directory, and is refused as typed', () => {
  const { env, left } = initWith({ install: () => injected('renaming the staging directory into place') });
  assertTypedRefusal(env, 'unresolved-context', 'INIT_REPAIR_REQUIRED');
  assert.deepEqual(left, ['.git'], 'the repository root holds nothing of the failed init');
});

test('a scaffold that fails validation is refused as typed before anything is staged', () => {
  const sealed = { stateVersion: 1, phase: 'release', sealed: true, accepted: true } as unknown as WorkflowState;
  const { env, left, staged } = initWith({ scaffold: () => ({ ...INIT_STEPS.scaffold(), state: sealed }) });
  assertTypedRefusal(env, 'invalid-input', 'CONFIG_INVALID');
  assert.equal(staged, 0, 'nothing was staged');
  assert.deepEqual(left, ['.git'], 'no state claiming a sealed, accepted release reaches the disk');
});

test('init outside any repository is refused', () => {
  const dir = scratch();
  const env = initWorkspace(dir);
  assert.equal(env.outcome, 'refused');
  assert.deepEqual(codes(env.findings), ['INIT_NOT_REPOSITORY_ROOT']);
});
