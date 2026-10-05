import { strict as assert } from 'node:assert';
import { symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { canonicalHash, importPinsOf, modelRevision, schemaErrors } from '@loom/core';
import type { LoomConfig, Model, MutationExpectation, NextAction } from '@loom/core';
import { loomDirOf, readConfig } from '../config.js';
import { initWorkspace, scaffoldModel } from '../init.js';
import { openSession } from '../session.js';
import { mutateWorkspace, writeModel } from '../write.js';
import { foldModelId, gitInit, readJsonFile, scratch, writeJson } from '../testing/helpers.js';

/** A freshly initialized workspace, with no composition and no trusted policy. */
function workspace(): string {
  const root = gitInit(scratch());
  const env = initWorkspace(root, { modelId: foldModelId(basename(root)), modelKind: 'implementation' });
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  return root;
}

/** The expectation a write against the current, unmodified configuration is prepared against. */
function correctExpectation(root: string, modelHash: string): MutationExpectation {
  const config = readConfig(loomDirOf(root)).value as LoomConfig;
  return { model: modelHash, config: canonicalHash(config), policy: null, imports: canonicalHash(importPinsOf(config)) };
}

const WRONG = `sha256:${'f'.repeat(64)}`;

test('writeModel refuses stale-base naming exactly the one input whose expectation does not hold, for each of model, config, policy and imports', async () => {
  const root = workspace();
  const before = readJsonFile<Model>(join(root, '.loom', 'model.json'));
  const correct = correctExpectation(root, modelRevision(before));
  for (const field of ['model', 'config', 'policy', 'imports'] as const) {
    const env = await writeModel(root, before, { ...correct, [field]: WRONG });
    assert.equal(env.outcome, 'refused', `${field}: ${JSON.stringify(env.findings)}`);
    assert.equal(env.refusal?.cause, 'stale-base', field);
    const f = env.findings.find((x) => x.code === 'STALE_BASE_REVISION');
    assert.ok(f, `${field}: no STALE_BASE_REVISION finding, got ${JSON.stringify(env.findings)}`);
    assert.ok(f!.message.includes(`${field} changed`), `${field}: ${f!.message}`);
    assert.ok(!f!.message.includes(','), `${field}: more than one input named: ${f!.message}`);
  }
  // every input correct: the write proceeds.
  const ok = await writeModel(root, before, correct);
  assert.equal(ok.outcome, 'ok', JSON.stringify(ok.findings));
});

test('a stale persistent mutate offers a re-plan next action whose arguments validate against PlanChangeInput, whether the staleness is caught before or inside the write', async () => {
  const root = workspace();
  const patch = { op: 'add', collection: 'components', record: { id: 'extra', purpose: 'Extra component for the test.', responsibilities: [] } };
  const checkAction = (env: { refusal?: { nextActions?: NextAction[] } }, baseRevision: string): void => {
    const action = env.refusal?.nextActions?.[0];
    assert.ok(action, JSON.stringify(env));
    assert.equal(action!.tool, 'loom.planChange');
    assert.deepEqual(schemaErrors('PlanChangeInput', action!.arguments), []);
    assert.equal((action!.arguments as Record<string, unknown>)['baseRevision'], baseRevision);
    assert.deepEqual((action!.arguments as Record<string, unknown>)['patch'], patch);
  };

  // Staleness on the model itself is caught before writeModel runs.
  const s1 = openSession(root);
  assert.ok(s1.model, JSON.stringify(s1.findings));
  const base = modelRevision(s1.model);
  const staleModel = await mutateWorkspace(s1, { ...correctExpectation(root, base), model: WRONG }, () => ({ patch }));
  assert.equal(staleModel.outcome, 'refused');
  assert.equal(staleModel.refusal?.cause, 'stale-base');
  checkAction(staleModel, base);

  // Staleness on config is caught only inside writeModel, after the patch applied cleanly.
  const s2 = openSession(root);
  const staleConfig = await mutateWorkspace(s2, { ...correctExpectation(root, base), config: WRONG }, () => ({ patch }));
  assert.equal(staleConfig.outcome, 'refused');
  assert.equal(staleConfig.refusal?.cause, 'stale-base');
  checkAction(staleConfig, base);
  // nothing was written in either case.
  assert.equal(modelRevision(readJsonFile<Model>(join(root, '.loom', 'model.json'))), base);
});

test('writeModel refuses policy-failure when the configured write target no longer resolves inside the workspace root', async () => {
  const root = workspace();
  const loomDir = loomDirOf(root);
  const outside = scratch();
  const external = scaffoldModel();
  writeJson(join(outside, 'model.json'), external);
  symlinkSync(outside, join(loomDir, 'linked'), 'junction');
  const config = readConfig(loomDir).value as LoomConfig;
  writeJson(join(loomDir, 'loom.json'), { ...config, model: 'linked/model.json' });
  const expectation = correctExpectation(root, modelRevision(external));
  const env = await writeModel(root, scaffoldModel(), expectation);
  assert.equal(env.outcome, 'refused');
  assert.equal(env.refusal?.cause, 'policy-failure');
  assert.ok(env.findings.some((f) => f.code === 'WRITE_OUTSIDE_WORKSPACE'), JSON.stringify(env.findings));
});
