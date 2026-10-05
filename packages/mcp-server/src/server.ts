import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ORIENTATION_TEXT, asFinding, canonicalStringify, envelope, refusal } from '@loom/core';
import type { ResultEnvelope } from '@loom/core';
import { RESOURCE_NOT_FOUND, listResources, readResource } from './resources.js';
import { executeTool, toolDefinitions, type ToolContext } from './tools.js';

/** The first protocol version whose tool results carry outputSchema and structuredContent. */
export const STRUCTURED_SINCE = '2025-06-18';

export interface LoomServerOptions extends Partial<ToolContext> {}

export interface LoomServer {
  server: Server;
  /** Connect to a transport, observing the protocol version the client negotiates. */
  connect(transport: Transport): Promise<void>;
  /** The negotiated protocol version, once the client has initialized. */
  protocolVersion(): string | undefined;
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
  const ctx: ToolContext = { workspace: options.workspace ?? process.cwd(), ...(options.trustedRef ? { trustedRef: options.trustedRef } : {}) };
  let negotiated: string | undefined;
  const structured = (): boolean => negotiated === undefined || negotiated >= STRUCTURED_SINCE;
  const server = new Server({ name: 'loom', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} }, instructions: ORIENTATION_TEXT });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions(structured()) }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: listResources() }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const contents = readResource(request.params.uri);
    if (!contents) throw new McpError(RESOURCE_NOT_FOUND, 'Resource not found', { uri: request.params.uri });
    return { contents: [contents] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let env: ResultEnvelope;
    let isError = false;
    try {
      env = await executeTool(request.params.name, request.params.arguments ?? {}, ctx);
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
