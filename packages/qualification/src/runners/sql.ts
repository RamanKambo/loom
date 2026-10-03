import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { indexModel, procedureName, sampleValue, sqlDeploymentOrder, type Model, type Routine, type Storage } from '@loom/core';
import { materialize, filesOfTarget } from '../artifacts.js';
import { exec, firstErrorLine, psq, runPwsh } from '../exec.js';
import { SQL_SDK_VERSION } from '../tools.js';
import { outcome, type ArtifactFile, type MigrationFixture, type Runner, type RunnerContext, type RunnerOutcome } from '../types.js';
import { CATALOG_QUERY, catalogRecords, routineMismatches, storageMismatches, type Catalog } from './catalog.js';
import { createDatabase, dropDatabase, messageCodes, queryJson, runInstance, runSql, throwMessage, type LocalDbInstance } from './localdb.js';

const atRoot = (ctx: RunnerContext, p: string): string => (isAbsolute(p) ? p : resolve(ctx.root, p));

/** The generated DDL files of a model in foreign-key deployment order. */
function schemaFiles(model: Model, files: readonly ArtifactFile[]): ArtifactFile[] {
  const order = sqlDeploymentOrder(model);
  return files
    .filter((f) => f.target === 'sql')
    .sort((a, b) => order.indexOf(a.component ?? '') - order.indexOf(b.component ?? ''));
}

const read = (path: string): string => readFileSync(path, 'utf8');

const realBoundary = [{ boundary: 'SQL Server database engine (LocalDB)', actual: 'real' as const }];

/** Run `steps` in a fresh database of the run's instance and always drop it afterwards. */
async function inDatabase(ctx: RunnerContext, purpose: string, steps: (inst: LocalDbInstance, db: string) => Promise<RunnerOutcome>): Promise<RunnerOutcome> {
  const inst = await runInstance(ctx);
  if (!inst.ok) return outcome('UNKNOWN', inst.reason);
  const db = await createDatabase(ctx, inst.value, purpose);
  if (!db.ok) return outcome('UNKNOWN', db.reason);
  try {
    const r = await steps(inst.value, db.value);
    return { boundaries: realBoundary, tool: { name: 'sqlcmd', version: `${ctx.tool.version}; SQL Server ${inst.value.engineVersion}` }, ...r };
  } finally {
    await dropDatabase(ctx, inst.value, db.value);
  }
}

type Applied = { ok: true } | { ok: false; result: RunnerOutcome };

/** Apply T-SQL scripts in order; a script that fails to apply is a failure of what the check deploys, never a pass. */
async function apply(ctx: RunnerContext, inst: LocalDbInstance, db: string, scripts: Array<{ label: string; text: string }>): Promise<Applied> {
  for (const s of scripts) {
    const r = await runSql(ctx, inst, s.text, db);
    if (!r.ok) return { ok: false, result: outcome('UNKNOWN', `${s.label}: ${r.reason}`) };
    if (r.status !== 0) return { ok: false, result: outcome('FAIL', `${s.label} did not apply: ${throwMessage(`${r.stdout}\n${r.stderr}`).message}`) };
  }
  return { ok: true };
}

const schemaScripts = (ctx: RunnerContext, model = ctx.model, files = ctx.artifacts.files) =>
  schemaFiles(model, files).map((f) => ({ label: f.instance, text: read(f.path) }));

const procedureScripts = (ctx: RunnerContext, which: 'conforming' | 'violating') =>
  (ctx.fixtures[which]?.sql ?? []).map((p) => ({ label: `${which} ${p}`, text: read(atRoot(ctx, p)) }));

async function readCatalog(ctx: RunnerContext, inst: LocalDbInstance, db: string): Promise<{ ok: true; value: Catalog } | { ok: false; reason: string }> {
  return queryJson<Catalog>(ctx, inst, db, CATALOG_QUERY);
}

// ---------- parse ----------

