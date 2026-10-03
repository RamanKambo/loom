import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { sampleModel, type Change, type CheckDefinition, type Model, type Policy } from '@loom/core';
import { initWorkspace, listEvidence, readTrustedEvidence, verifyRecord } from '@loom/workspace';
import { commitAll, gitInit, scratch } from '@loom/workspace/testing';
import { exec, runPwsh, lastJsonLine } from '../exec.js';
import { aggregate } from '../policy.js';
import { runChecks } from '../run.js';
import { verifyRunRevisionSet } from '../revision.js';
import { defaultToolLocator, satisfies, type ToolLocator } from '../tools.js';
import { unmatchedBreaks, type OasdiffItem } from '../runners/openapi.js';
import { connectionFailure } from '../runners/localdb.js';
import { declarativeDdl } from '../runners/sql.js';
import { outcome, type Runner } from '../types.js';
import { LOOM_ROOT, sampleArtifacts, selfPolicy, clone } from './helpers.js';

const check = (id: string, extra: Partial<CheckDefinition> = {}): CheckDefinition => ({
  id,
  revision: 1,
  layer: 'unit',
  evidence: 'unit',
  claim: `the ${id} claim`,
  tool: { name: 'node', versionPolicy: { minimum: '22.0' } },
  runner: id,
  inputs: [],
  environment: 'process',
  requiredByDefault: true,
  limits: 'Test check.',
  ...extra,
});

const passing: Runner = async () => outcome('PASS', 'ran');

const policyWith = (required: string[], optional: string[] = []): Policy => ({ ...selfPolicy(), qualification: { required, optional } });

async function run(checks: CheckDefinition[], runners: Record<string, Runner>, options: { policy?: Policy; toolLocator?: ToolLocator; timeoutMs?: number; environmentId?: string } = {}) {
  const { set, done } = sampleArtifacts();
  try {
    return await runChecks({ root: LOOM_ROOT, model: sampleModel(), checks, artifacts: set, runners, ...options });
  } finally {
    done();
  }
}

test('a required check whose tool is missing is UNKNOWN and keeps the aggregate from PASS', async () => {
  const missing: ToolLocator = async () => ({ status: 'missing', reason: 'tool removed for the test' });
  const out = await run([check('t.needs-tool')], { 't.needs-tool': passing }, { toolLocator: missing });
  assert.equal(out.run.checks[0]!.result, 'UNKNOWN');
  assert.match(out.run.checks[0]!.reason ?? '', /tool removed/);
  assert.equal(out.run.aggregate, 'UNKNOWN');
});

test('an optional check that is UNKNOWN stays visible but does not block a passing required check', async () => {
  const locator: ToolLocator = async (name, policy) => (policy.exact === '0.0.0' ? { status: 'missing', reason: 'absent' } : defaultToolLocator()(name, policy));
  const optional = check('t.optional', { tool: { name: 'node', versionPolicy: { exact: '0.0.0' } } });
  const out = await run([check('t.required'), optional], { 't.required': passing, 't.optional': passing }, { toolLocator: locator, policy: policyWith(['t.required'], ['t.optional']) });
  assert.deepEqual(out.run.checks.map((c) => [c.check, c.required, c.result]), [['t.required', true, 'PASS'], ['t.optional', false, 'UNKNOWN']]);
  assert.equal(out.run.aggregate, 'PASS');
});

test('a tool outside the version policy is UNKNOWN and its actual version is recorded', async () => {
  const out = await run([check('t.old', { tool: { name: 'node', versionPolicy: { major: 999 } } })], { 't.old': passing });
  assert.equal(out.run.checks[0]!.result, 'UNKNOWN');
  assert.equal(out.evidence[0]!.tool.version, process.versions.node);
});

