import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalStringify, defaultStates, envelope } from '@loom/core';
import type { ResultEnvelope, RunRecord } from '@loom/core';
import { findRepositoryRoot, openSession } from '@loom/workspace';
import { UsageError, flag, has, list, parseArgs } from './args.js';
import {
  cmdAccept,
  cmdBaseline,
  cmdCheck,
  cmdContext,
  cmdDescribe,
  cmdDocs,
  cmdEvidence,
  cmdInit,
  cmdMigrate,
  cmdMutate,
  cmdOwner,
  cmdPlan,
  cmdQualify,
  cmdReadiness,
  cmdWrite,
  type CommandResult,
  type Context,
} from './commands.js';
import { checkCapabilities, enumerateCases } from './coverage.js';
import { documentationFindings } from './docs.js';
import { exitStatus, renderEnvelope, type Log } from './render.js';
import { runSelfTest } from './selftest.js';

const USAGE = [
  'loom - schema-driven systems-engineering model',
  '',
  'Usage: loom <command> [options]   (every command takes --json to print the result envelope)',
  '',
  '  init [--force]                         Scaffold .loom at this repository root.',
  '  check [--model <path>] [--out <dir>]   Ownership, configuration, validity, the trusted-baseline comparison, outputs and manifest.',
  '  check --all [--boundary <dir>]         Every descriptor under the boundary, global disjointness and walk coverage.',
  '  write [--out <dir>] [--draft]          Install every enabled artifact, or write the projections into a directory.',
  '  docs [--check]                         Install the bundle with evaluated views, or check documents, links, views and history markers.',
  '  owner [<path>]                         The model that owns a path.',
  '  migrate [--model <path>] [--to <file>] Migrate a model document to the current format into a new file.',
  '  baseline create --id <id> --acceptance <id> [--predecessor <id>] [--frozen]',
  '  accept --id <id> --authority <alias> [--subject baseline|change] [--baseline <id>] [--scope kind:id,...] [--classes ...]',
  '  readiness --class <class> [--mode component|slice] [--components a,b] [--requirements r,...] | readiness --task <file>',
  '  plan --patch <file> [--base <revision>] [--ack id,...]',
  '  mutate --patch <file> --expected <revision> [--ack id,...] [--dry-run]',
  '  qualify [--self] [--profile p,...] [--checks id,...] [--fixtures <file>] [--store] [--metrics] [--key-id <id> --key-env <var>]',
  '  evidence list | evidence show <id>',
  '  context --kind component|record|claim|task --id <id> [--record-kind <kind>] [--max-records n] [--max-bytes n] [--continuation <token>]',
  '  describe [--sections a,b] [--profile <id>]',
  '  coverage --check [--register <file>] [--results <tap,...>] [--run <run.json>] | coverage --list-cases',
  '  --self-test                            The engine battery, the drift gate and every profile check against Loom fixtures.',
  '',
  'Common options: --model <path> selects a document (the governing workspace still applies), --boundary <dir>, --trusted-ref <ref>, --as-of <date>.',
  'Exit status: 0 ok, 1 refusal or error finding, 2 usage error.',
].join('\n');

function cmdDocsCheck(ctx: Context): CommandResult {
  const model = flag(ctx.args, 'model');
  const s = openSession(ctx.cwd, model ? { model } : {});
  const root = s.workspace?.root ?? findRepositoryRoot(resolve(ctx.cwd)) ?? resolve(ctx.cwd);
  const findings = documentationFindings({ root }, s);
  const env = envelope('cli.docsCheck', { model: s.model, findings, states: defaultStates(s.model ? { state: 'valid', reasons: [] } : { state: 'notEvaluated', reasons: [] }), data: { root } });
  return { env };
}

function cmdCoverage(ctx: Context): CommandResult {
  const root = findRepositoryRoot(resolve(ctx.cwd)) ?? resolve(ctx.cwd);
  if (has(ctx.args, 'list-cases')) {
    const cases = enumerateCases(root);
    return { env: envelope('cli.coverage', { model: null, findings: [], states: defaultStates({ state: 'notEvaluated', reasons: [] }), data: { cases } }), detail: cases.map((c) => c.id) };
  }
  if (!has(ctx.args, 'check')) throw new UsageError("coverage needs --check or --list-cases");
  const runFile = flag(ctx.args, 'run');
  const register = flag(ctx.args, 'register');
  const results = list(ctx.args, 'results')?.map((p) => resolve(ctx.cwd, p));
  const r = checkCapabilities({
    root,
    ...(register ? { register } : {}),
    ...(results ? { results } : {}),
    ...(runFile ? { run: JSON.parse(readFileSync(resolve(ctx.cwd, runFile), 'utf8')) as RunRecord } : {}),
  });
  const env = envelope('cli.coverage', { model: null, findings: r.findings, states: defaultStates({ state: 'notEvaluated', reasons: [] }), data: { capabilities: r.capabilities, cases: r.cases, verified: r.verified } });
  return { env, detail: [`capabilities: ${r.capabilities}; declared cases: ${r.cases}; verified references: ${r.verified}`] };
}

/** Run one command line; returns the exit status. Output goes only through `log`. */
export async function run(argv: readonly string[], cwd: string, loomRoot: string, log: Log): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      log(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
  if (!args.command || has(args, 'help')) {
    log(USAGE);
    return 0;
  }
  if (args.command === 'self-test') {
    if (has(args, 'list-cases')) {
      for (const c of enumerateCases(loomRoot)) log(c.id);
      return 0;
    }
    return runSelfTest(loomRoot, log);
  }
  const ctx: Context = { cwd, args, loomRoot };
  const commands: Record<string, (c: Context) => CommandResult | Promise<CommandResult>> = {
    init: cmdInit,
    check: cmdCheck,
    write: cmdWrite,
    docs: (c) => (has(c.args, 'check') ? cmdDocsCheck(c) : cmdDocs(c)),
    owner: cmdOwner,
    migrate: cmdMigrate,
    baseline: cmdBaseline,
    accept: cmdAccept,
    readiness: cmdReadiness,
    plan: cmdPlan,
    mutate: cmdMutate,
    qualify: cmdQualify,
    evidence: cmdEvidence,
    context: cmdContext,
    describe: cmdDescribe,
    coverage: cmdCoverage,
  };
  const command = commands[args.command];
  if (!command) {
    log(`error: unknown command '${args.command}'`);
    log(USAGE);
    return 2;
  }
  let result: CommandResult;
  try {
    result = await command(ctx);
  } catch (err) {
    if (err instanceof UsageError) {
      log(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
  const env: ResultEnvelope = result.env;
  if (has(args, 'json')) log(canonicalStringify(env));
  else renderEnvelope(env, log, result.detail ?? []);
  return exitStatus(env);
}
