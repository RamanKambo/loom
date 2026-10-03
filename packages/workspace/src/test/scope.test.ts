import { strict as assert } from 'node:assert';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LoomConfig, Model } from '@loom/core';
import { openWorkspace } from '../config.js';
import { discoverAll, resolveModel, resolveOwner } from '../discover.js';
import { initWorkspace, scaffoldConfig, scaffoldModel, scaffoldState } from '../init.js';
import { containsPath, isCaseSensitive } from '../paths.js';
import { codes, gitInit, readJsonFile, scratch, withCode, writeJson } from '../testing/helpers.js';

/** Write a descriptor by hand, as a copied or manually authored .loom would be. */
function manualDescriptor(home: string, config: LoomConfig, model: Model = scaffoldModel()): void {
  writeJson(join(home, '.loom', 'loom.json'), config);
  writeJson(join(home, '.loom', 'model.json'), model);
  writeJson(join(home, '.loom', 'state.json'), scaffoldState());
}

function withComponents(...ids: string[]): Model {
  const m = scaffoldModel();
  m.components = ids.map((id) => ({ id, purpose: `The ${id} component.`, responsibilities: [] }));
  return m;
}

test("'workspace' at '.' beside an overlapping component root fails", () => {
  const root = gitInit(scratch());
  mkdirSync(join(root, 'sql'));
  manualDescriptor(root, { ...scaffoldConfig(), scope: { workspace: ['.'], sql: ['sql'] } }, withComponents('workspace', 'sql'));
  const ws = openWorkspace(root);
  assert.ok(codes(ws.findings).includes('SCOPE_COMPONENT_ROOT_OVERLAP'), JSON.stringify(ws.findings));
});

test('a narrowed configuration claims exactly its roots, by whole path segment', () => {
  const root = gitInit(scratch());
  for (const d of ['src/api', 'src/db', 'src/apiary']) mkdirSync(join(root, d), { recursive: true });
  manualDescriptor(root, { ...scaffoldConfig(), scope: { api: ['src/api'], db: ['src/db'] } }, withComponents('api', 'db'));
  assert.equal(openWorkspace(root).findings.filter((f) => f.severity === 'error').length, 0);
  const api = resolveOwner(join(root, 'src', 'api', 'handler.ts'));
  assert.equal(api.result.status, 'owned');
  assert.deepEqual(api.result.owner, { descriptor: '.loom', component: 'api', root: 'src/api' });
  assert.equal(resolveOwner(join(root, 'src', 'db', 'schema.sql')).result.owner?.component, 'db');
  const apiary = resolveOwner(join(root, 'src', 'apiary', 'x.ts'));
  assert.equal(apiary.result.status, 'ungoverned');
  assert.deepEqual(codes(apiary.findings), ['SCOPE_NO_OWNER']);
  assert.equal(resolveOwner(join(root, 'README.md')).result.status, 'ungoverned');
});

test('containment compares whole segments', () => {
  const base = scratch();
  assert.equal(containsPath(join(base, 'src', 'a'), join(base, 'src', 'ab')), false);
  assert.equal(containsPath(join(base, 'src', 'a'), join(base, 'src', 'a', 'b')), true);
  assert.equal(containsPath(join(base, 'src', 'a'), join(base, 'src', 'a')), true);
});

test('an unclaimed sibling gets an explicit no-owner result, not the nearest unrelated model', () => {
  const sp = gitInit(scratch());
  const a = gitInit(join(sp, 'a'));
  assert.equal(initWorkspace(a).outcome, 'ok');
  const b = gitInit(join(sp, 'b'));
  writeFileSync(join(b, 'tool.ps1'), '');
  const owner = resolveOwner(join(b, 'tool.ps1'));
  assert.equal(owner.result.status, 'ungoverned');
  assert.deepEqual(codes(owner.findings), ['SCOPE_NO_OWNER']);
  const model = resolveModel(b);
  assert.equal(model.mode, 'validation-only');
  assert.equal(model.model, null);
  assert.equal(model.workspace, null);
});

test('a claiming child plus a claiming parent is an overlap naming both, never a first match', () => {
  const parent = gitInit(scratch());
  initWorkspace(parent);
  const child = gitInit(join(parent, 'child'));
  manualDescriptor(child, scaffoldConfig());
  const owner = resolveOwner(join(child, 'file.txt'));
  assert.equal(owner.result.status, 'overlap');
  const f = withCode(owner.findings, 'SCOPE_OVERLAP');
  assert.equal(f.length, 1);
  assert.match(f[0]?.message ?? '', /child\/\.loom and \.loom/);
  assert.ok(codes(discoverAll(parent, { cacheDir: null }).findings).includes('SCOPE_OVERLAP'));
});