test('a runner that never finishes is stopped and reported UNKNOWN', async () => {
  const hang: Runner = () => new Promise(() => undefined);
  const out = await run([check('t.hang')], { 't.hang': hang }, { timeoutMs: 50 });
  assert.equal(out.run.checks[0]!.result, 'UNKNOWN');
  assert.match(out.run.checks[0]!.reason ?? '', /did not finish/);
});

test('a runner that crashes is reported UNKNOWN with the error', async () => {
  const crash: Runner = async () => {
    throw new Error('boom');
  };
  const out = await run([check('t.crash')], { 't.crash': crash });
  assert.equal(out.run.checks[0]!.result, 'UNKNOWN');
  assert.match(out.run.checks[0]!.reason ?? '', /boom/);
});

test('an executable still running at the timeout is killed and reported as a timeout', async () => {
  const r = await exec(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.kind, 'timeout');
});

test('a tool whose output is unreadable yields UNKNOWN, never a pass', async () => {
  // node rejects the pwsh arguments and prints no JSON, which is exactly an unreadable result.
  const r = await runPwsh(process.execPath, '[pscustomobject]@{ ok = 1 } | ConvertTo-Json -Compress', { timeoutMs: 30_000 });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.kind, 'unreadable');
  assert.equal(lastJsonLine('not json\nstill not'), null);
  const fakePwsh: ToolLocator = async (name, policy) => (name === 'pwsh' ? { status: 'found', tool: { name, path: process.execPath, version: '7.6.0' } } : defaultToolLocator()(name, policy));
  const { set, done } = sampleArtifacts();
  try {
    const out = await runChecks({ root: LOOM_ROOT, model: sampleModel(), checks: ['powershell.parse'], artifacts: set, toolLocator: fakePwsh });
    assert.equal(out.run.checks[0]!.result, 'UNKNOWN');
  } finally {
    done();
  }
});

test('a fixture check runs only in an environment the policy designates', async () => {
  const fixtureCheck = check('t.fixture', { environment: 'disposable-fixture' });
  const none = await run([fixtureCheck], { 't.fixture': passing });
  assert.equal(none.run.checks[0]!.result, 'UNKNOWN');
  assert.match(none.run.checks[0]!.reason ?? '', /no policy designates/);
  const wrong = await run([fixtureCheck], { 't.fixture': passing }, { policy: policyWith(['t.fixture']), environmentId: 'production' });
  assert.equal(wrong.run.checks[0]!.result, 'UNKNOWN');
  const designated = await run([fixtureCheck], { 't.fixture': passing }, { policy: policyWith(['t.fixture']) });
  assert.equal(designated.run.checks[0]!.result, 'PASS');
  assert.equal(designated.evidence[0]!.environment.kind, 'disposable-fixture');
});

test('NOT_APPLICABLE without a justification is UNKNOWN', async () => {
  const out = await run([check('t.na')], { 't.na': async () => outcome('NOT_APPLICABLE', '  ') });
  assert.equal(out.run.checks[0]!.result, 'UNKNOWN');
});

test('a draft artifact set never qualifies', async () => {
  const { set, done } = sampleArtifacts();
  try {
    const out = await runChecks({ root: LOOM_ROOT, model: sampleModel(), checks: [check('t.draft')], artifacts: { ...set, draft: true }, runners: { 't.draft': passing } });
    assert.equal(out.run.checks[0]!.result, 'UNKNOWN');
    assert.match(out.run.checks[0]!.reason ?? '', /draft/);
  } finally {
    done();
  }
});

