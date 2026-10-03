import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportModel, modelRevision, sampleModel, schemaErrors, textHash } from '@loom/core';
import type { EvidenceObligation, LoomConfig, MetricsReport, Model, Policy, ResultEnvelope } from '@loom/core';
import { commitAll, fileHash, gitInit, scratch, writeJson } from '@loom/workspace/testing';

const CLI = fileURLToPath(new URL('../index.js', import.meta.url));
const LOOM_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

interface Run {
  status: number;
  stdout: string;
  env: ResultEnvelope;
}

function loom(cwd: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd, encoding: 'utf8' });
  let env = {} as ResultEnvelope;
  try {
    env = JSON.parse(r.stdout) as ResultEnvelope;
  } catch {
    // A usage error prints a message, not an envelope.
  }
  return { status: r.status ?? -1, stdout: r.stdout + r.stderr, env };
}

// The history phrases the documentation check must catch, assembled so the fixture text does not itself appear in the repository.
const PAST = ['previ', 'ously'].join('');
const USED = ['used', 'to'].join(' ');

const codes = (r: Run): string[] => (r.env.findings ?? []).map((f) => f.code);

function writeModelFile(dir: string, name: string, model: Model = sampleModel()): string {
  const path = join(dir, name);
  // Plain JSON: export fails closed, and some tests write deliberately invalid models.
  writeFileSync(path, `${JSON.stringify(model, null, 2)}\n`);
  return path;
}