/** The ScriptDom grammar of each storage platform. */
const PLATFORM_PARSER: Readonly<Record<Storage['platform'], string>> = {
  'sqlserver-2019': 'TSql150Parser',
  'sqlserver-2022': 'TSql160Parser',
  'azure-sql-database': 'TSql170Parser',
};

const PARSE_SCRIPT = (dll: string, parser: string, files: readonly string[]): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    `try { Add-Type -Path ${psq(dll)} } catch { [pscustomobject]@{ loadError = $_.Exception.Message } | ConvertTo-Json -Compress; return }`,
    "$asm = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq 'Microsoft.SqlServer.TransactSql.ScriptDom' } | Select-Object -First 1",
    `$parserType = $asm.GetExportedTypes() | Where-Object { $_.Name -eq ${psq(parser)} } | Select-Object -First 1`,
    `if (-not $parserType) { [pscustomobject]@{ loadError = ${psq(`this ScriptDom has no ${parser}`)} } | ConvertTo-Json -Compress; return }`,
    // -ArgumentList binds initialQuotedIdentifiers; [Activator]::CreateInstance($t, $true) would bind the (Type, nonPublic) overload.
    '$parser = New-Object -TypeName $parserType.FullName -ArgumentList $true',
    `$results = foreach ($file in @(${files.map(psq).join(', ')})) {`,
    '    $errs = $null',
    '    [void]$parser.Parse([IO.StringReader]::new([IO.File]::ReadAllText($file)), [ref] $errs)',
    '    [pscustomobject]@{ file = $file; errors = @($errs).Count; first = @($errs | Select-Object -First 3 | ForEach-Object { "line $($_.Line): $($_.Message)" }) }',
    '}',
    '[pscustomobject]@{ parser = $parserType.Name; results = @($results) } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');

const sqlParse: Runner = async (ctx) => {
  const files = ctx.artifacts.files.filter((f) => f.target === 'sql' || f.target === 'sql-contract-tests');
  if (!files.length) return outcome('NOT_APPLICABLE', 'the model has no storage or SQL routine, so no T-SQL is generated');
  const pwsh = await ctx.tools('pwsh', { minimum: '7.4' });
  if (pwsh.status !== 'found') return outcome('UNKNOWN', `ScriptDom is loaded through pwsh: ${pwsh.reason}`);
  const platforms = [...new Set(ctx.model.storage.map((s) => s.platform))].sort();
  const label = (path: string): string => files.find((f) => f.path === path)?.instance ?? path;
  const reports: string[] = [];
  for (const platform of platforms.length ? platforms : (['sqlserver-2022'] as const)) {
    const parser = PLATFORM_PARSER[platform];
    const r = await runPwsh(pwsh.tool.path, PARSE_SCRIPT(ctx.tool.path, parser, files.map((f) => f.path)), { timeoutMs: ctx.timeoutMs });
    if (!r.ok) return outcome('UNKNOWN', r.reason);
    if (r.json['loadError'] !== undefined) return outcome('UNKNOWN', `ScriptDom ${ctx.tool.version} at ${ctx.tool.path} did not load: ${String(r.json['loadError'])}`);
    const results = (r.json['results'] ?? []) as Array<{ file: string; errors: number; first: string[] }>;
    if (results.length !== files.length) return outcome('UNKNOWN', `the parser reported ${results.length} of ${files.length} files`);
    const bad = results.filter((x) => x.errors > 0);
    if (bad.length) return outcome('FAIL', `${bad.map((x) => `${label(x.file)}: ${x.errors} error(s): ${x.first.join('; ')}`).join(' | ')} (${parser}, ScriptDom ${ctx.tool.version})`);
    reports.push(`${platform} (${parser})`);
  }
  return outcome('PASS', `${files.length} file(s) parse with 0 errors under ${reports.join(', ')}, ScriptDom ${ctx.tool.version}`, { instances: files.map((f) => f.instance) });
};

// ---------- target-platform build ----------

