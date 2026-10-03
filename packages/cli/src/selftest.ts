import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportModel, sampleModel, selfTest } from '@loom/core';
import type { Finding, LoomConfig } from '@loom/core';
import { selfQualify } from '@loom/qualification';
import { parseArgs } from './args.js';
import { cmdCheck, cmdInit, cmdWrite, type Context } from './commands.js';
import type { Log } from './render.js';

const codes = (findings: readonly Finding[]): string[] => findings.map((f) => f.code);

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`cli self-test: ${message}`);
}

function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  for (const [k, v] of [['core.autocrlf', 'false'], ['commit.gpgsign', 'false'], ['user.name', 'loom-self-test'], ['user.email', 'loom-self-test@example.invalid']]) execFileSync('git', ['config', k as string, v as string], { cwd: dir });
}

const ctxOf = (cwd: string, loomRoot: string, argv: string[]): Context => ({ cwd, loomRoot, args: parseArgs(argv) });

/**
 * The drift gate through the commands themselves: an explicit output directory
 * and an initialized workspace each check clean after writing, and report a
 * hand edit and a deleted file.
 */
function driftChecks(loomRoot: string, log: Log): void {
  const work = mkdtempSync(join(tmpdir(), 'loom-cli-self-test-'));
  try {
    const modelFile = join(work, 'model.json');
    writeFileSync(modelFile, `${exportModel(sampleModel())}\n`, 'utf8');
    const out = join(work, 'projection');
    expect(cmdWrite(ctxOf(work, loomRoot, ['write', '--model', modelFile, '--out', out])).env.outcome === 'ok', 'write --out refused the sample model');
    const clean = cmdCheck(ctxOf(work, loomRoot, ['check', '--model', modelFile, '--out', out])).env;
    expect(!clean.findings.some((f) => f.severity === 'error'), `a fresh projection directory should check clean: ${codes(clean.findings).join(', ')}`);
    appendFileSync(join(out, 'ordering', 'schema.sql'), '-- hand edit\n', 'utf8');
    rmSync(join(out, 'reference.md'));
    const drifted = cmdCheck(ctxOf(work, loomRoot, ['check', '--model', modelFile, '--out', out])).env;
    expect(drifted.findings.some((f) => f.code === 'OUTPUT_DRIFT' && f.path === 'ordering/schema.sql'), 'a hand edit should be reported as drift');
    expect(drifted.findings.some((f) => f.code === 'OUTPUT_MISSING' && f.path === 'reference.md'), 'a deleted projection should be reported missing');

    const repo = join(work, 'repo');
    gitRepo(repo);
    for (const c of ['ordering', 'fulfillment', 'billing']) mkdirSync(join(repo, c), { recursive: true });
    expect(cmdInit(ctxOf(repo, loomRoot, ['init'])).env.outcome === 'ok', 'init refused a fresh repository root');
    writeFileSync(join(repo, '.loom', 'model.json'), `${exportModel(sampleModel())}\n`, 'utf8');
    const configPath = join(repo, '.loom', 'loom.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as LoomConfig;
    writeFileSync(configPath, `${JSON.stringify({ ...config, projectionProfile: 'contracts', scope: { ordering: ['ordering'], fulfillment: ['fulfillment'], billing: ['billing'] } }, null, 2)}\n`, 'utf8');
    const installed = cmdWrite(ctxOf(repo, loomRoot, ['write'])).env;
    expect(installed.outcome === 'ok', `write refused the workspace bundle: ${codes(installed.findings).join(', ')}`);
    const current = cmdCheck(ctxOf(repo, loomRoot, ['check'])).env;
    expect(!current.findings.some((f) => f.code === 'OUTPUT_DRIFT' || f.code === 'OUTPUT_MISSING' || f.code === 'MANIFEST_STALE'), `an installed bundle should check current: ${codes(current.findings).join(', ')}`);
    appendFileSync(join(repo, 'Docs', 'Loom', 'reference.md'), '\nhand edit\n', 'utf8');
    const stale = cmdCheck(ctxOf(repo, loomRoot, ['check'])).env;
    expect(stale.findings.some((f) => f.code === 'OUTPUT_DRIFT'), 'an edited installed artifact should be reported as drift');
    log('loom cli: drift check - explicit directory and workspace bundle check clean after writing; a hand edit and a deleted file are reported.');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The engine battery, the drift gate, then every profile check against Loom's own fixtures. */
export async function runSelfTest(loomRoot: string, log: Log): Promise<number> {
  selfTest();
  driftChecks(loomRoot, log);
  const q = await selfQualify(loomRoot);
  for (const c of q.run.checks) log(`check ${c.check} (${c.required ? 'required' : 'optional'}): ${c.result} - ${c.reason ?? ''}`);
  for (const id of q.unlisted) log(`check ${id}: the self-qualification policy neither requires it nor marks it optional`);
  const counts = (['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE'] as const).map((r) => `${q.run.checks.filter((c) => c.result === r).length} ${r}`).join(', ');
  // A required UNKNOWN keeps the aggregate from PASS, so a missing tool can never read as a qualified self-test.
  const ok = q.run.aggregate === 'PASS' && q.unlisted.length === 0;
  log(`loom cli self-test ${ok ? 'PASS' : 'FAIL'}: drift check OK; qualification ${q.run.aggregate} over ${q.run.checks.length} checks (${counts}).`);
  return ok ? 0 : 1;
}
