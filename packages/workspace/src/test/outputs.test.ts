import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { sampleModel } from '@loom/core';
import type { InstallJournal, LoomConfig, Model, ProjectionTarget } from '@loom/core';
import { openWorkspace, type Workspace } from '../config.js';
import { initWorkspace, scaffoldConfig } from '../init.js';
import { checkOutputs, collisionFindings, installOutputs, journalPath, planOutputs, recoverInstall, type OutputSteps } from '../outputs.js';
import { codes, foldModelId, gitInit, readJsonFile, scratch, withCode, writeJson } from '../testing/helpers.js';

const TARGETS: ProjectionTarget[] = ['reference', 'yaml', 'sql'];

/** Every fixture declares a real modelId, folded from its own directory name, and modelKind 'implementation'; init invents no default. */
const cfg = (dir: string): [string, 'implementation'] => [foldModelId(basename(dir)), 'implementation'];

/** A governed workspace holding the sample model, with the given output routing. */
function sampleWorkspace(outputs: LoomConfig['outputs'] = {}): Workspace {
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root, { modelId: foldModelId(basename(root)), modelKind: 'implementation' }).outcome, 'ok');
  writeJson(join(root, '.loom', 'model.json'), sampleModel());
  writeJson(join(root, '.loom', 'loom.json'), { ...scaffoldConfig(...cfg(root)), projectionProfile: 'documentation', scope: { ordering: ['.'] }, outputs });
  return reopen(root);
}

function reopen(root: string): Workspace {
  const ws = openWorkspace(root);
  assert.ok(ws.value, JSON.stringify(ws.findings));
  assert.equal(ws.findings.filter((f) => f.severity === 'error').length, 0, JSON.stringify(ws.findings));
  return ws.value;
}

function editModel(ws: Workspace, edit: (m: Model) => void): Workspace {
  const m = readJsonFile<Model>(ws.modelPath);
  edit(m);
  writeJson(ws.modelPath, m);
  return reopen(ws.root);
}

test('outputs route to Docs/Loom by default and to a mapped directory otherwise', () => {
  const ws = sampleWorkspace({ 'model.yaml': 'model/', 'schema.sql#ordering': 'db/schema/' });
  const plan = planOutputs(ws, { targets: TARGETS });
  assert.equal(plan.findings.filter((f) => f.severity === 'error').length, 0, JSON.stringify(plan.findings));
  const paths = Object.fromEntries(plan.artifacts.map((a) => [a.instance, a.path]));
  assert.deepEqual(paths, {
    'reference.md': 'Docs/Loom/reference.md',
    'model.yaml': 'model/model.yaml',
    'schema.sql#ordering': 'db/schema/schema.sql',
    'schema.sql#fulfillment': 'Docs/Loom/fulfillment/schema.sql',
    'schema.sql#billing': 'Docs/Loom/billing/schema.sql',
  });
  assert.deepEqual(plan.manifest.artifacts.map((a) => a.instance), ['model.yaml', 'reference.md', 'schema.sql#billing', 'schema.sql#fulfillment', 'schema.sql#ordering']);
});

test('a per-component artifact is not routed by its bare file name', () => {
  const ws = sampleWorkspace({ 'schema.sql': 'db/schema/' });
  const plan = planOutputs(ws, { targets: ['sql'] });
  assert.deepEqual(plan.artifacts.map((a) => a.path).sort(), ['Docs/Loom/billing/schema.sql', 'Docs/Loom/fulfillment/schema.sql', 'Docs/Loom/ordering/schema.sql']);
});

test('two artifact instances resolving to one file are a collision', () => {
  const f = collisionFindings([{ instance: 'contract-tests.sql#ordering', path: 'tests/contract-tests.sql' }, { instance: 'contract-tests.sql#billing', path: 'tests/contract-tests.sql' }], true);
  assert.deepEqual(codes(f), ['OUTPUT_COLLISION']);
  assert.deepEqual(codes(collisionFindings([{ instance: 'a#x', path: 'x/a' }, { instance: 'a#y', path: 'y/a' }], true)), []);
  assert.deepEqual(codes(collisionFindings([{ instance: 'a#x', path: 'Out/a' }, { instance: 'a#y', path: 'out/a' }], false)), ['OUTPUT_COLLISION']);
});

