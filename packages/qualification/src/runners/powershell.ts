import { isAbsolute, resolve } from 'node:path';
import { filesOfTarget } from '../artifacts.js';
import { psq, runPwsh } from '../exec.js';
import { outcome, type Runner, type RunnerContext } from '../types.js';
import { satisfies } from '../tools.js';

const atRoot = (ctx: RunnerContext, p: string): string => (isAbsolute(p) ? p : resolve(ctx.root, p));

const PARSE = (files: readonly string[]): string =>
  [
    `$results = foreach ($file in @(${files.map(psq).join(', ')})) {`,
    '    $tokens = $null; $errors = $null',
    '    [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref] $tokens, [ref] $errors)',
    '    [pscustomobject]@{ file = $file; errors = @($errors).Count; first = @($errors | Select-Object -First 3 | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" }) }',
    '}',
    '[pscustomobject]@{ version = $PSVersionTable.PSVersion.ToString(); results = @($results) } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');

const powershellParse: Runner = async (ctx) => {
  const files = filesOfTarget(ctx.artifacts, 'pester-contract-tests');
  if (!files.length) return outcome('NOT_APPLICABLE', 'no component declares a PowerShell implementation with a runbook or function routine');
  const r = await runPwsh(ctx.tool.path, PARSE(files.map((f) => f.path)), { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
  if (!r.ok) return outcome('UNKNOWN', r.reason);
  const results = (r.json['results'] ?? []) as Array<{ file: string; errors: number; first: string[] }>;
  if (results.length !== files.length) return outcome('UNKNOWN', `the parser reported ${results.length} of ${files.length} files`);
  const bad = results.filter((x) => x.errors > 0);
  return bad.length
    ? outcome('FAIL', bad.map((x) => `${files.find((f) => f.path === x.file)?.instance ?? x.file}: ${x.errors} parse error(s): ${x.first.join('; ')}`).join(' | '))
    : outcome('PASS', `${files.length} file(s) parse with 0 errors (pwsh ${String(r.json['version'])})`);
};

const RUN = (module: string, version: string, file: string, root: string): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    `Import-Module ${psq(module)} -RequiredVersion ${psq(version)} -Force`,
    `$container = New-PesterContainer -Path ${psq(file)} -Data @{ RoutineRoot = ${psq(root)} }`,
    '$r = Invoke-Pester -Container $container -PassThru -Output None',
    "$loaded = (Get-Module Pester | Select-Object -First 1).Version.ToString()",
    '[pscustomobject]@{ loaded = $loaded; passed = $r.PassedCount; failed = $r.FailedCount; result = [string]$r.Result; failedTests = @($r.Failed | ForEach-Object { $_.ExpandedName }) } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');

/**
 * The generated tests under the Pester version the check's policy selects.
 * Two Pester versions cannot share a session, so each run is a fresh pwsh,
 * and the version actually loaded is read back and must equal the one chosen.
 */
const pesterConformance: Runner = async (ctx) => {
  const files = filesOfTarget(ctx.artifacts, 'pester-contract-tests');
  if (!files.length) return outcome('NOT_APPLICABLE', 'no component declares a PowerShell implementation with a runbook or function routine');
  const conforming = ctx.fixtures.conforming?.powershellRoot;
  if (!conforming) return outcome('UNKNOWN', 'no routine root was supplied to run the generated Pester tests against');
  const desktop = ctx.check.runner === 'windows-pester-conformance';
  const pwsh = await ctx.tools(desktop ? 'powershell' : 'pwsh', desktop ? { major: 5, minimum: '5.1' } : { minimum: '7.4' });
  if (pwsh.status !== 'found') return outcome('UNKNOWN', `Pester runs in pwsh: ${pwsh.reason}`);
  let module = ctx.tool.path;
  let version = ctx.tool.version;
  if (desktop) {
    const discovery = await runPwsh(pwsh.tool.path, "[pscustomobject]@{edition=$PSVersionTable.PSEdition;version=$PSVersionTable.PSVersion.ToString();modules=@(Get-Module -ListAvailable Pester | ForEach-Object {[pscustomobject]@{version=$_.Version.ToString();path=$_.Path}})} | ConvertTo-Json -Compress -Depth 4", { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    if (!discovery.ok || discovery.json['edition'] !== 'Desktop' || !String(discovery.json['version']).startsWith('5.1')) return outcome('UNKNOWN', 'the declared Windows PowerShell 5.1 Desktop runtime is unavailable', { cause: 'version-policy' });
    const modules = (discovery.json['modules'] ?? []) as { version: string; path: string }[];
    const compatible = modules.filter((m) => satisfies(m.version, ctx.check.tool.versionPolicy)).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    if (!compatible) return outcome('UNKNOWN', 'no Pester version compatible with the declared Windows PowerShell 5.1 profile was found', { cause: 'tool-absent' });
    module = compatible.path; version = compatible.version;
  }
  const tool = { name: 'pester', version: `${version}; ${desktop ? 'Windows PowerShell Desktop' : 'PowerShell Core'} ${pwsh.tool.version}` };
  const run = async (file: string, root: string) => {
    const r = await runPwsh(pwsh.tool.path, RUN(module, version, file, atRoot(ctx, root)), { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    if (!r.ok) return { unknown: r.reason };
    const loaded = String(r.json['loaded']);
    if (loaded !== version) return { unknown: `Pester ${loaded} was loaded instead of the selected ${version}` };
    return { passed: Number(r.json['passed']), failed: Number(r.json['failed']), failedTests: (r.json['failedTests'] ?? []) as string[] };
  };
  const parts: string[] = [];
  for (const f of files) {
    const ok = await run(f.path, conforming);
    if ('unknown' in ok) return outcome('UNKNOWN', `${f.instance}: ${ok.unknown}`, { tool });
    if (!(ok.failed === 0 && ok.passed > 0)) return outcome('FAIL', `${f.instance} against the conforming routines: ${ok.passed} passed, ${ok.failed} failed (${ok.failedTests.join('; ')})`, { tool });
    let line = `${f.instance}: conforming ${ok.passed} passed`;
    const violating = ctx.fixtures.violating?.powershellRoot;
    if (violating) {
      const bad = await run(f.path, violating);
      if ('unknown' in bad) return outcome('UNKNOWN', `${f.instance} violating run: ${bad.unknown}`, { tool });
      if (bad.failed === 0) return outcome('FAIL', `${f.instance} accepts the violating routines, so the tests cannot fail`, { tool });
      line += `, violating ${bad.failed} failed (${bad.failedTests.join('; ')})`;
    }
    parts.push(line);
  }
  return outcome('PASS', `${parts.join('; ')} under Pester ${ctx.tool.version}`, {
    tool,
    records: ctx.model.routines.filter((r) => r.host !== 'sql-procedure').map((r) => `routine:${r.id}`),
  });
};

export const POWERSHELL_RUNNERS: Readonly<Record<string, Runner>> = {
  'powershell-parse': powershellParse,
  'pester-conformance': pesterConformance,
  'windows-pester-conformance': pesterConformance,
};
