import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sampleModel, validate, type LoomConfig, type Model, type PublishedContract } from '@loom/core';
import { initWorkspace, installOutputs, openSession } from '@loom/workspace';
import { commitAll, foldModelId, gitInit, readJsonFile, scratch, writeJson } from '@loom/workspace/testing';
import { exec, type ExecResult } from '../exec.js';
import { resolveChecks, runChecks, type RunOutput } from '../run.js';
import { connectionFailure, type LocalDbInstance } from '../runners/localdb.js';
import { SQL_RUNNERS } from '../runners/sql.js';
import { selfFixtures, selfQualify } from '../selfqualify.js';
import { defaultToolLocator, findSqlLocalDb, type ToolLocator } from '../tools.js';
import type { ArtifactSet, Fixtures, Runner, RunResources } from '../types.js';
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
  assert.equal(q.run.testOutcome, 'PASS');
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

type Sqlcmd = LocalDbInstance['sqlcmd'];

interface SqlCall {
  batch: string;
  result: ExecResult;
}

/**
 * One SQL check through runChecks with its run instance's sqlcmd replaced by
 * `through(real)`. With `live` false no LocalDB instance is created: `real`
 * is null and every call is answered by the replacement.
 */
async function throughSqlcmd(checkId: string, live: boolean, through: (real: Sqlcmd | null) => Sqlcmd, shared: { set: ArtifactSet; tools: ToolLocator }): Promise<RunOutput['run']['checks'][number]> {
  const check = resolveChecks([checkId])[0]!;
  const runner: Runner = (ctx) => {
    const resources: RunResources = {
      acquire: <T>(key: string, create: () => Promise<T>, release: (value: T) => Promise<void>): Promise<T> => {
        if (key !== 'localdb') return ctx.resources.acquire(key, create, release);
        if (!live) return ctx.resources.acquire(key, async () => ({ name: 'loom-replayed', server: '(localdb)\\loom-replayed', engineVersion: '15.0', sqlcmd: through(null) }) satisfies LocalDbInstance as unknown as T, async () => undefined);
        return ctx.resources.acquire(key, async () => {
          const inst = (await create()) as unknown as LocalDbInstance;
          return { ...inst, sqlcmd: through(inst.sqlcmd) } as unknown as T;
        }, release);
      },
    };
    return SQL_RUNNERS[check.runner]!({ ...ctx, resources });
  };
  const out = await runChecks({ root: LOOM_ROOT, model: sampleModel(), checks: [check], artifacts: shared.set, fixtures: selfFixtures(LOOM_ROOT), policy: selfPolicy(), toolLocator: shared.tools, runners: { [check.runner]: runner } });
  return out.run.checks[0]!;
}

/** The real sqlcmd, with each batch and its result recorded in order. */
const recording = (calls: SqlCall[]) => (real: Sqlcmd | null): Sqlcmd => async (args, options) => {
  const batch = readFileSync(args[args.indexOf('-i') + 1]!, 'utf8');
  const result = await real!(args, options);
  calls.push({ batch, result });
  return result;
};

/** The recorded results up to call `k`, then `failure` for that call and every later one, as when the server goes away. */
const failingFrom = (calls: readonly SqlCall[], k: number, failure: ExecResult) => (): Sqlcmd => {
  let i = 0;
  return async () => (i < k ? calls[i++]!.result : failure);
};

