import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

/**
 * Standard-tool proofs of the generated artifacts. Each probe reports PASS or
 * FAIL only when the tool actually ran; a tool that is absent, fails to load,
 * or returns no readable result yields UNKNOWN, never a pass. External tools
 * (pwsh, Pester, ScriptDom) are never installed: they are probed for and used
 * where already present. Probe (e) uses declared @loom/cli dependencies.
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
