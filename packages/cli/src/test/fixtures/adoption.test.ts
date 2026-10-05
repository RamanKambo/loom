import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { modelRevision, mutate, needsAcknowledgement } from '@loom/core';
import type { Change, Finding, LoomConfig, Model, Patch, ProjectionTarget, RecordRef, ResultEnvelope, WorkPackage } from '@loom/core';
import { putEvidence } from '@loom/workspace';
import { commitAll, gitInit, scratch, writeJson } from '@loom/workspace/testing';
import { materialize, readSelfPolicy, resolveChecks, runChecks, type MigrationFixture } from '@loom/qualification';
import { FIXTURE_AS_OF, compareWithExpectation, evaluateFixtures, fixtureKeys, observeCore, readFixtureSets, type CaseObservation, type PreparedCase } from '../../fixtures.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const CLI = fileURLToPath(new URL('../../index.js', import.meta.url));

function loom(cwd: string, ...args: string[]): { status: number; env: ResultEnvelope; output: string } {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd, encoding: 'utf8' });
  let env = {} as ResultEnvelope;
  try {
    env = JSON.parse(r.stdout) as ResultEnvelope;
  } catch {
    // A usage error prints a message, not an envelope.
  }
  return { status: r.status ?? -1, env, output: `${r.stdout}${r.stderr}` };
}

const keys = fixtureKeys();
const outcomes = evaluateFixtures(ROOT, keys);
const codesOf = (fs: readonly Finding[]): string[] => fs.map((f) => f.code);
const reasonsOf = (env: ResultEnvelope, state: keyof ResultEnvelope['states']): string[] => env.states[state].reasons.map((r) => r.code);

function writeModel(dir: string, model: Model): void {
  writeFileSync(join(dir, '.loom', 'model.json'), `${JSON.stringify(model, null, 2)}\n`);
}

/** loom.json naming one root per component of the model about to be read, so the configuration always validates against it. */
function configure(dir: string, model: Model, planned: { policy: string } | null): void {
  const path = join(dir, '.loom', 'loom.json');
  const config = JSON.parse(readFileSync(path, 'utf8')) as LoomConfig;
  for (const c of model.components) {
    mkdirSync(join(dir, c.id), { recursive: true });
    writeFileSync(join(dir, c.id, '.gitkeep'), '');
  }
  const scope = Object.fromEntries(model.components.map((c) => [c.id, [c.id]]));
  writeJson(path, planned ? { ...config, scope, gates: { policyRef: planned.policy }, projectionProfile: 'contracts' } : { ...config, scope });
}

/** The step's patches with the acknowledgements an intended change carries. */
function acknowledgements(previous: Model, patches: Patch[]): string[] {
  return [...new Set(mutate(previous, patches).changes.filter(needsAcknowledgement).map((c) => c.element))].sort();
}

interface Planned {
  changes: Change[];
  affected: RecordRef[];
  invalidatedEvidence: string[];
  acceptanceRequired: boolean;
}

/** A workspace records a baseline only under the trusted policy it was accepted by. */
const holdsBaseline = (p: PreparedCase): boolean => p.baseline !== undefined && p.policy !== undefined;

/**
 * A governed repository holding exactly the case inputs: the policy, accepted
 * baseline and acceptance records committed at the trusted ref, the vendored
 * bundles, the signed evidence in the store and the case model in the working
 * tree. A step is previewed with plan against its previous state first.
 */
