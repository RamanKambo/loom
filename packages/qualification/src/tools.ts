import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolName, VersionPolicy } from '@loom/core';
import { exec, runPwsh, which } from './exec.js';

const requireHere = createRequire(import.meta.url);

/** A located tool: its executable (or loadable library) and the exact version it reports. */
export interface ToolInfo {
  name: ToolName;
  path: string;
  version: string;
}

export type ToolResolution =
  | { status: 'found'; tool: ToolInfo }
  | { status: 'missing'; reason: string }
  | { status: 'out-of-policy'; tool: ToolInfo; reason: string };

/** Finds a tool that satisfies a version policy. Tests inject one to simulate an absent or mismatched tool. */
export type ToolLocator = (name: ToolName, policy: VersionPolicy) => Promise<ToolResolution>;

/** The Microsoft.Build.Sql SDK the sql-build runner pins; it carries the DacFx build. */
export const SQL_SDK_VERSION = '2.3.0';

const PROBE_TIMEOUT_MS = 60_000;

const parts = (v: string): number[] => (v.match(/\d+/g) ?? []).map(Number);

function compare(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when a version meets every stated constraint of the policy; an unparseable version meets none. */
export function satisfies(version: string, policy: VersionPolicy): boolean {
  if (!/\d/.test(version)) return false;
  if (policy.major !== undefined && parts(version)[0] !== policy.major) return false;
  if (policy.minimum !== undefined && compare(version, policy.minimum) < 0) return false;
  if (policy.exact !== undefined) {
    const want = parts(policy.exact);
    const have = parts(version);
    if (want.some((n, i) => have[i] !== n)) return false;
  }
  return true;
}

export const policyText = (p: VersionPolicy): string =>
  [p.major !== undefined ? `major ${p.major}` : '', p.minimum ? `>= ${p.minimum}` : '', p.exact ? `= ${p.exact}` : ''].filter(Boolean).join(', ') || 'any version';

function judge(tool: ToolInfo, policy: VersionPolicy): ToolResolution {
  return satisfies(tool.version, policy)
    ? { status: 'found', tool }
    : { status: 'out-of-policy', tool, reason: `${tool.name} ${tool.version} at ${tool.path} does not satisfy the profile's version policy (${policyText(policy)})` };
}

function packageVersion(name: string): { path: string; version: string } | null {
  try {
    const pkgPath = requireHere.resolve(`${name}/package.json`);
    return { path: dirname(pkgPath), version: String((requireHere(pkgPath) as { version: string }).version) };
  } catch {
    return null;
  }
}

/** SqlLocalDB on PATH, else the newest Tools\Binn\SqlLocalDB.exe under Program Files\Microsoft SQL Server. */
export function findSqlLocalDb(): string | null {
  const onPath = which('SqlLocalDB');
  if (onPath) return onPath;
  const root = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft SQL Server');
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
    if (existsSync(exe)) return exe;
  }
  return null;
}

function findGo(): string | null {
  return which('go') ?? (existsSync('C:\\Program Files\\Go\\bin\\go.exe') ? 'C:\\Program Files\\Go\\bin\\go.exe' : null);
}

