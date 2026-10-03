import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { modelRevision } from '@loom/core';
import type { Acceptance, EvidenceRecord, Model, Policy, ResultEnvelope } from '@loom/core';
import { putEvidence, listEvidence } from '../evidence.js';
import { initWorkspace, scaffoldConfig, scaffoldModel } from '../init.js';
import { resolvePublishedContracts } from '../published.js';
import { createBaseline } from '../records.js';
import { gatherEvaluationInputs, pinRevisionSet, readAcceptances, readBaselines, readPolicy, readTrustedEvidence, signRecord, verifyRevisionSet } from '../trust.js';
import { writeModel } from '../write.js';
import { codes, commitAll, gitInit, readJsonFile, scratch, writeJson } from '../testing/helpers.js';

const ZERO = `sha256:${'0'.repeat(64)}`;

function keyPair(): { privateKeyPem: string; spki: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    policyVersion: 1,
    id: 'engineering',
    revision: 1,
    trust: { ref: 'refs/heads/main', acceptanceVia: 'trusted-ref', acceptanceKeys: [], evidenceKeys: [] },
    changeClasses: [{ id: 'documentation', description: 'Edits with no semantic effect.', match: { kinds: ['nonSemantic'] }, approval: 'pre-authorized' }],
    readiness: { implementation: { requires: 'accepted-contract' }, integration: { evidence: ['conformance'] }, release: { evidence: ['integration', 'e2e'] } },
    substitutes: [],
    qualification: { required: ['sql.behavior'], optional: [] },
    environments: [{ id: 'localdb-fixture', kind: 'disposable-fixture', designated: true, description: 'A per-run LocalDB database.' }],
    freeze: { onAcceptance: true, defectFixRequalify: ['conformance'] },
    ...overrides,
  };
}

function acceptance(id: string, authority = 'team-architecture'): Acceptance {
  return { acceptanceVersion: 1, id, subject: { kind: 'baseline', baseline: 'bl-1' }, decision: 'accepted', authority, policy: { ref: 'engineering', revision: 1 }, scope: [], changeClasses: [], at: '2026-10-03T10:00:00Z' };
}

function evidence(id: string): EvidenceRecord {
  return {
    evidenceVersion: 1,
    id,
    claims: [{ kind: 'check', ref: 'sql.behavior' }],
    kind: 'behavior',
    check: { id: 'sql.behavior', revision: 1, definitionHash: ZERO },
    artifacts: [],
    sources: [{ repository: '.', revision: 'a9ce204' }],
    environment: { id: 'localdb-fixture', kind: 'disposable-fixture' },
    tool: { name: 'sqlcmd', version: '15.0' },
    result: 'PASS',
    run: { id: 'run-1', runner: 'ci', startedAt: '2026-10-03T10:00:00Z', finishedAt: '2026-10-03T10:00:05Z' },
    boundaries: [{ boundary: 'SQL Server engine', actual: 'real' }],
    limits: 'Fixture database only.',
    inputs: [],
  };
}

function governedRepo(): string {
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root).outcome, 'ok');
  return root;
}

const WORKER = (url: string): string => `
import { writeModel, scaffoldModel } from ${JSON.stringify(url)};
const [root, expected, purpose] = process.argv.slice(1);
const m = scaffoldModel();
m.components[0].purpose = purpose;
const env = writeModel(root, m, expected);
process.stdout.write(JSON.stringify({ outcome: env.outcome, codes: env.findings.map((f) => f.code) }));
`;

function runWriter(root: string, expected: string, purpose: string): Promise<{ outcome: string; codes: string[] }> {
  const url = pathToFileURL(join(import.meta.dirname, '..', 'index.js')).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER(url), root, expected, purpose], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as { outcome: string; codes: string[] }) : reject(new Error(`writer exited ${code}: ${err}`))));
  });
}

test('of two writers on the same expected revision exactly one succeeds and the other is refused as stale', async () => {
  const root = governedRepo();
  const base = modelRevision(scaffoldModel());
  const results = await Promise.all([runWriter(root, base, 'Written by the first writer.'), runWriter(root, base, 'Written by the second writer.')]);
  const ok = results.filter((r) => r.outcome === 'ok');
  const stale = results.filter((r) => r.outcome === 'refused' && r.codes.includes('STALE_BASE_REVISION'));
  assert.equal(ok.length, 1, JSON.stringify(results));
  assert.equal(stale.length, 1, JSON.stringify(results));
});

