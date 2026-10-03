import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { asFinding, schemaErrors, selfTest } from '@loom/core';
import type { CapabilityRegister, Finding, RunRecord } from '@loom/core';

/** The capability register: each capability mapped to its owning code, its contract and the cases that verify it. */
export const REGISTER_FILE = 'qualification/capabilities.json';

export interface Case {
  id: string;
  source: 'node-test' | 'self-test' | 'qualification';
  /** Repository-relative file declaring the case. */
  file?: string;
  /** For a case whose result is known without a supplied result file: the self-test runs here. */
  passed?: boolean;
}

/** A case id segment: lowercase words joined by hyphens. */
export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// A declaration starts its line, so a test call quoted inside a string or fixture text is not a case.
const TEST_CALL = /^\s*(?:test|it)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/gm;

function testFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!['node_modules', 'dist', 'generated'].includes(e.name)) testFiles(join(dir, e.name), out);
    } else if (/\.(test|spec)\.ts$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/** Self-test sections, run here with its summary line held back, so their result is live. */
function selfTestCases(): Case[] {
  const original = console.log;
  console.log = (): void => undefined;
  try {
    return selfTest().sections.map((s) => ({ id: `core.selftest.${slug(s.name)}`, source: 'self-test' as const, passed: s.passed }));
  } catch {
    return [];
  } finally {
    console.log = original;
  }
}

/**
 * Every verification case this repository declares: node:test and Vitest cases
 * by package, file and name; the engine self-test sections; and one case per
 * qualification check.
 */
export function enumerateCases(root: string, options: { selfTest?: boolean } = {}): Case[] {
  const cases: Case[] = [];
  for (const base of ['packages', 'apps']) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const pkg of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const file of testFiles(join(dir, pkg.name, 'src'))) {
        const stem = slug(basename(file).replace(/\.(test|spec)\.ts$/, ''));
        const relFile = file.slice(root.length + 1).replace(/\\/g, '/');
        for (const m of readFileSync(file, 'utf8').matchAll(TEST_CALL)) {
          const name = m[2] as string;
          if (name.includes('${')) continue;
          cases.push({ id: `${slug(pkg.name)}.${stem}.${slug(name)}`, source: 'node-test', file: relFile });
        }
      }
    }
  }
  if (options.selfTest !== false) cases.push(...selfTestCases());
  const profilesDir = join(root, 'packages', 'core', 'schema', 'profiles');
  if (existsSync(profilesDir)) {
    for (const f of readdirSync(profilesDir).filter((x) => x.endsWith('.json'))) {
      const p = JSON.parse(readFileSync(join(profilesDir, f), 'utf8')) as { checks?: { id: string }[] };
      for (const c of p.checks ?? []) cases.push({ id: `qualification.check.${slug(c.id)}`, source: 'qualification', file: `packages/core/schema/profiles/${f}` });
    }
  }
  const seen = new Set<string>();
  return cases.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/** Passed and failed test names from node:test TAP output; a name that failed anywhere counts as failed. */
export function parseTap(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(not )?ok \d+ - (.+?)(?:\s+#\s.*)?$/.exec(line);
    if (!m) continue;
    const key = slug(m[2] as string);
    const ok = !m[1];
    out.set(key, (out.get(key) ?? true) && ok);
  }
  return out;
}

