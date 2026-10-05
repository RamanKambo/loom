import { closeQualificationRuns } from './qualification-tools.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema, RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIENTATION_TEXT, asFinding, canonicalStringify, envelope, refusal } from '@loom/core';
import type { ResultEnvelope } from '@loom/core';
import { RESOURCE_NOT_FOUND, listResources, readResource } from './resources.js';
import { executeTool, handlesOf, toolDefinitions, type ToolContext } from './tools.js';
import { HandleRegistry, findRepositoryRoot } from '@loom/workspace';
import { BrowserHost } from './browser.js';

/** The first protocol version whose tool results carry outputSchema and structuredContent. */
export const STRUCTURED_SINCE = '2025-06-18';

export interface LoomServerOptions extends Partial<ToolContext> {}

export interface LoomServer {
  server: Server;
  /** Connect to a transport, observing the protocol version the client negotiates. */
  connect(transport: Transport): Promise<void>;
  /** The negotiated protocol version, once the client has initialized. */
  protocolVersion(): string | undefined;
  context: ToolContext;
  browser: BrowserHost;
  close(): Promise<void>;
}

/**
 * Build the Loom MCP server on the low-level SDK Server with JSON Schema tool
 * contracts. Initialization returns the orientation as the server's
 * instructions, which orient an agent and authorize nothing. Tools advertise
 * compact schemas whose deep members name the schema resources holding their
 * full contract, which the server serves beside the guidance. The tool list
 * and every result follow the negotiated protocol version: a client without
 * structured tool results gets the result envelope as text plus an explicit
 * compatibility finding.
 */
export function createLoomServer(options: LoomServerOptions = {}): LoomServer {
  const ctx: ToolContext = { ...options, workspace: options.workspace ?? process.cwd() };
  let browser: BrowserHost;
  ctx.handles = options.handles ?? new HandleRegistry({ grants: options.grants, allowedRoots: options.allowedRoots ?? [findRepositoryRoot(ctx.workspace) ?? ctx.workspace], viewProvider: (id) => browser?.viewUrl(id) ?? null });
  browser = new BrowserHost(ctx, ctx.handles);
  let negotiated: string | undefined;
  const structured = (): boolean => negotiated === undefined || negotiated >= STRUCTURED_SINCE;
  const server = new Server({ name: 'loom', version: '1.0.0' }, { capabilities: { tools: {}, resources: { subscribe: true, listChanged: true } }, instructions: ORIENTATION_TEXT });
  const subscriptions = new Set<string>();
  const watchers = new Map<string, FSWatcher>();
  const narrowRoots = async (): Promise<void> => {
    if (!server.getClientCapabilities()?.roots) return;
    const roots = await server.listRoots();
    handlesOf(ctx).narrow(roots.roots.filter((r) => r.uri.startsWith('file:')).map((r) => fileURLToPath(r.uri)));
  };
  let rootsReady: Promise<void> = Promise.resolve();
  server.oninitialized = () => { rootsReady = narrowRoots().catch((err: unknown) => { handlesOf(ctx).narrow(['C:/__loom_no_roots__']); throw err; }); void rootsReady.catch(() => undefined); };
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => { await narrowRoots(); });
  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    if (!readResource(request.params.uri, ctx)) throw new McpError(RESOURCE_NOT_FOUND, 'Resource not found');
    subscriptions.add(request.params.uri);
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => { subscriptions.delete(request.params.uri); return {}; });
  let cleanup: Promise<void> | undefined;
  const closeOwnedResources = (): Promise<void> => cleanup ??= (async () => {
    await closeQualificationRuns(ctx);
    for (const watcher of watchers.values()) watcher.close();
    for (const id of handlesOf(ctx).ids()) handlesOf(ctx).close(id);
    await browser.close();
  })();
  server.onclose = () => { void closeOwnedResources().catch((err: unknown) => console.error(`session cleanup incomplete: ${String(err)}`)); };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions(structured()) }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: listResources(ctx) }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const contents = readResource(request.params.uri, ctx);
    if (!contents) throw new McpError(RESOURCE_NOT_FOUND, 'Resource not found', { uri: request.params.uri });
    return { contents: [contents] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let env: ResultEnvelope;
    let isError = false;
    try {
      await rootsReady;
      const args = request.params.arguments ?? {};
      if (request.params.name === 'loom.workspace' && args['action'] === 'open' && args['view'] !== false) await browser.start();
      env = await executeTool(request.params.name, request.params.arguments ?? {}, ctx, extra.signal);
      for (const id of handlesOf(ctx).ids()) {
        if (watchers.has(id)) continue;
        const ws = handlesOf(ctx).resolve(id);
        if (!ws) continue;
        browser.watchWorkspace(id);
        const watcher = watch(join(ws.root, '.loom'), () => {
          for (const uri of subscriptions) if (uri.startsWith(`loom://workspaces/${id}/`)) void server.sendResourceUpdated({ uri }).catch(() => undefined);
        });
        watchers.set(id, watcher);
        handlesOf(ctx).registerCloseStep(id, { step: 'detach-watchers', run: () => { watcher.close(); watchers.delete(id); for (const uri of subscriptions) if (uri.startsWith(`loom://workspaces/${id}/`)) subscriptions.delete(uri); return { outcome: 'done' }; } });
      }
    } catch (err) {
      isError = true;
      env = envelope(request.params.name.replace(/[^A-Za-z.]/g, '') || 'loom.unknown', { model: null, findings: [], refusal: refusal('unresolved-context', `the tool failed: ${(err as Error).message}`) });
    }
    if (!structured()) {
      env = { ...env, findings: [...env.findings, asFinding('CLIENT_CAPABILITY_UNSUPPORTED', '(protocol)', `protocol version ${negotiated} carries no structured tool results; the result envelope is returned as text only`, `connect with protocol version ${STRUCTURED_SINCE} or later to receive structuredContent validated by each tool's outputSchema`)] };
      return { content: [{ type: 'text' as const, text: canonicalStringify(env) }], isError };
    }
    return { content: [{ type: 'text' as const, text: canonicalStringify(env) }], structuredContent: env as unknown as Record<string, unknown>, isError };
  });

  return {
    server,
    context: ctx,
    browser,
    async close(): Promise<void> { await server.close(); await closeOwnedResources(); },
    protocolVersion: () => negotiated,
    async connect(transport: Transport): Promise<void> {
      await server.connect(transport);
      const inner = transport.onmessage;
      transport.onmessage = (message, extra) => {
        const m = message as { method?: string; params?: { protocolVersion?: unknown } };
        if (m.method === 'initialize' && typeof m.params?.protocolVersion === 'string') negotiated = m.params.protocolVersion;
        inner?.(message, extra);
      };
    },
  };
}