test('a connection failure, a refused login or a timeout at any sqlcmd call of a SQL check is UNKNOWN with its reason, never FAIL', NATIVE, async () => {
  const tools = defaultToolLocator();
  const sqlcmd = await tools('sqlcmd', { minimum: '15.0' });
  assert.ok(sqlcmd.status === 'found', 'sqlcmd is installed on this host');
  const absent = await exec(sqlcmd.tool.path, ['-S', `(localdb)\\loom-absent-${randomBytes(3).toString('hex')}`, '-b', '-l', '5', '-Q', 'SELECT 1'], { timeoutMs: 120_000 });
  const unreachable = absent.ok ? connectionFailure(`${absent.stdout}\n${absent.stderr}`) : null;
  assert.ok(absent.ok && absent.status !== 0 && unreachable, `sqlcmd reports an instance it cannot reach as a connection failure: ${JSON.stringify(absent)}`);
  const failures: Array<{ label: string; result: ExecResult; reason: string }> = [
    { label: 'unreachable instance', result: absent, reason: unreachable! },
    { label: 'refused login', result: { ok: true, status: 1, stdout: "Msg 18456, Level 14, State 1, Server (localdb)\\loom-replayed, Line 1\r\nLogin failed for user 'loom'.\r\n", stderr: '' }, reason: "Msg 18456: Login failed for user 'loom'." },
    { label: 'stopped process', result: { ok: false, kind: 'timeout', reason: 'sqlcmd did not finish within 900000 ms and was stopped', stdout: '', stderr: '' }, reason: 'did not finish within 900000 ms' },
  ];
  const { set, done } = sampleArtifacts();
  try {
    for (const checkId of ['sql.catalog', 'sql.behavior', 'sql.transaction', 'sql.migration', 'sql.operations']) {
      const calls: SqlCall[] = [];
      const clean = await throughSqlcmd(checkId, true, recording(calls), { set, tools });
      assert.equal(clean.result, 'PASS', `${checkId} passes with every call answered: ${clean.reason}`);
      assert.ok(calls.length > 1, `${checkId} made ${calls.length} sqlcmd call(s)`);
      for (let k = 0; k < calls.length; k++) {
        // A failure that reaches only the closing drops of the check's databases leaves its claim decided.
        const onlyCleanup = calls.slice(k).every((c) => c.batch.startsWith("IF DB_ID(N'"));
        for (const f of failures) {
          const r = await throughSqlcmd(checkId, false, failingFrom(calls, k, f.result), { set, tools });
          const at = `${checkId}, ${f.label} at call ${k + 1} of ${calls.length} (${calls[k]!.batch.split(/\r?\n/)[0]})`;
          if (onlyCleanup) assert.equal(r.result, clean.result, `${at}: ${r.reason}`);
          else {
            assert.equal(r.result, 'UNKNOWN', `${at}: ${r.result} ${r.reason}`);
            assert.ok((r.reason ?? '').includes(f.reason), `${at} names the failure: ${r.reason}`);
          }
        }
      }
    }
  } finally {
    done();
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

/** A committed workspace governing the sample whose documentation views `loom write` installed with the session inputs. */
function writtenWorkspace(): string {
  const root = gitInit(scratch());
  assert.equal(initWorkspace(root, { modelId: foldModelId(basename(root)), modelKind: 'implementation' }).outcome, 'ok');
  const model = sampleModel();
  writeJson(join(root, '.loom', 'model.json'), model);
  for (const c of model.components) mkdirSync(join(root, c.id), { recursive: true });
  const configPath = join(root, '.loom', 'loom.json');
  writeJson(configPath, { ...readJsonFile<LoomConfig>(configPath), projectionProfile: 'documentation', scope: Object.fromEntries(model.components.map((c) => [c.id, [c.id]])) });
  commitAll(root, 'workspace');
  const s = openSession(root);
  assert.equal(installOutputs(s.workspace!, { inputs: s.inputs }).outcome, 'ok');
  return root;
}

const drift = async (root: string): Promise<RunOutput['run']['checks'][number]> => (await runChecks({ root, model: sampleModel(), checks: ['documentation.drift'], policy: selfPolicy() })).run.checks[0]!;

test('documentation.drift passes on a freshly written workspace whose readiness, coverage and evidence views summarize its inputs', NATIVE, async () => {
  const r = await drift(writtenWorkspace());
  assert.equal(r.result, 'PASS', r.reason);
});

test('documentation.drift reports a hand edit of a view installed in a workspace', NATIVE, async () => {
  const root = writtenWorkspace();
  writeFileSync(join(root, 'Docs', 'Loom', 'readiness.md'), 'hand edit\n');
  const r = await drift(root);
  assert.equal(r.result, 'FAIL', r.reason);
  assert.match(r.reason ?? '', /OUTPUT_DRIFT Docs\/Loom\/readiness\.md/);
});

test('documentation.yaml-roundtrip detects an export that no longer matches the model', NATIVE, async () => {
  const r = await one('documentation.yaml-roundtrip', { artifacts: (s) => replaceArtifact(s, 'model.yaml', (t) => t.replace(/^(\s*purpose: )(.+)$/m, '$1$2 Changed by hand.')) });
  assert.equal(r.result, 'FAIL', r.reason);
});

test('concurrent SQL requests serialize under the user lease and each leaves nothing behind', NATIVE, async () => {
  const [a, b] = await Promise.all([one('sql.catalog'), one('sql.catalog')]);
  assert.equal(a.result, 'PASS', a.reason);
  assert.equal(b.result, 'PASS', b.reason);
  const localdb = findSqlLocalDb();
  assert.ok(localdb, 'SqlLocalDB is installed on this host');
  const info = await exec(localdb!, ['info'], { timeoutMs: 60_000 });
  assert.ok(info.ok);
  assert.ok(!/^loom-/m.test(info.ok ? info.stdout : ''), `no run instance remains: ${info.ok ? info.stdout : ''}`);
});