function declares(text: string, symbol: string): boolean {
  const name = (symbol.split('.').pop() as string).replace(/[$]/g, '\\$');
  const forms = [
    `(?:function\\*?|const|let|var|class|interface|type|enum)\\s+${name}\\b`,
    `export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
    `^\\s*(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+)*${name}\\s*\\(`,
  ];
  return forms.some((f) => new RegExp(f, 'm').test(text));
}

function pointerResolves(doc: unknown, pointer: string): boolean {
  let node: unknown = doc;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
}

function contractResolves(root: string, contract: string): boolean {
  const [path, pointer] = contract.split('#', 2) as [string, string | undefined];
  const file = [join(root, 'packages', 'core', 'schema', ...path.split('/')), join(root, ...path.split('/'))].find((p) => existsSync(p));
  if (!file) return false;
  if (!pointer) return true;
  try {
    return pointerResolves(JSON.parse(readFileSync(file, 'utf8')), pointer);
  } catch {
    return false;
  }
}

export interface CoverageInputs {
  root: string;
  register?: string;
  /** node:test TAP output files; without them a node:test case cannot be shown to have passed. */
  results?: string[];
  /** A qualification run record whose checks decide the qualification cases. */
  run?: RunRecord;
}

export interface CoverageResult {
  findings: Finding[];
  capabilities: number;
  cases: number;
  verified: number;
}

/**
 * Check the capability register: every owning code symbol exists, every
 * contract pointer resolves, and every verification case exists and passed in
 * the supplied results. Missing results never count as a pass.
 */
export function checkCapabilities(input: CoverageInputs): CoverageResult {
  const root = input.root;
  const path = join(root, ...(input.register ?? REGISTER_FILE).split('/'));
  const findings: Finding[] = [];
  if (!existsSync(path)) {
    return { findings: [asFinding('CAPABILITY_CONTRACT_UNRESOLVED', input.register ?? REGISTER_FILE, 'the capability register does not exist', `author ${REGISTER_FILE}`)], capabilities: 0, cases: 0, verified: 0 };
  }
  const register = JSON.parse(readFileSync(path, 'utf8')) as CapabilityRegister;
  const errors = schemaErrors('CapabilityRegister', register);
  if (errors.length) {
    return { findings: errors.map((e) => asFinding('STRUCTURAL_INVALID', `${REGISTER_FILE}${e.pointer}`, e.message, 'correct the register to satisfy CapabilityRegister')), capabilities: 0, cases: 0, verified: 0 };
  }
  const cases = new Map(enumerateCases(root).map((c) => [c.id, c]));
  const tap = new Map<string, boolean>();
  for (const f of input.results ?? []) for (const [k, v] of parseTap(readFileSync(f, 'utf8'))) tap.set(k, (tap.get(k) ?? true) && v);
  const checks = new Map((input.run?.checks ?? []).map((c) => [`qualification.check.${slug(c.check)}`, c.result]));
  let verified = 0;
  for (const cap of register.capabilities) {
    const at = `${REGISTER_FILE}#${cap.id}`;
    for (const code of cap.code) {
      const [file, symbol] = code.split('#', 2) as [string, string];
      const abs = join(root, ...file.split('/'));
      if (!existsSync(abs) || !declares(readFileSync(abs, 'utf8'), symbol)) {
        findings.push(asFinding('CAPABILITY_CODE_UNRESOLVED', at, `'${code}' does not resolve to a declaration`, 'name a file and a symbol it declares'));
      }
    }
    for (const contract of cap.contract) {
      if (!contractResolves(root, contract)) findings.push(asFinding('CAPABILITY_CONTRACT_UNRESOLVED', at, `contract '${contract}' does not resolve`, 'name a schema definition, profile or interface control document that exists'));
    }
    for (const id of cap.verification) {
      const c = cases.get(id);
      if (!c) {
        findings.push(asFinding('CAPABILITY_CASE_UNKNOWN', at, `verification case '${id}' is not declared by any test, self-test section or qualification check`, 'name a declared case; list them with `loom coverage --list-cases`'));
        continue;
      }
      const passed = c.source === 'self-test' ? c.passed : c.source === 'qualification' ? (checks.has(id) ? checks.get(id) === 'PASS' : undefined) : tap.has(id.split('.').slice(2).join('.')) ? tap.get(id.split('.').slice(2).join('.')) : undefined;
      if (passed === true) verified++;
      else findings.push(asFinding('CAPABILITY_CASE_FAILED', at, passed === false ? `verification case '${id}' failed` : `no supplied result shows verification case '${id}' passed`, passed === false ? 'make the case pass' : 'supply the test results (--results) or the qualification run (--run) that executed it'));
    }
  }
  return { findings, capabilities: register.capabilities.length, cases: cases.size, verified };
}