test('a write against a stale base revision writes nothing', () => {
  const root = governedRepo();
  const modelPath = join(root, '.loom', 'model.json');
  const before = readJsonFile<Model>(modelPath);
  const next = scaffoldModel();
  (next.components[0] as { purpose: string }).purpose = 'Changed.';
  const env: ResultEnvelope = writeModel(root, next, ZERO);
  assert.equal(env.outcome, 'refused');
  assert.equal(env.refusal?.cause, 'stale-base');
  assert.deepEqual(codes(env.findings), ['STALE_BASE_REVISION']);
  assert.deepEqual(readJsonFile<Model>(modelPath), before);
  const ok = writeModel(root, next, modelRevision(before));
  assert.equal(ok.outcome, 'ok');
  assert.equal(readJsonFile<Model>(modelPath).components[0]?.purpose, 'Changed.');
});

test('policy is read from the trusted ref and a weakened working-tree copy is ignored', () => {
  const root = governedRepo();
  const policyPath = join(root, '.loom', 'policies', 'engineering.json');
  writeJson(policyPath, policy());
  commitAll(root, 'policy');
  writeJson(policyPath, policy({ qualification: { required: [], optional: [] } }));
  const read = readPolicy(root, 'engineering', 'refs/heads/main');
  assert.deepEqual(read.findings, []);
  assert.deepEqual(read.policy?.qualification.required, ['sql.behavior']);
  writeJson(join(root, '.loom', 'policies', 'release.json'), policy({ id: 'release', trust: { ref: 'refs/heads/release', acceptanceVia: 'trusted-ref', acceptanceKeys: [], evidenceKeys: [] } }));
  commitAll(root, 'release policy');
  assert.deepEqual(codes(readPolicy(root, 'release', 'refs/heads/main').findings), ['POLICY_UNTRUSTED']);
  assert.deepEqual(codes(readPolicy(root, 'absent', 'refs/heads/main').findings), ['POLICY_UNRESOLVED']);
});

test('acceptance is trusted at the trusted ref or under a listed key, never with a tampered signature', () => {
  const root = governedRepo();
  const owner = keyPair();
  const p = policy({ trust: { ref: 'refs/heads/main', acceptanceVia: 'either', acceptanceKeys: [{ id: 'owner-key', spki: owner.spki, authority: 'team-architecture' }], evidenceKeys: [] } });
  writeJson(join(root, '.loom', 'acceptance', 'acc-committed.json'), acceptance('acc-committed'));
  commitAll(root, 'committed acceptance');
  writeJson(join(root, '.loom', 'acceptance', 'acc-signed.json'), signRecord(acceptance('acc-signed'), owner.privateKeyPem, 'owner-key'));
  const tampered = signRecord(acceptance('acc-tampered'), owner.privateKeyPem, 'owner-key');
  tampered.authority = 'team-anyone';
  writeJson(join(root, '.loom', 'acceptance', 'acc-tampered.json'), tampered);
  writeJson(join(root, '.loom', 'acceptance', 'acc-unsigned.json'), acceptance('acc-unsigned'));
  const read = readAcceptances(root, 'refs/heads/main', p);
  const trust = Object.fromEntries(read.acceptances.map((a) => [a.record.id, a.trusted]));
  assert.deepEqual(trust, { 'acc-committed': true, 'acc-signed': true, 'acc-tampered': false, 'acc-unsigned': false });
  assert.equal(codes(read.findings).filter((c) => c === 'ACCEPTANCE_UNTRUSTED').length, 2);
  const refOnly = readAcceptances(root, 'refs/heads/main', policy());
  assert.equal(refOnly.acceptances.find((a) => a.record.id === 'acc-signed')?.trusted, false, 'a policy accepting only the trusted ref ignores signatures');
});

test('evidence is trusted only when signed by a runner key the trusted policy lists', () => {
  const root = governedRepo();
  const runner = keyPair();
  const stranger = keyPair();
  const p = policy({ trust: { ref: 'refs/heads/main', acceptanceVia: 'trusted-ref', acceptanceKeys: [], evidenceKeys: [{ id: 'ci-runner', spki: runner.spki, runner: 'ci' }] } });
  assert.equal(putEvidence(root, signRecord(evidence('ev-signed'), runner.privateKeyPem, 'ci-runner')).stored, true);
  assert.equal(putEvidence(root, signRecord(evidence('ev-stranger'), stranger.privateKeyPem, 'stranger')).stored, true);
  const forged = signRecord(evidence('ev-forged'), runner.privateKeyPem, 'ci-runner');
  forged.result = 'PASS';
  forged.limits = 'Claimed after the fact.';
  assert.equal(putEvidence(root, forged).stored, true);
  assert.equal(putEvidence(root, evidence('ev-unsigned')).stored, true);
  const read = readTrustedEvidence(root, p);
  const trust = Object.fromEntries(read.evidence.map((e) => [e.record.id, e.trusted]));
  assert.deepEqual(trust, { 'ev-forged': false, 'ev-signed': true, 'ev-stranger': false, 'ev-unsigned': false });
});