const DSP: Readonly<Record<Storage['platform'], string>> = {
  'sqlserver-2019': 'Microsoft.Data.Tools.Schema.Sql.Sql150DatabaseSchemaProvider',
  'sqlserver-2022': 'Microsoft.Data.Tools.Schema.Sql.Sql160DatabaseSchemaProvider',
  'azure-sql-database': 'Microsoft.Data.Tools.Schema.Sql.SqlAzureV12DatabaseSchemaProvider',
};

const SCHEMA_GUARD = /^IF SCHEMA_ID\(N'([^']+)'\) IS NULL EXEC\(N'CREATE SCHEMA \[([^\]]+)\]'\);$/gm;

/**
 * A database project accepts only declarative object definitions. The
 * generated DDL guards each CREATE SCHEMA so a pipeline can re-run it; that
 * one guard is rewritten to its declarative statement and nothing else is
 * changed, so any other non-declarative statement still fails the build.
 */
export const declarativeDdl = (text: string): string => text.replace(SCHEMA_GUARD, (_m, _a: string, name: string) => `CREATE SCHEMA [${name}];`);

const sqlBuild: Runner = async (ctx) => {
  const files = schemaFiles(ctx.model, ctx.artifacts.files);
  if (!files.length) return outcome('NOT_APPLICABLE', 'the model has no storage record, so no DDL is generated');
  const dotnet = await ctx.tools('dotnet', { minimum: '8.0' });
  if (dotnet.status !== 'found') return outcome('UNKNOWN', `the SQL database project build needs dotnet: ${dotnet.reason}`);
  const platforms = [...new Set(ctx.model.storage.map((s) => s.platform))].sort();
  const reports: string[] = [];
  for (const platform of platforms) {
    const dir = join(ctx.dir, `sqlproj-${platform}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'Loom.Schema.sqlproj'),
      [
        `<Project Sdk="Microsoft.Build.Sql/${SQL_SDK_VERSION}">`,
        '  <PropertyGroup>',
        '    <Name>Loom.Schema</Name>',
        `    <DSP>${DSP[platform]}</DSP>`,
        '    <ModelCollation>1033, CI</ModelCollation>',
        '  </PropertyGroup>',
        '</Project>',
        '',
      ].join('\n'),
      'utf8',
    );
    for (const f of files) writeFileSync(join(dir, `${f.component ?? 'schema'}.sql`), declarativeDdl(read(f.path)), 'utf8');
    const r = await exec(dotnet.tool.path, ['build', join(dir, 'Loom.Schema.sqlproj'), '-nologo', '-v:minimal', '-p:NuGetAudit=false'], { cwd: dir, timeoutMs: ctx.timeoutMs });
    if (!r.ok) return outcome('UNKNOWN', `dotnet build (${platform}): ${r.reason}`);
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.status !== 0) {
      if (/NU1101|NU1102|NU1301|Unable to (load the service index|find package)|could not be resolved|MSB4236/i.test(text)) {
        return outcome('UNKNOWN', `the Microsoft.Build.Sql ${SQL_SDK_VERSION} SDK could not be restored for ${platform}: ${firstErrorLine(text)}`);
      }
      const errors = text.split(/\r?\n/).filter((l) => /error\s+SQL\d+|error\s+MSB\d+|: error /i.test(l)).slice(0, 5).map((l) => l.trim());
      return outcome('FAIL', `the generated DDL does not build for ${platform} (${DSP[platform]}): ${errors.join(' | ') || firstErrorLine(text)}`);
    }
    const dacpac = findFile(join(dir, 'bin'), /\.dacpac$/i);
    if (!dacpac) return outcome('UNKNOWN', `dotnet build exited 0 for ${platform} but produced no .dacpac`);
    reports.push(`${platform}: ${files.length} file(s) built into ${dacpac.split(/[\\/]/).pop()}`);
  }
  return outcome('PASS', `${reports.join('; ')} with Microsoft.Build.Sql ${SQL_SDK_VERSION} (the idempotent CREATE SCHEMA guard was rewritten to its declarative form)`, {
    tool: { name: 'dacfx', version: `Microsoft.Build.Sql ${SQL_SDK_VERSION}; dotnet ${dotnet.tool.version}` },
    instances: files.map((f) => f.instance),
  });
};

function findFile(dir: string, pattern: RegExp): string | null {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, pattern);
      if (hit) return hit;
    } else if (pattern.test(e.name)) return p;
  }
  return null;
}

// ---------- catalog conformance ----------

const sqlCatalog: Runner = async (ctx) => {
  if (!ctx.model.storage.length && !ctx.model.routines.some((r) => r.host === 'sql-procedure')) return outcome('NOT_APPLICABLE', 'the model has no storage record and no SQL procedure');
  return inDatabase(ctx, 'catalog', async (inst, db) => {
    const applied = await apply(ctx, inst, db, [...schemaScripts(ctx), ...procedureScripts(ctx, 'conforming')]);
    if (!applied.ok) return applied.result;
    const cat = await readCatalog(ctx, inst, db);
    if (!cat.ok) return outcome('UNKNOWN', cat.reason);
    const problems = [...storageMismatches(ctx.model.storage, cat.value, { exhaustive: true }), ...routineMismatches(ctx.model.routines, cat.value)];
    const tables = ctx.model.storage.length;
    const procs = ctx.model.routines.filter((r) => r.host === 'sql-procedure').length;
    return problems.length
      ? outcome('FAIL', `${problems.length} catalog difference(s): ${problems.slice(0, 8).join('; ')}`, { records: catalogRecords(ctx.model) })
      : outcome('PASS', `${tables} table(s) and ${procs} procedure(s) in the deployed catalog match the storage and routine records exactly`, { records: catalogRecords(ctx.model) });
  });
};

// ---------- behavioral execution of the contract tests ----------

const contractScripts = (ctx: RunnerContext) => filesOfTarget(ctx.artifacts, 'sql-contract-tests').map((f) => ({ label: f.instance, text: read(f.path) }));

async function runContractTests(ctx: RunnerContext, which: 'conforming' | 'violating'): Promise<{ exit: number; output: string } | { unknown: string } | { failed: RunnerOutcome }> {
  const inst = await runInstance(ctx);
  if (!inst.ok) return { unknown: inst.reason };
  const db = await createDatabase(ctx, inst.value, `behavior_${which}`);
  if (!db.ok) return { unknown: db.reason };
  try {
    const applied = await apply(ctx, inst.value, db.value, [...schemaScripts(ctx), ...procedureScripts(ctx, which)]);
    if (!applied.ok) return { failed: applied.result };
    const r = await runSql(ctx, inst.value, contractScripts(ctx).map((s) => s.text).join('\nGO\n'), db.value);
    if (!r.ok) return { unknown: r.reason };
    return { exit: r.status, output: `${r.stdout}\n${r.stderr}` };
  } finally {
    await dropDatabase(ctx, inst.value, db.value);
  }
}

const sqlBehavior: Runner = async (ctx) => {
  const tests = contractScripts(ctx);
  if (!tests.length) return outcome('NOT_APPLICABLE', 'no SQL contract tests are generated for this model');
  const inst = await runInstance(ctx);
  if (!inst.ok) return outcome('UNKNOWN', inst.reason);
  const tool = { name: 'sqlcmd', version: `${ctx.tool.version}; SQL Server ${inst.value.engineVersion}` };
  const conforming = await runContractTests(ctx, 'conforming');
  if ('unknown' in conforming) return outcome('UNKNOWN', `conforming run: ${conforming.unknown}`);
  if ('failed' in conforming) return conforming.failed;
  if (conforming.exit !== 0) {
    const t = throwMessage(conforming.output);
    return outcome('FAIL', `the contract tests fail against the conforming implementation with THROW ${String(t.code)}: ${t.message}`, { tool, boundaries: realBoundary });
  }
  const parts = [`conforming implementation passes ${tests.length} contract test file(s)`];
  if (ctx.fixtures.violating?.sql?.length) {
    const want = ctx.check.negativeControl ? Number(ctx.check.negativeControl.reason) : NaN;
    const violating = await runContractTests(ctx, 'violating');
    if ('unknown' in violating) return outcome('UNKNOWN', `violating run: ${violating.unknown}`);
    if ('failed' in violating) return violating.failed;
    const got = throwMessage(violating.output);
    if (violating.exit === 0) return outcome('FAIL', 'the contract tests accept the violating implementation, so they cannot fail', { tool, boundaries: realBoundary });
    if (Number.isFinite(want) && got.code !== want) return outcome('FAIL', `the violating implementation should raise THROW ${want} but raised ${String(got.code)} "${got.message}"`, { tool, boundaries: realBoundary });
    parts.push(`violating implementation raises THROW ${String(got.code)} "${got.message}"`);
  }
  return outcome('PASS', parts.join('; '), { tool, boundaries: realBoundary, records: ctx.model.routines.filter((r) => r.host === 'sql-procedure').map((r) => `routine:${r.id}`) });
};

// ---------- transaction rollback ----------

const INJECTED = 'LOOM_QUALIFY_INJECTED_FAILURE';

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return `N'${String(value).replace(/'/g, "''")}'`;
}