/** An initialized repository governing the fixture model with one scope root per component. */
function workspace(extra: Partial<LoomConfig> = {}): string {
  const dir = gitInit(scratch());
  assert.equal(loom(dir, 'init').status, 0);
  const model = sampleModel();
  writeModelFile(join(dir, '.loom'), 'model.json', model);
  for (const c of model.components) mkdirSync(join(dir, c.id), { recursive: true });
  const configPath = join(dir, '.loom', 'loom.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as LoomConfig;
  writeJson(configPath, { ...config, scope: Object.fromEntries(model.components.map((c) => [c.id, [c.id]])), ...extra });
  return dir;
}

const POLICY: Policy = {
  policyVersion: 1,
  id: 'engineering',
  revision: 1,
  trust: { ref: 'refs/heads/main', acceptanceVia: 'trusted-ref', acceptanceKeys: [], evidenceKeys: [] },
  changeClasses: [],
  readiness: { implementation: { requires: 'accepted-contract' }, integration: { evidence: [] }, release: { evidence: [] } },
  substitutes: [],
  qualification: { required: [], optional: [] },
  environments: [],
};

/** A workspace whose policy, accepted baseline and acceptance are committed to the trusted ref. */
function governedWithBaseline(): string {
  const dir = workspace({ gates: { policyRef: 'engineering' } });
  writeJson(join(dir, '.loom', 'policies', 'engineering.json'), POLICY);
  commitAll(dir, 'policy');
  assert.equal(loom(dir, 'accept', '--id', 'acc-1', '--authority', 'team-architecture', '--subject', 'baseline', '--baseline', 'bl-1').status, 0);
  // An acceptance is trusted once it is committed at the trusted ref; the baseline it accepts is created after that.
  commitAll(dir, 'acceptance');
  const created = loom(dir, 'baseline', 'create', '--id', 'bl-1', '--acceptance', 'acc-1');
  assert.equal(created.status, 0, created.stdout);
  commitAll(dir, 'baseline');
  return dir;
}

test('the CLI without a command prints usage and an unknown command is a usage error', () => {
  const dir = scratch();
  const usage = spawnSync(process.execPath, [CLI], { cwd: dir, encoding: 'utf8' });
  assert.equal(usage.status, 0);
  assert.match(usage.stdout, /Usage: loom <command>/);
  assert.equal(loom(dir, 'frobnicate').status, 2);
  assert.equal(loom(dir, 'readiness', '--class').status, 2);
});

test('init scaffolds a repository root and refuses a subdirectory and a second run', () => {
  const dir = gitInit(scratch());
  const first = loom(dir, 'init');
  assert.equal(first.status, 0, first.stdout);
  assert.ok(existsSync(join(dir, '.loom', 'model.json')));
  mkdirSync(join(dir, 'sub'));
  const sub = loom(join(dir, 'sub'), 'init');
  assert.equal(sub.status, 1);
  assert.ok(codes(sub).includes('INIT_NOT_REPOSITORY_ROOT'));
  const again = loom(dir, 'init');
  assert.equal(again.status, 1);
  assert.ok(codes(again).includes('INIT_ALREADY_INITIALIZED'));
});

test('check with an explicit model outside a workspace is validation only', () => {
  const dir = scratch();
  const model = writeModelFile(dir, 'model.json');
  const r = loom(dir, 'check', '--model', model);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(codes(r).includes('VALIDATION_ONLY_MODE'));
  assert.equal(r.env.states.validation.state, 'valid');
  const broken = sampleModel();
  broken.mutations[0]!.from = ['$absent', 'placed'];
  const bad = loom(dir, 'check', '--model', writeModelFile(dir, 'bad.json', broken));
  assert.equal(bad.status, 1);
  assert.ok(codes(bad).includes('MUTATION_MIXED_ORIGIN'));
});

test('write and check agree on an installed bundle and report a hand edit as drift', () => {
  const dir = workspace({ projectionProfile: 'contracts' });
  const w = loom(dir, 'write');
  assert.equal(w.status, 0, w.stdout);
  const clean = loom(dir, 'check');
  assert.ok(!codes(clean).some((c) => c === 'OUTPUT_DRIFT' || c === 'OUTPUT_MISSING' || c === 'MANIFEST_STALE'), clean.stdout);
  writeFileSync(join(dir, 'Docs', 'Loom', 'reference.md'), 'hand edit\n');
  const drift = loom(dir, 'check');
  assert.equal(drift.status, 1);
  assert.ok(codes(drift).includes('OUTPUT_DRIFT'));
});

test('write --out writes every projection into a directory and refuses an invalid model', () => {
  const dir = scratch();
  const model = writeModelFile(dir, 'model.json');
  const out = join(dir, 'out');
  assert.equal(loom(dir, 'write', '--model', model, '--out', out).status, 0);
  assert.ok(existsSync(join(out, 'openapi.json')));
  assert.equal(loom(dir, 'check', '--model', model, '--out', out).status, 0);
  const broken = sampleModel();
  broken.types[0]!.properties[0]!.bounds = { minLength: 5, maxLength: 2 };
  assert.equal(loom(dir, 'write', '--model', writeModelFile(dir, 'bad.json', broken), '--out', join(dir, 'out2')).status, 1);
});

test('an explicit model inside a governed workspace is still compared with the trusted accepted baseline', () => {
  const dir = governedWithBaseline();
  const accepted = loom(dir, 'check');
  assert.equal(accepted.env.states.acceptance.state, 'accepted', accepted.stdout);
  const replaced = sampleModel();
  replaced.operations.find((o) => o.id === 'order.place')!.authority.permission = 'order.admin';
  const r = loom(dir, 'check', '--model', writeModelFile(dir, 'replacement.json', replaced));
  assert.notEqual(r.env.states.acceptance.state, 'accepted');
  assert.ok(codes(r).includes('CHANGE_UNACCEPTED'), r.stdout);
  assert.ok(!codes(r).includes('VALIDATION_ONLY_MODE'));
});

/** The fixture with a narrower permission on order.get: a breaking security change, kept at the accepted version unless `version` raises it. */
function narrowedRead(version = 1): Model {
  const m = sampleModel();
  const op = m.operations.find((o) => o.id === 'order.get')!;
  op.authority = { ...op.authority, permission: 'order.admin' };
  op.version = version;
  return m;
}

const unbumped = (r: Run): string[] => (r.env.findings ?? []).filter((f) => f.code === 'BREAKING_CHANGE_WITHOUT_VERSION_BUMP').map((f) => f.path);

test('check reports a breaking change kept at the accepted contract version, whether a file edit, another document or two accepted patches made it', () => {
  const dir = governedWithBaseline();
  writeModelFile(join(dir, '.loom'), 'model.json', narrowedRead());
  const edited = loom(dir, 'check');
  assert.equal(edited.status, 1);
  assert.deepEqual(unbumped(edited), ['operations/order.get/version'], edited.stdout);
  const document = loom(dir, 'check', '--model', writeModelFile(dir, 'document.json', narrowedRead()));
  assert.deepEqual(unbumped(document), ['operations/order.get/version'], document.stdout);

  writeModelFile(join(dir, '.loom'), 'model.json');
  const raise = join(dir, 'raise.json');
  const lower = join(dir, 'lower.json');
  writeJson(raise, { op: 'update', collection: 'operations', id: 'order.get', set: { version: 2, authority: { permission: 'order.admin', scheme: 'bearer' } } });
  writeJson(lower, { op: 'update', collection: 'operations', id: 'order.get', set: { version: 1 } });
  const first = loom(dir, 'mutate', '--patch', raise, '--ack', 'order.get', '--expected', modelRevision(sampleModel()));
  assert.equal(first.status, 0, first.stdout);
  const second = loom(dir, 'mutate', '--patch', lower, '--expected', (first.env.data as { revision: string }).revision);
  assert.equal(second.status, 0, 'lowering a version is no breaking change against the model it patches');
  const patched = loom(dir, 'check');
  assert.deepEqual(unbumped(patched), ['operations/order.get/version'], patched.stdout);
});

test('check reports no unbumped version once the breaking change raises it, nor for a compatible edit at the accepted version', () => {
  const dir = governedWithBaseline();
  writeModelFile(join(dir, '.loom'), 'model.json', narrowedRead(2));
  const raised = loom(dir, 'check');
  assert.deepEqual(unbumped(raised), [], raised.stdout);
  assert.ok(codes(raised).includes('CHANGE_UNACCEPTED'), 'the raised change still needs acceptance');
  const reworded = sampleModel();
  reworded.operations.find((o) => o.id === 'order.get')!.description = 'Read one order by its id.';
  writeModelFile(join(dir, '.loom'), 'model.json', reworded);
  const compatible = loom(dir, 'check');
  assert.deepEqual(unbumped(compatible), [], compatible.stdout);
});

test('a baseline whose acceptance accepted another revision is not accepted, and one accepted at the revision it pins is', () => {
  const dir = workspace({ gates: { policyRef: 'engineering' } });
  writeJson(join(dir, '.loom', 'policies', 'engineering.json'), POLICY);
  commitAll(dir, 'policy');
  assert.equal(loom(dir, 'accept', '--id', 'acc-1', '--authority', 'team-architecture', '--subject', 'baseline', '--baseline', 'bl-1').status, 0);
  commitAll(dir, 'acceptance of the fixture revision');
  const other = sampleModel();
  other.operations.find((o) => o.id === 'order.get')!.description = 'Read one order by its id.';
  writeModelFile(join(dir, '.loom'), 'model.json', other);
  const created = loom(dir, 'baseline', 'create', '--id', 'bl-1', '--acceptance', 'acc-1');
  assert.equal(created.status, 0, created.stdout);
  commitAll(dir, 'baseline of another revision');
  const r = loom(dir, 'check');
  assert.equal(r.env.states.acceptance.state, 'unaccepted', r.stdout);
  assert.ok(r.env.findings.some((f) => f.code === 'ACCEPTANCE_MISSING' && f.message.includes(modelRevision(sampleModel()))), r.stdout);
  const blocked = loom(dir, 'readiness', '--class', 'implementation', '--components', 'ordering');
  assert.ok(blocked.env.states.readiness.reasons.some((x) => x.code === 'READINESS_MATURITY_INSUFFICIENT'), blocked.stdout);

  const own = governedWithBaseline();
  assert.equal(loom(own, 'check').env.states.acceptance.state, 'accepted');
  const ready = loom(own, 'readiness', '--class', 'implementation', '--components', 'ordering');
  assert.ok(!ready.env.states.readiness.reasons.some((x) => x.code === 'READINESS_MATURITY_INSUFFICIENT'), ready.stdout);
});

test('check --all finds every descriptor and reports overlapping claims', () => {
  const parent = gitInit(scratch());
  assert.equal(loom(parent, 'init').status, 0);
  const child = gitInit(join(parent, 'child'));
  assert.equal(loom(child, 'init').status, 1, 'init refuses a scope an ancestor already claims');
  mkdirSync(join(child, '.loom'), { recursive: true });
  for (const f of ['model.json', 'loom.json', 'state.json']) writeFileSync(join(child, '.loom', f), readFileSync(join(parent, '.loom', f)));
  const all = loom(parent, 'check', '--all');
  assert.equal(all.status, 1);
  assert.ok(codes(all).includes('SCOPE_OVERLAP'), all.stdout);
  assert.equal((all.env.data as { models: unknown[] }).models.length, 2);
});

test('owner names the owning model or reports an ungoverned path', () => {
  const dir = workspace();
  const owned = loom(dir, 'owner', 'ordering');
  assert.equal((owned.env.data as { status: string }).status, 'owned');
  mkdirSync(join(dir, 'tools'));
  const free = loom(dir, 'owner', 'tools');
  assert.equal(free.status, 0);
  assert.ok(codes(free).includes('SCOPE_NO_OWNER'));
});

test('migrate leaves a current document unchanged, never replaces its source and refuses an unknown format', () => {
  const dir = scratch();
  const model = writeModelFile(dir, 'model.json');
  const r = loom(dir, 'migrate', '--model', model, '--to', join(dir, 'migrated.json'));
  assert.equal(r.status, 0, r.stdout);
  assert.equal(modelRevision(JSON.parse(readFileSync(join(dir, 'migrated.json'), 'utf8')) as Model), modelRevision(sampleModel()));
  assert.equal(loom(dir, 'migrate', '--model', model, '--to', model).status, 2);
  writeJson(join(dir, 'other.json'), { version: 0, components: [] });
  const unknown = loom(dir, 'migrate', '--model', join(dir, 'other.json'));
  assert.equal(unknown.status, 1);
  assert.ok(codes(unknown).includes('MODEL_FORMAT_UNSUPPORTED'));
});

test('accept needs a policy, and baseline creation needs an acceptance record', () => {
  const dir = workspace();
  const noPolicy = loom(dir, 'accept', '--id', 'acc-1', '--authority', 'team-architecture');
  assert.equal(noPolicy.status, 1);
  assert.equal(noPolicy.env.refusal?.cause, 'unmet-prerequisite');
  const noAcceptance = loom(dir, 'baseline', 'create', '--id', 'bl-1', '--acceptance', 'missing');
  assert.equal(noAcceptance.status, 1, noAcceptance.stdout);
  assert.equal(loom(dir, 'baseline', 'remove').status, 2);
});

test('readiness evaluates a task and refuses an invalid task class', () => {
  const dir = workspace();
  const r = loom(dir, 'readiness', '--class', 'implementation', '--components', 'ordering');
  assert.equal(r.env.tool, 'loom.checkReadiness');
  assert.notEqual(r.env.states.readiness.state, 'notEvaluated');
  assert.equal(loom(dir, 'readiness', '--class', 'launch').status, 2);
});

test('plan previews a change and refuses a stale base', () => {
  const dir = workspace();
  const patch = join(dir, 'patch.json');
  writeJson(patch, { op: 'update', collection: 'operations', id: 'order.get', set: { description: 'Read one order by its id.' } });
  const ok = loom(dir, 'plan', '--patch', patch);
  assert.equal(ok.status, 0, ok.stdout);
  assert.ok(Array.isArray((ok.env.data as { changes: unknown[] }).changes));
  const stale = loom(dir, 'plan', '--patch', patch, '--base', textHash('another revision'));
  assert.equal(stale.status, 1);
  assert.equal(stale.env.refusal?.cause, 'stale-base');
});

test('mutate persists only onto the expected revision and a dry run writes nothing', () => {
  const dir = workspace();
  const modelPath = join(dir, '.loom', 'model.json');
  const patch = join(dir, 'patch.json');
  writeJson(patch, { op: 'update', collection: 'operations', id: 'order.get', set: { description: 'Read one order by its id.' } });
  const base = modelRevision(JSON.parse(readFileSync(modelPath, 'utf8')) as Model);
  const before = fileHash(modelPath);
  assert.equal(loom(dir, 'mutate', '--patch', patch, '--expected', base, '--dry-run').status, 0);
  assert.equal(fileHash(modelPath), before);
  const stale = loom(dir, 'mutate', '--patch', patch, '--expected', textHash('another revision'));
  assert.equal(stale.status, 1);
  assert.ok(codes(stale).includes('STALE_BASE_REVISION'));
  const committed = loom(dir, 'mutate', '--patch', patch, '--expected', base);
  assert.equal(committed.status, 0, committed.stdout);
  assert.equal((committed.env.data as { committed: boolean }).committed, true);
  assert.notEqual(fileHash(modelPath), before);
  assert.equal(loom(dir, 'mutate', '--patch', patch, '--expected', base).status, 1, 'the old base is now stale');
  const outside = loom(scratch(), 'mutate', '--patch', patch, '--expected', base);
  assert.equal(outside.env.refusal?.cause, 'unresolved-context');
});

test('qualify runs a named check and refuses an unknown one', () => {
  const dir = workspace({ projectionProfile: 'documentation' });
  commitAll(dir, 'workspace');
  const r = loom(dir, 'qualify', '--checks', 'documentation.yaml-roundtrip');
  assert.equal(r.status, 0, r.stdout);
  assert.notEqual(r.env.states.qualification.state, 'qualified', 'one unsigned passing check never qualifies the workspace obligations');
  const run = (r.env.data as { run: { checks: Array<{ check: string; result: string }> } }).run;
  assert.equal(run.checks[0]?.result, 'PASS');
  assert.equal(loom(dir, 'qualify', '--checks', 'no.such.check').status, 2);
});

test('qualify judges the evidence of its own signed run against the artifacts that run rendered', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const policy: Policy = { ...POLICY, trust: { ...POLICY.trust, evidenceKeys: [{ id: 'cli-runner', spki, runner: 'loom-cli' }] }, qualification: { required: ['documentation.yaml-roundtrip'], optional: [] } };
  const dir = workspace({ projectionProfile: 'documentation', gates: { policyRef: 'engineering' } });
  writeJson(join(dir, '.loom', 'policies', 'engineering.json'), policy);
  commitAll(dir, 'workspace');
  process.env['LOOM_CLI_TEST_KEY'] = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  try {
    const r = loom(dir, 'qualify', '--checks', 'documentation.yaml-roundtrip', '--key-id', 'cli-runner', '--key-env', 'LOOM_CLI_TEST_KEY');
    assert.equal(r.status, 0, r.stdout);
    const obligation = (r.env.data as { obligations: EvidenceObligation[] }).obligations.find((o) => o.id === 'check:documentation.yaml-roundtrip');
    assert.equal(obligation?.status, 'passing', JSON.stringify(obligation));
  } finally {
    delete process.env['LOOM_CLI_TEST_KEY'];
  }
});

