#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, appendFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import SwaggerParser from '@apidevtools/swagger-parser';
import {
  selfTest,
  validate,
  project,
  projectToFiles,
  sampleModel,
  sqlDeploymentOrder,
  exportModel,
  importModel,
  LoomStructuralError,
  LoomInvalidModelError,
  type Finding,
  type Model,
} from '@loom/core';
import { probePesterParse, probePesterRun, probeScriptDom, probeMermaid, probeLocalDb, type ProbeResult } from './probes.js';

type Log = (line: string) => void;
const out: Log = (line) => console.log(line);

// dist/index.js sits three levels below the loom root.
const LOOM_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TMP = join(LOOM_ROOT, '.tmp');
const EXAMPLES = join(LOOM_ROOT, 'examples');

function printUsage(): void {
  out(
    [
      'loom - schema-driven systems-engineering model',
      '',
      'Usage:',
      '  loom --self-test                  Run the engine self-test, the drift check and the standard-tool probes.',
      '  loom --check <model> [dir]        Validate a model (JSON or YAML); exit non-zero on any error finding.',
      '                                    With <dir>, also compare every projected file byte-for-byte (CRLF as LF)',
      '                                    and exit non-zero on drift. Never writes.',
      '  loom --write <model> <dir>        Write every projection into <dir>.',
    ].join('\n'),
  );
}

function printFinding(log: Log, f: Finding): void {
  const impact = f.impact && f.impact.length ? ` [impact: ${f.impact.map((a) => a.ref.id).join(', ')}]` : '';
  log(`  ${f.severity.toUpperCase()} ${f.code} at ${f.path}: ${f.message}${impact}`);
  if (f.fix) log(`    fix: ${f.fix}`);
}

/** Read a model file, or log the structural error and return null. */
function readModel(file: string, log: Log): Model | null {
  try {
    return importModel(readFileSync(resolve(file), 'utf8'));
  } catch (e) {
    if (e instanceof LoomStructuralError) {
      log(`STRUCTURAL ERROR: ${e.message}`);
      return null;
    }
    throw e;
  }
}

function readIfFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Every file below `root` as a forward-slash relative path, sorted; an unreadable root yields none. */
function filesUnder(root: string, prefix = ''): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(root, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * Validate a model; with `dir`, also compare each projected file to the file on
 * disk. Prints DRIFT <file>: missing | stale per drifted file and warns on files
 * that are not projections. Never writes. Non-zero on any error finding or drift.
 */
function runCheck(file: string, dir: string | undefined, log: Log): number {
  const model = readModel(file, log);
  if (!model) return 1;
  const findings = validate(model);
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  for (const f of findings) printFinding(log, f);
  log(`loom check: ${findings.length} finding(s) - ${errors.length} error, ${warnings.length} warning.`);
  if (errors.length > 0) {
    if (dir !== undefined) log('loom check: drift check skipped because the model has error findings.');
    return 1;
  }
  if (dir === undefined) return 0;

  const root = resolve(dir);
  const expected = projectToFiles(model);
  const names = Object.keys(expected);
  let drifted = 0;
  for (const name of names) {
    const actual = readIfFile(join(root, ...name.split('/')));
    if (actual === null) {
      log(`DRIFT ${name}: missing`);
      drifted++;
    } else if (actual.replace(/\r\n/g, '\n') !== expected[name]) {
      log(`DRIFT ${name}: stale`);
      drifted++;
    }
  }
  for (const name of filesUnder(root)) {
    if (!Object.prototype.hasOwnProperty.call(expected, name)) log(`WARN unexpected file ${name}: not a Loom projection`);
  }
  log(
    drifted
      ? `loom check: ${drifted} of ${names.length} projected file(s) drifted from the model in ${root}.`
      : `loom check: all ${names.length} projected file(s) in ${root} match the model.`,
  );
  return drifted ? 1 : 0;
}

/** Write every projection of a valid model into `dir`. */
function runWrite(file: string, dir: string, log: Log): number {
  const model = readModel(file, log);
  if (!model) return 1;
  let files: Record<string, string>;
  try {
    files = projectToFiles(model);
  } catch (e) {
    if (e instanceof LoomInvalidModelError) {
      log(`refusing to write: ${e.message}`);
      for (const f of e.findings.filter((x) => x.severity === 'error')) printFinding(log, f);
      return 1;
    }
    throw e;
  }
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, ...name.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  }
  log(`loom write: wrote ${Object.keys(files).length} file(s) to ${root}: ${Object.keys(files).join(', ')}.`);
  return 0;
}

/** (d) model.yaml parses back to the same model. */
function probeYaml(yamlText: string, model: Model): ProbeResult {
  const title = 'YAML parse-back of model.yaml';
  try {
    const same = exportModel(importModel(yamlText)) === exportModel(model);
    return {
      id: 'd',
      title,
      status: same ? 'PASS' : 'FAIL',
      detail: same ? 'parsed model re-exports to the identical canonical JSON' : 'parsed model differs from the source model',
    };
  } catch (e) {
    return { id: 'd', title, status: 'FAIL', detail: e instanceof Error ? e.message : String(e) };
  }
}