function workspaceFor(p: PreparedCase): { dir: string; planned?: Planned } {
  const dir = gitInit(scratch());
  const init = loom(dir, 'init', '--model-id', 'adoption', '--model-kind', 'implementation');
  assert.equal(init.status, 0, init.output);
  const loomDir = join(dir, '.loom');
  const planned = p.policy ? { policy: p.policy.id } : null;
  if (p.policy) {
    writeJson(join(loomDir, 'policies', `${p.policy.id}.json`), p.policy);
    writeJson(join(loomDir, 'state.json'), { stateVersion: 1, phase: 'implementation', sealed: false });
  }
  for (const b of p.bundles ?? []) writeJson(join(loomDir, 'contracts', b.publisher, `${b.contract}@${b.version}.json`), b);
  const acceptances = [...(p.baselineAcceptance && !p.acceptances.includes(p.baselineAcceptance) ? [p.baselineAcceptance] : []), ...p.acceptances];
  for (const a of acceptances) writeJson(join(loomDir, 'acceptance', `${a.id}.json`), a);
  for (const e of p.evidence) assert.equal(putEvidence(dir, e.record).stored, true, `evidence ${e.record.id} is stored`);
  if (holdsBaseline(p) && p.baseline && p.baselineAcceptance) {
    configure(dir, p.baseline, planned);
    writeModel(dir, p.baseline);
    commitAll(dir, 'accepted baseline inputs');
    const created = loom(dir, 'baseline', 'create', '--id', p.baselineAcceptance.subject.baseline as string, '--acceptance', p.baselineAcceptance.id);
    assert.equal(created.status, 0, created.output);
    commitAll(dir, 'baseline');
  }
  let plan: Planned | undefined;
  if (p.case.patches && p.previous && holdsBaseline(p) && modelRevision(p.previous) === modelRevision(p.baseline as Model)) {
    configure(dir, p.previous, planned);
    writeModel(dir, p.previous);
    const step = JSON.parse(readFileSync(join(ROOT, p.set.dir, p.case.patches), 'utf8')) as { patches: Patch[] };
    const patchFile = join(dir, 'step.json');
    writeJson(patchFile, step.patches);
    const acks = acknowledgements(p.previous, step.patches);
    const r = loom(dir, 'plan', '--patch', patchFile, '--as-of', FIXTURE_AS_OF, ...(acks.length ? ['--ack', acks.join(',')] : []));
    const data = r.env.data as { changes: Change[]; affected: Array<{ ref: RecordRef }>; invalidatedEvidence: Array<{ evidence: string }>; acceptanceRequired: boolean };
    assert.ok(data?.changes, `plan previews the step: ${r.output.slice(0, 400)}`);
    plan = {
      changes: data.changes,
      affected: [...data.changes.map((c) => ({ kind: c.elementKind, id: c.element })), ...data.changes.flatMap((c) => c.consumers.map((a) => a.ref)), ...data.affected.map((a) => a.ref)],
      invalidatedEvidence: data.invalidatedEvidence.map((i) => i.evidence),
      acceptanceRequired: data.acceptanceRequired,
    };
  }
  configure(dir, p.model, planned);
  writeModel(dir, p.model);
  if (!holdsBaseline(p)) commitAll(dir, 'case inputs');
  return plan ? { dir, planned: plan } : { dir };
}

/** What the CLI reports for the case: check for validation, comparison and evidence, readiness for every task. */
function observeCli(p: PreparedCase): CaseObservation {
  const { dir, planned } = workspaceFor(p);
  const check = loom(dir, 'check', '--as-of', FIXTURE_AS_OF);
  assert.ok(check.env.states, `check returns an envelope: ${check.output.slice(0, 400)}`);
  const o: CaseObservation = {
    validation: check.env.states.validation.state === 'valid' ? 'valid' : 'invalid',
    validationFindings: check.env.findings,
    findings: check.env.findings,
    reasonCodes: [...reasonsOf(check.env, 'acceptance'), ...reasonsOf(check.env, 'qualification')],
    readiness: [],
  };
  o.qualification = check.env.states.qualification.state;
  const baseline = (check.env.data as { baseline?: { changes?: Change[] } } | undefined)?.baseline;
  if (planned) {
    o.changes = planned.changes.map((c) => ({ kind: c.kind, dimension: c.dimension, element: { kind: c.elementKind, id: c.element } }));
    o.affected = planned.affected;
    o.invalidatedEvidence = planned.invalidatedEvidence;
    o.acceptanceRequired = planned.acceptanceRequired;
  } else if (holdsBaseline(p) && baseline?.changes) {
    o.changes = baseline.changes.map((c) => ({ kind: c.kind, dimension: c.dimension, element: { kind: c.elementKind, id: c.element } }));
    o.affected = [...baseline.changes.map((c) => ({ kind: c.elementKind, id: c.element })), ...baseline.changes.flatMap((c) => c.consumers.map((a) => a.ref))];
  }
  (p.case.expect.readiness ?? []).forEach((r, i) => {
    const taskFile = join(dir, `task-${i}.json`);
    writeJson(taskFile, r.task);
    const got = loom(dir, 'readiness', '--task', taskFile, '--as-of', FIXTURE_AS_OF);
    assert.ok(got.env.states, `readiness returns an envelope: ${got.output.slice(0, 400)}`);
    o.readiness.push({ state: got.env.states.readiness.state, reasons: reasonsOf(got.env, 'readiness'), workPackage: (got.env.data as { workPackage?: WorkPackage } | undefined)?.workPackage });
  });
  return o;
}

test('the fixture sets hold every case with an asserted validation and its inputs', () => {
  const sets = readFixtureSets(ROOT);
  const cases = sets.flatMap((s) => s.cases);
  assert.deepEqual(sets.map((s) => s.id), ['api-database', 'async-workflow', 'cli-library', 'currency-change']);
  assert.equal(outcomes.length, cases.length);
  assert.equal(cases.length, 28);
  for (const c of cases) assert.ok(c.expect.validation === 'valid' || c.expect.validation === 'invalid', `${c.id} asserts its validation`);
});

for (const o of outcomes) {
  test(`the core meets every expectation of ${o.id}`, () => {
    assert.deepEqual(o.mismatches, []);
  });
}

