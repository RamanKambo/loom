import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, executeTool } from './tools.js';

/**
 * Build the Loom MCP server. Uses the low-level Server with JSON-Schema tool
 * input (no Zod dependency). The server is transport-agnostic; the caller
 * connects it to stdio (index.ts) or an in-memory transport (smoke.ts).
 */
export function createLoomServer(): Server {
  const server = new Server(
    { name: 'loom', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = executeTool(request.params.name, args);
    return {
      content: [{ type: 'text' as const, text: result.text }],
      isError: result.isError,
    };
  });

  return server;
}
