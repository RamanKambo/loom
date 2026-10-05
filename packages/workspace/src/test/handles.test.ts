import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import type { LoomConfig, WorkspaceCloseData, WorkspaceInitializeData, WorkspaceInspectData, WorkspaceSummary } from '@loom/core';
import { HandleRegistry } from '../handles.js';
import { initWorkspace, scaffoldConfig, scaffoldModel, scaffoldState, type InitOptions } from '../init.js';
import { gitDirOf } from '../repo.js';
import { codes, commitAll, fileHash, foldModelId, gitInit, scratch, writeJson } from '../testing/helpers.js';

/** Every fixture declares a real modelId, folded from its own directory name, and modelKind 'implementation'; init invents no default. */
const implOf = (dir: string): InitOptions => ({ modelId: foldModelId(basename(dir)), modelKind: 'implementation' });

/** Write a descriptor by hand, so a child claims a path without going through init's own overlap check. */
function manualDescriptor(home: string, config: LoomConfig): void {
  writeJson(join(home, '.loom', 'loom.json'), config);
  writeJson(join(home, '.loom', 'model.json'), scaffoldModel());
  writeJson(join(home, '.loom', 'state.json'), scaffoldState());
}

test('a handle opened by one session is refused unknown-handle in another, and two handles on the same model share the revision protocol', () => {
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root, implOf(root)).outcome, 'ok');
  const sessionA = new HandleRegistry({ allowedRoots: [root] });
  const sessionB = new HandleRegistry({ allowedRoots: [root] });

  const openedA = sessionA.open(root, 'read');
  assert.equal(openedA.outcome, 'ok', JSON.stringify(openedA.findings));
  const dataA = openedA.data as WorkspaceSummary;
  const workspaceId = dataA.workspace.workspaceId;

  // Another session's handle is refused exactly like a missing one.
  const statusInB = sessionB.status(workspaceId);
  assert.equal(statusInB.outcome, 'refused');
  assert.equal(statusInB.refusal?.cause, 'unknown-handle');
  const statusMissing = sessionB.status('ws_0000000000000000000000');
  assert.equal(statusMissing.outcome, 'refused');
  assert.equal(statusMissing.refusal?.cause, 'unknown-handle');
  const closeInB = sessionB.close(workspaceId);
  assert.equal(closeInB.outcome, 'refused');
  assert.equal(closeInB.refusal?.cause, 'unknown-handle');

  // Within its own session the handle resolves and its status reads back the same revision protocol.
  const statusInA = sessionA.status(workspaceId);
  assert.equal(statusInA.outcome, 'ok', JSON.stringify(statusInA.findings));

  // Two handles opened on the same model share the revision protocol.
  const openedB = sessionB.open(root, 'read');
  assert.equal(openedB.outcome, 'ok', JSON.stringify(openedB.findings));
  const dataB = openedB.data as WorkspaceSummary;
  assert.notEqual(dataB.workspace.workspaceId, workspaceId);
  assert.deepEqual(dataB.workspace.revisions, dataA.workspace.revisions);
  assert.equal(dataB.revisionVector, dataA.revisionVector);
});

test('a path outside the allowed roots is refused access-denied on open, and a client root can only narrow', () => {
  const outer = scratch();
  mkdirSync(join(outer, 'child'), { recursive: true });
  const elsewhere = scratch();
  const registry = new HandleRegistry({ allowedRoots: [outer] });

  const refused = registry.open(elsewhere, 'read');
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.refusal?.cause, 'access-denied');
  assert.ok(codes(refused.findings).includes('ROOT_INACCESSIBLE'), JSON.stringify(refused.findings));

  // Narrowing to a true subdirectory shrinks the allowed set: the former root itself now falls outside it.
  registry.narrow([join(outer, 'child')]);
  const narrowedOut = registry.open(outer, 'read');
  assert.equal(narrowedOut.outcome, 'refused');
  assert.equal(narrowedOut.refusal?.cause, 'access-denied');

  // A client root outside every configured root cannot widen access to it.
  registry.narrow([elsewhere]);
  const stillRefused = registry.open(elsewhere, 'read');
  assert.equal(stillRefused.outcome, 'refused');
  assert.equal(stillRefused.refusal?.cause, 'access-denied');
});

