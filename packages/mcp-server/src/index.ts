#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLoomServer } from './server.js';

async function main(): Promise<void> {
  const server = createLoomServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The protocol owns stdout; status goes to stderr so it never corrupts the
  // JSON-RPC stream.
  console.error('loom MCP server ready on stdio.');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