/** oasdiff on PATH, else in the Go workspace's bin directory, where `go install` places it. */
async function findOasdiff(): Promise<string | null> {
  const onPath = which('oasdiff');
  if (onPath) return onPath;
  const go = findGo();
  if (go) {
    const r = await exec(go, ['env', 'GOPATH'], { timeoutMs: PROBE_TIMEOUT_MS });
    if (r.ok) {
      for (const dir of r.stdout.trim().split(process.platform === 'win32' ? ';' : ':')) {
        const exe = join(dir.trim(), 'bin', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
        if (existsSync(exe)) return exe;
      }
    }
  }
  const fallback = join(homedir(), 'go', 'bin', process.platform === 'win32' ? 'oasdiff.exe' : 'oasdiff');
  return existsSync(fallback) ? fallback : null;
}

/** oasdiff built by `go install` reports 'main'; the module version is read from the binary's build information. */
async function oasdiffVersion(exe: string): Promise<string> {
  const go = findGo();
  if (go) {
    const r = await exec(go, ['version', '-m', exe], { timeoutMs: PROBE_TIMEOUT_MS });
    const m = r.ok ? /^\s*mod\s+github\.com\/oasdiff\/oasdiff\s+v?(\S+)/m.exec(r.stdout) : null;
    if (m) return m[1]!;
  }
  const r = await exec(exe, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
  const m = r.ok ? /version\s+v?(\d[\w.-]*)/i.exec(r.stdout) : null;
  return m ? m[1]! : 'unknown';
}

const SCRIPTDOM_SEARCH = [
  "$name = 'Microsoft.SqlServer.TransactSql.ScriptDom.dll'",
  '$candidates = [System.Collections.Generic.List[string]]::new()',
  'foreach ($root in ($env:PSModulePath -split [IO.Path]::PathSeparator)) {',
  '    if ($root -and (Test-Path -LiteralPath $root)) {',
  '        Get-ChildItem -LiteralPath $root -Recurse -File -Filter $name -ErrorAction SilentlyContinue | ForEach-Object { $candidates.Add($_.FullName) }',
  '    }',
  '}',
  "$pf = $env:ProgramFiles; $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')",
  '$globs = @(',
  '    (Join-Path $env:USERPROFILE ".nuget\\packages\\microsoft.sqlserver.transactsql.scriptdom\\*\\lib\\*\\$name"),',
  // The pinned Microsoft.Build.Sql SDK the sql.build check restores ships the same parser.
  '    (Join-Path $env:USERPROFILE ".nuget\\packages\\microsoft.build.sql\\*\\tools\\net8.0\\$name"),',
  '    "$pf\\Microsoft SQL Server\\*\\DAC\\bin\\$name", "$pf86\\Microsoft SQL Server\\*\\DAC\\bin\\$name",',
  '    "$pf\\Microsoft SQL Server Management Studio*\\Common7\\IDE\\$name", "$pf86\\Microsoft SQL Server Management Studio*\\Common7\\IDE\\$name"',
  ')',
  'foreach ($g in $globs) { if ($g -and -not $g.StartsWith("\\")) { Get-ChildItem -Path $g -File -ErrorAction SilentlyContinue | ForEach-Object { $candidates.Add($_.FullName) } } }',
  '$found = foreach ($dll in $candidates) { try { [pscustomobject]@{ path = $dll; version = [Reflection.AssemblyName]::GetAssemblyName($dll).Version.ToString() } } catch { } }',
  '[pscustomobject]@{ dlls = @($found) } | ConvertTo-Json -Compress -Depth 3',
].join('\n');

const PESTER_LIST = [
  "$m = @(Get-Module -ListAvailable -Name Pester | Sort-Object Version -Descending | ForEach-Object { [pscustomobject]@{ version = $_.Version.ToString(); path = $_.Path } })",
  '[pscustomobject]@{ modules = $m } | ConvertTo-Json -Compress -Depth 3',
].join('\n');

/**
 * The default locator: PATH, then the known install locations, with each
 * tool's own version report. Nothing is installed. Results are cached per
 * locator because several checks share one tool.
 */
export function defaultToolLocator(): ToolLocator {
  const cache = new Map<string, Promise<ToolInfo[] | string>>();

  /** Every installed candidate of a tool, or the reason none was found. */
  const candidates = (name: ToolName): Promise<ToolInfo[] | string> => {
    let p = cache.get(name);
    if (!p) {
      p = discover(name);
      cache.set(name, p);
    }
    return p;
  };

  async function discover(name: ToolName): Promise<ToolInfo[] | string> {
    switch (name) {
      case 'node':
        return [{ name, path: process.execPath, version: process.versions.node }];
      case 'tsc': {
        const pkg = packageVersion('typescript');
        return pkg ? [{ name, path: join(pkg.path, 'bin', 'tsc'), version: pkg.version }] : 'the typescript package is not installed';
      }
      case 'ajv':
      case 'mermaid':
      case 'swagger-parser': {
        const pkg = packageVersion(name === 'swagger-parser' ? '@apidevtools/swagger-parser' : name);
        return pkg ? [{ name, path: pkg.path, version: pkg.version }] : `the ${name} package is not installed`;
      }
      case 'dotnet': {
        const exe = which('dotnet');
        if (!exe) return 'dotnet is not on PATH';
        const r = await exec(exe, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
        return r.ok && r.status === 0 ? [{ name, path: exe, version: r.stdout.trim() }] : `dotnet --version failed: ${r.ok ? r.stderr.trim() : r.reason}`;
      }
      case 'dacfx': {
        const dotnet = await candidates('dotnet');
        if (typeof dotnet === 'string') return `the SQL database project build needs dotnet: ${dotnet}`;
        return [{ name, path: `Microsoft.Build.Sql/${SQL_SDK_VERSION}`, version: SQL_SDK_VERSION }];
      }
      case 'pwsh': {
        const exe = which('pwsh');
        if (!exe) return 'pwsh is not on PATH';
        const r = await runPwsh(exe, '[pscustomobject]@{ version = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress', { timeoutMs: PROBE_TIMEOUT_MS });
        return r.ok ? [{ name, path: exe, version: String(r.json['version']) }] : `pwsh did not report its version: ${r.reason}`;
      }
      case 'pester': {
        const pwsh = await candidates('pwsh');
        if (typeof pwsh === 'string') return `Pester needs pwsh: ${pwsh}`;
        const r = await runPwsh(pwsh[0]!.path, PESTER_LIST, { timeoutMs: PROBE_TIMEOUT_MS });
        if (!r.ok) return `the installed Pester modules could not be listed: ${r.reason}`;
        const modules = (r.json['modules'] ?? []) as Array<{ version: string; path: string }>;
        return modules.length ? modules.map((m) => ({ name, path: m.path, version: m.version })) : 'Pester is not installed';
      }
      case 'scriptdom': {
        const pwsh = await candidates('pwsh');
        if (typeof pwsh === 'string') return `ScriptDom is loaded through pwsh: ${pwsh}`;
        const r = await runPwsh(pwsh[0]!.path, SCRIPTDOM_SEARCH, { timeoutMs: PROBE_TIMEOUT_MS * 3 });
        if (!r.ok) return `the ScriptDom search failed: ${r.reason}`;
        const dlls = (r.json['dlls'] ?? []) as Array<{ path: string; version: string }>;
        return dlls.length ? dlls.map((d) => ({ name, path: d.path, version: d.version })).sort((a, b) => compare(b.version, a.version)) : 'Microsoft.SqlServer.TransactSql.ScriptDom was not found';
      }
      case 'sqlcmd': {
        const exe = which('sqlcmd');
        if (!exe) return 'sqlcmd is not on PATH';
        const r = await exec(exe, ['-?'], { timeoutMs: PROBE_TIMEOUT_MS });
        const m = r.ok ? /Version\s+([\d.]+)/i.exec(`${r.stdout}\n${r.stderr}`) : null;
        return m ? [{ name, path: exe, version: m[1]! }] : `sqlcmd did not report its version`;
      }
      case 'sqllocaldb': {
        const exe = findSqlLocalDb();
        if (!exe) return 'SqlLocalDB.exe was not found on PATH or under Program Files\\Microsoft SQL Server\\*\\Tools\\Binn';
        const r = await exec(exe, ['versions'], { timeoutMs: PROBE_TIMEOUT_MS });
        const m = r.ok ? /\(([\d.]+)\)/.exec(r.stdout) : null;
        return m ? [{ name, path: exe, version: m[1]! }] : `SqlLocalDB did not report an installed engine version`;
      }
      case 'oasdiff': {
        const exe = await findOasdiff();
        if (!exe) return 'oasdiff was not found on PATH or in the Go bin directory';
        return [{ name, path: exe, version: await oasdiffVersion(exe) }];
      }
      case 'git': {
        const exe = which('git');
        if (!exe) return 'git is not on PATH';
        const r = await exec(exe, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
        const m = r.ok ? /(\d+\.\d+[\d.]*)/.exec(r.stdout) : null;
        return m ? [{ name, path: exe, version: m[1]! }] : 'git did not report its version';
      }
    }
  }

  return async (name, policy) => {
    const found = await candidates(name);
    if (typeof found === 'string') return { status: 'missing', reason: found };
    const ok = found.filter((t) => satisfies(t.version, policy)).sort((a, b) => compare(b.version, a.version));
    if (ok.length) return { status: 'found', tool: ok[0]! };
    return judge(found[0]!, policy);
  };
}