test('inspect over a planted unrelated tree reads none of it, through an injectable reader that counts directory reads', () => {
  const root = gitInit(scratch());
  const target = join(root, 'services', 'payments');
  const nodeModules = join(target, 'node_modules');
  const unrelatedSrc = join(target, 'src');
  mkdirSync(nodeModules, { recursive: true });
  mkdirSync(unrelatedSrc, { recursive: true });
  for (let i = 0; i < 1200; i++) writeFileSync(join(nodeModules, `pkg-${i}.js`), '');
  for (let i = 0; i < 900; i++) writeFileSync(join(unrelatedSrc, `file-${i}.ts`), '');

  const calls: string[] = [];
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const env = registry.inspect(target, {
    readdir: (dir) => {
      calls.push(dir);
      return readdirSync(dir);
    },
  });
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  const data = env.data as WorkspaceInspectData;
  assert.equal(data.ownership.status, 'ungoverned');
  assert.deepEqual(calls, [target], 'the only directory read is the inspected path itself');
  assert.equal(calls.includes(nodeModules), false, 'inspect never reads the unrelated node_modules tree');
  assert.equal(calls.includes(unrelatedSrc), false, 'inspect never reads the unrelated src tree');
});

test('inspect reports a missing checkout as a typed unresolved result', () => {
  const root = gitInit(scratch());
  writeFileSync(join(root, '.gitmodules'), '[submodule "missing"]\n\tpath = libs/missing\n\turl = ../missing.git\n');
  assert.equal(initWorkspace(root, implOf(root)).outcome, 'ok');
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const env = registry.inspect(join(root, 'libs', 'missing', 'x.sql'));
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  const data = env.data as WorkspaceInspectData;
  assert.equal(data.ownership.status, 'unresolved');
  assert.ok(codes(env.findings).includes('CHECKOUT_MISSING'), JSON.stringify(env.findings));
});

test('inspect refuses invalid-input for a path that does not exist and claims no owner', () => {
  const root = gitInit(scratch());
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const env = registry.inspect(join(root, 'nowhere', 'nothing.txt'));
  assert.equal(env.outcome, 'refused');
  assert.equal(env.refusal?.cause, 'invalid-input');
});

test('inspect reports an unreadable descriptor as a typed unresolved result', () => {
  const parent = gitInit(scratch());
  assert.equal(initWorkspace(parent, implOf(parent)).outcome, 'ok');
  const child = gitInit(join(parent, 'child'));
  mkdirSync(join(child, '.loom'));
  writeFileSync(join(child, '.loom', 'loom.json'), '{');
  const registry = new HandleRegistry({ allowedRoots: [parent] });
  const env = registry.inspect(join(child, 'x.txt'));
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  const data = env.data as WorkspaceInspectData;
  assert.equal(data.ownership.status, 'unresolved');
  assert.ok(codes(env.findings).includes('DESCRIPTOR_UNREADABLE'), JSON.stringify(env.findings));
});

test('inspect reports an inaccessible root as a typed unresolved result, without refusing', () => {
  const allowed = scratch();
  const outside = scratch();
  const registry = new HandleRegistry({ allowedRoots: [allowed] });
  const env = registry.inspect(outside);
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  const data = env.data as WorkspaceInspectData;
  assert.equal(data.ownership.status, 'unresolved');
  assert.ok(codes(env.findings).includes('ROOT_INACCESSIBLE'), JSON.stringify(env.findings));
});

test('inspect reports an ownership conflict as a typed unresolved result', () => {
  const parent = gitInit(scratch());
  assert.equal(initWorkspace(parent, implOf(parent)).outcome, 'ok');
  const child = gitInit(join(parent, 'child'));
  manualDescriptor(child, scaffoldConfig(foldModelId('child'), 'implementation'));
  const registry = new HandleRegistry({ allowedRoots: [parent] });
  const env = registry.inspect(join(child, 'file.txt'));
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  const data = env.data as WorkspaceInspectData;
  assert.equal(data.ownership.status, 'overlap');
  assert.ok(codes(env.findings).includes('SCOPE_OVERLAP'), JSON.stringify(env.findings));
});

