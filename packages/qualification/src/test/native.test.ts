import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sampleModel, validate, type Model, type PublishedContract } from '@loom/core';
import { exec } from '../exec.js';
import { runChecks, type RunOutput } from '../run.js';
import { selfFixtures, selfQualify } from '../selfqualify.js';
import { findSqlLocalDb } from '../tools.js';
import type { ArtifactSet, Fixtures } from '../types.js';
import { LOOM_ROOT, clone, replaceArtifact, sampleArtifacts, selfPolicy, tempDir } from './helpers.js';

const NATIVE = { timeout: 1_200_000 };

/** One check against the sample, with Loom's own fixtures unless overridden, under the self-qualification policy. */
async function one(checkId: string, options: { model?: Model; artifacts?: (set: ArtifactSet) => void; artifactModel?: Model; fixtures?: Partial<Fixtures>; root?: string } = {}): Promise<RunOutput['run']['checks'][number] & { record: RunOutput['evidence'][number] }> {
  const { set, done } = sampleArtifacts(options.artifactModel ?? sampleModel());
  try {
    options.artifacts?.(set);
    const out = await runChecks({
      root: options.root ?? LOOM_ROOT,
      model: options.model ?? sampleModel(),
      checks: [checkId],
      artifacts: set,
      fixtures: { ...selfFixtures(LOOM_ROOT), ...(options.fixtures ?? {}) },
      policy: selfPolicy(),
    });
    return { ...out.run.checks[0]!, record: out.evidence[0]! };
  } finally {
    done();
  }
}

const valid = (m: Model): Model => {
  const errors = validate(m).filter((f) => f.severity === 'error');
  assert.deepEqual(errors.map((f) => `${f.code} ${f.path}`), [], 'the test model must be valid');
  return m;
};

test('every profile check passes against Loom\'s own fixtures under the self-qualification policy', NATIVE, async () => {
  const q = await selfQualify(LOOM_ROOT);
  assert.deepEqual(q.unlisted, []);
  const notPassing = q.run.checks.filter((c) => c.result !== 'PASS').map((c) => `${c.check}: ${c.result} ${c.reason ?? ''}`);
  assert.deepEqual(notPassing, []);
  assert.equal(q.run.aggregate, 'PASS');
  assert.ok(q.evidence.every((e) => e.tool.version !== 'unknown' && e.limits.length > 0));
});

test('sql.parse rejects malformed T-SQL', NATIVE, async () => {
  const r = await one('sql.parse', { artifacts: (s) => replaceArtifact(s, 'schema.sql#ordering', (t) => `${t}\nCREATE TABL [ordering].[broken] (\n`) });
  assert.equal(r.result, 'FAIL', r.reason);
});

test('sql.build rejects DDL with an unresolved object reference', NATIVE, async () => {
  const r = await one('sql.build', { artifacts: (s) => replaceArtifact(s, 'schema.sql#fulfillment', (t) => t.replace('REFERENCES [ordering].[orders]', 'REFERENCES [ordering].[missing_orders]')) });
  assert.equal(r.result, 'FAIL', r.reason);
  assert.match(r.reason ?? '', /SQL\d+|missing_orders/);
});

test('sql.catalog reports a deployed column whose precision differs from its storage record', NATIVE, async () => {
  const model = clone(sampleModel());
  const total = model.storage.find((s) => s.id === 'ordering.orders')!.columns.find((c) => c.name === 'total')!;
  total.sqlType = { ...total.sqlType, precision: 14 };
  const r = await one('sql.catalog', { model: valid(model) });
  assert.equal(r.result, 'FAIL', r.reason);
  assert.match(r.reason ?? '', /total/);
});

test('sql.behavior fails when the implementation breaks the routine contract', NATIVE, async () => {
  const r = await one('sql.behavior', { fixtures: { conforming: { ...selfFixtures(LOOM_ROOT).conforming, sql: ['examples/violating/ordering/sp_place_order.sql'] } } });
  assert.equal(r.result, 'FAIL', r.reason);
  assert.match(r.reason ?? '', /50005/);
});

