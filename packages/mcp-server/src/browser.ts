import { randomBytes } from 'node:crypto';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { OPERATION_CATALOGUE, canonicalHash, envelope, modelRevision, refusal, schemaErrors } from '@loom/core';
import type { ActivityEvent, BrowserRejection, BrowserSession, ResultEnvelope, WorkspaceHandle, WorkspaceSummary } from '@loom/core';
import { currentInputs, openSession, type HandleRegistry } from '@loom/workspace';
import { executeTool, type ToolContext } from './tools.js';

const token = (): string => randomBytes(32).toString('base64url');
interface Capability { workspaceId: string; expires: number; used: boolean }
interface Session { id: string; selector: string; workspaceId: string; expires: number; sequence: number; events: ActivityEvent[]; streams: Set<Response> }

/** An authenticated view borrows a handle; ending the browser session never closes its agent handle. */
export class BrowserHost {
  private listener: HttpServer | null = null;
  private starting: Promise<void> | null = null;
  private origin = '';
  private readonly capabilities = new Map<string, Capability>();
  private readonly sessions = new Map<string, Session>();
  private readonly watchers = new Map<string, FSWatcher>();
  private failures = { since: 0, count: 0 };
  constructor(private readonly ctx: ToolContext, private readonly handles: HandleRegistry,
    private readonly assets = fileURLToPath(new URL('../../../apps/designer/dist/designer/browser', import.meta.url))) {}

