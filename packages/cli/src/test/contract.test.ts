import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTRACT_DIGEST } from '@loom/core';
import { scratch } from '@loom/workspace/testing';

const LOOM_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CORE = join(LOOM_ROOT, 'packages', 'core');

/**
 * A copy of the authored contract, its generated artifacts and the generator,
 * whose dependencies resolve from this installation, so a test can break the
 * copy and run the generator on it without touching the repository.
 */
function contractCopy(t: TestContext): string {
  const dir = scratch();
  const core = join(dir, 'core');
  const modules = join(dir, 'node_modules');
  for (const part of ['scripts', 'schema', join('src', 'generated')]) cpSync(join(CORE, part), join(core, part), { recursive: true });
  symlinkSync(join(LOOM_ROOT, 'node_modules'), modules, 'junction');
  t.after(() => {
    // The junction goes first, so removing the copy can never reach the installation's modules.
    unlinkSync(modules);
    rmSync(dir, { recursive: true, force: true });
  });
  return core;
}

function generate(core: string, ...args: string[]): { status: number; output: string } {
  const r = spawnSync(process.execPath, [join(core, 'scripts', 'generate.mjs'), ...args], { encoding: 'utf8' });
  return { status: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
}

function editJson(path: string, edit: (doc: Record<string, unknown>) => void): void {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(doc);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

const digestOf = (core: string): string => /CONTRACT_DIGEST = "([^"]+)"/.exec(readFileSync(join(core, 'src', 'generated', 'digest.ts'), 'utf8'))?.[1] ?? '';

test('generate --check accepts the authored contract and refuses a generated artifact edited by hand', (t) => {
  const core = contractCopy(t);
  const clean = generate(core, '--check');
  assert.equal(clean.status, 0, clean.output);
  assert.match(clean.output, /artifacts current/);
  const registry = join(core, 'src', 'generated', 'registry.ts');
  writeFileSync(registry, `${readFileSync(registry, 'utf8')}\nexport const EDITED_BY_HAND = true;\n`);
  const drifted = generate(core, '--check');
  assert.equal(drifted.status, 1, drifted.output);
  assert.match(drifted.output, /stale: .*registry\.ts/);
});

test('the contract digest is regenerated from every authored schema, profile and interface control document', (t) => {
  const core = contractCopy(t);
  assert.equal(digestOf(core), CONTRACT_DIGEST, 'the copy starts at the digest the core was built with');
  editJson(join(core, 'schema', 'profiles', 'sql.json'), (p) => (p['description'] = `${String(p['description'])} Edited.`));
  assert.equal(generate(core, '--check').status, 1, 'a profile edit leaves the recorded digest stale');
  const written = generate(core);
  assert.equal(written.status, 0, written.output);
  assert.notEqual(digestOf(core), CONTRACT_DIGEST);
  assert.match(digestOf(core), /^sha256:[0-9a-f]{64}$/);
});

test('a schema keyword outside the qualified vocabulary fails generation instead of being dropped', (t) => {
  const core = contractCopy(t);
  editJson(join(core, 'schema', 'common.schema.json'), (s) => {
    const defs = s['$defs'] as Record<string, Record<string, unknown>>;
    defs['Id']!['minProperties'] = 1;
  });
  const r = generate(core, '--check');
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /keyword 'minProperties' is outside the qualified vocabulary/);
});

test('a hand-authored contract fixture whose valid instance the schema rejects fails generation', (t) => {
  const core = contractCopy(t);
  editJson(join(core, 'schema', 'fixtures', 'policy.json'), (fx) => {
    const valid = fx['valid'] as Array<{ trust: { ref: string } }>;
    valid[0]!.trust.ref = 'main';
  });
  const r = generate(core, '--check');
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /fixtures\/policy\.json: valid\[0\] is rejected/);
});

test('an interface control document that consumes an interface no component provides fails generation', (t) => {
  const core = contractCopy(t);
  editJson(join(core, 'schema', 'icd', 'cli.json'), (icd) => (icd['consumes'] as unknown[]).push({ component: 'core', interface: 'undeclaredInterface' }));
  const r = generate(core, '--check');
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /consumes 'core:undeclaredInterface', which no ICD provides/);
});

const ALLOWED_IMPORTS = /^(?:\.{1,2}\/|ajv(?:\/|$)|ajv-formats$|yaml$)/;
const IMPURE = /\bprocess\.(?:env|argv|exit|cwd|platform)\b|\bDate\.now\(|\bnew Date\(|\bMath\.random\(|\bfetch\(|\brequire\(|\bsetTimeout\(|\bsetInterval\(|\bwindow\.|\blocalStorage\b|\bXMLHttpRequest\b/;

/** Imports outside the pure dependencies and uses of a host facility, ignoring string literals and comments. */
function impurities(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^(?:import|export)\s[^'"`;]*?from\s+'([^']+)'/gm)) if (!ALLOWED_IMPORTS.test(m[1] as string)) out.push(`imports '${m[1]}'`);
  for (const m of text.matchAll(/\bimport\(\s*'([^']+)'/g)) out.push(`loads '${m[1]}' at run time`);
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\/\/.*$/g, "''");
    if (IMPURE.test(code) && !/^\s*\*/.test(line)) out.push(`line ${i + 1}: ${line.trim()}`);
  });
  return out;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('the core imports only its pure dependencies and reaches no process, clock, timer, network or random source', () => {
  const negative = "import { readFileSync } from 'node:fs';\nconst now = Date.now();\nconst text = 'Date.now() inside a string is data';\n";
  assert.deepEqual(impurities(negative), ["imports 'node:fs'", 'line 2: const now = Date.now();'], 'the scan fires on an impure import and an impure call');
  const files = sources(join(CORE, 'src'));
  assert.ok(files.length > 50, `scanned ${files.length} files`);
  const problems = files.flatMap((file) => impurities(readFileSync(file, 'utf8')).map((p) => `${file}: ${p}`));
  assert.deepEqual(problems, []);
  const manifest = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['ajv', 'ajv-formats', 'yaml']);
});
