import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Standard-tool proofs of the generated artifacts. Each probe reports PASS or
 * FAIL only when the tool actually ran; a tool that is absent, fails to load,
 * or returns no readable result yields UNKNOWN, never a pass. External tools
 * (pwsh, Pester, ScriptDom, SqlLocalDB, sqlcmd) are never installed: they are
 * probed for and used where already present. Probe (e) uses declared
 * @loom/cli dependencies (mermaid, jsdom) instead.
 */
export type ProbeStatus = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface ProbeResult {
  id: string;
  title: string;
  status: ProbeStatus;
  detail: string;
}

const requireFromHere = createRequire(import.meta.url);

/** A PowerShell single-quoted literal. */
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

type PwshResult = { ok: true; json: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Run a script in a fresh pwsh process. -EncodedCommand carries it verbatim, so
 * no shell quoting can alter it. The result is the last JSON line on stdout.
 */
function runPwsh(script: string): PwshResult {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 600_000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) {
    const code = (r.error as { code?: string }).code;
    return { ok: false, reason: code === 'ENOENT' ? 'pwsh is not on PATH' : r.error.message };
  }
  const line = (r.stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  if (!line) {
    const err = (r.stderr ?? '').trim().split(/\r?\n/)[0] ?? '';
    return { ok: false, reason: `pwsh returned no result (exit ${String(r.status)})${err ? `: ${err}` : ''}` };
  }
  try {
    return { ok: true, json: JSON.parse(line) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'pwsh result was not JSON' };
  }
}

/** (a) pwsh parses the generated Pester file with zero parse errors. */
export function probePesterParse(testFile: string): ProbeResult {
  const title = 'pwsh parses Routines.Contract.Tests.ps1';
  const r = runPwsh(
    [
      '$tokens = $null; $errors = $null',
      `try { [void][System.Management.Automation.Language.Parser]::ParseFile(${psq(testFile)}, [ref] $tokens, [ref] $errors) }`,
      'catch { [pscustomobject]@{ probeError = $_.Exception.Message } | ConvertTo-Json -Compress; return }',
      "if ($null -eq $errors) { [pscustomobject]@{ probeError = 'ParseFile returned no error list' } | ConvertTo-Json -Compress; return }",
      '[pscustomobject]@{',
      '    errors = $errors.Count',
      '    first = @($errors | Select-Object -First 3 | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" })',
      '    version = $PSVersionTable.PSVersion.ToString()',
      '} | ConvertTo-Json -Compress',
    ].join('\n'),
  );
  if (!r.ok) return { id: 'a', title, status: 'UNKNOWN', detail: r.reason };
  if (r.json['probeError'] !== undefined) return { id: 'a', title, status: 'UNKNOWN', detail: String(r.json['probeError']) };
  const errors = Number(r.json['errors']);
  const version = String(r.json['version']);
  if (errors === 0) return { id: 'a', title, status: 'PASS', detail: `0 parse errors (pwsh ${version})` };
  return { id: 'a', title, status: 'FAIL', detail: `${errors} parse error(s): ${String(r.json['first'])}` };
}

/**
 * (b) The generated tests run under each installed Pester major >= 5 (the
 * newest of each, one process per version because two Pester versions cannot
 * share a session): they must pass on examples/conforming and fail on
 * examples/violating.
 */
export function probePesterRun(testFile: string, examplesDir: string): ProbeResult {
  const title = 'Pester runs the contract tests against examples/';
  const listed = runPwsh(
    [
      "$modules = @(Get-Module -ListAvailable -Name Pester | Where-Object { $_.Version -ge [version]'5.0.0' } |",
      '    Group-Object { $_.Version.Major } | ForEach-Object { $_.Group | Sort-Object Version -Descending | Select-Object -First 1 } |',
      '    Sort-Object Version | ForEach-Object { [pscustomobject]@{ version = $_.Version.ToString(); path = $_.Path } })',
      '[pscustomobject]@{ modules = $modules } | ConvertTo-Json -Compress -Depth 4',
    ].join('\n'),
  );
  if (!listed.ok) return { id: 'b', title, status: 'UNKNOWN', detail: listed.reason };
  const modules = (listed.json['modules'] ?? []) as Array<{ version: string; path: string }>;
  if (modules.length === 0) return { id: 'b', title, status: 'UNKNOWN', detail: 'Pester 5 or later is not installed' };

  const reports: string[] = [];
  let failed = false;
  for (const m of modules) {
    const run = runPwsh(
      [
        "$ErrorActionPreference = 'Stop'",
        `Import-Module ${psq(m.path)} -Force`,
        '$runs = foreach ($fixture in @(\'conforming\', \'violating\')) {',
        `    $container = New-PesterContainer -Path ${psq(testFile)} -Data @{ RoutineRoot = (Join-Path ${psq(examplesDir)} $fixture) }`,
        '    $r = Invoke-Pester -Container $container -PassThru -Output None',
        '    [pscustomobject]@{ fixture = $fixture; passed = $r.PassedCount; failed = $r.FailedCount; failedTests = @($r.Failed | ForEach-Object { $_.ExpandedName }) }',
        '}',
        '[pscustomobject]@{ runs = @($runs) } | ConvertTo-Json -Compress -Depth 4',
      ].join('\n'),
    );
    if (!run.ok) return { id: 'b', title, status: 'UNKNOWN', detail: `Pester ${m.version}: ${run.reason}` };
    const runs = (run.json['runs'] ?? []) as Array<{ fixture: string; passed: number; failed: number; failedTests: string[] }>;
    const conforming = runs.find((x) => x.fixture === 'conforming');
    const violating = runs.find((x) => x.fixture === 'violating');
    if (!conforming || !violating) return { id: 'b', title, status: 'UNKNOWN', detail: `Pester ${m.version}: incomplete result` };
    const ok = conforming.failed === 0 && conforming.passed > 0 && violating.failed > 0;
    if (!ok) failed = true;
    reports.push(
      `Pester ${m.version}: conforming ${conforming.passed} passed/${conforming.failed} failed, ` +
        `violating ${violating.failed} failed (${violating.failedTests.join('; ')})`,
    );
  }
  return { id: 'b', title, status: failed ? 'FAIL' : 'PASS', detail: reports.join('; ') };
}

/**
 * (c) Parse SQL files with Microsoft.SqlServer.TransactSql.ScriptDom, using the
 * newest TSqlNNNParser of the first loadable copy found on PSModulePath or in
 * the usual NuGet, DacFx, SSMS, Visual Studio and Azure Data Studio locations.
 */
export function probeScriptDom(sqlFiles: string[]): ProbeResult {
  const title = 'ScriptDom parses schema.sql and contract-tests.sql';
  const files = `@(${sqlFiles.map(psq).join(', ')})`;
  const r = runPwsh(
    [
      "$name = 'Microsoft.SqlServer.TransactSql.ScriptDom.dll'",
      '$candidates = [System.Collections.Generic.List[string]]::new()',
      'foreach ($root in ($env:PSModulePath -split [IO.Path]::PathSeparator)) {',
      '    if ($root -and (Test-Path -LiteralPath $root)) {',
      '        Get-ChildItem -LiteralPath $root -Recurse -File -Filter $name -ErrorAction SilentlyContinue | ForEach-Object { $candidates.Add($_.FullName) }',
      '    }',
      '}',
      '$pf = $env:ProgramFiles; $pf86 = [Environment]::GetEnvironmentVariable(\'ProgramFiles(x86)\')',
      '$globs = @(',
      '    (Join-Path $env:USERPROFILE ".nuget\\packages\\microsoft.sqlserver.transactsql.scriptdom\\*\\lib\\*\\$name"),',
      '    "$pf\\Microsoft SQL Server\\*\\DAC\\bin\\$name", "$pf86\\Microsoft SQL Server\\*\\DAC\\bin\\$name",',
      '    "$pf\\Microsoft SQL Server Management Studio*\\Common7\\IDE\\$name", "$pf86\\Microsoft SQL Server Management Studio*\\Common7\\IDE\\$name",',
      '    "$pf\\Microsoft Visual Studio\\*\\*\\Common7\\IDE\\Extensions\\Microsoft\\SQLDB\\DAC\\$name",',
      '    "$pf\\Azure Data Studio\\resources\\app\\extensions\\*\\*\\$name"',
      ')',
      'foreach ($g in $globs) { if ($g -and -not $g.StartsWith("\\")) { Get-ChildItem -Path $g -File -ErrorAction SilentlyContinue | ForEach-Object { $candidates.Add($_.FullName) } } }',
      'if ($candidates.Count -eq 0) { [pscustomobject]@{ found = $false } | ConvertTo-Json -Compress; return }',
      '$loaded = $null; $loadError = $null',
      'foreach ($dll in $candidates) { try { Add-Type -Path $dll -ErrorAction Stop; $loaded = $dll; break } catch { $loadError = $_.Exception.Message } }',
      'if (-not $loaded) { [pscustomobject]@{ found = $true; loaded = $false; error = $loadError } | ConvertTo-Json -Compress; return }',
      "$asm = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq 'Microsoft.SqlServer.TransactSql.ScriptDom' } | Select-Object -First 1",
      "$parserType = $asm.GetExportedTypes() | Where-Object { $_.Name -match '^TSql\\d+Parser$' } | Sort-Object { [int]($_.Name -replace '\\D', '') } | Select-Object -Last 1",
      // -ArgumentList binds initialQuotedIdentifiers; [Activator]::CreateInstance($t, $true)
      // would bind the (Type, bool nonPublic) overload instead.
      '$parser = New-Object -TypeName $parserType.FullName -ArgumentList $true',
      `$results = foreach ($file in ${files}) {`,
      '    $errs = $null',
      '    try { [void]$parser.Parse([IO.StringReader]::new([IO.File]::ReadAllText($file)), [ref] $errs) }',
      '    catch { [pscustomobject]@{ file = (Split-Path -Leaf $file); probeError = $_.Exception.Message }; continue }',
      "    if ($null -eq $errs) { [pscustomobject]@{ file = (Split-Path -Leaf $file); probeError = 'the parser returned no error list' }; continue }",
      '    [pscustomobject]@{ file = (Split-Path -Leaf $file); errors = $errs.Count; first = @($errs | Select-Object -First 3 | ForEach-Object { "line $($_.Line): $($_.Message)" }) }',
      '}',
      '[pscustomobject]@{ found = $true; loaded = $true; assembly = $asm.GetName().Version.ToString(); parser = $parserType.Name; results = @($results) } | ConvertTo-Json -Compress -Depth 4',
    ].join('\n'),
  );
  if (!r.ok) return { id: 'c', title, status: 'UNKNOWN', detail: r.reason };
  if (r.json['found'] !== true) {
    return { id: 'c', title, status: 'UNKNOWN', detail: 'Microsoft.SqlServer.TransactSql.ScriptDom was not found' };
  }
  if (r.json['loaded'] !== true) {
    return { id: 'c', title, status: 'UNKNOWN', detail: `ScriptDom found but did not load: ${String(r.json['error'])}` };
  }
  const results = (r.json['results'] ?? []) as Array<{ file: string; errors: number; first: string[]; probeError?: string }>;
  const via = `${String(r.json['parser'])}, ScriptDom ${String(r.json['assembly'])}`;
  if (results.length !== sqlFiles.length) return { id: 'c', title, status: 'UNKNOWN', detail: `incomplete result (${via})` };
  const broken = results.filter((x) => x.probeError !== undefined);
  if (broken.length) {
    return { id: 'c', title, status: 'UNKNOWN', detail: broken.map((x) => `${x.file}: ${String(x.probeError)}`).join('; ') };
  }
  const bad = results.filter((x) => x.errors > 0);
  if (bad.length === 0) {
    return { id: 'c', title, status: 'PASS', detail: `${results.map((x) => `${x.file} 0 errors`).join(', ')} (${via})` };
  }
  return {
    id: 'c',
    title,
    status: 'FAIL',
    detail: bad.map((x) => `${x.file} ${x.errors} error(s): ${x.first.join('; ')}`).join(' | '),
  };
}

/**
 * A mermaid error in one line: its first line names the position and its last
 * the expectation ("Parse error on line 3: ... Expecting 'X', got 'EOF'").
 */
function mermaidError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const lines = e.message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 1 ? `${lines[0]} ${lines[lines.length - 1]}` : (lines[0] ?? e.name);
}

