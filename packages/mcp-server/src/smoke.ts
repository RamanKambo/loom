import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sampleModel, PROJECTION_FILES } from '@loom/core';
import { createLoomServer } from './server.js';
import { TOOLS } from './tools.js';

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.map((c) => c.text ?? '').join('');
  if (res.isError) throw new Error(`${name} returned isError: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function codesOf(result: Record<string, unknown>): string[] {
  const findings = (result['findings'] ?? []) as Array<{ code: string; severity: string }>;
  return findings.filter((f) => f.severity === 'error').map((f) => f.code);
}

/**
 * Non-interactive smoke test: wire the server to an in-memory client, enumerate
 * the registered tools over the real protocol, and call one end to end. Proves
 * the server starts and serves tools without needing a live MCP client.
 */
async function main(): Promise<void> {
  const server = createLoomServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'loom-smoke', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);

  const list = await client.listTools();
  const names = list.tools.map((t) => t.name).sort();
  console.log(`MCP tools (${names.length}): ${names.join(', ')}`);

  const expected = TOOLS.map((t) => t.name).sort();
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length) {
    console.error(`MISSING tools: ${missing.join(', ')}`);
    process.exit(1);
  }

  const res = await client.callTool({ name: 'loom.selftest', arguments: {} });
  const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.map((c) => c.text ?? '').join('');
  console.log(`loom.selftest via MCP -> ${text}`);
  if (res.isError) {
    console.error('loom.selftest returned isError');
    process.exit(1);
  }

  // loom.mutate over the protocol: a breaking patch is refused, the complete
  // acknowledged batch is accepted.
  const model = sampleModel();
  const dropSettled = {
    op: 'updateItem',
    collection: 'types',
    id: 'invoice',
    field: 'properties',
    key: 'state',
    set: { enumValues: ['draft', 'issued'] },
  };
  const refused = await callJson(client, 'loom.mutate', { model, patch: dropSettled });
  const refusedCodes = codesOf(refused);
  console.log(`loom.mutate single breaking patch -> refused=${String(refused['refused'])} errors: ${refusedCodes.join(', ')}`);
  if (refused['refused'] !== true || !refusedCodes.includes('BREAKING_CHANGE_WITHOUT_VERSION_BUMP')) {
    console.error('loom.mutate should refuse an unversioned breaking change');
    process.exit(1);
  }

  const accepted = await callJson(client, 'loom.mutate', {
    model,
    patches: [
      dropSettled,
      { op: 'update', collection: 'types', id: 'invoice', set: { version: 2 } },
      { op: 'updateItem', collection: 'workflows', id: 'wf.reporting', field: 'imports', key: 'invoice', set: { version: 2 } },
    ],
    acknowledgeBreaking: ['invoice'],
  });
  const changes = (accepted['changes'] ?? []) as Array<{ kind: string; element: string }>;
  const breakingElements = [...new Set(changes.filter((c) => c.kind === 'breaking').map((c) => c.element))];
  console.log(`loom.mutate acknowledged batch -> refused=${String(accepted['refused'])} breaking elements: ${breakingElements.join(', ')}`);
  if (accepted['refused'] !== false || codesOf(accepted).length !== 0) {
    console.error(`loom.mutate should accept the complete batch, got errors: ${codesOf(accepted).join(', ')}`);
    process.exit(1);
  }

  // loom.projectAll returns every projection keyed by file name; loom.project
  // returns a text target verbatim.
  const files = await callJson(client, 'loom.projectAll', { model });
  const fileNames = Object.keys(files).sort();
  const expectedFiles = Object.keys(PROJECTION_FILES).sort();
  console.log(`loom.projectAll -> ${fileNames.length} files: ${fileNames.join(', ')}`);
  if (fileNames.join(',') !== expectedFiles.join(',') || fileNames.some((f) => typeof files[f] !== 'string')) {
    console.error(`loom.projectAll should return ${expectedFiles.join(', ')} as text`);
    process.exit(1);
  }
  const sqlRes = await client.callTool({ name: 'loom.project', arguments: { model, target: 'sql' } });
  const sqlText = ((sqlRes.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
  if (sqlRes.isError || sqlText !== files['schema.sql']) {
    console.error('loom.project sql should return the same text as projectAll schema.sql');
    process.exit(1);
  }
  console.log(`loom.project sql -> ${sqlText.split('\n').length - 1} lines, identical to projectAll schema.sql`);

  console.log(
    `MCP smoke test PASS: server lists ${names.length} tools; selftest, refused and accepted mutate, projectAll and project respond over an in-memory client.`,
  );

  await client.close();
  await server.close();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
