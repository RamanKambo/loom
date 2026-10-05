import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schemaErrors, type BrowserSession, type WorkspaceSummary } from '@loom/core';
import { initWorkspace } from '@loom/workspace';
import { gitInit, scratch } from '@loom/workspace/testing';
import { createLoomServer } from '../server.js';

test('production browser host binds independent sessions to handles and refuses reused links and cross-origin actions', async () => {
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root, { modelId: 'browser-test', modelKind: 'implementation' }).outcome, 'ok');
  const loom = createLoomServer({ workspace: root });
  await loom.browser.start();
  try {
    const opened = loom.context.handles!.open(root, 'edit', { view: true });
    const summary = opened.data as WorkspaceSummary;
    const url = new URL(summary.workspace.viewUrl!);
    const capability = new URLSearchParams(url.hash.slice(1)).get('capability');
    const headers = { Origin: url.origin, 'Content-Type': 'application/json' };
    const bootstrap = () => fetch(`${url.origin}/api/session`, { method: 'POST', headers, body: JSON.stringify({ capability }) });
    const response = await bootstrap();
    assert.equal(response.status, 200);
    const session = await response.json() as BrowserSession;
    assert.deepEqual(schemaErrors('BrowserSession', session), []);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    assert.ok(response.headers.get('set-cookie')!.includes('HttpOnly'));
    assert.equal((await bootstrap()).status, 401);
    const auth = { ...headers, Cookie: cookie, 'X-Loom-Session': session.sessionId };
    const path = `${url.origin}/api/workspaces/${summary.workspace.workspaceId}`;
    const snapshot = await fetch(`${path}/model`, { headers: auth });
    assert.equal(snapshot.status, 200);
    assert.deepEqual(schemaErrors('WorkspaceSnapshot', await snapshot.json()), []);
    assert.equal((await fetch(path, { headers: { ...auth, Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await fetch(`${url.origin}/api/workspaces/ws_unknown/model`, { headers: auth })).status, 404);
    const secondURL = new URL(loom.browser.viewUrl(summary.workspace.workspaceId)!);
    const second = await fetch(`${url.origin}/api/session`, { method: 'POST', headers, body: JSON.stringify({ capability: new URLSearchParams(secondURL.hash.slice(1)).get('capability') }) });
    assert.equal(second.status, 200);
    const secondSession = await second.json() as BrowserSession;
    assert.notEqual(secondSession.sessionId, session.sessionId);
    assert.equal((await fetch(`${url.origin}/api/session`, { method: 'DELETE', headers: auth })).status, 204);
    assert.equal((await fetch(`${path}/model`, { headers: auth })).status, 401);
    const secondAuth = { ...headers, Cookie: second.headers.get('set-cookie')!.split(';')[0]!, 'X-Loom-Session': secondSession.sessionId };
    assert.equal((await fetch(`${path}/model`, { headers: secondAuth })).status, 200);
    loom.context.handles!.close(summary.workspace.workspaceId);
    assert.equal((await fetch(`${path}/model`, { headers: secondAuth })).status, 404);
  } finally { await loom.browser.close(); }
});