test('a protected target is refused before anything is written', () => {
  const inLoom = sampleWorkspace({ 'reference.md': '.loom/views/' });
  const env = installOutputs(inLoom, { targets: TARGETS });
  assert.equal(env.outcome, 'refused');
  assert.ok(codes(env.findings).includes('OUTPUT_PROTECTED_TARGET'));
  assert.equal(existsSync(join(inLoom.root, 'Docs', 'Loom', 'model.yaml')), false, 'nothing is written when any check fails');
  assert.equal(existsSync(join(inLoom.loomDir, 'manifest.json')), false);

  const handAuthored = sampleWorkspace();
  mkdirSync(join(handAuthored.root, 'Docs', 'Loom'), { recursive: true });
  writeFileSync(join(handAuthored.root, 'Docs', 'Loom', 'reference.md'), 'hand-written notes\n');
  const refused = installOutputs(handAuthored, { targets: TARGETS });
  assert.equal(refused.outcome, 'refused');
  assert.equal(withCode(refused.findings, 'OUTPUT_PROTECTED_TARGET').length, 1);
  assert.equal(readFileSync(join(handAuthored.root, 'Docs', 'Loom', 'reference.md'), 'utf8'), 'hand-written notes\n');
});

test("an output another model's manifest lists is a collision", () => {
  const parent = gitInit(scratch());
  initWorkspace(parent, { modelId: foldModelId(basename(parent)), modelKind: 'implementation' });
  writeJson(join(parent, '.loom', 'model.json'), sampleModel());
  writeJson(join(parent, '.loom', 'loom.json'), { ...scaffoldConfig(...cfg(parent)), scope: { ordering: ['.'] }, outputs: { 'reference.md': 'child/Docs/Loom/' } });
  const parentWs = reopen(parent);
  assert.equal(installOutputs(parentWs, { targets: ['reference'] }).outcome, 'ok');
  const child = gitInit(join(parent, 'child'));
  writeJson(join(child, '.loom', 'model.json'), sampleModel());
  writeJson(join(child, '.loom', 'loom.json'), { ...scaffoldConfig(...cfg(child)), scope: { ordering: ['.'] } });
  writeJson(join(child, '.loom', 'state.json'), { stateVersion: 1, phase: 'unplanned', sealed: false });
  const childWs = reopen(child);
  const env = installOutputs(childWs, { targets: ['reference'] });
  assert.equal(env.outcome, 'refused');
  assert.ok(codes(env.findings).includes('OUTPUT_COLLISION'), JSON.stringify(env.findings));
});

test('drift, missing files and a stale or missing manifest are detected', () => {
  let ws = sampleWorkspace();
  assert.equal(installOutputs(ws, { targets: TARGETS }).outcome, 'ok');
  assert.deepEqual(codes(checkOutputs(ws, { targets: TARGETS }).findings), []);
  const ref = join(ws.root, 'Docs', 'Loom', 'reference.md');
  writeFileSync(ref, readFileSync(ref, 'utf8').replace(/\n/g, '\r\n'));
  assert.deepEqual(codes(checkOutputs(ws, { targets: TARGETS }).findings), [], 'CRLF line endings are not drift');
  writeFileSync(ref, `${readFileSync(ref, 'utf8')}hand edit\n`);
  rmSync(join(ws.root, 'Docs', 'Loom', 'model.yaml'));
  const broken = codes(checkOutputs(ws, { targets: TARGETS }).findings);
  assert.ok(broken.includes('OUTPUT_DRIFT'));
  assert.ok(broken.includes('OUTPUT_MISSING'));
  ws = editModel(ws, (m) => {
    (m.components[0] as { purpose: string }).purpose = 'Accepts and tracks orders.';
  });
  assert.ok(codes(checkOutputs(ws, { targets: TARGETS }).findings).includes('MANIFEST_STALE'));
  rmSync(join(ws.loomDir, 'manifest.json'));
  assert.ok(codes(checkOutputs(ws, { targets: TARGETS }).findings).includes('MANIFEST_MISSING'));
});

