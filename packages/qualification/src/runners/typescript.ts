import { createRequire } from 'node:module';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { exec, firstErrorLine } from '../exec.js';
import { outcome, type ArtifactFile, type Runner, type RunnerContext } from '../types.js';

const requireHere = createRequire(import.meta.url);
const atRoot = (ctx: RunnerContext, p: string): string => (isAbsolute(p) ? p : resolve(ctx.root, p));
const posix = (p: string): string => p.split('\\').join('/');

interface Instance {
  component: string;
  module: string;
  tests: ArtifactFile;
}

function instances(ctx: RunnerContext): Instance[] {
  return ctx.artifacts.files
    .filter((f) => f.file === 'contract.test.ts' && f.component)
    .flatMap((tests) => {
      const module = ctx.model.components.find((c) => c.id === tests.component)?.implementations?.find((i) => i.language === 'typescript')?.module;
      return module ? [{ component: tests.component!, module, tests }] : [];
    });
}

/** Directory holding @types/node, so the generated tests type-check their node:test and node:assert imports. */
function typeRoots(): string[] {
  try {
    return [dirname(dirname(requireHere.resolve('@types/node/package.json')))];
  } catch {
    return [];
  }
}

interface Staged {
  dir: string;
  out: string;
}

/**
 * The generated test and a copy of the implementation, with a tsconfig whose
 * `paths` maps the module name to the copy for compilation, and a package
 * under out/node_modules that maps the same name for Node at run time. The
 * generated file itself names no path.
 */