/** Every ```mermaid fenced code block in a Markdown document, in document order. */
export function mermaidBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```mermaid\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) blocks.push(m[1]);
  return blocks;
}

/**
 * Deliberately malformed: an unterminated composite `state` block. mermaid's
 * own grammar rejects it (confirmed by running it), so this is the negative
 * control that proves the probe can fail and not only ever pass.
 */
const BROKEN_DIAGRAM = ['stateDiagram-v2', '    state s0 {', '        s0a --> s0b'].join('\n');

/**
 * (e) `mermaid.parse()` parses every Mermaid diagram Loom projects into the
 * given Markdown files, and rejects a deliberately malformed diagram.
 * `@mermaid-js/parser` does not cover `stateDiagram-v2` or `flowchart`, so
 * this uses the full `mermaid` package; its diagram detection depends on
 * DOMPurify, which needs a `document`, so `jsdom` supplies one. No network
 * call and no Chromium download: both run as plain Node modules. `mermaid`
 * and `jsdom` are declared `@loom/cli` dependencies rather than probed-for
 * external tools, but a load failure still yields UNKNOWN rather than a pass,
 * per this module's probe convention.
 */
export async function probeMermaid(files: Record<string, string>): Promise<ProbeResult> {
  const id = 'e';
  const title = 'mermaid.parse() parses every projected Mermaid diagram';

  let mermaidVersion: string;
  let jsdomVersion: string;
  let parse: (text: string) => Promise<unknown>;
  try {
    mermaidVersion = String(requireFromHere('mermaid/package.json').version);
    jsdomVersion = String(requireFromHere('jsdom/package.json').version);
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    const g = globalThis as unknown as { window?: unknown; document?: unknown };
    g.window = dom.window;
    g.document = dom.window.document;
    const mermaid = (await import('mermaid')).default;
    parse = (text: string) => mermaid.parse(text) as Promise<unknown>;
  } catch (e) {
    return { id, title, status: 'UNKNOWN', detail: `mermaid or jsdom did not load: ${e instanceof Error ? e.message : String(e)}` };
  }

  const diagrams: Array<{ file: string; text: string }> = [];
  for (const [file, markdown] of Object.entries(files)) {
    for (const text of mermaidBlocks(markdown)) diagrams.push({ file, text });
  }
  if (diagrams.length === 0) {
    return { id, title, status: 'FAIL', detail: `no \`\`\`mermaid block found in ${Object.keys(files).join(', ')}` };
  }

  const failed: string[] = [];
  for (const d of diagrams) {
    try {
      await parse(d.text);
    } catch (e) {
      failed.push(`${d.file}: ${mermaidError(e)}`);
    }
  }

  let rejectedBroken = false;
  let rejection = 'the deliberately malformed diagram was not rejected';
  try {
    await parse(BROKEN_DIAGRAM);
  } catch (e) {
    rejectedBroken = true;
    rejection = mermaidError(e);
  }

  const via = `mermaid ${mermaidVersion} + jsdom ${jsdomVersion}`;
  if (failed.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: `${failed.length} of ${diagrams.length} diagram(s) failed to parse (${via}): ${failed.join('; ')}`,
    };
  }
  if (!rejectedBroken) {
    return { id, title, status: 'FAIL', detail: `${diagrams.length} diagram(s) parsed OK (${via}), but ${rejection}` };
  }
  return {
    id,
    title,
    status: 'PASS',
    detail: `${diagrams.length} diagram(s) parsed across ${Object.keys(files).length} file(s) (${via}); rejected the malformed negative control: ${rejection}`,
  };
}