test('qualify --metrics measures the outcome corpora and --compare reports every measurement beside the recorded one', () => {
  const dir = workspace({ projectionProfile: 'documentation' });
  commitAll(dir, 'workspace');
  const recorded = join(LOOM_ROOT, 'qualification', 'metrics.json');
  const r = loom(dir, 'qualify', '--checks', 'documentation.yaml-roundtrip', '--metrics', '--compare', recorded);
  assert.equal(r.status, 0, r.stdout);
  const metrics = (r.env.data as { metrics: MetricsReport }).metrics;
  assert.deepEqual(schemaErrors('MetricsReport', metrics), []);
  for (const c of [metrics.seededErrors, metrics.legitimateChanges, metrics.escapedContradictions!, metrics.staleEvidence, metrics.unnecessaryBlocking]) {
    assert.ok(c.cases > 0 && c.intended + c.missed.length === c.cases, 'every count names its corpus and accounts for each case');
  }
  assert.equal(metrics.manualDuplication.handMaintainedStructuralDeclarations, 0, 'no structural declaration is maintained by hand');
  const baseline = JSON.parse(readFileSync(recorded, 'utf8')) as MetricsReport;
  const byMetric = new Map((metrics.comparison ?? []).map((c) => [c.metric, c]));
  assert.equal(byMetric.get('seededErrors.intended')?.baseline, baseline.seededErrors.intended);
  assert.equal(byMetric.get('qualificationCoverage.required')?.baseline, baseline.qualificationCoverage.required);
  assert.equal(byMetric.get('qualificationCoverage.required')?.current, 1, 'the current coverage is that of this run');
  assert.ok(['seededErrors', 'legitimateChanges', 'escapedContradictions', 'staleEvidence', 'unnecessaryBlocking', 'qualificationCoverage', 'contextSize', 'manualDuplication'].every((m) => [...byMetric.keys()].some((k) => k.startsWith(`${m}.`))), 'every metric is compared');
  assert.equal(loom(dir, 'qualify', '--checks', 'documentation.yaml-roundtrip', '--compare', recorded).status, 2, '--compare needs --metrics');
  writeJson(join(dir, 'not-a-report.json'), { metricsVersion: 2 });
  assert.equal(loom(dir, 'qualify', '--checks', 'documentation.yaml-roundtrip', '--metrics', '--compare', join(dir, 'not-a-report.json')).status, 2, 'a baseline that is not a metrics report is refused');
});

