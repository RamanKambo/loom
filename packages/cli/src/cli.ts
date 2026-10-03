import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLI_COMMANDS, CLI_USAGE, canonicalStringify, defaultStates, envelope } from '@loom/core';
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

function cmdDocsCheck(ctx: Context): CommandResult {
  if (has(ctx.args, 'self')) {
    const findings = documentationFindings({ root: ctx.loomRoot, release: true }, null);
    return { env: envelope('cli.docsCheck', { model: null, findings, states: defaultStates({ state: 'notEvaluated', reasons: [] }), data: { root: ctx.loomRoot } }) };
  }
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

/** The command the --self-test switch selects; it reports through the log and its own exit status rather than a result envelope. */
const SELF_TEST = 'self-test';

/** The handler of every command the operation catalogue exposes on the command line, by command word. */
const COMMANDS: Record<string, (c: Context) => CommandResult | Promise<CommandResult>> = {
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

/** Every command word this CLI handles, for the check that the catalogue and the handlers agree. */
export const HANDLED_COMMANDS: readonly string[] = [...Object.keys(COMMANDS), SELF_TEST];

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
    log(CLI_USAGE);
    return 0;
  }
  if (args.command === SELF_TEST) {
    if (has(args, 'list-cases')) {
      for (const c of enumerateCases(loomRoot)) log(c.id);
      return 0;
    }
    return runSelfTest(loomRoot, log);
  }
  const ctx: Context = { cwd, args, loomRoot };
  const command = CLI_COMMANDS.includes(args.command) ? COMMANDS[args.command] : undefined;
  if (!command) {
    log(`error: unknown command '${args.command}'`);
    log(CLI_USAGE);
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