test('inspect reports the enclosing composition that lists the repository, its existing models and a declared submodule without a checkout', () => {
  const parent = gitInit(scratch());
  const parentModelId = foldModelId(basename(parent));
  const childModelId = foldModelId('child');
  const child = gitInit(join(parent, 'child'));
  assert.equal(initWorkspace(child, { modelId: childModelId, modelKind: 'implementation' }).outcome, 'ok');
  writeFileSync(join(child, '.gitmodules'), '[submodule "missing"]\n\tpath = libs/missing\n\turl = ../missing.git\n');
  const parentConfig: LoomConfig = {
    configVersion: 1,
    modelId: parentModelId,
    modelKind: 'composition',
    model: 'model.json',
    projectionProfile: 'none',
    scope: {},
    outputs: {},
    gates: {},
    composition: { members: [{ memberId: 'child', modelId: childModelId, repositoryPath: 'child', relationship: 'implementation', exports: [] }], delegatedRoots: [{ memberId: 'child', roots: ['child'] }], outputClaims: [] },
  };
  manualDescriptor(parent, parentConfig);
  const registry = new HandleRegistry({ allowedRoots: [parent] });
  const env = registry.inspect(child);
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  const data = env.data as WorkspaceInspectData;
  assert.deepEqual(data.composition, { descriptor: '.loom', modelId: parentModelId, listed: true });
  assert.ok(data.models.some((m) => m.descriptor === '.loom' && m.readable && m.modelId === childModelId && m.modelKind === 'implementation'), JSON.stringify(data.models));
  assert.deepEqual(data.submodules, [{ path: 'libs/missing', checkedOut: false, hasDescriptor: false }]);
  assert.ok(codes(env.findings).includes('CHECKOUT_MISSING'), JSON.stringify(env.findings));
});

test('open sets WorkspaceHandle.parent from the enclosing composition that lists the workspace', () => {
  const parent = gitInit(scratch());
  const parentModelId = foldModelId(basename(parent));
  const childModelId = foldModelId('member');
  const child = gitInit(join(parent, 'member'));
  assert.equal(initWorkspace(child, { modelId: childModelId, modelKind: 'implementation' }).outcome, 'ok');
  const parentConfig: LoomConfig = {
    configVersion: 1,
    modelId: parentModelId,
    modelKind: 'composition',
    model: 'model.json',
    projectionProfile: 'none',
    scope: {},
    outputs: {},
    gates: {},
    composition: { members: [{ memberId: 'member-1', modelId: childModelId, repositoryPath: 'member', relationship: 'implementation', exports: [] }], delegatedRoots: [{ memberId: 'member-1', roots: ['member'] }], outputClaims: [] },
  };
  manualDescriptor(parent, parentConfig);
  const registry = new HandleRegistry({ allowedRoots: [parent] });
  const opened = registry.open(child, 'read');
  assert.equal(opened.outcome, 'ok', JSON.stringify(opened.findings));
  const workspace = (opened.data as WorkspaceSummary).workspace;
  assert.deepEqual(workspace.parent, { modelId: parentModelId, memberId: 'member-1' });
});

test('inspect reports one tracked and one untracked path under the inspected path', () => {
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root, implOf(root)).outcome, 'ok');
  writeFileSync(join(root, 'tracked.txt'), 'a');
  commitAll(root, 'add tracked');
  writeFileSync(join(root, 'untracked.txt'), 'b');
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const env = registry.inspect(root);
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  const data = env.data as WorkspaceInspectData;
  assert.ok(data.affectedPaths.tracked.includes('tracked.txt'), JSON.stringify(data.affectedPaths));
  assert.ok(data.affectedPaths.untracked.includes('untracked.txt'), JSON.stringify(data.affectedPaths));
});

test('affectedPaths truncates a list longer than the discovery item limit, with the omission in the envelope completeness', () => {
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root, implOf(root)).outcome, 'ok');
  for (let i = 0; i < 40; i++) writeFileSync(join(root, `untracked-${String(i).padStart(2, '0')}.txt`), 'x');
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const env = registry.inspect(root);
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  const data = env.data as WorkspaceInspectData;
  assert.equal(data.affectedPaths.untracked.length, 32, JSON.stringify(data.affectedPaths.untracked));
  assert.equal(env.completeness.truncated, true);
  assert.ok(env.completeness.omitted.some((o) => o.section === 'affectedPaths/untracked' && o.reason === 'budget'), JSON.stringify(env.completeness));
});