async function runSelfTest(): Promise<number> {
  // Prints the core summary line and throws on any assertion failure.
  selfTest();

  // OpenAPI projection, proved by a standard validator the engine does not own.
  const api = (await SwaggerParser.validate(
    JSON.parse(JSON.stringify(project(sampleModel(), 'openapi'))),
  )) as { paths?: Record<string, unknown> };
  out(`loom cli: OpenAPI 3.1 projection validated by swagger-parser (paths: ${Object.keys(api.paths ?? {}).join(', ')}).`);

  const work = join(TMP, 'cli-self-test');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const model = sampleModel();
    const modelFile = join(work, 'model.json');
    const projection = join(work, 'projection');
    writeFileSync(modelFile, `${exportModel(model)}\n`, 'utf8');
    const quiet: Log = () => undefined;
    if (runWrite(modelFile, projection, quiet) !== 0) throw new Error('cli self-test: --write failed on the sample model');

    const captured: string[] = [];
    const capture: Log = (line) => captured.push(line);
    const cleanCode = runCheck(modelFile, projection, capture);
    if (cleanCode !== 0 || captured.some((l) => l.startsWith('DRIFT'))) {
      throw new Error(`cli self-test: a fresh projection should check clean, got exit ${cleanCode}: ${captured.join(' | ')}`);
    }

    // Standard-tool proofs on the files just written. Per-component artifacts
    // sit in <component>/ directories; SQL files apply in foreign-key order.
    const testFile = join(projection, 'fulfillment', 'Routines.Contract.Tests.ps1');
    const sqlComponents = sqlDeploymentOrder(model);
    const schemaFiles = sqlComponents.map((c) => join(projection, c, 'schema.sql'));
    const contractFiles = sqlComponents.map((c) => join(projection, c, 'contract-tests.sql'));
    const probes: ProbeResult[] = [
      probePesterParse(testFile),
      probePesterRun(testFile, EXAMPLES),
      probeScriptDom([...schemaFiles, ...contractFiles]),
      probeYaml(readFileSync(join(projection, 'model.yaml'), 'utf8'), model),
      await probeMermaid({
        'workflows.md': readFileSync(join(projection, 'workflows.md'), 'utf8'),
        'reference.md': readFileSync(join(projection, 'reference.md'), 'utf8'),
        'architecture.md': readFileSync(join(projection, 'architecture.md'), 'utf8'),
      }),
      // The override env vars exist only to prove the UNKNOWN path in a test
      // run, without uninstalling SqlLocalDB or removing sqlcmd from PATH.
      probeLocalDb(
        {
          schemaSql: schemaFiles,
          contractTestsSql: contractFiles,
          conformingFixture: join(EXAMPLES, 'conforming', 'ordering', 'sp_place_order.sql'),
          violatingFixture: join(EXAMPLES, 'violating', 'ordering', 'sp_place_order.sql'),
        },
        {
          sqlLocalDbExe: process.env['LOOM_PROBE_SQLLOCALDB_EXE'],
          sqlcmdExe: process.env['LOOM_PROBE_SQLCMD_EXE'],
        },
      ),
    ];
    for (const p of probes) out(`probe (${p.id}) ${p.title}: ${p.status} - ${p.detail}`);

    // Drift: edit one file, delete one, add a stray one.
    appendFileSync(join(projection, 'ordering', 'schema.sql'), '-- hand edit\n', 'utf8');
    rmSync(join(projection, 'reference.md'));
    writeFileSync(join(projection, 'ordering', 'notes.txt'), 'scratch\n', 'utf8');
    captured.length = 0;
    const driftCode = runCheck(modelFile, projection, capture);
    const expectations = ['DRIFT ordering/schema.sql: stale', 'DRIFT reference.md: missing', 'WARN unexpected file ordering/notes.txt: not a Loom projection'];
    const unmet = expectations.filter((e) => !captured.includes(e));
    if (driftCode === 0 || unmet.length) {
      throw new Error(`cli self-test: drift should be reported with a non-zero exit, got exit ${driftCode}; missing lines: ${unmet.join(' | ')}`);
    }
    out(
      `loom cli: drift check - fresh projection exit 0; edited ordering/schema.sql -> "DRIFT ordering/schema.sql: stale", ` +
        `deleted reference.md -> "DRIFT reference.md: missing", stray ordering/notes.txt warned, exit ${driftCode}.`,
    );

    const failed = probes.filter((p) => p.status === 'FAIL');
    out(
      `loom cli self-test ${failed.length ? 'FAIL' : 'PASS'}: swagger-parser OK, drift check OK, probes ` +
        `${probes.map((p) => `${p.id}=${p.status}`).join(' ')}.`,
    );
    return failed.length ? 1 : 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const [cmd, a, b] = process.argv.slice(2);
  switch (cmd) {
    case '--self-test':
      return runSelfTest();
    case '--check':
      if (!a) {
        out('error: --check requires <model>');
        return 2;
      }
      return runCheck(a, b, out);
    case '--write':
      if (!a || !b) {
        out('error: --write requires <model> <dir>');
        return 2;
      }
      return runWrite(a, b, out);
    default:
      printUsage();
      return cmd ? 2 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
