import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { validate } from '@loom/core';
import { initWorkspace } from '../init.js';
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

test('init outside any repository is refused', () => {
  const dir = scratch();
  const env = initWorkspace(dir);
  assert.equal(env.outcome, 'refused');
  assert.deepEqual(codes(env.findings), ['INIT_NOT_REPOSITORY_ROOT']);
});