test('close reports a registered step that leaves a resource as cleanup-incomplete, naming it with its recovery, and keeps the handle open', () => {
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root, implOf(root)).outcome, 'ok');
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const opened = registry.open(root, 'read');
  assert.equal(opened.outcome, 'ok', JSON.stringify(opened.findings));
  const workspaceId = (opened.data as WorkspaceSummary).workspace.workspaceId;
  registry.registerCloseStep(workspaceId, {
    step: 'detach-watchers',
    run: () => ({ outcome: 'failed', residual: { kind: 'watcher', identity: 'watcher-1', recovery: 'stop the watcher process, then close again' } }),
  });
  const closed = registry.close(workspaceId);
  assert.equal(closed.outcome, 'refused');
  assert.equal(closed.refusal?.cause, 'cleanup-incomplete');
  const data = closed.data as WorkspaceCloseData;
  assert.equal(data.released, false);
  assert.equal(data.cleanup.complete, false);
  assert.deepEqual(data.cleanup.residual, [{ kind: 'watcher', identity: 'watcher-1', recovery: 'stop the watcher process, then close again' }]);
  // The handle is not released: it still resolves within this session.
  assert.equal(registry.status(workspaceId).outcome, 'ok');
});

test('close reports every step and releases the handle once nothing is residual', () => {
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root, implOf(root)).outcome, 'ok');
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const opened = registry.open(root, 'read');
  const workspaceId = (opened.data as WorkspaceSummary).workspace.workspaceId;
  const closed = registry.close(workspaceId);
  assert.equal(closed.outcome, 'ok', JSON.stringify(closed.findings));
  const data = closed.data as WorkspaceCloseData;
  assert.equal(data.released, true);
  assert.equal(data.cleanup.complete, true);
  assert.deepEqual(data.cleanup.residual, []);
  assert.ok(data.cleanup.steps.some((s) => s.step === 'release-handle' && s.outcome === 'done'));
  assert.equal(registry.status(workspaceId).refusal?.cause, 'unknown-handle');
});

test('resumeInputs reports every field of the recorded progress, unaffected by a touched timestamp or an unrelated commit', () => {
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root, implOf(root)).outcome, 'ok');
  commitAll(root, 'init');
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const opened = registry.open(root, 'read');
  assert.equal(opened.outcome, 'ok', JSON.stringify(opened.findings));
  const workspaceId = (opened.data as WorkspaceSummary).workspace.workspaceId;

  assert.equal(registry.resumeInputs('ws_0000000000000000000000'), null);

  const inputs = registry.resumeInputs(workspaceId);
  assert.ok(inputs);
  assert.deepEqual(inputs.address, { workspace: true });
  assert.equal(inputs.workspaceId, workspaceId);
  assert.equal(inputs.outcome, null);
  assert.equal(inputs.phase, 'unplanned');
  assert.deepEqual(inputs.owningScopes, [{ modelId: foldModelId(basename(root)), component: 'workspace', roots: ['.'] }]);
  assert.equal(inputs.baseline, null);
  assert.deepEqual(inputs.openUnknowns, []);
  assert.deepEqual(inputs.pendingWork, []);
  assert.deepEqual(inputs.pendingRuns, []);
  assert.ok(Array.isArray(inputs.evidence));

  const before = registry.resumeInputs(workspaceId);
  const touched = new Date(Date.now() + 60_000);
  utimesSync(join(root, '.loom', 'loom.json'), touched, touched);
  writeFileSync(join(root, 'unrelated.txt'), 'x');
  commitAll(root, 'an unrelated commit');
  const after = registry.resumeInputs(workspaceId);
  assert.deepEqual(after, before);
});

test('initialize: a dry run proposes every write, including the journal, and writes nothing', async () => {
  const root = gitInit(scratch());
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const declaration = scaffoldConfig(foldModelId(basename(root)), 'implementation');
  const env = await registry.initialize(root, declaration, { dryRun: true });
  assert.equal(env.outcome, 'ok', JSON.stringify(env.findings));
  const data = env.data as WorkspaceInitializeData;
  assert.equal(data.outcome, 'proposed');
  assert.deepEqual(data.writes.map((w) => w.role).sort(), ['config', 'gitignore', 'journal', 'model', 'state']);
  assert.equal(existsSync(join(root, '.loom')), false);
});