/** EXEC with a contract-conforming sample argument for every parameter, passed by name. */
function execStatement(model: Model, r: Routine): string {
  const index = indexModel(model);
  const { schema, name } = procedureName(r);
  const args = r.params.map((p) => `@${p.name} = ${literal(p.kind === 'decimal' || p.kind === 'string' || p.kind === 'enum' || p.kind === 'integer' || p.kind === 'number' || p.kind === 'boolean' || p.kind === 'uuid' || p.kind === 'date' || p.kind === 'datetime' ? sampleValue(index, p) : null)}`);
  return `EXEC [${schema}].[${name}]${args.length ? ` ${args.join(', ')}` : ''};`;
}

const countQuery = (tables: readonly Storage[]): string =>
  `SELECT (SELECT ${tables.map((s, i) => `(SELECT COUNT_BIG(*) FROM [${s.schema}].[${s.table}]) AS [t${i}]`).join(', ')} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS j;`;

const sqlTransaction: Runner = async (ctx) => {
  const storage = new Map(ctx.model.storage.map((s) => [s.id, s]));
  const routines = ctx.model.routines.filter((r) => r.host === 'sql-procedure' && (r.writes ?? []).length > 0);
  if (!routines.length) return outcome('NOT_APPLICABLE', 'no SQL procedure declares writes, so no transaction scope can be exercised');
  if (!ctx.fixtures.conforming?.sql?.length) return outcome('UNKNOWN', 'no procedure implementation was supplied to execute');
  return inDatabase(ctx, 'transaction', async (inst, db) => {
    const applied = await apply(ctx, inst, db, [...schemaScripts(ctx), ...procedureScripts(ctx, 'conforming')]);
    if (!applied.ok) return applied.result;
    const reports: string[] = [];
    for (const r of routines) {
      const writes = (r.writes ?? []).map((w) => storage.get(w.storage)).filter((s): s is Storage => s !== undefined);
      const scope = [...new Map([...(r.transactionScope ?? []).map((id) => storage.get(id)), ...writes].filter((s): s is Storage => s !== undefined).map((s) => [s.id, s])).values()];
      const last = writes[writes.length - 1]!;
      const counts = async (): Promise<number[] | string> => {
        const q = await queryJson<Record<string, number>>(ctx, inst, db, countQuery(scope));
        return q.ok ? scope.map((_s, i) => Number(q.value[`t${i}`])) : q.reason;
      };
      const before = await counts();
      if (typeof before === 'string') return outcome('UNKNOWN', before);
      // A CHECK that no row satisfies makes the routine's last declared write fail
      // inside its transaction; a trigger cannot be used, because a routine that
      // returns OUTPUT rows without INTO is rejected outright on a table with one.
      const inject = await runSql(ctx, inst, `ALTER TABLE [${last.schema}].[${last.table}] WITH NOCHECK ADD CONSTRAINT [${INJECTED}] CHECK (1 = 0);`, db);
      if (!inject.ok || inject.status !== 0) return outcome('UNKNOWN', `the failure could not be injected into [${last.schema}].[${last.table}]: ${inject.ok ? throwMessage(`${inject.stdout}\n${inject.stderr}`).message : inject.reason}`);
      const failing = await runSql(ctx, inst, `SET XACT_ABORT OFF;\n${execStatement(ctx.model, r)}`, db);
      if (!failing.ok) return outcome('UNKNOWN', failing.reason);
      const failText = `${failing.stdout}\n${failing.stderr}`;
      if (!failText.includes(INJECTED)) {
        return outcome('FAIL', `routine ${r.id} with sample arguments never wrote [${last.schema}].[${last.table}], its last declared write: ${failing.status === 0 ? 'it succeeded' : throwMessage(failText).message}`);
      }
      const after = await counts();
      if (typeof after === 'string') return outcome('UNKNOWN', after);
      const kept = scope.filter((_s, i) => after[i] !== before[i]);
      if (kept.length) return outcome('FAIL', `routine ${r.id} failed inside its transaction scope but left rows in ${kept.map((s) => `[${s.schema}].[${s.table}]`).join(', ')}`);
      // Left in place, the injected constraint would fail the valid call below and read as a defect of the routine.
      const removed = await runSql(ctx, inst, `ALTER TABLE [${last.schema}].[${last.table}] DROP CONSTRAINT [${INJECTED}];`, db);
      if (!removed.ok || removed.status !== 0) return outcome('UNKNOWN', `the injected failure could not be removed from [${last.schema}].[${last.table}]: ${removed.ok ? throwMessage(`${removed.stdout}\n${removed.stderr}`).message : removed.reason}`);
      const ok = await runSql(ctx, inst, execStatement(ctx.model, r), db);
      if (!ok.ok) return outcome('UNKNOWN', ok.reason);
      if (ok.status !== 0) return outcome('FAIL', `routine ${r.id} fails with sample arguments: ${throwMessage(`${ok.stdout}\n${ok.stderr}`).message}`);
      const committed = await counts();
      if (typeof committed === 'string') return outcome('UNKNOWN', committed);
      const missing = writes.filter((w) => committed[scope.indexOf(w)]! <= before[scope.indexOf(w)]!);
      if (missing.length) return outcome('FAIL', `routine ${r.id} succeeded but committed nothing to ${missing.map((s) => `[${s.schema}].[${s.table}]`).join(', ')}`);
      reports.push(`${r.id}: an injected failure on [${last.schema}].[${last.table}] left ${scope.length} table(s) unchanged, and a valid call committed`);
    }
    return outcome('PASS', reports.join('; '), { records: routines.map((r) => `routine:${r.id}`) });
  });
};

