import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  LoomInvalidModelError,
  PROFILES,
  artifactInputs,
  asFinding,
  checkReadinessTool,
  compareBaselineTool,
  contextTool,
  defaultStates,
  describeTool,
  envelope,
  evaluateEvidenceTool,
  exportModel,
  migrateModel,
  modelRevision,
  planChangeTool,
  projectToFiles,
  refusal,
  schemaErrors,
  validate,
  validationState,
  withArtifactHashes,
} from '@loom/core';
import type {
  Acceptance,
  ContextTarget,
  DescribeInput,
  DiscoveryBudget,
  Finding,
  MetricsReport,
  Model,
  MutateData,
  Patch,
  QualificationState,
  RecordKind,
  RecordRef,
  ResultEnvelope,
  States,
  TaskSpec,
} from '@loom/core';
import {
  checkOutputs,
  createAcceptance,
  createBaseline,
  discoverAll,
  enabledTargets,
  findBoundary,
  findRepositoryRoot,
  hasDescriptor,
  initWorkspace,
  installOutputs,
  listEvidence,
  loomDirOf,
  mutateWorkspace,
  openSession,
  readConfig,
  readEvidence,
  readTrustedEvidence,
  resolveOwner,
  signRecord,
  stampSession,
  verifyRecord,
  type Session,
  type Workspace,
} from '@loom/workspace';
import { runChecks, selfQualify, type Fixtures, type RunOutput, type Signer } from '@loom/qualification';
import { UsageError, flag, has, integer, list, required, type Args } from './args.js';
import { compareMetrics, computeMetrics } from './metrics.js';

export interface Context {
  cwd: string;
  args: Args;
  /** Root of the Loom installation, for Loom's own qualification policy and fixtures. */
  loomRoot: string;
}

export interface CommandResult {
  env: ResultEnvelope;
  /** Extra summary lines for the readable rendering. */
  detail?: string[];
}

const NOT_EVALUATED = { state: 'notEvaluated' as const, reasons: [] };

function session(ctx: Context): Session {
  const a = ctx.args;
  const model = flag(a, 'model');
  const boundary = flag(a, 'boundary');
  const trustedRef = flag(a, 'trusted-ref');
  const asOf = flag(a, 'as-of');
  return openSession(ctx.cwd, {
    ...(model !== undefined ? { model } : {}),
    ...(boundary !== undefined ? { boundary: resolve(ctx.cwd, boundary) } : {}),
    ...(trustedRef !== undefined ? { trustedRef } : {}),
    ...(asOf !== undefined ? { asOf } : {}),
  });
}

/** The refusal for a command that needs a model when none applies. */
function noModel(tool: string, s: Session): CommandResult {
  return {
    env: stampSession(
      envelope(tool, {
        model: null,
        findings: [],
        refusal: refusal('unresolved-context', 'no model applies here: pass --model <path> or run inside a governed workspace'),
      }),
      s,
    ),
  };
}

function noWorkspace(tool: string, s: Session): CommandResult {
  return {
    env: stampSession(
      envelope(tool, {
        model: s.model,
        findings: [],
        refusal: refusal('unresolved-context', 'this command persists through a workspace; run it inside a directory a .loom governs'),
      }),
      s,
    ),
  };
}

/** The workspace with the selected document: an explicit model is checked under the governing workspace's routing and policy. */
const governed = (s: Session, model: Model): Workspace => ({ ...(s.workspace as Workspace), model });

function readJsonFile(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    throw new UsageError(`${what} '${path}' is not readable JSON: ${(err as Error).message}`);
  }
}

function patchesOf(ctx: Context): { patch: Patch } | { patches: Patch[] } {
  const value = readJsonFile(resolve(ctx.cwd, required(ctx.args, 'patch')), 'patch file');
  return Array.isArray(value) ? { patches: value as Patch[] } : { patch: value as Patch };
}

function signerOf(ctx: Context): Signer | undefined {
  const keyId = flag(ctx.args, 'key-id');
  if (!keyId) return undefined;
  return { keyId, keyEnv: flag(ctx.args, 'key-env') ?? 'LOOM_EVIDENCE_KEY' };
}