test('initialize: apply with a different declaration than the dry run is refused invalid-input, writing nothing', async () => {
  const root = gitInit(scratch());
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const modelId = foldModelId(basename(root));
  const dry = await registry.initialize(root, scaffoldConfig(modelId, 'implementation'), { dryRun: true });
  assert.equal(dry.outcome, 'ok', JSON.stringify(dry.findings));
  const digest = (dry.data as WorkspaceInitializeData).inspectionDigest;
  const applied = await registry.initialize(root, scaffoldConfig(modelId, 'composition'), { dryRun: false, expectedInspection: digest });
  assert.equal(applied.outcome, 'refused');
  assert.equal(applied.refusal?.cause, 'invalid-input');
  assert.equal(existsSync(join(root, '.loom')), false);
});

test('initialize: apply is refused stale-base when the inspection changed since the dry run, writing nothing', async () => {
  const root = gitInit(scratch());
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const declaration = scaffoldConfig(foldModelId(basename(root)), 'implementation');
  const dry = await registry.initialize(root, declaration, { dryRun: true });
  const digest = (dry.data as WorkspaceInitializeData).inspectionDigest;
  writeFileSync(join(root, 'tracked.txt'), 'x');
  commitAll(root, 'advance HEAD between the dry run and the apply');
  const applied = await registry.initialize(root, declaration, { dryRun: false, expectedInspection: digest });
  assert.equal(applied.outcome, 'refused');
  assert.equal(applied.refusal?.cause, 'stale-base');
  assert.equal(existsSync(join(root, '.loom')), false);
});

test('initialize: dirty files outside the write set do not block it', async () => {
  const root = gitInit(scratch());
  writeFileSync(join(root, 'README.md'), 'draft');
  commitAll(root, 'seed');
  writeFileSync(join(root, 'README.md'), 'draft, edited uncommitted');
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const declaration = scaffoldConfig(foldModelId(basename(root)), 'implementation');
  const dry = await registry.initialize(root, declaration, { dryRun: true });
  assert.equal(dry.outcome, 'ok', JSON.stringify(dry.findings));
  const digest = (dry.data as WorkspaceInitializeData).inspectionDigest;
  const applied = await registry.initialize(root, declaration, { dryRun: false, expectedInspection: digest });
  assert.equal(applied.outcome, 'ok', JSON.stringify(applied.findings));
  assert.equal((applied.data as WorkspaceInitializeData).outcome, 'created');
  assert.equal(existsSync(join(root, '.loom', 'loom.json')), true);
});

test('initialize: a conflicting path another descriptor claims is refused policy-failure, writing nothing', async () => {
  const parent = gitInit(scratch());
  assert.equal(initWorkspace(parent, implOf(parent)).outcome, 'ok');
  const child = gitInit(join(parent, 'conflict-child'));
  const registry = new HandleRegistry({ allowedRoots: [parent] });
  const declaration = scaffoldConfig(foldModelId('conflict-child'), 'implementation');
  const env = await registry.initialize(child, declaration, { dryRun: true });
  assert.equal(env.outcome, 'refused');
  assert.equal(env.refusal?.cause, 'policy-failure');
  assert.equal(existsSync(join(child, '.loom')), false);
});

test('initialize: a composition declaration with empty member export pins initializes', async () => {
  const root = gitInit(scratch());
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const declaration: LoomConfig = {
    configVersion: 1,
    modelId: foldModelId(basename(root)),
    modelKind: 'composition',
    model: 'model.json',
    projectionProfile: 'none',
    scope: {},
    outputs: {},
    gates: {},
    composition: { members: [{ memberId: 'child', modelId: foldModelId('child'), repositoryPath: 'child', relationship: 'implementation', exports: [] }], delegatedRoots: [{ memberId: 'child', roots: ['child'] }], outputClaims: [] },
  };
  const dry = await registry.initialize(root, declaration, { dryRun: true });
  assert.equal(dry.outcome, 'ok', JSON.stringify(dry.findings));
  const digest = (dry.data as WorkspaceInitializeData).inspectionDigest;
  const applied = await registry.initialize(root, declaration, { dryRun: false, expectedInspection: digest });
  assert.equal(applied.outcome, 'ok', JSON.stringify(applied.findings));
  assert.equal((applied.data as WorkspaceInitializeData).outcome, 'created');
});