test('evidence lists the store and refuses an unknown record', () => {
  const dir = workspace();
  const list = loom(dir, 'evidence', 'list');
  assert.equal(list.status, 0, list.stdout);
  const missing = loom(dir, 'evidence', 'show', 'ev-missing');
  assert.equal(missing.status, 1);
  assert.ok(codes(missing).includes('EVIDENCE_MISSING'));
});

test('context is bounded, names its continuation and refuses a continuation of another revision', () => {
  const dir = workspace();
  const r = loom(dir, 'context', '--kind', 'component', '--id', 'ordering', '--max-records', '3');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.env.completeness.truncated, true);
  const token = r.env.completeness.continuation as string;
  assert.ok(token);
  const next = loom(dir, 'context', '--kind', 'component', '--id', 'ordering', '--max-records', '3', '--continuation', token);
  assert.equal(next.status, 0, next.stdout);
  const stale = loom(dir, 'context', '--kind', 'component', '--id', 'ordering', '--continuation', `ctx1.${textHash('another')}.3`);
  assert.equal(stale.env.refusal?.cause, 'stale-base');
});

test('describe lists every tool and finding code', () => {
  const r = loom(scratch(), 'describe');
  assert.equal(r.status, 0);
  const data = r.env.data as { tools: unknown[]; findingCodes: unknown[] };
  assert.ok(data.tools.length >= 12 && data.findingCodes.length > 100);
});

