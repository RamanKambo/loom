#!/usr/bin/env node
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLoomServer } from './server.js';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const workspace = option('workspace');
  const trustedRef = option('trusted-ref');
  const loom = createLoomServer({ workspace: resolve(workspace ?? process.cwd()), ...(trustedRef ? { trustedRef } : {}), grants: { qualify: process.argv.includes('--allow-qualify'), publish: process.argv.includes('--allow-publish') } });
  await loom.connect(new StdioServerTransport());
  const shutdown = (): void => { void loom.close().catch((error: unknown) => { console.error(`session cleanup incomplete: ${String(error)}`); process.exitCode = 1; }); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  // The protocol owns stdout; status goes to stderr so it never corrupts the JSON-RPC stream.
  console.error('loom MCP server ready on stdio.');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