  async start(): Promise<void> {
    if (this.listener) return;
    if (this.starting) return this.starting;
    this.starting = this.listen();
    try { await this.starting; } finally { this.starting = null; }
  }
  private async listen(): Promise<void> {
    if (!existsSync(join(this.assets, 'index.html'))) throw new Error('The production designer assets are unavailable; build apps/designer before opening its view.');
    const app = createMcpExpressApp({ host: '127.0.0.1' });
    app.use((req, res, next) => {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if (req.headers.host !== this.origin.slice('http://'.length)) { this.reject(res, 'host-rejected', 403); return; }
      next();
    });
    app.use('/api', (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      const supplied = req.headers.origin;
      // Same-origin fetches do not always send Origin. Sec-Fetch-Site is a browser-controlled
      // alternative; command-line clients supply Origin explicitly.
      if (supplied !== this.origin && !(supplied === undefined && req.headers['sec-fetch-site'] === 'same-origin')) { this.reject(res, 'origin-rejected', 403); return; }
      next();
    });
    app.use('/api', express.json({ limit: '1mb', strict: true }));
    app.post('/api/session', (req, res) => {
      if (Date.now() - this.failures.since > 60_000) this.failures = { since: Date.now(), count: 0 };
      if (this.failures.count >= 10) { this.reject(res, 'rate-limited', 429); return; }
      if (schemaErrors('BrowserSessionRequest', req.body).length) { this.failures.count++; this.reject(res, 'session-required', 401); return; }
      const capability = this.capabilities.get(req.body.capability as string);
      if (!capability || capability.expires <= Date.now()) { this.failures.count++; this.reject(res, 'bootstrap-expired', 401); return; }
      if (capability.used) { this.failures.count++; this.reject(res, 'bootstrap-reused', 401); return; }
      const status = this.handles.status(capability.workspaceId);
      if (status.refusal) { this.reject(res, 'unknown-handle', 404); return; }
      capability.used = true;
      const session: Session = { id: token(), selector: `browser_${randomBytes(12).toString('hex')}`, workspaceId: capability.workspaceId, expires: Date.now() + 60 * 60_000, sequence: 0, events: [], streams: new Set() };
      this.sessions.set(session.id, session);
      const handle = (status.data as { workspace: WorkspaceHandle }).workspace;
      const result = { sessionId: session.selector, handles: [{ handle, access: handle.capabilities.includes('edit') ? 'edit' : 'read' }], expiresAt: new Date(session.expires).toISOString() };
      res.cookie(`loom_session_${session.selector}`, session.id, { httpOnly: true, sameSite: 'strict', path: '/api', maxAge: 60 * 60_000 });
      res.json(result);
    });
    app.use('/api', (req, res, next) => {
      const selector = req.headers['x-loom-session'] ?? req.query['session'];
      if (typeof selector !== 'string' || !/^browser_[a-f0-9]{24}$/.test(selector)) { this.reject(res, 'session-required', 401); return; }
      const id = new RegExp(`(?:^|;\\s*)loom_session_${selector}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
      const session = id ? this.sessions.get(id) : undefined;
      if (!session || session.expires <= Date.now()) { if (session) this.revoke(session); this.reject(res, 'session-required', 401); return; }
      res.locals['session'] = session;
      next();
    });
    app.delete('/api/session', (_req, res) => { const session = res.locals['session'] as Session; this.revoke(session); res.clearCookie(`loom_session_${session.selector}`, { path: '/api' }); res.status(204).end(); });
    app.use('/api/workspaces/:workspaceId', (req, res, next) => {
      const session = res.locals['session'] as Session;
      if (req.params['workspaceId'] !== session.workspaceId || !this.handles.resolve(session.workspaceId)) { this.reject(res, 'unknown-handle', 404); return; }
      next();
    });
    app.get('/api/workspaces/:workspaceId', (_req, res) => {
      const session = res.locals['session'] as Session;
      const snapshot = this.handles.snapshot(session.workspaceId);
      if (snapshot.refusal) { this.reject(res, 'unknown-handle', 404); return; }
      res.json(snapshot.data);
    });
    app.get('/api/workspaces/:workspaceId/model', async (_req, res) => {
      const session = res.locals['session'] as Session;
      const ws = this.handles.resolve(session.workspaceId)!;
      const inputs = currentInputs(ws.root, ws.loomDir, ws.config).current;
      const validation = await executeTool('loom.validate', { workspaceId: session.workspaceId }, this.ctx);
      const fresh = this.handles.resolve(session.workspaceId);
      if (!fresh || modelRevision(fresh.model) !== inputs.model || validation.revisions.model !== inputs.model) { res.status(409).json({ cause: 'revision-conflict', message: 'Workspace inputs changed while reading the snapshot; retry the request.' }); return; }
      res.json({ model: ws.model, expectation: { model: inputs.model, config: inputs.config.hash, policy: inputs.policy?.hash ?? null, imports: inputs.imports }, states: validation.states, revisions: validation.revisions });
    });
    app.get('/api/workspaces/:workspaceId/activity', (req, res) => {
      const session = res.locals['session'] as Session;
      res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
      const last = Number(req.headers['last-event-id'] ?? req.query['after'] ?? 0);
      const earliest = session.events[0]?.sequence ?? session.sequence + 1;
      if (last && last < earliest - 1) res.write(`event: gap\ndata: ${JSON.stringify({ current: session.sequence })}\n\n`);
      for (const event of session.events) if (event.sequence > last) this.send(res, event);
      session.streams.add(res);
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
      req.on('close', () => { clearInterval(heartbeat); session.streams.delete(res); });
    });
    app.post('/api/workspaces/:workspaceId/actions', async (req, res) => {
      const session = res.locals['session'] as Session;
      if (schemaErrors('BrowserActionRequest', req.body).length) { res.status(400).json(envelope('browser.action', { model: null, findings: [], refusal: refusal('invalid-input', 'the action request does not satisfy its contract') })); return; }
      const op = OPERATION_CATALOGUE.operations.find((o) => o.id === req.body.operation);
      const exposure = op?.exposure.mcp;
      if (!op || !exposure || exposure === 'none' || ['workspaceInitialize', 'workspaceOpen', 'workspaceClose'].includes(op.id)) { res.status(400).json(envelope('browser.action', { model: null, findings: [], refusal: refusal('invalid-input', 'this operation is unavailable through a browser handle') })); return; }
      const args = { ...req.body.arguments } as Record<string, unknown>;
      if ((op.effects === 'writes' || op.effects === 'executes') && Object.hasOwn(args, 'model')) { res.status(400).json(envelope(exposure.tool, { model: null, findings: [], refusal: refusal('invalid-input', 'connected changes must address the opened workspace') })); return; }
      if (args['workspaceId'] !== undefined && args['workspaceId'] !== session.workspaceId) { this.reject(res, 'unknown-handle', 404); return; }
      if ((op.effects === 'writes' || op.effects === 'executes') && !this.handles.can(session.workspaceId, 'edit')) { res.json(envelope(exposure.tool, { model: null, findings: [], refusal: refusal('access-denied', 'this browser session grants read access only') })); return; }
      if (exposure.action && args['action'] !== exposure.action) { res.status(400).json(envelope(exposure.tool, { model: null, findings: [], refusal: refusal('invalid-input', 'the selected action differs from its catalogue operation') })); return; }
      const input = exposure.input;
      if (input !== 'ExportInput' && input !== 'ImportInput' && !Object.hasOwn(args, 'model')) args['workspaceId'] = session.workspaceId;
      const result = await executeTool(exposure.tool, args, this.ctx);
      if (result.outcome === 'ok' && op.effects === 'writes') this.emit(session.workspaceId, 'model.changed', op.id, 'Workspace model changed.');
      res.json(result);
    });
    app.use(express.static(this.assets, { index: 'index.html', dotfiles: 'deny', fallthrough: true }));
    app.get('/workspaces/:workspaceId', (_req, res) => res.sendFile(join(this.assets, 'index.html')));
    app.use((_req, res) => res.status(404).end());
    app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => { console.error('Browser request failed:', error instanceof Error ? error.name : 'unknown error'); if (!res.headersSent) res.status(400).json({ cause: 'session-required', message: 'The request could not be processed.' }); });
    const listener = createServer(app);
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', () => { listener.removeListener('error', reject); resolve(); }); });
    this.listener = listener;
    this.origin = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  }

  viewUrl(workspaceId: string): string | null {
    if (!this.listener) return null;
    const capability = token();
    this.capabilities.set(capability, { workspaceId, expires: Date.now() + 120_000, used: false });
    return `${this.origin}/workspaces/${workspaceId}#capability=${capability}`;
  }
  watchWorkspace(workspaceId: string): void {
    if (this.watchers.has(workspaceId)) return;
    const ws = this.handles.resolve(workspaceId);
    if (!ws) return;
    this.watchers.set(workspaceId, watch(ws.loomDir, () => this.emit(workspaceId, 'model.changed', 'workspaceStatus', 'Workspace inputs changed.')));
    this.handles.registerCloseStep(workspaceId, { step: 'revoke-browser-access', run: () => { this.watchers.get(workspaceId)?.close(); this.watchers.delete(workspaceId); for (const session of this.sessions.values()) if (session.workspaceId === workspaceId) this.revoke(session); return { outcome: 'done' }; } });
  }
  emit(workspaceId: string, kind: ActivityEvent['kind'], operationId: string, summary: string): void {
    const ws = this.handles.resolve(workspaceId);
    if (!ws) return;
    for (const session of this.sessions.values()) if (session.workspaceId === workspaceId) {
      const event: ActivityEvent = { sessionId: session.selector, workspaceId, sequence: ++session.sequence, kind, subject: { kind: 'model', id: ws.config.modelId }, revision: modelRevision(ws.model), operationId, summary: summary.slice(0, 300), time: new Date().toISOString() };
      session.events.push(event); if (session.events.length > 200) session.events.shift();
      for (const stream of session.streams) this.send(stream, event);
    }
  }
  private send(res: Response, event: ActivityEvent): void { res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`); }
  private reject(res: Response, cause: BrowserRejection['cause'], status: number): void { res.status(status).json({ cause, message: 'The browser request is not authorized.' } satisfies BrowserRejection); }
  private revoke(session: Session): void { for (const stream of session.streams) stream.end(); this.sessions.delete(session.id); }
  async close(): Promise<void> {
    for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear();
    for (const session of this.sessions.values()) this.revoke(session);
    const listener = this.listener; this.listener = null;
    if (listener) await new Promise<void>((resolve, reject) => { listener.close((err) => err ? reject(err) : resolve()); listener.closeAllConnections(); });
  }
}