test('an interrupted installation stays visibly incomplete until it is recovered', () => {
  let ws = sampleWorkspace();
  assert.equal(installOutputs(ws, { targets: TARGETS }).outcome, 'ok');
  ws = editModel(ws, (m) => {
    (m.components[0] as { purpose: string }).purpose = 'Accepts, prices and tracks orders.';
  });
  const ref = join(ws.root, 'Docs', 'Loom', 'reference.md');
  chmodSync(ref, 0o444);
  try {
    const env = installOutputs(ws, { targets: TARGETS });
    assert.equal(env.outcome, 'refused');
    const journal = readJsonFile<InstallJournal>(journalPath(ws));
    assert.equal(journal.state, 'failed');
    assert.ok(journal.entries.some((e) => e.status !== 'installed'));
    assert.ok(codes(checkOutputs(ws, { targets: TARGETS }).findings).includes('INSTALL_INCOMPLETE'));
  } finally {
    chmodSync(ref, 0o666);
  }
  const recovered = recoverInstall(ws, { targets: TARGETS });
  assert.equal(recovered.outcome, 'ok', JSON.stringify(recovered));
  assert.deepEqual(codes(checkOutputs(ws, { targets: TARGETS }).findings), []);
  assert.equal(readJsonFile<InstallJournal>(journalPath(ws)).state, 'complete');
});

test('installOutputs refuses a write target that a link redirects outside the workspace after planning, and writes nothing through the link', () => {
  const ws = sampleWorkspace();
  const outside = scratch();
  const steps: OutputSteps = {
    write: (path, content) => {
      writeFileSync(path, content);
      // Planted only once planning is behind us: between writing the first component's staged file and the third's, a link redirects the third's directory.
      if (path.includes(join('Loom', 'ordering'))) symlinkSync(outside, join(ws.root, 'Docs', 'Loom', 'billing'), 'junction');
    },
    rename: (from, to) => renameSync(from, to),
  };
  const env = installOutputs(ws, { targets: ['sql'] }, steps);
  assert.equal(env.outcome, 'refused');
  assert.ok(codes(env.findings).includes('WRITE_OUTSIDE_WORKSPACE'), JSON.stringify(env.findings));
  assert.equal(env.refusal?.cause, 'policy-failure');
  assert.equal(existsSync(join(outside, 'schema.sql')), false, 'nothing was written through the redirected link');
  assert.equal(existsSync(join(ws.root, 'Docs', 'Loom', 'billing', 'schema.sql')), false);
  assert.equal(readJsonFile<InstallJournal>(journalPath(ws)).state, 'failed');
});

test('installOutputs refuses a rename target that a link redirects outside the workspace after staging, catching it before any file is renamed', () => {
  const ws = sampleWorkspace();
  const outside = scratch();
  const steps: OutputSteps = {
    write: (path, content) => {
      writeFileSync(path, content);
      // Planted after every component's staged file is written, so the rename phase alone meets the redirect.
      if (path.includes(join('Loom', 'billing'))) {
        rmSync(join(ws.root, 'Docs', 'Loom', 'ordering'), { recursive: true, force: true });
        symlinkSync(outside, join(ws.root, 'Docs', 'Loom', 'ordering'), 'junction');
      }
    },
    rename: (from, to) => renameSync(from, to),
  };
  const env = installOutputs(ws, { targets: ['sql'] }, steps);
  assert.equal(env.outcome, 'refused');
  assert.ok(codes(env.findings).includes('WRITE_OUTSIDE_WORKSPACE'), JSON.stringify(env.findings));
  assert.equal(env.refusal?.cause, 'policy-failure');
  assert.equal(existsSync(join(outside, 'schema.sql')), false, 'nothing was written through the redirected link');
  assert.equal(existsSync(join(ws.root, 'Docs', 'Loom', 'fulfillment', 'schema.sql')), false, 'the rename phase stops before renaming any file once a redirect is met');
  assert.equal(readJsonFile<InstallJournal>(journalPath(ws)).state, 'failed');
});

test('a target this engine does not render fails closed instead of being skipped', () => {
  const ws = sampleWorkspace();
  const plan = planOutputs(ws, { targets: ['reference', 'unrendered-target' as ProjectionTarget] });
  assert.deepEqual(codes(plan.findings.filter((f) => f.severity === 'error')), ['PROJECTION_INVALID']);
  assert.equal(installOutputs(ws, { targets: ['reference', 'unrendered-target' as ProjectionTarget] }).outcome, 'refused');
});