/** The sample with an order-line table that the place-order routine also writes, inside one declared transaction scope. */
function twoTableModel(): Model {
  const m = clone(sampleModel());
  m.types.push({
    id: 'order-line',
    version: 1,
    owner: 'ordering',
    representation: 'domain',
    description: 'One line of an order.',
    key: ['orderId', 'line'],
    properties: [
      { name: 'orderId', kind: 'string', required: true, nullable: false, immutable: true, origin: 'client', bounds: { maxLength: 64 }, binds: 'order.id' },
      { name: 'line', kind: 'integer', required: true, nullable: false, immutable: true, origin: 'client', bounds: { min: 1 } },
      { name: 'sku', kind: 'string', required: true, nullable: false, immutable: false, origin: 'client', bounds: { minLength: 1, maxLength: 32 } },
    ],
  });
  m.storage.push({
    id: 'ordering.order_lines',
    type: 'order-line',
    owner: 'ordering',
    platform: 'sqlserver-2022',
    schema: 'ordering',
    table: 'order_lines',
    columns: [
      { name: 'order_id', property: 'orderId', sqlType: { name: 'nvarchar', length: 64 }, nullable: false },
      { name: 'line', property: 'line', sqlType: { name: 'bigint' }, nullable: false },
      { name: 'sku', property: 'sku', sqlType: { name: 'nvarchar', length: 32 }, nullable: false },
    ],
    primaryKey: ['order_id', 'line'],
    foreignKeys: [{ name: 'order', columns: ['order_id'], references: 'ordering.orders', referencedColumns: ['id'] }],
  });
  const r = m.routines.find((x) => x.id === 'ordering.sp_place_order')!;
  r.writes = [...(r.writes ?? []), { storage: 'ordering.order_lines', columns: ['order_id', 'line', 'sku'] }];
  r.transactionScope = [...(r.transactionScope ?? []), 'ordering.order_lines'];
  return valid(m);
}

function procedure(transactional: boolean): string {
  const body = [
    '    DECLARE @order_id NVARCHAR(64) = CONVERT(NVARCHAR(64), NEWID());',
    "    INSERT INTO [ordering].[orders] ([id], [status], [total], [note]) OUTPUT inserted.[id] AS order_id, inserted.[status] AS status VALUES (@order_id, N'placed', @p_total, @p_note);",
    "    INSERT INTO [ordering].[order_lines] ([order_id], [line], [sku]) VALUES (@order_id, 1, N'sku-1');",
  ];
  return [
    'CREATE PROCEDURE [ordering].[sp_place_order]',
    '    @p_total DECIMAL(12,2),',
    '    @p_note NVARCHAR(280) = NULL',
    'AS',
    'BEGIN',
    '    SET NOCOUNT ON;',
    ...(transactional ? ['    SET XACT_ABORT ON;', '    BEGIN TRANSACTION;', ...body, '    COMMIT TRANSACTION;'] : body),
    'END',
    'GO',
    '',
  ].join('\n');
}

test('sql.transaction fails when a routine leaves writes behind after a failure inside its scope, and passes when it rolls them back', NATIVE, async () => {
  const model = twoTableModel();
  const t = tempDir('transaction');
  try {
    writeFileSync(join(t.dir, 'leaky.sql'), procedure(false), 'utf8');
    writeFileSync(join(t.dir, 'atomic.sql'), procedure(true), 'utf8');
    const leaky = await one('sql.transaction', { model, artifactModel: model, fixtures: { conforming: { sql: [join(t.dir, 'leaky.sql')] } } });
    assert.equal(leaky.result, 'FAIL', leaky.reason);
    assert.match(leaky.reason ?? '', /left rows in \[ordering\]\.\[orders\]/);
    const atomic = await one('sql.transaction', { model, artifactModel: model, fixtures: { conforming: { sql: [join(t.dir, 'atomic.sql')] } } });
    assert.equal(atomic.result, 'PASS', atomic.reason);
  } finally {
    t.done();
  }
});