// ---------- migration ----------

function migrationStorage(model: Model, ref: { kind: string; id: string }): Storage[] {
  if (ref.kind === 'storage') return model.storage.filter((s) => s.id === ref.id);
  if (ref.kind === 'type') return model.storage.filter((s) => s.type === ref.id);
  return [];
}

const rowsQuery = (s: Storage): string =>
  `SELECT (SELECT ${s.columns.map((c) => `CONVERT(nvarchar(max), [${c.name}]) AS [${c.name}]`).join(', ')} FROM [${s.schema}].[${s.table}] ORDER BY ${s.primaryKey.map((k) => `[${k}]`).join(', ')} FOR JSON PATH, INCLUDE_NULL_VALUES) AS j;`;

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

async function runMigration(ctx: RunnerContext, fx: MigrationFixture): Promise<RunnerOutcome> {
  const candidate = fx.candidate ?? ctx.model;
  const mig = candidate.migrations.find((m) => m.id === fx.migration);
  if (!mig) return outcome('UNKNOWN', `the migration fixture names ${fx.migration}, which the model does not declare`);
  if (!mig.script) return outcome('UNKNOWN', `migration ${mig.id} names no authored script to execute`);
  const after = migrationStorage(candidate, mig.contract);
  const before = migrationStorage(fx.previous, mig.contract);
  if (!after.length || !before.length) return outcome('UNKNOWN', `migration ${mig.id} names ${mig.contract.kind} ${mig.contract.id}, which has no storage in both shapes`);
  const previousFiles = materialize(fx.previous, join(ctx.dir, `previous-${mig.id}`), { targets: ['sql'] }).files;
  return inDatabase(ctx, 'migration', async (inst, db) => {
    const applied = await apply(ctx, inst, db, [...schemaScripts(ctx, fx.previous, previousFiles), { label: `representative rows ${fx.rows}`, text: read(atRoot(ctx, fx.rows)) }]);
    if (!applied.ok) return applied.result;
    const snapshot = async (shape: readonly Storage[]): Promise<Array<Array<Record<string, string | null>>> | string> => {
      const out: Array<Array<Record<string, string | null>>> = [];
      for (const s of shape) {
        const q = await queryJson<Array<Record<string, string | null>> | Record<string, never>>(ctx, inst, db, rowsQuery(s));
        if (!q.ok) return q.reason;
        out.push(Array.isArray(q.value) ? q.value : []);
      }
      return out;
    };
    const old = await snapshot(before);
    if (typeof old === 'string') return outcome('UNKNOWN', old);
    const script = await apply(ctx, inst, db, [{ label: `migration script ${mig.script!}`, text: read(atRoot(ctx, mig.script!)) }]);
    if (!script.ok) return script.result;
    const cat = await readCatalog(ctx, inst, db);
    if (!cat.ok) return outcome('UNKNOWN', cat.reason);
    const shape = storageMismatches(after, cat.value);
    if (shape.length) return outcome('FAIL', `after migration ${mig.id} the catalog differs from the new storage: ${shape.slice(0, 6).join('; ')}`);
    const now = await snapshot(after);
    if (typeof now === 'string') return outcome('UNKNOWN', now);
    const problems: string[] = [];
    after.forEach((s, i) => {
      const was = old[i] ?? [];
      const is = now[i] ?? [];
      if (was.length !== is.length) problems.push(`[${s.schema}].[${s.table}] holds ${is.length} row(s), it held ${was.length}`);
      const shared = s.columns.filter((c) => before[i]!.columns.some((p) => p.name === c.name)).map((c) => c.name);
      for (const col of shared) {
        if (sorted(was.map((r) => String(r[col]))).join('|') !== sorted(is.map((r) => String(r[col]))).join('|')) problems.push(`[${s.schema}].[${s.table}].[${col}] values changed`);
      }
      for (const c of s.columns.filter((x) => !x.nullable && !shared.includes(x.name))) {
        if (is.some((r) => r[c.name] === null)) problems.push(`[${s.schema}].[${s.table}].[${c.name}] is NOT NULL but a migrated row has no value`);
      }
      for (const [col, value] of Object.entries(fx.expectColumns ?? {})) {
        const off = is.filter((r) => r[col] !== value);
        if (off.length) problems.push(`${off.length} migrated row(s) have ${col} other than ${value}`);
      }
      if (fx.expectValues && sorted(is.map((r) => String(r[fx.expectValues!.column]))).join('|') !== sorted(fx.expectValues.values).join('|')) {
        problems.push(`${fx.expectValues.column} holds ${is.map((r) => String(r[fx.expectValues!.column])).join(', ')}, not ${fx.expectValues.values.join(', ')}`);
      }
    });
    // A fixture with its own candidate model qualifies that model's migration; the run model's records and artifacts were not its inputs.
    const own = candidate === ctx.model;
    const inputs = own ? { records: [`migration:${mig.id}`] } : { records: [] as string[], instances: [] as string[] };
    return problems.length
      ? outcome('FAIL', `migration ${mig.id}: ${problems.join('; ')}`, inputs)
      : outcome('PASS', `migration ${mig.id} took ${old.reduce((n, t) => n + t.length, 0)} representative row(s) from the previous shape to the new one with every row and preserved value intact`, {
          ...inputs,
          claims: [{ kind: 'migration', ref: mig.id }],
        });
  });
}