test('initialize: a stale staging directory whose content still matches its journal is removed, then apply proceeds', async () => {
  const root = gitInit(scratch());
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const declaration = scaffoldConfig(foldModelId(basename(root)), 'implementation');

  const cleanStaging = mkdtempSync(join(root, '.loom-staging-'));
  writeFileSync(join(cleanStaging, 'model.json'), 'placeholder');
  mkdirSync(join(cleanStaging, 'cache'), { recursive: true });
  writeJson(join(cleanStaging, 'cache', 'init-journal.json'), {
    journalVersion: 1,
    bundle: `sha256:${'a'.repeat(64)}`,
    state: 'staged',
    entries: [{ path: '.loom/model.json', hash: fileHash(join(cleanStaging, 'model.json')), previousHash: null, status: 'pending' }],
  });

  const inspected = registry.inspect(root);
  const digest = (inspected.data as WorkspaceInspectData).inspectionDigest;
  const applied = await registry.initialize(root, declaration, { dryRun: false, expectedInspection: digest });
  assert.equal(applied.outcome, 'ok', JSON.stringify(applied.findings));
  assert.equal(existsSync(cleanStaging), false, 'the verified stale staging directory is removed');
  assert.equal(existsSync(join(root, '.loom', 'loom.json')), true);
});

test('initialize: a stale staging directory whose content no longer matches its journal is left in place and refused', async () => {
  const root = gitInit(scratch());
  const registry = new HandleRegistry({ allowedRoots: [root] });
  const declaration = scaffoldConfig(foldModelId(basename(root)), 'implementation');

  const dirtyStaging = mkdtempSync(join(root, '.loom-staging-'));
  writeFileSync(join(dirtyStaging, 'model.json'), 'placeholder');
  mkdirSync(join(dirtyStaging, 'cache'), { recursive: true });
  writeJson(join(dirtyStaging, 'cache', 'init-journal.json'), {
    journalVersion: 1,
    bundle: `sha256:${'a'.repeat(64)}`,
    state: 'staged',
    entries: [{ path: '.loom/model.json', hash: `sha256:${'b'.repeat(64)}`, previousHash: null, status: 'pending' }],
  });

  const inspected = registry.inspect(root);
  const digest = (inspected.data as WorkspaceInspectData).inspectionDigest;
  const applied = await registry.initialize(root, declaration, { dryRun: false, expectedInspection: digest });
  assert.equal(applied.outcome, 'refused');
  assert.equal(applied.refusal?.cause, 'unresolved-context');
  assert.ok(codes(applied.findings).includes('INIT_REPAIR_REQUIRED'), JSON.stringify(applied.findings));
  assert.equal(existsSync(dirtyStaging), true, 'the unverifiable staging directory is left in place');
  assert.equal(existsSync(join(root, '.loom')), false);
});

test('the initialization lock resolves a gitdir: file, as a worktree or submodule checkout has, to its real Git directory', async () => {
  const root = gitInit(scratch());
  const realGit = join(dirname(root), `${basename(root)}-git`);
  renameSync(join(root, '.git'), realGit);
  writeFileSync(join(root, '.git'), `gitdir: ${realGit}\n`);
  assert.equal(gitDirOf(root), realGit);

  const registry = new HandleRegistry({ allowedRoots: [root] });
  const declaration = scaffoldConfig(foldModelId(basename(root)), 'implementation');
  const dry = await registry.initialize(root, declaration, { dryRun: true });
  assert.equal(dry.outcome, 'ok', JSON.stringify(dry.findings));
  const digest = (dry.data as WorkspaceInitializeData).inspectionDigest;
  const applied = await registry.initialize(root, declaration, { dryRun: false, expectedInspection: digest });
  assert.equal(applied.outcome, 'ok', JSON.stringify(applied.findings));
  assert.equal(existsSync(join(root, '.loom', 'loom.json')), true);
  assert.equal(existsSync(join(realGit, 'loom-init.lock')), false, 'the lock is released once the write completes');
});