test('an unreadable descriptor makes ownership unresolved', () => {
  const parent = gitInit(scratch());
  initWorkspace(parent);
  const child = gitInit(join(parent, 'child'));
  mkdirSync(join(child, '.loom'));
  writeFileSync(join(child, '.loom', 'loom.json'), '{');
  const owner = resolveOwner(join(child, 'x.txt'));
  assert.equal(owner.result.status, 'unresolved');
  assert.deepEqual(codes(owner.findings), ['SCOPE_UNRESOLVED']);
  const all = discoverAll(parent, { cacheDir: null });
  assert.equal(all.coverage.complete, false);
  assert.deepEqual(all.coverage.unreadable, ['child/.loom']);
});

test('a declared submodule without a checkout makes coverage incomplete and ownership inside it unresolved', () => {
  const root = gitInit(scratch());
  writeFileSync(join(root, '.gitmodules'), '[submodule "missing"]\n\tpath = libs/missing\n\turl = ../missing.git\n');
  initWorkspace(root);
  const all = discoverAll(root, { cacheDir: null });
  assert.equal(all.coverage.complete, false);
  assert.deepEqual(all.coverage.missing, ['libs/missing']);
  assert.equal(resolveOwner(join(root, 'libs', 'missing', 'x.sql')).result.status, 'unresolved');
});

test('a scope root that escapes the workspace through a junction is rejected', () => {
  const root = gitInit(scratch());
  const outside = scratch();
  symlinkSync(outside, join(root, 'linked'), 'junction');
  manualDescriptor(root, { ...scaffoldConfig(), scope: { workspace: ['linked'] } });
  const ws = openWorkspace(root);
  const f = withCode(ws.findings, 'SCOPE_ROOT_INVALID');
  assert.equal(f.length, 1, JSON.stringify(ws.findings));
  assert.match(f[0]?.message ?? '', /outside the workspace/);
});

test('a case-variant path resolves under the probed case sensitivity of the volume', () => {
  const root = gitInit(scratch());
  mkdirSync(join(root, 'src', 'App'), { recursive: true });
  manualDescriptor(root, { ...scaffoldConfig(), scope: { app: ['src/App'] } }, withComponents('app'));
  const sensitive = isCaseSensitive(root);
  const owner = resolveOwner(join(root, 'SRC', 'app', 'main.ts'));
  assert.equal(owner.result.status, sensitive ? 'ungoverned' : 'owned');
});

test('creating a child descriptor invalidates the cached discovery result', () => {
  const parent = gitInit(scratch());
  initWorkspace(parent);
  const first = discoverAll(parent);
  assert.equal(first.cached, false);
  const second = discoverAll(parent);
  assert.equal(second.cached, true);
  assert.deepEqual(second.coverage, first.coverage);
  const child = gitInit(join(parent, 'child'));
  manualDescriptor(child, scaffoldConfig());
  const third = discoverAll(parent);
  assert.equal(third.cached, false);
  assert.deepEqual(third.coverage.descriptors, ['.loom', 'child/.loom']);
  assert.ok(codes(third.findings).includes('SCOPE_OVERLAP'));
  const uncached = discoverAll(parent, { cacheDir: null });
  assert.deepEqual(uncached.coverage, third.coverage, 'the cache never changes the result');
});

test('an explicit model path keeps the governing workspace; outside one it is validation-only', () => {
  const root = gitInit(scratch());
  initWorkspace(root);
  writeJson(join(root, 'candidate.json'), scaffoldModel());
  const governed = resolveModel(root, { model: 'candidate.json' });
  assert.equal(governed.mode, 'explicit');
  assert.ok(governed.workspace);
  assert.ok(governed.model);
  const loose = scratch();
  writeJson(join(loose, 'm.json'), scaffoldModel());
  const ungoverned = resolveModel(loose, { model: 'm.json' });
  assert.equal(ungoverned.mode, 'validation-only');
  assert.ok(codes(ungoverned.findings).includes('VALIDATION_ONLY_MODE'));
  assert.ok(ungoverned.model);
});

test('discovery inside a governed child resolves the ancestor owner across a nearer non-claiming descriptor', () => {
  const parent = gitInit(scratch());
  manualDescriptor(parent, { ...scaffoldConfig(), scope: { sql: ['child/sql'] } }, withComponents('sql'));
  const child = gitInit(join(parent, 'child'));
  mkdirSync(join(child, 'sql'));
  mkdirSync(join(child, 'app'));
  manualDescriptor(child, { ...scaffoldConfig(), scope: { app: ['app'] } }, withComponents('app'));
  const owner = resolveOwner(join(child, 'sql', 'tables.sql'));
  assert.equal(owner.result.status, 'owned');
  assert.equal(owner.result.owner?.descriptor, '.loom');
  assert.equal(owner.result.owner?.component, 'sql');
  assert.equal(owner.result.candidates.length, 2);
  const parsed = readJsonFile<LoomConfig>(join(parent, '.loom', 'loom.json'));
  assert.deepEqual(parsed.scope, { sql: ['child/sql'] });
});