for (const o of outcomes) {
  test(`the CLI in a governed workspace meets every expectation of ${o.id} and agrees with the core`, { timeout: 300_000 }, () => {
    const cli = observeCli(o.prepared);
    assert.deepEqual(compareWithExpectation(o.prepared.case.expect, cli), []);
    // The core is compared on the inputs the workspace can hold.
    const p = o.prepared;
    const core = holdsBaseline(p) || !p.baseline ? o.observation : observeCore({ ...p, inputs: { ...p.inputs, baseline: undefined } });
    assert.equal(cli.validation, core.validation, 'CLI and core agree on validation');
    assert.equal(cli.qualification, core.qualification, 'CLI and core agree on qualification');
    assert.deepEqual(
      cli.readiness.map((r) => [r.state, [...r.reasons].sort()]),
      core.readiness.map((r) => [r.state, [...r.reasons].sort()]),
      'CLI and core agree on every readiness state and reason',
    );
    const reported = new Set(codesOf(cli.findings));
    const missing = [...new Set(codesOf(core.validationFindings))].filter((c) => !reported.has(c));
    assert.deepEqual(missing, [], 'the CLI reports every validation finding of the core');
    assert.deepEqual([...new Set(cli.reasonCodes)].sort(), [...new Set(core.reasonCodes)].sort(), 'CLI and core give the same acceptance and qualification reasons');
  });
}

test('the native checks a fixture case names give their stated results against its inputs', { timeout: 1_200_000 }, async () => {
  let ran = 0;
  for (const set of readFixtureSets(ROOT)) {
    for (const c of set.cases) {
      for (const check of c.expect.checks ?? []) {
        const read = <T>(rel: string): T => JSON.parse(readFileSync(join(ROOT, set.dir, rel), 'utf8')) as T;
        // The run model is the case model, so the fixture names no candidate of its own.
        const model = read<Model>(c.model);
        const migration: MigrationFixture = { migration: check.inputs.migration, previous: read<Model>(check.inputs.previousModel), rows: `${set.dir}/${check.inputs.rows}` };
        if (check.afterwards.currency !== undefined) migration.expectColumns = { currency: check.afterwards.currency };
        if (check.afterwards.amounts !== undefined) migration.expectValues = { column: 'amount', values: check.afterwards.amounts };
        // Only the artifacts the check reads are rendered, so a target the case cannot render does not decide this check.
        const dir = scratch();
        const artifacts = materialize(model, dir, { targets: resolveChecks([check.id]).flatMap((d) => d.inputs) as ProjectionTarget[] });
        const out = await runChecks({ root: ROOT, model, checks: [check.id], artifacts, fixtures: { migrations: [migration] }, policy: readSelfPolicy(ROOT), runner: 'fixture-harness' });
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        const result = out.run.checks[0]!;
        assert.equal(result.result, check.result, `${set.id}/${c.id} ${check.id}: ${result.reason ?? ''}`);
        assert.match(result.reason ?? '', new RegExp(`\\b${check.afterwards.rows} representative row\\(s\\)`), `${check.id} names the ${check.afterwards.rows} rows it carried over`);
        ran++;
      }
    }
  }
  assert.ok(ran > 0, 'a case names a native check');
});

test('a workspace that vendors the pinned bundle installs a complete OpenAPI document, and one without it refuses to install', { timeout: 300_000 }, () => {
  const o = outcomes.find((x) => x.id === 'api-database/coexisting-versions-with-pinned-published-contract');
  assert.ok(o);
  const { dir } = workspaceFor(o.prepared);
  const written = loom(dir, 'write', '--as-of', FIXTURE_AS_OF);
  assert.equal(written.status, 0, written.output.slice(0, 600));
  const doc = JSON.parse(readFileSync(join(dir, 'Docs', 'Loom', 'openapi.json'), 'utf8')) as { info: { description: string }; components: { schemas: Record<string, unknown> } };
  assert.ok('payments.payment' in doc.components.schemas, 'the pinned type is a component');
  assert.doesNotMatch(doc.info.description, /DRAFT/);
  const check = loom(dir, 'check', '--as-of', FIXTURE_AS_OF);
  assert.ok(!codesOf(check.env.findings).some((c) => c.startsWith('OUTPUT_') || c === 'PROFILE_UNSUPPORTED_CONSTRUCT'), check.output.slice(0, 600));

  const unresolved = outcomes.find((x) => x.id === 'api-database/unresolved-published-contract-blocks-dependent-work');
  assert.ok(unresolved);
  const bare = workspaceFor(unresolved.prepared).dir;
  const refused = loom(bare, 'write', '--as-of', FIXTURE_AS_OF);
  assert.equal(refused.status, 1);
  assert.ok(codesOf(refused.env.findings).includes('PROFILE_UNSUPPORTED_CONSTRUCT'), refused.output.slice(0, 600));
});