const sqlMigration: Runner = async (ctx) => {
  const fixtures = ctx.fixtures.migrations ?? [];
  const declared = ctx.model.migrations.filter((m) => !fixtures.some((f) => (f.candidate ?? ctx.model) === ctx.model && f.migration === m.id));
  if (!fixtures.length && !ctx.model.migrations.length) return outcome('NOT_APPLICABLE', 'the model declares no migration');
  if (declared.length) return outcome('UNKNOWN', `migration(s) ${declared.map((m) => m.id).join(', ')} have no representative-data fixture, so they were not executed`);
  const reports: RunnerOutcome[] = [];
  for (const fx of fixtures) {
    const r = await runMigration(ctx, fx);
    if (r.result !== 'PASS') return r;
    reports.push(r);
  }
  return {
    ...reports[0]!,
    reason: reports.map((r) => r.reason).join('; '),
    records: reports.flatMap((r) => r.records ?? []),
    instances: reports.every((r) => r.instances) ? [] : reports[0]!.instances,
    claims: reports.flatMap((r) => r.claims ?? []),
  };
};

// ---------- operations ----------

const sqlOperations: Runner = async (ctx) => {
  if (!ctx.model.storage.length) return outcome('NOT_APPLICABLE', 'the model has no storage record');
  return inDatabase(ctx, 'operations', async (inst, db) => {
    const applied = await apply(ctx, inst, db, schemaScripts(ctx));
    if (!applied.ok) return applied.result;
    const file = join(ctx.dir, `${db}.bak`).replace(/'/g, "''");
    const backup = await runSql(ctx, inst, `BACKUP DATABASE [${db}] TO DISK = N'${file}' WITH INIT, CHECKSUM;\nRESTORE VERIFYONLY FROM DISK = N'${file}' WITH CHECKSUM;`);
    if (!backup.ok) return outcome('UNKNOWN', backup.reason);
    const text = `${backup.stdout}\n${backup.stderr}`;
    if (backup.status !== 0 || messageCodes(text).some((c) => c !== 3014)) return outcome('FAIL', `backup or verification failed: ${throwMessage(text).message}`);
    if (!/is valid/i.test(text)) return outcome('UNKNOWN', 'RESTORE VERIFYONLY did not report the backup set valid');
    const cat = await readCatalog(ctx, inst, db);
    if (!cat.ok) return outcome('UNKNOWN', cat.reason);
    const missing = storageMismatches(ctx.model.storage, cat.value).filter((m) => /\bindex\b/.test(m));
    const declared = ctx.model.storage.reduce((n, s) => n + (s.indexes ?? []).length, 0);
    return missing.length
      ? outcome('FAIL', `declared indexes are missing or differ: ${missing.join('; ')}`)
      : outcome('PASS', `the fixture database backs up and the backup verifies; ${declared} declared index(es) exist`, { records: ctx.model.storage.map((s) => `storage:${s.id}`) });
  });
};

export const SQL_RUNNERS: Readonly<Record<string, Runner>> = {
  'sql-parse': sqlParse,
  'sql-build': sqlBuild,
  'sql-catalog': sqlCatalog,
  'sql-behavior': sqlBehavior,
  'sql-transaction': sqlTransaction,
  'sql-migration': sqlMigration,
  'sql-operations': sqlOperations,
};