function stage(ctx: RunnerContext, inst: Instance, entry: string, label: string): Staged {
  const dir = join(ctx.dir, `${inst.component}-${label}`);
  mkdirSync(join(dir, 'impl'), { recursive: true });
  cpSync(inst.tests.path, join(dir, 'contract.test.ts'));
  cpSync(entry, join(dir, 'impl', 'index.ts'));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          rootDir: '.',
          outDir: 'out',
          types: ['node'],
          typeRoots: typeRoots(),
          paths: { [inst.module]: ['./impl/index.ts'] },
        },
        files: ['contract.test.ts', 'impl/index.ts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n', 'utf8');
  const out = join(dir, 'out');
  const pkg = join(out, 'node_modules', ...inst.module.split('/'));
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify({ name: inst.module, type: 'module', main: 'index.js' })}\n`, 'utf8');
  const target = posix(relative(pkg, join(out, 'impl', 'index.js')));
  writeFileSync(join(pkg, 'index.js'), `export * from '${target.startsWith('.') ? target : `./${target}`}';\n`, 'utf8');
  return { dir, out };
}

async function compile(ctx: RunnerContext, staged: Staged): Promise<{ ok: true } | { ok: false; unknown?: string; reason: string }> {
  const tsc = await ctx.tools('tsc', { minimum: '5.4' });
  if (tsc.status !== 'found') return { ok: false, unknown: tsc.reason, reason: tsc.reason };
  const r = await exec(process.execPath, [tsc.tool.path, '-p', join(staged.dir, 'tsconfig.json')], { cwd: staged.dir, timeoutMs: ctx.timeoutMs });
  if (!r.ok) return { ok: false, unknown: r.reason, reason: r.reason };
  if (r.status !== 0) return { ok: false, reason: firstErrorLine(`${r.stdout}\n${r.stderr}`, /error TS\d+/) };
  return { ok: true };
}

function entryFor(ctx: RunnerContext, which: 'conforming' | 'violating', module: string): string | null {
  const p = ctx.fixtures[which]?.typescript?.[module];
  return p ? atRoot(ctx, p) : null;
}

const typescriptBuild: Runner = async (ctx) => {
  const list = instances(ctx);
  if (!list.length) return outcome('NOT_APPLICABLE', 'no component declares a TypeScript implementation with contract types');
  const parts: string[] = [];
  for (const inst of list) {
    const entry = entryFor(ctx, 'conforming', inst.module);
    if (!entry) return outcome('UNKNOWN', `no implementation entry file was supplied for module ${inst.module}`);
    const c = await compile(ctx, stage(ctx, inst, entry, 'build'));
    if (!c.ok) return c.unknown ? outcome('UNKNOWN', `${inst.component}: ${c.unknown}`) : outcome('FAIL', `${inst.component}: the generated tests do not compile against ${inst.module}: ${c.reason}`);
    parts.push(`${inst.component} (${inst.module}) compiles`);
  }
  return outcome('PASS', `${parts.join('; ')} with tsc ${ctx.tool.version}`);
};

interface TapCounts {
  pass: number;
  fail: number;
  failed: string[];
}

function readTap(text: string): TapCounts | null {
  const pass = /^# pass (\d+)/m.exec(text);
  const fail = /^# fail (\d+)/m.exec(text);
  if (!pass || !fail) return null;
  const failed = [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]!.trim());
  return { pass: Number(pass[1]), fail: Number(fail[1]), failed };
}

async function runTests(ctx: RunnerContext, inst: Instance, entry: string, label: string): Promise<TapCounts | { unknown: string } | { compileFailed: string }> {
  const staged = stage(ctx, inst, entry, label);
  const c = await compile(ctx, staged);
  if (!c.ok) return c.unknown ? { unknown: c.unknown } : { compileFailed: c.reason };
  const node = await ctx.tools('node', { minimum: '22.0' });
  if (node.status !== 'found') return { unknown: node.reason };
  const env = { ...process.env };
  delete env['NODE_OPTIONS'];
  delete env['NODE_TEST_CONTEXT'];
  const r = await exec(node.tool.path, ['--test', '--test-reporter=tap', join(staged.out, 'contract.test.js')], { cwd: staged.out, timeoutMs: ctx.timeoutMs, env });
  if (!r.ok) return { unknown: r.reason };
  return readTap(r.stdout) ?? { unknown: `node --test exited ${r.status} without a readable TAP summary` };
}

const typescriptConformance: Runner = async (ctx) => {
  const list = instances(ctx);
  if (!list.length) return outcome('NOT_APPLICABLE', 'no component declares a TypeScript implementation with contract types');
  const node = await ctx.tools('node', { minimum: '22.0' });
  const tool = { name: 'node', version: node.status === 'found' ? node.tool.version : 'unknown' };
  const parts: string[] = [];
  for (const inst of list) {
    const entry = entryFor(ctx, 'conforming', inst.module);
    if (!entry) return outcome('UNKNOWN', `no implementation entry file was supplied for module ${inst.module}`);
    const ok = await runTests(ctx, inst, entry, 'conforming');
    if ('unknown' in ok) return outcome('UNKNOWN', `${inst.component}: ${ok.unknown}`, { tool });
    if ('compileFailed' in ok) return outcome('FAIL', `${inst.component}: the generated tests do not compile against ${inst.module}: ${ok.compileFailed}`, { tool });
    if (ok.fail !== 0 || ok.pass === 0) return outcome('FAIL', `${inst.component} against ${inst.module}: ${ok.pass} passed, ${ok.fail} failed (${ok.failed.slice(0, 5).join('; ')})`, { tool });
    let line = `${inst.component}: conforming ${ok.pass} passed`;
    const bad = entryFor(ctx, 'violating', inst.module);
    if (bad) {
      const v = await runTests(ctx, inst, bad, 'violating');
      if ('unknown' in v) return outcome('UNKNOWN', `${inst.component} violating run: ${v.unknown}`, { tool });
      if ('compileFailed' in v) line += `, violating does not compile (${v.compileFailed})`;
      else if (v.fail === 0) return outcome('FAIL', `${inst.component}: the generated tests accept the violating implementation, so they cannot fail`, { tool });
      else line += `, violating ${v.fail} failed (${v.failed.slice(0, 3).join('; ')})`;
    }
    parts.push(line);
  }
  return outcome('PASS', `${parts.join('; ')} under node ${tool.version}`, {
    tool,
    records: ctx.model.types.filter((t) => list.some((i) => i.component === t.owner)).map((t) => `type:${t.id}`),
  });
};

export const TYPESCRIPT_RUNNERS: Readonly<Record<string, Runner>> = {
  'typescript-build': typescriptBuild,
  'typescript-conformance': typescriptConformance,
};