test('sql.migration fails when the migration loses a representative row', NATIVE, async () => {
  const fx = selfFixtures(LOOM_ROOT).migrations![0]!;
  const t = tempDir('migration');
  try {
    const script = fx.candidate!.migrations.find((m) => m.id === fx.migration)!.script!;
    mkdirSync(join(t.dir, ...script.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(t.dir, ...script.split('/')), `${readFileSync(join(LOOM_ROOT, ...script.split('/')), 'utf8')}\nDELETE TOP (1) FROM [invoicing].[invoices];\n`, 'utf8');
    cpSync(join(LOOM_ROOT, ...fx.rows.split('/')), join(t.dir, ...fx.rows.split('/')));
    const r = await one('sql.migration', { root: t.dir, fixtures: { migrations: [fx] } });
    assert.equal(r.result, 'FAIL', r.reason);
    assert.match(r.reason ?? '', /2 row\(s\), it held 3/);
  } finally {
    t.done();
  }
});

test('sql.operations reports a declared index the deployed database lacks', NATIVE, async () => {
  const model = clone(sampleModel());
  model.storage.find((s) => s.id === 'ordering.orders')!.indexes = [{ name: 'status', columns: ['status'], unique: false }];
  const r = await one('sql.operations', { model: valid(model) });
  assert.equal(r.result, 'FAIL', r.reason);
  assert.match(r.reason ?? '', /index/);
});

test('powershell.parse rejects a malformed generated file', NATIVE, async () => {
  const r = await one('powershell.parse', { artifacts: (s) => replaceArtifact(s, 'Routines.Contract.Tests.ps1#fulfillment', (t) => `${t}\nfunction Broken {\n`) });
  assert.equal(r.result, 'FAIL', r.reason);
});

test('pester conformance fails when the routines break their contract', NATIVE, async () => {
  const r = await one('powershell.conformance', { fixtures: { conforming: { ...selfFixtures(LOOM_ROOT).conforming, powershellRoot: 'examples/violating' } } });
  assert.equal(r.result, 'FAIL', r.reason);
  assert.equal(r.record.tool.version.split('.')[0], '5');
});

test('csharp.build fails when the implementation does not compile', NATIVE, async () => {
  const t = tempDir('csharp');
  try {
    const dir = join(t.dir, 'Ordering.Contracts');
    cpSync(join(LOOM_ROOT, 'examples', 'conforming', 'csharp', 'Ordering.Contracts'), dir, { recursive: true });
    writeFileSync(join(dir, 'Broken.cs'), 'namespace Ordering.Contracts { public class Broken { public int X => ; } }\n', 'utf8');
    const r = await one('csharp.build', { fixtures: { conforming: { csharp: { 'Ordering.Contracts': join(dir, 'Ordering.Contracts.csproj') } } } });
    assert.equal(r.result, 'FAIL', r.reason);
  } finally {
    t.done();
  }
});

test('csharp.conformance fails against an implementation that breaks the declared types', NATIVE, async () => {
  const r = await one('csharp.conformance', { fixtures: { conforming: { csharp: { 'Ordering.Contracts': 'examples/violating/csharp/Ordering.Contracts/Ordering.Contracts.csproj' } } } });
  assert.equal(r.result, 'FAIL', r.reason);
  assert.match(r.reason ?? '', /Total_has_the_declared_type/);
});

test('typescript.build fails when an exported type loses a readonly member', NATIVE, async () => {
  const t = tempDir('typescript');
  try {
    const entry = join(t.dir, 'index.ts');
    writeFileSync(entry, readFileSync(join(LOOM_ROOT, 'examples', 'conforming', 'typescript', 'index.ts'), 'utf8').replace('readonly id: string;', 'id: string;'), 'utf8');
    const r = await one('typescript.build', { fixtures: { conforming: { typescript: { '@loom-fixtures/fulfillment': entry } } } });
    assert.equal(r.result, 'FAIL', r.reason);
    assert.match(r.reason ?? '', /TS\d+/);
  } finally {
    t.done();
  }
});

test('typescript.conformance fails against an implementation whose parse accepts a missing member', NATIVE, async () => {
  const r = await one('typescript.conformance', { fixtures: { conforming: { typescript: { '@loom-fixtures/fulfillment': 'examples/violating/typescript/index.ts' } } } });
  assert.equal(r.result, 'FAIL', r.reason);
});

test('openapi.validate rejects a templated path that does not declare its parameter', NATIVE, async () => {
  const r = await one('openapi.validate', {
    artifacts: (s) =>
      replaceArtifact(s, 'openapi.json', (t) => {
        const doc = JSON.parse(t) as { paths: Record<string, Record<string, { parameters?: unknown[] }>> };
        delete doc.paths['/orders/{id}']!['get']!.parameters;
        return `${JSON.stringify(doc)}\n`;
      }),
  });
  assert.equal(r.result, 'FAIL', r.reason);
  assert.match(r.reason ?? '', /id/);
});

test('openapi.compatibility passes when every oasdiff break is also a model break, and is not applicable without a baseline', NATIVE, async () => {
  const baseline = sampleModel();
  const candidate = clone(baseline);
  const response = candidate.types.find((x) => x.id === 'order-response')!;
  response.properties = response.properties.filter((p) => p.name !== 'total');
  for (const m of candidate.mappings) if (m.to === 'order-response') m.fields = m.fields.filter((f) => f.to !== 'total');
  valid(candidate);
  const matched = await one('openapi.compatibility', { fixtures: { compatibility: { baseline, candidate } } });
  assert.equal(matched.result, 'PASS', matched.reason);
  assert.match(matched.reason ?? '', /reports [1-9]\d* breaking change/);
  const none = await one('openapi.compatibility', { fixtures: { compatibility: undefined, baseline: undefined } });
  assert.equal(none.result, 'NOT_APPLICABLE', none.reason);
});

test('a model that consumes a pinned published contract over HTTP qualifies its OpenAPI document with the resolved bundle, outside draft mode', NATIVE, async () => {
  const dir = 'qualification/fixtures/api-database';
  const read = <T>(rel: string): T => JSON.parse(readFileSync(join(LOOM_ROOT, dir, rel), 'utf8')) as T;
  const model = valid(read<Model>('model.json'));
  const bundle = read<PublishedContract>('published/payments-api@2.json');
  const out = await runChecks({
    root: LOOM_ROOT,
    model,
    checks: ['openapi.validate', 'openapi.compatibility'],
    inputs: { publishedContracts: [bundle] },
    fixtures: { baseline: read<Model>('baseline/model.json') },
    policy: selfPolicy(),
  });
  const byCheck = new Map(out.run.checks.map((c) => [c.check, c]));
  assert.equal(byCheck.get('openapi.validate')?.result, 'PASS', byCheck.get('openapi.validate')?.reason);
  assert.equal(byCheck.get('openapi.compatibility')?.result, 'PASS', byCheck.get('openapi.compatibility')?.reason);
  assert.doesNotMatch(byCheck.get('openapi.validate')?.reason ?? '', /draft/);
  const withoutBundle = await runChecks({ root: LOOM_ROOT, model, checks: ['openapi.validate'], policy: selfPolicy() }).then(
    () => 'rendered',
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  assert.match(withoutBundle, /refusing to project 'openapi'/, 'without the bundle the document is refused rather than qualified');
});

test('json-schema.compile rejects a schema Ajv cannot compile', NATIVE, async () => {
  const r = await one('json-schema.compile', { artifacts: (s) => replaceArtifact(s, 'schema.json', (t) => t.replace(/"type":\s*"object"/, '"type": "objekt"')) });
  assert.equal(r.result, 'FAIL', r.reason);
});

test('diagrams.parse rejects a malformed diagram in a generated view', NATIVE, async () => {
  const r = await one('diagrams.parse', { artifacts: (s) => replaceArtifact(s, 'workflows.md', (t) => t.replace('```mermaid\n', '```mermaid\nstateDiagram-v2\n    state broken {\n')) });
  assert.equal(r.result, 'FAIL', r.reason);
});

test('documentation.drift detects a hand edit of a generated view', NATIVE, async () => {
  const r = await one('documentation.drift', { artifacts: (s) => replaceArtifact(s, 'reference.md', (t) => `${t}\nhand edit\n`) });
  assert.equal(r.result, 'FAIL', r.reason);
  assert.match(r.reason ?? '', /reference\.md/);
});

test('documentation.yaml-roundtrip detects an export that no longer matches the model', NATIVE, async () => {
  const r = await one('documentation.yaml-roundtrip', { artifacts: (s) => replaceArtifact(s, 'model.yaml', (t) => t.replace(/^(\s*purpose: )(.+)$/m, '$1$2 Changed by hand.')) });
  assert.equal(r.result, 'FAIL', r.reason);
});

test('two parallel runs each use their own LocalDB instance and leave none behind', NATIVE, async () => {
  const [a, b] = await Promise.all([one('sql.catalog'), one('sql.catalog')]);
  assert.equal(a.result, 'PASS', a.reason);
  assert.equal(b.result, 'PASS', b.reason);
  const localdb = findSqlLocalDb();
  assert.ok(localdb, 'SqlLocalDB is installed on this host');
  const info = await exec(localdb!, ['info'], { timeoutMs: 60_000 });
  assert.ok(info.ok);
  assert.ok(!/^loom-/m.test(info.ok ? info.stdout : ''), `no run instance remains: ${info.ok ? info.stdout : ''}`);
});