test('the aggregate is PASS only when every required check passed or is justified not applicable', () => {
  const o = (result: 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE', required = true, reason = 'r') => ({ check: 'c', required, result, reason });
  assert.equal(aggregate([o('PASS'), o('NOT_APPLICABLE')]), 'PASS');
  assert.equal(aggregate([o('PASS'), o('UNKNOWN')]), 'UNKNOWN');
  assert.equal(aggregate([o('UNKNOWN'), o('FAIL')]), 'FAIL');
  assert.equal(aggregate([o('PASS'), o('FAIL', false)]), 'PASS');
  assert.equal(aggregate([o('NOT_APPLICABLE', true, '')]), 'UNKNOWN');
  assert.equal(aggregate([o('PASS', false)]), 'UNKNOWN');
});

test('version policies compare numerically', () => {
  assert.ok(satisfies('5.8.0', { major: 5, minimum: '5.7.0' }));
  assert.ok(!satisfies('5.6.9', { major: 5, minimum: '5.7.0' }));
  assert.ok(!satisfies('6.2.0', { major: 5 }));
  assert.ok(satisfies('18.0.0.0', { minimum: '16.1' }));
  assert.ok(satisfies('1.33.0', { exact: '1.33' }));
  assert.ok(!satisfies('unknown', { minimum: '1.0' }));
});

test('evidence and run records are signed with the key the signer names, and a tampered record fails verification', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  process.env['LOOM_TEST_EVIDENCE_KEY'] = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const { set, done } = sampleArtifacts();
  try {
    const out = await runChecks({ root: LOOM_ROOT, model: sampleModel(), checks: [check('t.signed')], artifacts: set, runners: { 't.signed': passing }, signer: { keyEnv: 'LOOM_TEST_EVIDENCE_KEY', keyId: 'test-runner' } });
    const ev = out.evidence[0]!;
    assert.equal(ev.signature?.keyId, 'test-runner');
    assert.ok(verifyRecord(ev, spki));
    assert.ok(verifyRecord(out.run, spki));
    assert.ok(!verifyRecord({ ...ev, result: 'FAIL' } as typeof ev, spki));
    assert.ok(!JSON.stringify(ev).includes('PRIVATE KEY'));
  } finally {
    delete process.env['LOOM_TEST_EVIDENCE_KEY'];
    done();
  }
});

test('a storing run puts every signed record into the workspace evidence store, where the trusted policy verifies it', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  process.env['LOOM_TEST_STORE_KEY'] = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root).outcome, 'ok');
  commitAll(root, 'workspace');
  const { set, done } = sampleArtifacts();
  try {
    const checks = [check('t.stored.pass'), check('t.stored.fail')];
    const out = await runChecks({ root, model: sampleModel(), checks, artifacts: set, runners: { 't.stored.pass': passing, 't.stored.fail': async () => outcome('FAIL', 'failed on purpose') }, store: true, signer: { keyEnv: 'LOOM_TEST_STORE_KEY', keyId: 'ci' } });
    assert.deepEqual(out.findings, []);
    const stored = listEvidence(root).value ?? [];
    assert.deepEqual(stored.map((e) => e.id).sort(), out.evidence.map((e) => e.id).sort(), 'every record of the run is in the store');
    assert.deepEqual(stored.map((e) => e.result).sort(), ['FAIL', 'PASS'], 'a failing record is stored as faithfully as a passing one');
    const trusted = readTrustedEvidence(root, { ...selfPolicy(), trust: { ...selfPolicy().trust, evidenceKeys: [{ id: 'ci', spki, runner: 'ci' }] } });
    assert.ok(trusted.evidence.length === 2 && trusted.evidence.every((e) => e.trusted), 'the stored records verify under the policy key');
    assert.ok(readTrustedEvidence(root, selfPolicy()).evidence.every((e) => !e.trusted), 'a policy that does not list the key trusts none of them');

    const blocked = gitInit(scratch());
    assert.equal(initWorkspace(blocked).outcome, 'ok');
    writeFileSync(join(blocked, '.loom', 'evidence'), 'not a directory');
    const refused = await runChecks({ root: blocked, model: sampleModel(), checks: [check('t.stored.pass')], artifacts: set, runners: { 't.stored.pass': passing }, store: true });
    assert.equal(refused.evidence.length, 1, 'the run still returns its record');
    assert.ok(refused.findings.some((f) => f.code === 'EVIDENCE_STORE_UNAVAILABLE'), 'an unwritable store is reported, never silently skipped');
  } finally {
    delete process.env['LOOM_TEST_STORE_KEY'];
    done();
  }
});

