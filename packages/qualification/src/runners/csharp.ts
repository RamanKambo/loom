import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { exec, firstErrorLine } from '../exec.js';
import { outcome, type ArtifactFile, type Runner, type RunnerContext } from '../types.js';

const atRoot = (ctx: RunnerContext, p: string): string => (isAbsolute(p) ? p : resolve(ctx.root, p));

interface Instance {
  component: string;
  module: string;
  project: ArtifactFile;
  tests: ArtifactFile;
}

function instances(ctx: RunnerContext): Instance[] {
  const out: Instance[] = [];
  for (const project of ctx.artifacts.files.filter((f) => f.file === 'ContractTests.csproj')) {
    const tests = ctx.artifacts.files.find((f) => f.file === 'ContractTests.cs' && f.component === project.component);
    const component = ctx.model.components.find((c) => c.id === project.component);
    const module = component?.implementations?.find((i) => i.language === 'csharp')?.module;
    if (tests && module && project.component) out.push({ component: project.component, module, project, tests });
  }
  return out;
}

/**
 * Copies of the generated test project and of the implementation project in
 * the check directory. Building in place would write bin and obj into the
 * implementation's own tree; the copies keep every build inside the run.
 */
function stage(ctx: RunnerContext, inst: Instance, implementation: string, label: string): { project: string; implementation: string } {
  const dir = join(ctx.dir, `${inst.component}-${label}`);
  const testDir = join(dir, 'tests');
  mkdirSync(testDir, { recursive: true });
  cpSync(inst.project.path, join(testDir, 'ContractTests.csproj'));
  cpSync(inst.tests.path, join(testDir, 'ContractTests.cs'));
  const source = dirname(implementation);
  const implDir = join(dir, 'implementation');
  cpSync(source, implDir, { recursive: true, filter: (src) => !/[\\/](bin|obj)$/i.test(src) });
  return { project: join(testDir, 'ContractTests.csproj'), implementation: join(implDir, basename(implementation)) };
}

function implementationFor(ctx: RunnerContext, which: 'conforming' | 'violating', module: string): string | null {
  const p = ctx.fixtures[which]?.csharp?.[module];
  return p ? atRoot(ctx, p) : null;
}

const build = async (ctx: RunnerContext, project: string, implementation: string) =>
  exec(ctx.tool.path, ['build', project, '-nologo', '-v:minimal', `-p:LoomImplementationProject=${implementation}`, '-p:NuGetAudit=false'], { cwd: dirname(project), timeoutMs: ctx.timeoutMs, signal: ctx.signal });

const csharpBuild: Runner = async (ctx) => {
  const list = instances(ctx);
  if (!list.length) return outcome('NOT_APPLICABLE', 'no component declares a C# implementation with contract types');
  const parts: string[] = [];
  for (const inst of list) {
    const impl = implementationFor(ctx, 'conforming', inst.module);
    if (!impl) return outcome('UNKNOWN', `no implementation project was supplied for module ${inst.module}`);
    if (!existsSync(impl)) return outcome('UNKNOWN', `implementation project ${impl} does not exist`);
    const staged = stage(ctx, inst, impl, 'build');
    const r = await build(ctx, staged.project, staged.implementation);
    if (!r.ok) return outcome('UNKNOWN', `${inst.component}: ${r.reason}`);
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.status !== 0) {
      if (/NU1101|NU1102|NU1301|Unable to load the service index/i.test(text)) return outcome('UNKNOWN', `${inst.component}: the test packages could not be restored: ${firstErrorLine(text)}`);
      return outcome('FAIL', `${inst.component}: the generated tests do not build against ${inst.module}: ${firstErrorLine(text, /error/i)}`);
    }
    parts.push(`${inst.component} (${inst.module}) builds`);
  }
  return outcome('PASS', `${parts.join('; ')} with dotnet ${ctx.tool.version}`, { instances: list.flatMap((i) => [i.project.instance, i.tests.instance]) });
};

interface TrxCounts {
  total: number;
  passed: number;
  failed: number;
  failedTests: string[];
}

