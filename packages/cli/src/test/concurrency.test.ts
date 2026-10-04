import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { modelRevision, sampleModel } from '@loom/core';
import type { LoomConfig, Model, Policy, ResultEnvelope } from '@loom/core';
import { commitAll, gitInit, readJsonFile, scratch, writeJson } from '@loom/workspace/testing';

const CLI = fileURLToPath(new URL('../index.js', import.meta.url));

function loom(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): { status: number; env: ResultEnvelope; output: string } {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  let parsed = {} as ResultEnvelope;
  try {
    parsed = JSON.parse(r.stdout) as ResultEnvelope;
  } catch {
    // A usage error prints a message, not an envelope.
  }
  return { status: r.status ?? -1, env: parsed, output: `${r.stdout}${r.stderr}` };
}

/** The CLI in its own process, so two of them contend for one workspace. */
function loomAsync(cwd: string, args: string[]): Promise<{ status: number; env: ResultEnvelope }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--json'], { cwd });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (status) => resolve({ status: status ?? -1, env: JSON.parse(out) as ResultEnvelope }));
  });
}

const codes = (env: ResultEnvelope): string[] => (env.findings ?? []).map((f) => f.code);

/** A repository governing the sample with one root per component; planned workspaces bind a committed policy. */
function workspace(options: { profile?: string; policy?: Policy; scope?: LoomConfig['scope'] } = {}): string {
  const dir = gitInit(scratch());
  assert.equal(loom(dir, ['init']).status, 0);
  const model = sampleModel();
  writeFileSync(join(dir, '.loom', 'model.json'), `${JSON.stringify(model, null, 2)}\n`);
  for (const c of model.components) mkdirSync(join(dir, c.id), { recursive: true });
  const path = join(dir, '.loom', 'loom.json');
  const config = readJsonFile<LoomConfig>(path);
  const scope = options.scope ?? Object.fromEntries(model.components.map((c) => [c.id, [c.id]]));
  writeJson(path, { ...config, scope, ...(options.profile ? { projectionProfile: options.profile } : {}), ...(options.policy ? { gates: { policyRef: options.policy.id } } : {}) });
  if (options.policy) {
    writeJson(join(dir, '.loom', 'policies', `${options.policy.id}.json`), options.policy);
    writeJson(join(dir, '.loom', 'state.json'), { stateVersion: 1, phase: 'implementation', sealed: false });
  }
  commitAll(dir, 'workspace');
  return dir;
}

const policy = (spki: string, required: string[]): Policy => ({
  policyVersion: 1,
  id: 'engineering',
  revision: 1,
  trust: { ref: 'refs/heads/main', acceptanceVia: 'trusted-ref', acceptanceKeys: [], evidenceKeys: [{ id: 'ci', spki, runner: 'ci' }] },
  changeClasses: [],
  readiness: { implementation: { requires: 'none' }, integration: { evidence: [] }, release: { evidence: [] } },
  substitutes: [],
  qualification: { required, optional: [] },
  environments: [],
  execution: { providers: [], budgets: { totalDeadlineSeconds: 900, commandDeadlineSeconds: 60, engineStartDeadlineSeconds: 60, cleanupDeadlineSeconds: 60, fixtureFileBytes: 2147483648, maxServerMemoryMiB: 512, maxDegreeOfParallelism: 1 } },
});

function editModel(dir: string, edit: (m: Model) => void): void {
  const path = join(dir, '.loom', 'model.json');
  const m = JSON.parse(readFileSync(path, 'utf8')) as Model;
  edit(m);
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
}