const LOCALDB_INSTANCE = '(localdb)\\MSSQLLocalDB';

/**
 * The one contract probe (f) deliberately breaks: the violating fixture
 * returns status before order_id, so the generated contract-tests.sql must
 * raise this exact THROW code (sql.ts fail(50005, 'first result set columns
 * differ from the contract...')).
 */
const EXPECTED_VIOLATION_CODE = 50005;

export interface LocalDbPaths {
  /** Paths to the projected per-component schema.sql files, in foreign-key deployment order. */
  schemaSql: string[];
  /** Paths to the projected per-component contract-tests.sql files. */
  contractTestsSql: string[];
  /** Path to examples/conforming/ordering/sp_place_order.sql. */
  conformingFixture: string;
  /** Path to examples/violating/ordering/sp_place_order.sql. */
  violatingFixture: string;
}

export interface LocalDbOverrides {
  /** Override SqlLocalDB.exe discovery; a nonexistent path proves the UNKNOWN path without uninstalling LocalDB. */
  sqlLocalDbExe?: string;
  /** Override the sqlcmd executable name/path; a nonexistent one proves the UNKNOWN path without removing it from PATH. */
  sqlcmdExe?: string;
}

type ExecResult =
  | { ok: true; status: number | null; stdout: string; stderr: string }
  | { ok: false; reason: string };