test('the evidence store is append-only and an unreadable store is reported', () => {
  const root = governedRepo();
  const record = evidence('ev-1');
  assert.equal(putEvidence(root, record).stored, true);
  const again = putEvidence(root, record);
  assert.equal(again.stored, false);
  assert.equal(again.refused, undefined, 'identical content is idempotent');
  const rewrite = putEvidence(root, { ...record, result: 'FAIL' });
  assert.equal(rewrite.stored, false);
  assert.match(rewrite.refused ?? '', /append-only/);
  assert.equal(listEvidence(root).value?.[0]?.result, 'PASS');
  const other = governedRepo();
  writeFileSync(join(other, '.loom', 'evidence'), 'not a directory');
  assert.deepEqual(codes(listEvidence(other).findings), ['EVIDENCE_STORE_UNAVAILABLE']);
});

test('a pinned published contract without a vendored bundle stays unresolved', () => {
  const root = governedRepo();
  const model = scaffoldModel();
  model.publishedContracts = [{ id: 'payments', publisher: 'team-payments', contract: 'payments-api', version: 2, digest: ZERO, schemaVersion: 1, consumers: [] }];
  const missing = resolvePublishedContracts(root, model);
  assert.deepEqual(codes(missing.findings), ['PUBLISHED_CONTRACT_UNRESOLVED']);
  assert.equal(missing.bundles.length, 0);
  writeJson(join(root, '.loom', 'contracts', 'team-payments', 'payments-api@2.json'), {
    bundleVersion: 1,
    publisher: 'team-payments',
    contract: 'payments-api',
    version: 2,
    schemaVersion: 1,
    profiles: ['openapi'],
    digest: ZERO,
    content: { types: [], operations: [], routines: [], securitySchemes: [] },
  });
  const found = resolvePublishedContracts(root, model);
  assert.deepEqual(found.findings, []);
  assert.equal(found.bundles.length, 1);
});

test('the pinned revision set detects a changed repository HEAD', () => {
  const root = governedRepo();
  commitAll(root, 'root');
  const lib = gitInit(join(root, 'lib'));
  writeFileSync(join(lib, 'a.txt'), 'one\n');
  commitAll(lib, 'lib one');
  const pinned = pinRevisionSet(root, ['lib']);
  assert.deepEqual(pinned.findings, []);
  assert.deepEqual(pinned.sources.map((s) => s.repository), ['.', 'lib']);
  assert.deepEqual(verifyRevisionSet(pinned.sources, pinRevisionSet(root, ['lib']).sources), []);
  writeFileSync(join(lib, 'a.txt'), 'two\n');
  commitAll(lib, 'lib two');
  const drift = verifyRevisionSet(pinned.sources, pinRevisionSet(root, ['lib']).sources);
  assert.deepEqual(codes(drift), ['EVIDENCE_REVISION_SET_INCONSISTENT']);
  assert.match(drift[0]?.message ?? '', /'lib'/);
});

test('a committed baseline is the trusted head and a tampered snapshot is reported', () => {
  const root = governedRepo();
  writeJson(join(root, '.loom', 'loom.json'), { ...scaffoldConfig(), gates: { policyRef: 'engineering' } });
  writeJson(join(root, '.loom', 'policies', 'engineering.json'), policy());
  commitAll(root, 'policy');
  const made = createBaseline(root, { id: 'bl-1', acceptance: 'acc-1' });
  assert.ok(made.value, JSON.stringify(made));
  assert.equal(createBaseline(root, { id: 'bl-1', acceptance: 'acc-1' }).value, null, 'a baseline is never rewritten');
  commitAll(root, 'baseline');
  const read = readBaselines(root, 'refs/heads/main');
  assert.equal(read.head?.record.id, 'bl-1');
  assert.equal(read.head?.verified, true);
  const inputs = gatherEvaluationInputs(root);
  assert.equal(inputs.ref, 'refs/heads/main');
  assert.equal(inputs.inputs.baseline?.verified, true);
  assert.equal(inputs.inputs.policy?.id, 'engineering');
  const snap = join(root, '.loom', 'baselines', 'bl-1.model.json');
  const tamperedModel = readJsonFile<Model>(snap);
  (tamperedModel.components[0] as { purpose: string }).purpose = 'Rewritten after acceptance.';
  writeJson(snap, tamperedModel);
  commitAll(root, 'tamper');
  assert.ok(codes(readBaselines(root, 'refs/heads/main').findings).includes('BASELINE_HASH_MISMATCH'));
  rmSync(join(root, '.loom', 'policies'), { recursive: true, force: true });
  mkdirSync(join(root, '.loom', 'policies'));
  assert.equal(readPolicy(root, 'engineering', 'refs/heads/main').policy?.id, 'engineering', 'removing the working-tree policy changes nothing at the trusted ref');
});