test('stored evidence of a signed run goes stale when the model changes what its artifact holds', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = { LOOM_TEST_EVIDENCE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const dir = workspace({ profile: 'documentation', policy: policy(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), ['documentation.yaml-roundtrip']) });
  const run = loom(dir, ['qualify', '--checks', 'documentation.yaml-roundtrip', '--store', '--key-id', 'ci', '--key-env', 'LOOM_TEST_EVIDENCE_KEY'], key);
  assert.equal(run.status, 0, run.output);
  const listed = loom(dir, ['evidence', 'list']).env.data as { records: Array<{ check: string; trusted: boolean }> };
  assert.deepEqual(listed.records.map((r) => [r.check, r.trusted]), [['documentation.yaml-roundtrip', true]], 'the run stored one trusted record');
  const stale = (env: ResultEnvelope): boolean => env.states.qualification.reasons.some((r) => r.code === 'EVIDENCE_STALE' && r.message.includes('check:documentation.yaml-roundtrip'));
  assert.equal(stale(loom(dir, ['check']).env), false, 'the evidence is current for the model it ran against');
  editModel(dir, (m) => (m.components[0]!.purpose = 'Accepts and tracks orders.'));
  assert.equal(stale(loom(dir, ['check']).env), true, 'the changed model.yaml makes the evidence stale');
  editModel(dir, (m) => (m.components[0]!.purpose = sampleModel().components[0]!.purpose));
  assert.equal(stale(loom(dir, ['check']).env), false, 'restoring the model restores currency');
});

test('of two CLI mutations against one expected revision exactly one commits and the other is refused as stale', async () => {
  const dir = workspace();
  const base = modelRevision(JSON.parse(readFileSync(join(dir, '.loom', 'model.json'), 'utf8')) as Model);
  const patches = ['Read one order by its id.', 'Fetch an order.'].map((description, i) => {
    const file = join(dir, `patch-${i}.json`);
    writeJson(file, { op: 'update', collection: 'operations', id: 'order.get', set: { description } });
    return file;
  });
  const results = await Promise.all(patches.map((p) => loomAsync(dir, ['mutate', '--patch', p, '--expected', base])));
  const committed = results.filter((r) => r.status === 0 && (r.env.data as { committed?: boolean }).committed === true);
  const refused = results.filter((r) => r.env.refusal?.cause === 'stale-base');
  assert.equal(committed.length, 1, JSON.stringify(results.map((r) => [r.status, r.env.refusal])));
  assert.equal(refused.length, 1);
  assert.ok(codes(refused[0]!.env).includes('STALE_BASE_REVISION'));
  const now = JSON.parse(readFileSync(join(dir, '.loom', 'model.json'), 'utf8')) as Model;
  assert.equal(modelRevision(now), (committed[0]!.env.data as { revision: string }).revision, 'the model holds exactly the winning change');
});

test('an interrupted multi-file installation stays visibly incomplete to check until write completes it', () => {
  const dir = workspace({ profile: 'documentation' });
  assert.equal(loom(dir, ['write']).status, 0);
  editModel(dir, (m) => (m.components[0]!.purpose = 'Accepts, prices and tracks orders.'));
  const reference = join(dir, 'Docs', 'Loom', 'reference.md');
  chmodSync(reference, 0o444);
  try {
    const interrupted = loom(dir, ['write']);
    assert.equal(interrupted.status, 1);
    assert.ok(codes(loom(dir, ['check']).env).includes('INSTALL_INCOMPLETE'), 'check reports the unfinished installation');
  } finally {
    chmodSync(reference, 0o666);
  }
  assert.equal(loom(dir, ['write']).status, 0);
  const after = codes(loom(dir, ['check']).env);
  assert.ok(!after.includes('INSTALL_INCOMPLETE') && !after.includes('OUTPUT_DRIFT'), after.join(', '));
});

test('overlapping component roots in one configuration are reported by check', () => {
  const dir = workspace({ scope: { ordering: ['.'], fulfillment: ['fulfillment'], billing: ['billing'] } });
  const r = loom(dir, ['check']);
  assert.equal(r.status, 1);
  assert.ok(codes(r.env).includes('SCOPE_COMPONENT_ROOT_OVERLAP'), r.output.slice(0, 400));
});

test('a declared submodule without a checkout leaves check --all incomplete and its paths without an owner', () => {
  const dir = workspace();
  writeFileSync(join(dir, '.gitmodules'), '[submodule "missing"]\n\tpath = libs/missing\n\turl = ../missing.git\n');
  const all = loom(dir, ['check', '--all']);
  const coverage = (all.env.data as { coverage: { complete: boolean; missing: string[] } }).coverage;
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.missing, ['libs/missing']);
  assert.ok(codes(all.env).includes('SCOPE_UNRESOLVED'), all.output.slice(0, 400));
  const owner = loom(dir, ['owner', join('libs', 'missing', 'x.sql')]);
  assert.equal((owner.env.data as { status: string }).status, 'unresolved');
});