test('docs installs the views with evaluated inputs and docs --check reports broken links, unknown records and history markers', () => {
  const dir = workspace({ projectionProfile: 'documentation' });
  assert.equal(loom(dir, 'docs').status, 0);
  writeFileSync(join(dir, 'README.md'), '# Fixture\n\nSee [the reference](Docs/Loom/reference.md) and [order](loom:type/order).\n');
  const clean = loom(dir, 'docs', '--check');
  assert.ok(!codes(clean).some((c) => c.startsWith('DOCUMENT_') || c.startsWith('OUTPUT_')), clean.stdout);
  writeFileSync(join(dir, 'README.md'), `# Fixture\n\nSee [missing](Docs/none.md), [nothing](loom:type/nothing) and [anchor](Docs/Loom/reference.md#no-such-heading).\n\nThe store was ${PAST} a file share.\n`);
  const fired = loom(dir, 'docs', '--check');
  assert.equal(fired.status, 1);
  for (const code of ['DOCUMENT_LINK_BROKEN', 'DOCUMENT_RECORD_UNKNOWN', 'DOCUMENT_HISTORY_MARKER']) assert.ok(codes(fired).includes(code), `${code}: ${fired.stdout}`);
});

test('docs --check flags a hand-authored copy of a generated register and a comment narrating history', () => {
  const dir = workspace();
  mkdirSync(join(dir, 'Docs'), { recursive: true });
  writeFileSync(join(dir, 'Docs', 'open-items.md'), '# Open items\n\n| Id | Question |\n|---|---|\n| unk.report-period | Which reporting period? |\n');
  mkdirSync(join(dir, 'packages', 'tool', 'src'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'tool', 'src', 'index.ts'), `// This ${USED} be a shell script.\nexport const x = 1;\n`);
  const r = loom(dir, 'docs', '--check');
  assert.ok(codes(r).includes('DOCUMENT_DUPLICATES_GENERATED'), r.stdout);
  assert.ok(codes(r).includes('DOCUMENT_HISTORY_MARKER'), r.stdout);
});