test('a storing run writes its records only after its last check has finished', async () => {
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root).outcome, 'ok');
  commitAll(root, 'workspace');
  const seen: number[] = [];
  const observing: Runner = async () => {
    seen.push((listEvidence(root).value ?? []).length);
    return outcome('PASS', 'read the store');
  };
  const { set, done } = sampleArtifacts();
  try {
    const ids = ['t.observe.first', 't.observe.second', 't.observe.third'];
    const out = await runChecks({ root, model: sampleModel(), checks: ids.map((id) => check(id)), artifacts: set, runners: Object.fromEntries(ids.map((id) => [id, observing])), store: true });
    assert.deepEqual(seen, [0, 0, 0], 'no check reads a record of its own run');
    assert.deepEqual((listEvidence(root).value ?? []).map((e) => e.id).sort(), out.evidence.map((e) => e.id).sort());
  } finally {
    done();
  }
});

test('without a signing key the records are written unsigned', async () => {
  const out = await run([check('t.unsigned')], { 't.unsigned': passing });
  assert.equal(out.evidence[0]!.signature, undefined);
});

test('evidence from another run or another revision set is reported inconsistent', async () => {
  const out = await run([check('t.pin')], { 't.pin': passing });
  // The checkout under test may itself be uncommitted; a clean copy of its pins stands for an unchanged checkout.
  const pins = out.run.revisionSet.sources.map((s) => ({ ...s, dirty: false }));
  assert.deepEqual(verifyRunRevisionSet(out.run, out.evidence, pins), []);
  const foreign = { ...out.evidence[0]!, run: { ...out.evidence[0]!.run, id: 'run.other' } };
  assert.ok(verifyRunRevisionSet(out.run, [foreign], pins).some((f) => f.code === 'EVIDENCE_REVISION_SET_INCONSISTENT'));
  const moved = pins.map((s) => ({ ...s, revision: 'f'.repeat(40) }));
  if (pins.length) assert.ok(verifyRunRevisionSet(out.run, out.evidence, moved).some((f) => f.code === 'EVIDENCE_REVISION_SET_INCONSISTENT'));
  const otherSources = { ...out.evidence[0]!, sources: [{ repository: 'elsewhere', revision: 'a'.repeat(40) }] };
  assert.ok(verifyRunRevisionSet(out.run, [otherSources], pins).some((f) => f.code === 'EVIDENCE_REVISION_SET_INCONSISTENT'));
});

test('two parallel runs use separate directories and never remove each other\'s files', async () => {
  const seen: Record<string, string[]> = {};
  const marking: Runner = async (ctx) => {
    writeFileSync(join(ctx.dir, `${ctx.runId}.marker`), 'x');
    await new Promise((r) => setTimeout(r, 200));
    seen[ctx.runId] = readdirSync(ctx.dir);
    return outcome('PASS', 'marked');
  };
  const [a, b] = await Promise.all([run([check('t.mark')], { 't.mark': marking }), run([check('t.mark')], { 't.mark': marking })]);
  assert.notEqual(a.runDir, b.runDir);
  assert.notEqual(a.run.id, b.run.id);
  assert.deepEqual(seen[a.run.id], [`${a.run.id}.marker`]);
  assert.deepEqual(seen[b.run.id], [`${b.run.id}.marker`]);
  assert.ok(!existsSync(a.runDir) && !existsSync(b.runDir));
});