/** Projected files compared with an explicit output directory; nothing is written. */
function directoryDrift(model: Model, dir: string, draft: boolean, s: Session): Finding[] {
  let files: Record<string, string>;
  try {
    files = projectToFiles(model, { draft, inputs: s.inputs });
  } catch (err) {
    if (err instanceof LoomInvalidModelError) return err.findings.filter((f) => f.severity === 'error');
    throw err;
  }
  const findings: Finding[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    if (!existsSync(abs)) findings.push(asFinding('OUTPUT_MISSING', rel, `${rel} is not present in ${dir}`, 'write the projections into the directory'));
    else if (readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') !== text) findings.push(asFinding('OUTPUT_DRIFT', rel, `${rel} in ${dir} differs from a fresh projection`, 'edit the model, never the generated file, and write the projections again'));
  }
  return findings;
}

/**
 * One model checked in order: ownership and configuration (the session),
 * validity under the verified inputs, the comparison with the trusted accepted
 * baseline, then the installed outputs and their manifest.
 */
function checkOne(s: Session, out: string | undefined, draft: boolean): ResultEnvelope {
  const model = s.model as Model;
  const base = compareBaselineTool({ model }, s.inputs);
  const findings = [...base.findings];
  let outputs: unknown[] = [];
  if (out !== undefined) findings.push(...directoryDrift(model, out, draft, s));
  else if (s.workspace) {
    const r = checkOutputs(s.mode === 'explicit' ? governed(s, model) : s.workspace, { inputs: s.inputs, ...(draft ? { draft } : {}) });
    findings.push(...r.findings);
    outputs = r.artifacts;
  }
  return stampSession(envelope('cli.check', { model, findings, states: base.states, data: { mode: s.mode, ownership: s.ownership, outputs, baseline: base.data } }), s);
}

function checkAll(ctx: Context): CommandResult {
  const a = ctx.args;
  const explicit = flag(a, 'boundary');
  const boundary = findBoundary(resolve(ctx.cwd), explicit ? resolve(ctx.cwd, explicit) : undefined);
  const walk = discoverAll(boundary);
  const findings = [...walk.findings];
  const models: Array<Record<string, unknown>> = [];
  let invalid = false;
  for (const d of walk.descriptors) {
    if (!d.readable) {
      models.push({ descriptor: d.location, outcome: 'unreadable' });
      continue;
    }
    const trustedRef = flag(a, 'trusted-ref');
    const s = openSession(d.home, { boundary, ...(trustedRef ? { trustedRef } : {}) });
    if (!s.model) {
      findings.push(...s.findings.map((f) => ({ ...f, path: `${d.location}:${f.path}` })));
      models.push({ descriptor: d.location, outcome: 'unresolved' });
      continue;
    }
    const one = checkOne(s, undefined, has(a, 'draft'));
    const errors = one.findings.filter((f) => f.severity === 'error').length;
    if (one.states.validation.state === 'invalid' || errors) invalid = true;
    findings.push(...one.findings.map((f) => ({ ...f, path: `${d.location}:${f.path}` })));
    models.push({ descriptor: d.location, outcome: one.outcome, validation: one.states.validation.state, acceptance: one.states.acceptance.state, errors, revision: one.revisions.model });
  }
  if (!walk.coverage.complete && !findings.some((f) => f.code === 'SCOPE_UNRESOLVED')) {
    findings.push(asFinding('SCOPE_UNRESOLVED', walk.coverage.boundary, 'the walk did not inspect the whole boundary, so global disjointness is not established', 'check out every declared submodule and repair every unreadable descriptor, then check again'));
  }
  const states: States = defaultStates(models.length ? { state: invalid ? 'invalid' : 'valid', reasons: [] } : NOT_EVALUATED);
  const env = envelope('cli.checkAll', { model: null, findings, states, data: { boundary: walk.coverage.boundary, coverage: walk.coverage, models } });
  return { env, detail: [`descriptors: ${walk.descriptors.length}; coverage ${walk.coverage.complete ? 'complete' : 'incomplete'}`] };
}

export function cmdCheck(ctx: Context): CommandResult {
  if (has(ctx.args, 'all')) return checkAll(ctx);
  const s = session(ctx);
  if (!s.model) return noModel('cli.check', s);
  const out = flag(ctx.args, 'out');
  const env = checkOne(s, out === undefined ? undefined : resolve(ctx.cwd, out), has(ctx.args, 'draft'));
  return { env, detail: [`mode: ${s.mode}`] };
}

export function cmdInit(ctx: Context): CommandResult {
  const boundary = flag(ctx.args, 'boundary');
  return { env: initWorkspace(ctx.cwd, { ...(has(ctx.args, 'force') ? { force: true } : {}), ...(boundary ? { boundary: resolve(ctx.cwd, boundary) } : {}) }) };
}

/** Install the bundle: every enabled artifact, with readiness, coverage and evidence views evaluated under the verified inputs. */
function install(ctx: Context, tool: string): CommandResult {
  const s = session(ctx);
  if (!s.model) return noModel(tool, s);
  const draft = has(ctx.args, 'draft');
  const out = flag(ctx.args, 'out');
  if (out !== undefined) {
    const dir = resolve(ctx.cwd, out);
    let files: Record<string, string>;
    try {
      files = projectToFiles(s.model, { draft, inputs: s.inputs });
    } catch (err) {
      if (err instanceof LoomInvalidModelError) {
        return { env: stampSession(envelope(tool, { model: s.model, findings: err.findings, refusal: refusal('invalid-input', err.message) }), s) };
      }
      throw err;
    }
    for (const [rel, text] of Object.entries(files)) {
      const path = join(dir, ...rel.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, 'utf8');
    }
    return { env: stampSession(envelope(tool, { model: s.model, findings: [], data: { written: Object.keys(files) } }), s), detail: [`wrote ${Object.keys(files).length} file(s) to ${dir}`] };
  }
  if (!s.workspace) return noWorkspace(tool, s);
  const ws = s.mode === 'explicit' ? governed(s, s.model) : s.workspace;
  const env = installOutputs(ws, { inputs: s.inputs, ...(draft ? { draft } : {}) });
  return { env: stampSession({ ...env, tool }, s) };
}

export const cmdWrite = (ctx: Context): CommandResult => install(ctx, 'cli.write');
export const cmdDocs = (ctx: Context): CommandResult => install(ctx, 'cli.docs');

export function cmdOwner(ctx: Context): CommandResult {
  const target = resolve(ctx.cwd, ctx.args.positionals[0] ?? '.');
  const boundary = flag(ctx.args, 'boundary');
  const r = resolveOwner(target, boundary ? { boundary: resolve(ctx.cwd, boundary) } : {});
  const env = envelope('cli.owner', { model: null, findings: r.findings, states: defaultStates(NOT_EVALUATED), data: r.result });
  return { env, detail: [`status: ${r.result.status}${r.result.owner ? ` (${r.result.owner.descriptor}, component ${r.result.owner.component})` : ''}`] };
}

/** The model document a migration reads: an explicit path, or the governing descriptor's model at this repository root. */
function migrationSource(ctx: Context): string {
  const explicit = flag(ctx.args, 'model');
  if (explicit) return resolve(ctx.cwd, explicit);
  const repo = findRepositoryRoot(resolve(ctx.cwd));
  if (repo && hasDescriptor(repo)) {
    const config = readConfig(loomDirOf(repo));
    if (config.value) return join(loomDirOf(repo), ...config.value.model.split('/'));
  }
  throw new UsageError('migrate needs --model <path> outside a repository root that holds a .loom');
}

export function cmdMigrate(ctx: Context): CommandResult {
  const source = migrationSource(ctx);
  const doc = readJsonFile(source, 'model document');
  const r = migrateModel(doc);
  const to = flag(ctx.args, 'to');
  let written: string | undefined;
  if (to !== undefined) {
    const target = resolve(ctx.cwd, to);
    if (target === source) throw new UsageError('--to must name a new file; a migration never replaces its source, so the result can be compared and tested first');
    if (r.after && !r.findings.some((f) => f.severity === 'error')) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${exportModel(r.after)}\n`, 'utf8');
      written = target;
    }
  }
  const data = { steps: r.steps, changes: r.changes, ...(written ? { written } : {}) };
  const env = envelope('cli.migrate', { model: r.after, findings: r.findings, data, ...(r.after ? {} : { refusal: refusal('invalid-input', 'no registered migration leads to the current model format') }) });
  return { env, detail: [`steps: ${r.steps.length ? r.steps.join(' -> ') : 'none (already current)'}`] };
}

export function cmdBaseline(ctx: Context): CommandResult {
  const sub = ctx.args.positionals[0];
  if (sub !== 'create') throw new UsageError("baseline needs the subcommand 'create'");
  const s = session(ctx);
  if (!s.workspace || !s.model) return noWorkspace('cli.baseline', s);
  const predecessor = flag(ctx.args, 'predecessor');
  const trustedRef = flag(ctx.args, 'trusted-ref');
  const r = createBaseline(s.workspace.root, {
    id: required(ctx.args, 'id'),
    acceptance: required(ctx.args, 'acceptance'),
    ...(predecessor ? { predecessor } : {}),
    ...(trustedRef ? { trustedRef } : {}),
    ...(s.inputs.policy ? { policy: s.inputs.policy } : {}),
    ...(has(ctx.args, 'frozen') ? { frozen: true } : {}),
  });
  const env = envelope('cli.baseline', { model: s.model, findings: r.findings, data: r.value ?? {}, ...(r.refused ? { refusal: refusal('invalid-input', r.refused) } : {}) });
  return { env: stampSession(env, s) };
}

function refsOf(values: string[] | undefined): RecordRef[] {
  return (values ?? []).map((v) => {
    const i = v.indexOf(':');
    if (i <= 0) throw new UsageError(`'${v}' is not a record reference; write kind:id, for example type:order`);
    return { kind: v.slice(0, i) as RecordKind, id: v.slice(i + 1) };
  });
}

export function cmdAccept(ctx: Context): CommandResult {
  const s = session(ctx);
  if (!s.workspace || !s.model) return noWorkspace('cli.accept', s);
  const policyId = s.inputs.policy?.id ?? s.workspace.config.gates.policyRef;
  if (!policyId) {
    return { env: stampSession(envelope('cli.accept', { model: s.model, findings: [], refusal: refusal('unmet-prerequisite', 'acceptance is recorded under a policy; set gates.policyRef in loom.json') }), s) };
  }
  const kind = (flag(ctx.args, 'subject') ?? 'change') as Acceptance['subject']['kind'];
  const baseline = flag(ctx.args, 'baseline');
  const base = flag(ctx.args, 'base');
  const decision = (flag(ctx.args, 'decision') ?? 'accepted') as Acceptance['decision'];
  let record: Acceptance = {
    acceptanceVersion: 1,
    id: required(ctx.args, 'id'),
    subject: { kind, candidate: modelRevision(s.model), ...(baseline ? { baseline } : {}), ...(base ? { base } : {}) },
    decision,
    authority: required(ctx.args, 'authority'),
    policy: { ref: policyId, revision: s.inputs.policy?.revision ?? 1 },
    scope: refsOf(list(ctx.args, 'scope')),
    changeClasses: list(ctx.args, 'classes') ?? [],
    at: new Date().toISOString(),
  };
  const errors = schemaErrors('Acceptance', record);
  if (errors.length) throw new UsageError(`the acceptance record is not valid: ${errors.map((e) => `${e.pointer || '(root)'} ${e.message}`).join('; ')}`);
  const keyId = flag(ctx.args, 'key-id');
  if (keyId) {
    const env = flag(ctx.args, 'key-env') ?? 'LOOM_ACCEPTANCE_KEY';
    const pem = process.env[env];
    if (!pem) throw new UsageError(`--key-id needs the private key in the environment variable ${env}`);
    record = signRecord(record, pem, keyId);
  }
  const r = createAcceptance(s.workspace.root, record);
  const env = envelope('cli.accept', { model: s.model, findings: r.findings, data: r.value ?? {}, ...(r.refused ? { refusal: refusal('invalid-input', r.refused) } : {}) });
  return { env: stampSession(env, s), detail: ['an acceptance record is trusted only once it is present at the trusted ref or signed by a key the trusted policy lists'] };
}

function taskOf(ctx: Context): TaskSpec {
  const a = ctx.args;
  const file = flag(a, 'task');
  if (file !== undefined) {
    // Substitutes and records have no flag form, so a whole TaskSpec comes from a file.
    const task = readJsonFile(resolve(ctx.cwd, file), 'task file') as TaskSpec;
    const errors = schemaErrors('TaskSpec', task);
    if (errors.length) throw new UsageError(`the task file is not a valid task: ${errors.map((e) => `${e.pointer || '(root)'} ${e.message}`).join('; ')}`);
    return task;
  }
  const components = list(a, 'components');
  const requirements = list(a, 'requirements');
  const records = list(a, 'records');
  const id = flag(a, 'task-id');
  const task = {
    class: required(a, 'class'),
    mode: flag(a, 'mode') ?? 'component',
    ...(id ? { id } : {}),
    ...(components ? { components } : {}),
    ...(requirements ? { requirements } : {}),
    ...(records ? { records: refsOf(records) } : {}),
  } as TaskSpec;
  const errors = schemaErrors('TaskSpec', task);
  if (errors.length) throw new UsageError(`the task is not valid: ${errors.map((e) => `${e.pointer || '(root)'} ${e.message}`).join('; ')}`);
  return task;
}

export function cmdReadiness(ctx: Context): CommandResult {
  const s = session(ctx);
  if (!s.model) return noModel('loom.checkReadiness', s);
  const env = stampSession(checkReadinessTool({ model: s.model, task: taskOf(ctx) }, s.inputs), s);
  const data = env.data as { allowedNext?: string[] } | undefined;
  return { env, detail: [`allowed next: ${(data?.allowedNext ?? []).join(', ') || 'none'}`] };
}

export function cmdPlan(ctx: Context): CommandResult {
  const s = session(ctx);
  if (!s.model) return noModel('loom.planChange', s);
  const env = planChangeTool({ model: s.model, baseRevision: flag(ctx.args, 'base') ?? modelRevision(s.model), ...patchesOf(ctx), acknowledgeBreaking: list(ctx.args, 'ack') ?? [] }, s.inputs);
  return { env: stampSession(env, s) };
}

/**
 * A persistent mutation through the workspace adapter, the one the MCP server
 * performs too: refused unless the workspace model is still at the expected
 * revision, computed by the pure core, then written under the workspace lock,
 * which rechecks the base revision. The patch file is read only once the
 * revision holds.
 */
export function cmdMutate(ctx: Context): CommandResult {
  const s = session(ctx);
  if (!s.workspace || !s.model || s.mode !== 'workspace') return noWorkspace('loom.mutate', s);
  const expected = required(ctx.args, 'expected');
  const env = mutateWorkspace(s, expected, () => ({ ...patchesOf(ctx), acknowledgeBreaking: list(ctx.args, 'ack') ?? [], dryRun: has(ctx.args, 'dry-run') }));
  const data = env.data as MutateData | undefined;
  return data?.committed === true ? { env, detail: [`committed revision ${data.revision ?? ''}`] } : { env };
}

const qualificationOf = (testOutcome: string): QualificationState =>
  testOutcome === 'PASS'
    ? { state: 'qualified', reasons: [] }
    : testOutcome === 'FAIL'
      ? { state: 'unqualified', reasons: [{ code: 'EVIDENCE_FAILED', message: 'a required check failed', refs: [] }] }
      : { state: 'unknown', reasons: [{ code: 'EVIDENCE_UNKNOWN', message: 'a required check did not produce a result', refs: [] }] };

/** The checks of the language and interface profiles whose artifacts the workspace's projection profile enables. */
function checksFor(ws: Workspace, profiles: string[] | undefined): string[] {
  const enabled = new Set(enabledTargets(ws));
  const chosen = profiles ? PROFILES.filter((p) => profiles.includes(p.id)) : PROFILES.filter((p) => p.artifacts.some((a) => enabled.has(a.target)));
  return chosen.flatMap((p) => p.checks.map((c) => c.id));
}

function runSummary(run: RunOutput['run']): string[] {
  return run.checks.map((c) => `check ${c.check} (${c.required ? 'required' : 'optional'}): ${c.result}${c.reason ? ` - ${c.reason}` : ''}`);
}

/** The outcome metrics of the run, beside the recorded baseline that --compare names. */
function metricsOf(ctx: Context, run: RunOutput['run']): { report: MetricsReport; detail: string[] } {
  const report = computeMetrics(ctx.loomRoot, run);
  const file = flag(ctx.args, 'compare');
  const line = (name: string, c: { cases: number; intended: number }): string => `${name}: ${c.intended} of ${c.cases} with the intended outcome`;
  const detail = [line('seeded errors detected', report.seededErrors), line('legitimate changes accepted', report.legitimateChanges), line('contradictions rejected', report.escapedContradictions ?? { cases: 0, intended: 0 }), line('stale evidence detected', report.staleEvidence), line('ready tasks not blocked', report.unnecessaryBlocking)];
  if (file === undefined) return { report, detail };
  const baseline = readJsonFile(resolve(ctx.cwd, file), 'metrics baseline');
  const errors = schemaErrors('MetricsReport', baseline);
  if (errors.length) throw new UsageError(`'${file}' is not a metrics report: ${errors.map((e) => `${e.pointer || '(root)'} ${e.message}`).join('; ')}`);
  const compared = compareMetrics(report, baseline as MetricsReport);
  return { report: compared, detail: [...detail, ...(compared.comparison ?? []).map((c) => `${c.metric}: baseline ${c.baseline}, current ${c.current}`)] };
}

export async function cmdQualify(ctx: Context): Promise<CommandResult> {
  const a = ctx.args;
  if (has(a, 'compare') && !has(a, 'metrics')) throw new UsageError('--compare names the baseline of --metrics');
  const signer = signerOf(ctx);
  if (has(a, 'self')) {
    const q = await selfQualify(ctx.loomRoot, signer ? { signer } : {});
    const data: Record<string, unknown> = { run: q.run, evidence: q.evidence.map((e) => e.id), unlisted: q.unlisted };
    const metrics = has(a, 'metrics') ? metricsOf(ctx, q.run) : null;
    if (metrics) data['metrics'] = metrics.report;
    const states = defaultStates(NOT_EVALUATED);
    states.qualification = q.unlisted.length ? { state: 'unknown', reasons: [{ code: 'EVIDENCE_UNKNOWN', message: `checks outside the self-qualification policy: ${q.unlisted.join(', ')}`, refs: [] }] } : qualificationOf(q.run.testOutcome);
    return { env: envelope('cli.qualify', { model: null, findings: q.findings, states, data }), detail: [...runSummary(q.run), `testOutcome: ${q.run.testOutcome}`, ...(metrics?.detail ?? [])] };
  }
  const s = session(ctx);
  if (!s.workspace || !s.model) return noWorkspace('cli.qualify', s);
  const known = new Set(PROFILES.flatMap((p) => p.checks.map((c) => c.id)));
  const unknownProfiles = (list(a, 'profile') ?? []).filter((id) => !PROFILES.some((p) => p.id === id));
  if (unknownProfiles.length) throw new UsageError(`unknown profile(s): ${unknownProfiles.join(', ')}`);
  const checks = list(a, 'checks') ?? checksFor(s.workspace, list(a, 'profile'));
  const unknownChecks = checks.filter((id) => !known.has(id));
  if (unknownChecks.length) throw new UsageError(`unknown check(s): ${unknownChecks.join(', ')}; describe --detail full --sections profiles lists them`);
  const fixturesFile = flag(a, 'fixtures');
  const fixtures = (fixturesFile ? readJsonFile(resolve(ctx.cwd, fixturesFile), 'fixtures file') : {}) as Fixtures;
  if (!fixtures.baseline && s.inputs.baseline) fixtures.baseline = s.inputs.baseline.model;
  const rendering = artifactInputs(s.inputs);
  const out = await runChecks({
    root: s.workspace.root,
    model: s.model,
    checks,
    fixtures,
    ...(rendering ? { inputs: rendering } : {}),
    ...(s.inputs.policy ? { policy: s.inputs.policy } : {}),
    ...(signer ? { signer } : {}),
    ...(has(a, 'store') ? { store: true } : {}),
    runner: flag(a, 'runner') ?? 'loom-cli',
  });
  // The run's records join the stored evidence under the trusted policy's keys; an unsigned fresh record is a claim, not evidence.
  const keys = s.inputs.policy?.trust.evidenceKeys ?? [];
  const fresh = out.evidence.map((record) => {
    const key = keys.find((k) => k.id === record.signature?.keyId);
    const trusted = key !== undefined && verifyRecord(record, key.spki);
    return trusted ? { record, trusted } : { record, trusted, reason: key ? 'the signature does not verify' : 'no evidence key of the trusted policy signs this record' };
  });
  // The session hashed only the artifacts stored evidence names; the fresh records name theirs too.
  const evaluated = evaluateEvidenceTool({ model: s.model }, withArtifactHashes(s.model, { ...s.inputs, evidence: [...(s.inputs.evidence ?? []), ...fresh] }));
  const states = defaultStates(validationState(validate(s.model, s.inputs)));
  states.qualification = evaluated.states.qualification;
  const data: Record<string, unknown> = { run: out.run, evidence: out.evidence.map((e) => e.id), obligations: (evaluated.data as { obligations?: unknown } | undefined)?.obligations ?? [] };
  const metrics = has(a, 'metrics') ? metricsOf(ctx, out.run) : null;
  if (metrics) data['metrics'] = metrics.report;
  return { env: stampSession(envelope('cli.qualify', { model: s.model, findings: out.findings, states, data }), s), detail: [...runSummary(out.run), `testOutcome: ${out.run.testOutcome}`, ...(metrics?.detail ?? [])] };
}

export function cmdEvidence(ctx: Context): CommandResult {
  const sub = ctx.args.positionals[0];
  const s = session(ctx);
  if (!s.workspace) return noWorkspace('cli.evidence', s);
  const trust = new Map(readTrustedEvidence(s.workspace.root, s.inputs.policy ?? null).evidence.map((e) => [e.record.id, e]));
  if (sub === 'list') {
    const r = listEvidence(s.workspace.root);
    const records = (r.value ?? []).map((e) => ({ id: e.id, check: e.check.id, kind: e.kind, result: e.result, trusted: trust.get(e.id)?.trusted ?? false, ...(trust.get(e.id)?.reason ? { reason: trust.get(e.id)?.reason } : {}) }));
    return { env: stampSession(envelope('cli.evidence', { model: s.model, findings: r.findings, data: { records } }), s), detail: records.map((x) => `${x.id}: ${x.check} ${x.result}${x.trusted ? '' : ' (untrusted)'}`) };
  }
  if (sub === 'show') {
    const id = ctx.args.positionals[1];
    if (!id) throw new UsageError('evidence show needs an evidence id');
    const record = readEvidence(s.workspace.root, id);
    if (!record) {
      return { env: stampSession(envelope('cli.evidence', { model: s.model, findings: [asFinding('EVIDENCE_MISSING', id, `no evidence record '${id}' is stored`, 'list the stored evidence and name an existing id')], refusal: refusal('unresolved-context', `evidence '${id}' is not stored`) }), s) };
    }
    return { env: stampSession(envelope('cli.evidence', { model: s.model, findings: [], data: { record, trusted: trust.get(id)?.trusted ?? false } }), s) };
  }
  throw new UsageError("evidence needs the subcommand 'list' or 'show <id>'");
}

/** The page budget the --max-bytes and --max-records flags name; a flag left out leaves its member to the default. */
function budgetOf(a: Args): DiscoveryBudget | undefined {
  const maxBytes = integer(a, 'max-bytes');
  const maxRecords = integer(a, 'max-records');
  return maxBytes === undefined && maxRecords === undefined ? undefined : { ...(maxBytes !== undefined ? { maxBytes } : {}), ...(maxRecords !== undefined ? { maxRecords } : {}) };
}

export function cmdContext(ctx: Context): CommandResult {
  const s = session(ctx);
  if (!s.model) return noModel('loom.context', s);
  const a = ctx.args;
  const kind = (flag(a, 'kind') ?? 'component') as ContextTarget['kind'];
  let target: ContextTarget;
  if (kind === 'task') target = { kind, task: taskOf(ctx) };
  else if (kind === 'component') target = { kind, ref: { kind: 'component', id: required(a, 'id') } };
  else target = { kind, ref: { kind: required(a, 'record-kind') as RecordKind, id: required(a, 'id') } };
  const budget = budgetOf(a);
  const continuation = flag(a, 'continuation');
  // In workspace mode the request that starts again addresses the workspace, never a copy of its model.
  const options = s.mode === 'workspace' ? { address: { workspace: true } } : {};
  const env = contextTool({ model: s.model, target, ...(budget ? { budget } : {}), ...(continuation ? { continuation } : {}) }, s.inputs, options);
  return { env: stampSession(env, s) };
}

export function cmdDescribe(ctx: Context): CommandResult {
  const a = ctx.args;
  const detail = flag(a, 'detail') as DescribeInput['detail'];
  const sections = list(a, 'sections') as DescribeInput['sections'];
  const profile = flag(a, 'profile');
  const operation = flag(a, 'operation');
  const cursor = flag(a, 'cursor');
  const budget = budgetOf(a);
  return {
    env: describeTool({
      ...(detail ? { detail } : {}),
      ...(sections ? { sections } : {}),
      ...(profile ? { profile } : {}),
      ...(operation ? { operation } : {}),
      ...(cursor ? { cursor } : {}),
      ...(budget ? { budget } : {}),
    }),
  };
}