test('docs --check reports an accepted interface dropped from the regenerated documentation', () => {
  const dir = governedWithBaseline();
  const modelPath = join(dir, '.loom', 'model.json');
  const model = JSON.parse(readFileSync(modelPath, 'utf8')) as Model;
  model.operations = model.operations.filter((o) => o.id !== 'shipment.status');
  writeFileSync(modelPath, `${JSON.stringify(model, null, 2)}\n`);
  const r = loom(dir, 'docs', '--check');
  assert.ok(codes(r).includes('DOCUMENT_INTERFACE_DROPPED'), r.stdout);
});

test('coverage --check resolves code, contracts and cases, and fires on each kind of miss', () => {
  const dir = gitInit(scratch());
  mkdirSync(join(dir, 'packages', 'tool', 'src', 'test'), { recursive: true });
  mkdirSync(join(dir, 'qualification'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'tool', 'src', 'feature.ts'), 'export function feature(): number {\n  return 1;\n}\n');
  writeFileSync(join(dir, 'packages', 'tool', 'src', 'test', 'feature.test.ts'), "test('the feature returns one', () => {});\n");
  writeFileSync(join(dir, 'schema.json'), '{"$defs":{"Feature":{}}}\n');
  const tap = join(dir, 'results.tap');
  writeFileSync(tap, 'TAP version 13\nok 1 - the feature returns one\n');
  const register = (code: string, contract: string, verification: string): void =>
    writeJson(join(dir, 'qualification', 'capabilities.json'), { registerVersion: 1, capabilities: [{ id: 'tool.feature', description: 'The feature.', code: [code], contract: [contract], verification: [verification] }] });
  register('packages/tool/src/feature.ts#feature', 'schema.json#/$defs/Feature', 'tool.feature.the-feature-returns-one');
  const listed = loom(dir, 'coverage', '--list-cases');
  assert.ok((listed.env.data as { cases: Array<{ id: string }> }).cases.some((c) => c.id === 'tool.feature.the-feature-returns-one'));
  const pass = loom(dir, 'coverage', '--check', '--results', tap);
  assert.equal(pass.status, 0, pass.stdout);
  const noResults = loom(dir, 'coverage', '--check');
  assert.ok(codes(noResults).includes('CAPABILITY_CASE_FAILED'), 'a case without a supplied result never counts as passed');
  register('packages/tool/src/feature.ts#missing', 'schema.json#/$defs/Missing', 'tool.feature.no-such-case');
  const fired = loom(dir, 'coverage', '--check', '--results', tap);
  assert.equal(fired.status, 1);
  for (const code of ['CAPABILITY_CODE_UNRESOLVED', 'CAPABILITY_CONTRACT_UNRESOLVED', 'CAPABILITY_CASE_UNKNOWN']) assert.ok(codes(fired).includes(code), `${code}: ${fired.stdout}`);
});
