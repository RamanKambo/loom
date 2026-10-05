import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../exec.js';
import { acquireLease, assertLifecycleResult, ownedPath, processIdentity, sameProcess, Lifecycle, claimCleanup, recoverRun } from '../lifecycle.js';
import { acquireDeveloperService, type ServiceController, type ServiceSnapshot } from '../provider.js';
import { runChecks } from '../run.js';
import { sampleModel, type CheckDefinition } from '@loom/core';

const temp = () => mkdtempSync(join(tmpdir(), 'loom-lifecycle-test-'));
test('cancellation awaits a stopped native process and never launches a pre-cancelled process', async () => {
  const controller = new AbortController();
  const running = exec(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 10000, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const result = await running; assert.equal(result.ok, false); if (!result.ok) assert.equal(result.kind, 'cancelled');
  const never = await exec('unprovisioned-do-not-launch', [], { timeoutMs: 10, signal: controller.signal }); assert.equal(never.ok, false); if (!never.ok) assert.equal(never.kind, 'cancelled');
});
test('user lease serializes contenders and cancelled waiters leave the holder intact', async () => {
  const root = temp(); try {
    const release = await acquireLease(root, 'run.first'); const controller = new AbortController();
    const waiting = acquireLease(root, 'run.second', controller.signal); setTimeout(() => controller.abort(), 30);
    await assert.rejects(waiting, /cancel/); assert.equal(JSON.parse(readFileSync(join(root, 'user.lease', 'holder.json'), 'utf8')).runId, 'run.first'); release();
    const next = await acquireLease(root, 'run.third'); next();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('process creation identity prevents PID reuse from proving owner liveness', () => { const current = processIdentity(); assert.ok(current); assert.equal(sameProcess(current), true); assert.equal(sameProcess({ ...current, createdAt: '2000-01-01T00:00:00.000Z' }), false); });
test('canonical containment rejects sibling roots and escaping junctions', () => {
  const root = temp(); const outside = temp(); try { mkdirSync(join(root, 'own')); assert.equal(ownedPath(root, join(root, 'own')), join(root, 'own')); assert.throws(() => ownedPath(root, outside), /outside/); symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => ownedPath(root, join(root, 'escape', 'file')), /outside/); } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
test('cleanup requires one claim and recovery refuses a live owner', async () => {
  const root = temp(); try { const lifecycle = new Lifecycle(root, 'run.claim', { kind: 'localdb', id: 'localdb' }); const release = claimCleanup(lifecycle.file, 'coordinator'); assert.ok(release); assert.equal(claimCleanup(lifecycle.file, 'guardian'), null); await assert.rejects(recoverRun(lifecycle.file, 'SqlLocalDB'), /live owner/); release(); assert.ok(claimCleanup(lifecycle.file, 'recovery')); } finally { rmSync(root, { recursive: true, force: true }); }
});
test('success requires PASS and clean cleanup; residual requires recovery', () => {
  const cleanup = { state: 'clean' as const, outcomes: [], actions: [], residual: [] }; assert.doesNotThrow(() => assertLifecycleResult('PASS', cleanup, 'succeeded')); assert.throws(() => assertLifecycleResult('FAIL', cleanup, 'succeeded')); assert.throws(() => assertLifecycleResult('PASS', { ...cleanup, state: 'failed' }, 'succeeded')); assert.throws(() => assertLifecycleResult('FAIL', { ...cleanup, residual: [{ kind: 'instance', identity: 'loom-residual' }] }, 'unsuccessful')); assert.doesNotThrow(() => assertLifecycleResult('FAIL', { ...cleanup, residual: [{ kind: 'instance', identity: 'loom-residual' }], recovery: { journal: 'run.residual', action: 'recover journal' } }, 'unsuccessful'));
});
const entry = { id: 'developer', kind: 'developer-service' as const, serviceName: 'MSSQL$LOOM_TEST', instanceName: 'LOOM_TEST', startupChangeAuthorized: false };
for (const [name, override] of Object.entries({ wrong: { name: 'MSSQL$UNRELATED' }, permission: { canControl: false }, running: { state: 'Running' }, disabled: { startup: 'Disabled' }, edition: { edition: 'Enterprise' } })) {
  test(`Developer service refusal (${name}) performs no mutation`, async () => {
    const changes: string[] = []; const initial = { name: entry.serviceName, state: 'Stopped', startup: 'Manual', edition: 'Developer Edition', canControl: true, ...override } as ServiceSnapshot;
    const controller: ServiceController = { inspect: async () => initial, startup: async () => { changes.push('startup'); }, start: async () => { changes.push('start'); }, stop: async () => { changes.push('stop'); } };
    assert.equal((await acquireDeveloperService(entry, controller)).ok, false); assert.deepEqual(changes, []);
  });
}
test('preauthorized Disabled dedicated service restores its original startup state', async () => {
  const snapshot: ServiceSnapshot = { name: entry.serviceName, state: 'Stopped', startup: 'Disabled', edition: 'Developer Edition', canControl: true }; const changes: string[] = [];
  const controller: ServiceController = { inspect: async () => ({ ...snapshot }), startup: async (_name, mode) => { changes.push(mode); snapshot.startup = mode; }, start: async () => { changes.push('start'); snapshot.state = 'Running'; }, stop: async () => { changes.push('stop'); snapshot.state = 'Stopped'; } };
  const acquired = await acquireDeveloperService({ ...entry, startupChangeAuthorized: true }, controller); assert.ok(acquired.ok); await acquired.restore(); assert.deepEqual(changes, ['Manual', 'start', 'stop', 'Disabled']);
});
test('aborted check settles before evidence capture and clean cleanup', async () => {
  const root = temp(); try {
    const check: CheckDefinition = { id: 'lifecycle.abort', revision: 1, layer: 'unit', evidence: 'unit', claim: 'abort awaited', tool: { name: 'node', versionPolicy: { minimum: '1.0' } }, runner: 'test-abort', inputs: [], environment: 'process', requiredByDefault: true, limits: 'No native SQL evidence.' };
    let settled = false;
    const result = await runChecks({ root, lifecycleRoot: root, model: sampleModel(), checks: [check], artifacts: { dir: root, files: [], draft: false }, timeoutMs: 30, runners: { 'test-abort': async (ctx) => { const r = await exec(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 10000, signal: ctx.signal }); settled = true; return { result: r.ok ? 'PASS' : 'UNKNOWN', reason: 'native child settled' }; } } });
    assert.equal(settled, true); assert.equal(result.run.checks[0]!.cause, 'timeout'); assert.equal(result.run.cleanup?.state, 'clean'); assert.equal(result.run.outcome, 'unsuccessful'); assert.ok(JSON.parse(readFileSync(join(root, 'evidence', `${result.run.runId}.json`), 'utf8')).checks.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