test('an oasdiff breaking item the model comparison does not report is unmatched', () => {
  const model: Model = clone(sampleModel());
  const items: OasdiffItem[] = [
    { id: 'response-property-removed', level: 3, operation: 'GET', path: '/orders/{id}' },
    { id: 'api-path-removed-without-deprecation', level: 3, operationId: 'shipment.status' },
    { id: 'response-optional-property-added', level: 1, operationId: 'order.get' },
  ];
  const changes: Change[] = [
    { path: 'types/order-response/properties/note', kind: 'breaking', dimension: 'shape-consumer', rule: 'PROPERTY_REMOVED', reason: 'r', element: 'order-response', elementKind: 'type', consumers: [{ ref: { kind: 'operation', id: 'order.get' }, reason: 'depends-on', path: ['order-response', 'order.get'] }] },
  ];
  const unmatched = unmatchedBreaks(items, changes, model, model);
  assert.deepEqual(unmatched.map((i) => i.id), ['api-path-removed-without-deprecation']);
  assert.deepEqual(unmatchedBreaks(items.slice(0, 1), changes, model, model), []);
});

/** sqlcmd 15 with ODBC Driver 17, run against a LocalDB instance that does not exist. */
const UNREACHABLE = [
  'Sqlcmd: Error: Microsoft ODBC Driver 17 for SQL Server : SQL Server Network Interfaces: .',
  'Sqlcmd: Error: Microsoft ODBC Driver 17 for SQL Server : Login timeout expired.',
  'Sqlcmd: Error: Microsoft ODBC Driver 17 for SQL Server : A network-related or instance-specific error has occurred while establishing a connection to SQL Server. Server is not found or not accessible.',
].join('\r\n');

test('sqlcmd output reporting an unreachable server, a refused login or an expired timeout is a connection failure with its reason', () => {
  assert.match(connectionFailure(UNREACHABLE) ?? '', /Login timeout expired\..*Server is not found or not accessible/);
  assert.equal(connectionFailure("Msg 18456, Level 14, State 1, Server (localdb)\\loom-x, Line 1\r\nLogin failed for user 'loom'.\r\n"), "Msg 18456: Login failed for user 'loom'.");
  assert.match(connectionFailure('Sqlcmd: Error: Microsoft ODBC Driver 17 for SQL Server : Cannot open database "loom_catalog_1a2b3c4d" requested by the login. The login failed..') ?? '', /requested by the login/);
  assert.match(connectionFailure('Sqlcmd: Error: Microsoft ODBC Driver 17 for SQL Server : Query timeout expired.') ?? '', /Query timeout expired/);
  assert.match(connectionFailure('Sqlcmd: Error: Microsoft ODBC Driver 17 for SQL Server : Communication link failure.') ?? '', /Communication link failure/);
});

test('sqlcmd output of statements the server ran and rejected is not a connection failure', () => {
  for (const output of [
    'Msg 50005, Level 16, State 1, Server (localdb)\\loom-x, Procedure sp_place_order, Line 9\r\nThe order total must be positive.\r\n',
    "Msg 102, Level 15, State 1, Server (localdb)\\loom-x, Line 3\r\nIncorrect syntax near 'TABL'.\r\n",
    'Msg 547, Level 16, State 0, Server (localdb)\\loom-x, Line 1\r\nThe INSERT statement conflicted with the CHECK constraint "LOOM_QUALIFY_INJECTED_FAILURE".\r\n',
    "Sqlcmd: Error: Syntax error at line 4 near command ':setvar' in file 'batch.sql'.",
    '',
  ]) {
    assert.equal(connectionFailure(output), null, output);
  }
});

test('only the idempotent CREATE SCHEMA guard is rewritten for the database project', () => {
  const ddl = "IF SCHEMA_ID(N'ordering') IS NULL EXEC(N'CREATE SCHEMA [ordering]');\nGO\nIF OBJECT_ID(N'x') IS NULL EXEC(N'DROP TABLE x');\n";
  const out = declarativeDdl(ddl);
  assert.match(out, /^CREATE SCHEMA \[ordering\];$/m);
  assert.match(out, /IF OBJECT_ID\(N'x'\) IS NULL EXEC\(N'DROP TABLE x'\);/);
});