function readTrx(dir: string): TrxCounts | null {
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.trx')) : undefined;
  if (!file) return null;
  const xml = readFileSync(join(dir, file), 'utf8');
  const counters = /<Counters\s+([^>]*)\/>/.exec(xml);
  if (!counters) return null;
  const attr = (n: string): number => Number(new RegExp(`\\b${n}="(\\d+)"`).exec(counters[1]!)?.[1] ?? NaN);
  const failedTests = [...xml.matchAll(/<UnitTestResult[^>]*testName="([^"]+)"[^>]*outcome="Failed"/g)].map((m) => m[1]!);
  const c = { total: attr('total'), passed: attr('passed'), failed: attr('failed'), failedTests };
  return Number.isFinite(c.total) && Number.isFinite(c.passed) && Number.isFinite(c.failed) ? c : null;
}

async function test(ctx: RunnerContext, inst: Instance, implementation: string, label: string): Promise<TrxCounts | { unknown: string } | { buildFailed: string }> {
  const staged = stage(ctx, inst, implementation, label);
  const results = join(dirname(staged.project), 'results');
  const r = await exec(
    ctx.tool.path,
    ['test', staged.project, '-nologo', '-v:minimal', `-p:LoomImplementationProject=${staged.implementation}`, '-p:NuGetAudit=false', '--logger', 'trx;LogFileName=result.trx', '--results-directory', results],
    { cwd: dirname(staged.project), timeoutMs: ctx.timeoutMs, signal: ctx.signal },
  );
  if (!r.ok) return { unknown: r.reason };
  const counts = readTrx(results);
  if (counts) return counts;
  const text = `${r.stdout}\n${r.stderr}`;
  if (/error CS\d+|error MSB\d+/i.test(text)) return { buildFailed: firstErrorLine(text, /error/i) };
  return { unknown: `dotnet test exited ${r.status} without a readable result file: ${firstErrorLine(text)}` };
}

const csharpConformance: Runner = async (ctx) => {
  const list = instances(ctx);
  if (!list.length) return outcome('NOT_APPLICABLE', 'no component declares a C# implementation with contract types');
  const parts: string[] = [];
  for (const inst of list) {
    const impl = implementationFor(ctx, 'conforming', inst.module);
    if (!impl || !existsSync(impl)) return outcome('UNKNOWN', `no implementation project exists for module ${inst.module}`);
    const ok = await test(ctx, inst, impl, 'conforming');
    if ('unknown' in ok) return outcome('UNKNOWN', `${inst.component}: ${ok.unknown}`);
    if ('buildFailed' in ok) return outcome('FAIL', `${inst.component}: the generated tests do not build against ${inst.module}: ${ok.buildFailed}`);
    if (ok.failed !== 0 || ok.passed === 0) return outcome('FAIL', `${inst.component} against ${inst.module}: ${ok.passed} passed, ${ok.failed} failed (${ok.failedTests.slice(0, 5).join('; ')})`);
    let line = `${inst.component}: conforming ${ok.passed}/${ok.total} passed`;
    const bad = implementationFor(ctx, 'violating', inst.module);
    if (bad) {
      const v = await test(ctx, inst, bad, 'violating');
      if ('unknown' in v) return outcome('UNKNOWN', `${inst.component} violating run: ${v.unknown}`);
      if ('buildFailed' in v) line += `, violating does not build (${v.buildFailed})`;
      else if (v.failed === 0) return outcome('FAIL', `${inst.component}: the generated tests accept the violating implementation, so they cannot fail`);
      else line += `, violating ${v.failed} failed (${v.failedTests.slice(0, 3).join('; ')})`;
    }
    parts.push(line);
  }
  return outcome('PASS', `${parts.join('; ')} with dotnet ${ctx.tool.version}`, {
    instances: list.flatMap((i) => [i.project.instance, i.tests.instance]),
    records: ctx.model.types.filter((t) => list.some((i) => i.component === t.owner)).map((t) => `type:${t.id}`),
  });
};

export const CSHARP_RUNNERS: Readonly<Record<string, Runner>> = {
  'csharp-build': csharpBuild,
  'csharp-conformance': csharpConformance,
};