function runExe(exe: string, args: string[], timeoutMs: number): ExecResult {
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) {
    const code = (r.error as { code?: string }).code;
    return { ok: false, reason: code === 'ENOENT' ? `${exe} was not found` : r.error.message };
  }
  if (r.status === null) return { ok: false, reason: `${exe} timed out or was killed (signal ${String(r.signal)})` };
  return { ok: true, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `SqlLocalDB` on PATH, else the newest `Tools\Binn\SqlLocalDB.exe` under `%ProgramFiles%\Microsoft SQL Server\*`. */
function resolveSqlLocalDb(override: string | undefined): { exe: string; via: string } | null {
  if (override !== undefined) return { exe: override, via: 'override' };
  const where = spawnSync('where', ['SqlLocalDB'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (!where.error && where.status === 0) {
    const first = (where.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (first) return { exe: first, via: 'PATH' };
  }
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const root = join(programFiles, 'Microsoft SQL Server');
  let versions: string[] = [];
  try {
    versions = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    return null;
  }
  for (const v of versions) {
    const exe = join(root, v, 'Tools', 'Binn', 'SqlLocalDB.exe');
    if (existsSync(exe)) return { exe, via: `Microsoft SQL Server\\${v}\\Tools\\Binn` };
  }
  return null;
}

/**
 * `SqlLocalDB info MSSQLLocalDB`; starts the instance if it exists but is not
 * running. `startedByUs` tells the caller whether to leave the instance
 * running (it already was) or stop it again once the probe is done, so
 * LocalDB stays dormant between self-test runs.
 */
function ensureLocalDbRunning(exe: string, timeoutMs: number): { ok: true; startedByUs: boolean } | { ok: false; reason: string } {
  const info = runExe(exe, ['info', 'MSSQLLocalDB'], timeoutMs);
  if (!info.ok) return { ok: false, reason: info.reason };
  if (info.status !== 0) {
    const line = (info.stderr || info.stdout).trim().split(/\r?\n/)[0] ?? '';
    return { ok: false, reason: `SqlLocalDB info MSSQLLocalDB exited ${String(info.status)}: ${line}` };
  }
  if (/State:\s*Running/i.test(info.stdout)) return { ok: true, startedByUs: false };
  const start = runExe(exe, ['start', 'MSSQLLocalDB'], timeoutMs);
  if (!start.ok) return { ok: false, reason: `instance MSSQLLocalDB is not running: ${start.reason}` };
  if (start.status !== 0) {
    const line = (start.stderr || start.stdout).trim().split(/\r?\n/)[0] ?? '';
    return { ok: false, reason: `instance MSSQLLocalDB would not start: ${line}` };
  }
  return { ok: true, startedByUs: true };
}

/** `SqlLocalDB stop MSSQLLocalDB`; best-effort, so a stop failure is reported, not thrown. */
function stopLocalDb(exe: string, timeoutMs: number): { ok: true } | { ok: false; reason: string } {
  const stop = runExe(exe, ['stop', 'MSSQLLocalDB'], timeoutMs);
  if (!stop.ok) return { ok: false, reason: stop.reason };
  if (stop.status !== 0) {
    const line = (stop.stderr || stop.stdout).trim().split(/\r?\n/)[0] ?? '';
    return { ok: false, reason: `SqlLocalDB stop MSSQLLocalDB exited ${String(stop.status)}: ${line}` };
  }
  return { ok: true };
}

/** Run a batch of T-SQL text through sqlcmd -b, as a throwaway file so no shell quoting is involved. */
function runSqlBatch(sqlcmdExe: string, sql: string, timeoutMs: number): ExecResult {
  const file = join(tmpdir(), `loom-localdb-${randomBytes(6).toString('hex')}.sql`);
  writeFileSync(file, sql, 'utf8');
  try {
    return runExe(sqlcmdExe, ['-S', LOCALDB_INSTANCE, '-b', '-i', file], timeoutMs);
  } finally {
    rmSync(file, { force: true });
  }
}

/** The first `Msg <n>, Level ..., State ...` line in sqlcmd output, with the message text that follows it. */
function throwMessage(output: string): { code: number | null; message: string } {
  const m = /Msg (\d+), Level \d+, State \d+,[^\n]*\r?\n(.+)/.exec(output);
  if (m) return { code: Number(m[1]), message: m[2].trim() };
  const last = output.trim().split(/\r?\n/).pop() ?? '';
  return { code: null, message: last };
}

function dbCreateHeader(name: string): string {
  return [
    `IF DB_ID(N'${name}') IS NOT NULL`,
    'BEGIN',
    `    ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`,
    `    DROP DATABASE [${name}];`,
    'END',
    'GO',
    `CREATE DATABASE [${name}];`,
    'GO',
    `USE [${name}];`,
    'GO',
  ].join('\n');
}

function dropDb(sqlcmdExe: string, name: string, timeoutMs: number): void {
  const sql = [
    `IF DB_ID(N'${name}') IS NOT NULL`,
    'BEGIN',
    `    ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`,
    `    DROP DATABASE [${name}];`,
    'END',
  ].join('\n');
  runSqlBatch(sqlcmdExe, sql, timeoutMs);
}

/** Every `loom_%` database currently on the instance, or null if the query itself could not run. */
function leftoverLoomDatabases(sqlcmdExe: string, timeoutMs: number): string[] | null {
  const r = runExe(
    sqlcmdExe,
    ['-S', LOCALDB_INSTANCE, '-b', '-h', '-1', '-W', '-Q', "SET NOCOUNT ON; SELECT name FROM sys.databases WHERE name LIKE 'loom\\_%' ESCAPE '\\';"],
    timeoutMs,
  );
  if (!r.ok || r.status !== 0) return null;
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/rows affected/i.test(l) && !/^-+$/.test(l));
}

/**
 * (f) Proves contract-tests.sql against a real SQL Server: for each of the
 * conforming and violating `ordering.sp_place_order` fixtures, creates a
 * throwaway `loom_selftest_*` database on a local SqlLocalDB instance, applies
 * the projected schema.sql, applies the fixture procedure, then runs the
 * projected contract-tests.sql with `sqlcmd -b` and always drops the database
 * afterwards. SqlLocalDB and sqlcmd are external tools nothing in this
 * repository installs; either missing, or the instance refusing to start,
 * yields UNKNOWN. PASS requires the conforming run to exit 0 and the
 * violating run to raise exactly `EXPECTED_VIOLATION_CODE`. LocalDB stays
 * dormant between runs: if the `MSSQLLocalDB` instance was stopped and this
 * probe started it, it stops it again when done, pass or fail; if it was
 * already running, it is left running. Nothing persists either way: every
 * database is created and dropped per fixture run.
 */
export function probeLocalDb(paths: LocalDbPaths, overrides: LocalDbOverrides = {}): ProbeResult {
  const id = 'f';
  const title = 'LocalDB proves contract-tests.sql against a real database';
  const timeoutMs = 60_000;
  const sqlcmdExe = overrides.sqlcmdExe ?? 'sqlcmd';

  const localDb = resolveSqlLocalDb(overrides.sqlLocalDbExe);
  if (!localDb) {
    return {
      id,
      title,
      status: 'UNKNOWN',
      detail: 'SqlLocalDB.exe was not found on PATH or under %ProgramFiles%\\Microsoft SQL Server\\*\\Tools\\Binn',
    };
  }
  const running = ensureLocalDbRunning(localDb.exe, timeoutMs);
  if (!running.ok) {
    return { id, title, status: 'UNKNOWN', detail: `${localDb.exe} (${localDb.via}): ${running.reason}` };
  }

  // LocalDB stays dormant between runs: run the checks first, then — pass or
  // fail — stop the instance again if this probe is the one that started it.
  // If it was already running, leave it running either way.
  const result = runLocalDbChecks(id, title, sqlcmdExe, localDb, paths, timeoutMs);
  const lifecycle = running.startedByUs
    ? describeLifecycle(true, stopLocalDb(localDb.exe, timeoutMs))
    : describeLifecycle(false, null);
  return { ...result, detail: `${result.detail} (${lifecycle})` };
}

/** Describes what happened to the instance's running state, for the probe detail. */
function describeLifecycle(startedByUs: boolean, stop: { ok: true } | { ok: false; reason: string } | null): string {
  if (!startedByUs) return 'MSSQLLocalDB was already running; left it running';
  if (stop === null) return 'started MSSQLLocalDB; stop pending';
  if (stop.ok) return 'started MSSQLLocalDB for this probe and stopped it again';
  return `started MSSQLLocalDB for this probe but could not stop it afterwards: ${stop.reason}`;
}

function runLocalDbChecks(
  id: string,
  title: string,
  sqlcmdExe: string,
  localDb: { exe: string; via: string },
  paths: LocalDbPaths,
  timeoutMs: number,
): ProbeResult {
  const versionQuery = runExe(
    sqlcmdExe,
    [
      '-S',
      LOCALDB_INSTANCE,
      '-b',
      '-h',
      '-1',
      '-W',
      '-Q',
      "SET NOCOUNT ON; SELECT CONVERT(nvarchar(100), SERVERPROPERTY('ProductVersion')) + N' ' + CONVERT(nvarchar(100), SERVERPROPERTY('Edition'));",
    ],
    timeoutMs,
  );
  if (!versionQuery.ok) return { id, title, status: 'UNKNOWN', detail: versionQuery.reason };
  if (versionQuery.status !== 0) {
    return {
      id,
      title,
      status: 'UNKNOWN',
      detail: `sqlcmd could not connect to ${LOCALDB_INSTANCE}: ${(versionQuery.stderr || versionQuery.stdout).trim().split(/\r?\n/)[0] ?? ''}`,
    };
  }
  const serverVersion = versionQuery.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? 'unknown';

  let schemaSql: string;
  let contractTestsSql: string;
  let conformingFixture: string;
  let violatingFixture: string;
  try {
    schemaSql = paths.schemaSql.map((p) => readFileSync(p, 'utf8')).join('\n');
    contractTestsSql = paths.contractTestsSql.map((p) => readFileSync(p, 'utf8')).join('\n');
    conformingFixture = readFileSync(paths.conformingFixture, 'utf8');
    violatingFixture = readFileSync(paths.violatingFixture, 'utf8');
  } catch (e) {
    return { id, title, status: 'UNKNOWN', detail: `could not read a fixture or projected file: ${e instanceof Error ? e.message : String(e)}` };
  }

  function runFixture(fixtureSql: string): { exitCode: number | null; output: string } | { unknown: string } {
    const name = `loom_selftest_${randomBytes(6).toString('hex')}`;
    const script = [dbCreateHeader(name), schemaSql, fixtureSql, contractTestsSql].join('\n');
    try {
      const r = runSqlBatch(sqlcmdExe, script, timeoutMs);
      if (!r.ok) return { unknown: r.reason };
      return { exitCode: r.status, output: `${r.stdout}\n${r.stderr}` };
    } finally {
      dropDb(sqlcmdExe, name, timeoutMs);
    }
  }

  const conforming = runFixture(conformingFixture);
  if ('unknown' in conforming) return { id, title, status: 'UNKNOWN', detail: `conforming run: ${conforming.unknown}` };
  const violating = runFixture(violatingFixture);
  if ('unknown' in violating) return { id, title, status: 'UNKNOWN', detail: `violating run: ${violating.unknown}` };

  const leftover = leftoverLoomDatabases(sqlcmdExe, timeoutMs);
  const via = `sqlcmd + SqlLocalDB ${localDb.via} (${serverVersion})`;

  if (conforming.exitCode !== 0) {
    const msg = throwMessage(conforming.output);
    return {
      id,
      title,
      status: 'FAIL',
      detail: `conforming fixture should exit 0 but exited ${String(conforming.exitCode)} (${via}): ${msg.message}`,
    };
  }
  const violatingThrow = throwMessage(violating.output);
  if (violating.exitCode === 0 || violatingThrow.code !== EXPECTED_VIOLATION_CODE) {
    return {
      id,
      title,
      status: 'FAIL',
      detail:
        violating.exitCode === 0
          ? `violating fixture should fail with THROW ${EXPECTED_VIOLATION_CODE} but exited 0 (${via})`
          : `violating fixture should raise THROW ${EXPECTED_VIOLATION_CODE} but raised ${String(violatingThrow.code)} "${violatingThrow.message}" (${via})`,
    };
  }
  if (leftover && leftover.length > 0) {
    return {
      id,
      title,
      status: 'FAIL',
      detail: `conforming and violating ran correctly, but ${leftover.length} loom_* database(s) were left behind: ${leftover.join(', ')} (${via})`,
    };
  }

  return {
    id,
    title,
    status: 'PASS',
    detail:
      `conforming exits 0; violating raises THROW ${violatingThrow.code} "${violatingThrow.message}"; ` +
      `0 loom_* database(s) remain on ${LOCALDB_INSTANCE} (${via})`,
  };
}
