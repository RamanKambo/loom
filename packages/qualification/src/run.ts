import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  CONTRACT_DIGEST,
  PROFILES,
  canonicalHash,
  modelRevision,
  parseRefKey,
  indexModel,
  recordHash,
  type CheckDefinition,
  type CheckResult,
  type EvaluationInputs,
  type EvidenceRecord,
  type Finding,
  type Model,
  type Policy,
  type RunRecord,
  type SourceRevision,
  type RunBudgets,
  type RunCleanup,
  type AllocationJournal,
  type ProviderRef,
} from '@loom/core';
import { pinRevisionSet, putEvidence, signRecord } from '@loom/workspace';
import { materialize } from './artifacts.js';
import { aggregate, environmentFor, isRequired } from './policy.js';
import { RUNNERS } from './runners/index.js';
import { defaultToolLocator, fileDigest, type ToolLocator } from './tools.js';
import { unavailableCause, type ArtifactSet, type Fixtures, type Runner, type RunnerOutcome, type RunResources } from './types.js';
import { Lifecycle, acquireLease, defaultLifecycleRoot, diskBytes, assertLifecycleResult, claimCleanup, recoverRun, sameProcess } from './lifecycle.js';
import { readProviderConfiguration, type ProviderEntry } from './provider.js';

export interface Signer {
  /** Environment variable holding the Ed25519 private key PEM; the key itself never enters a record. */
  keyEnv?: string;
  keyId: string;
}

export interface RunOptions {
  /** Root that fixture paths and source pins resolve against; also the workspace whose evidence store receives records when `store` is set. */
  root: string;
  model: Model;
  checks: ReadonlyArray<CheckDefinition | string>;
  artifacts?: ArtifactSet;
  fixtures?: Fixtures;
  /** Verified inputs the artifacts are rendered with, such as the resolved published-contract bundles. */
  inputs?: EvaluationInputs;
  policy?: Policy;
  environmentId?: string;
  signer?: Signer;
  toolLocator?: ToolLocator;
  /** Runner identity recorded in every record. */
  runner?: string;
  /** Write every evidence record into the workspace evidence store at `root` once the last check has finished. */
  store?: boolean;
  /** Limit for one check; a check still running is stopped and reported UNKNOWN. */
  timeoutMs?: number;
  /** Replace or add runners, by runner id. */
  runners?: Readonly<Record<string, Runner>>;
  /** Keep the run directory for inspection instead of deleting it. */
  keepRunDir?: boolean;
  log?: (line: string) => void;
  signal?: AbortSignal;
  lifecycleRoot?: string;
  /** LocalDB cannot promise an OS-enforced hard memory bound. */
  requireHardMemoryLimit?: boolean;
  /** Registry-assigned opaque id; only trusted adapters supply it. */
  runId?: string;
  provider?: ProviderRef;
  targetCapabilities?: readonly string[];
  implementationFiles?: readonly string[];
  fixtureFiles?: readonly string[];
  assertionFiles?: readonly string[];
}

export interface RunOutput {
  run: RunRecord;
  evidence: EvidenceRecord[];
  findings: Finding[];
  /** The run's temporary directory; deleted on return unless keepRunDir was set. */
  runDir: string;
}

const ALL_CHECKS = (): CheckDefinition[] => PROFILES.flatMap((p) => p.checks);

/** Check definitions by id, from every profile. An unknown id throws: a run never invents a check. */
export function resolveChecks(checks: ReadonlyArray<CheckDefinition | string>): CheckDefinition[] {
  const all = ALL_CHECKS();
  return checks.map((c) => {
    if (typeof c !== 'string') return c;
    const found = all.find((x) => x.id === c);
    if (!found) throw new Error(`no profile defines check '${c}'`);
    return found;
  });
}

/** The profile that defines a check. */
const profileOf = (check: CheckDefinition) => PROFILES.find((p) => p.checks.some((c) => c.id === check.id));

/**
 * The input digest of a run record: the canonical hash of its revision set and,
 * in run order, the id, revision and definition hash of every check it ran, so
 * anyone holding the record and the check definitions can recompute it.
 */
export function runInputDigest(revisionSet: RunRecord['revisionSet'], checks: readonly CheckDefinition[]): string {
  return canonicalHash({ revisionSet, checks: checks.map((c) => ({ id: c.id, revision: c.revision, definitionHash: canonicalHash(c) })) });
}

const newRunId = (): string => `run.${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.${randomBytes(4).toString('hex')}`;

class Resources implements RunResources {
  private readonly held = new Map<string, { value: Promise<unknown>; release: (v: unknown) => Promise<void>; partial?: () => unknown }>();

  acquire<T>(key: string, create: () => Promise<T>, release: (value: T) => Promise<void>, partial?: () => T | undefined): Promise<T> {
    const existing = this.held.get(key);
    if (existing) return existing.value as Promise<T>;
    const value = create();
    this.held.set(key, { value, release: release as (v: unknown) => Promise<void>, partial });
    // A resource whose creation failed is forgotten, so a later check can retry and the release never runs on nothing.
    // Failed acquisition remains visible; resource-specific intent journaling settles partial creation.
    return value;
  }

  async releaseAll(runId: string): Promise<RunCleanup> {
    const cleanup: RunCleanup = { state: 'running', outcomes: [], actions: [], residual: [] };
    for (const [key, h] of [...this.held].reverse()) {
      try {
        let value: unknown;
        try { value = await h.value; } catch { value = h.partial?.(); }
        if (value !== undefined) await h.release(value);
        cleanup.outcomes.push({ kind: 'instance', identity: key, outcome: 'done' });
      } catch (e) {
        cleanup.outcomes.push({ kind: 'instance', identity: key, outcome: 'failed', detail: String(e) });
        cleanup.residual.push({ kind: 'instance', identity: key });
      }
    }
    this.held.clear();
    cleanup.state = cleanup.residual.length ? 'failed' : 'clean';
    if (cleanup.residual.length) cleanup.recovery = { journal: runId, action: 'recover the run allocation journal before the next native allocation' };
    return cleanup;
  }
}

const DEFAULT_BUDGETS: RunBudgets = { totalDeadlineSeconds: 900, commandDeadlineSeconds: 60, engineStartDeadlineSeconds: 60, cleanupDeadlineSeconds: 60, fixtureFileBytes: 2147483648, maxServerMemoryMiB: 512, maxDegreeOfParallelism: 1 };

/**
 * Run checks and return signed, revision-bound evidence. Checks run one at a
 * time so native tools never compete for memory. A missing or out-of-policy
 * tool, an undesignated environment, an unreadable result, a crash or a
 * timeout is UNKNOWN with its reason, never PASS.
 */
export async function runChecks(options: RunOptions): Promise<RunOutput> {
  const log = options.log ?? (() => undefined);
  const runId = options.runId ?? newRunId();
  if (!/^run\.[A-Za-z0-9.-]+$/.test(runId)) throw new Error('invalid run identity');
  const lifecycleRoot = options.lifecycleRoot ?? defaultLifecycleRoot();
  mkdirSync(join(lifecycleRoot, 'runs'), { recursive: true });
  const runDir = mkdtempSync(join(lifecycleRoot, 'runs', 'loom-qualify-'));
  const tools = options.toolLocator ?? defaultToolLocator();
  const runners = { ...RUNNERS, ...(options.runners ?? {}) };
  const budgets = options.policy?.execution?.budgets ?? DEFAULT_BUDGETS;
  const timeoutMs = Math.min(options.timeoutMs ?? budgets.commandDeadlineSeconds * 1000, budgets.commandDeadlineSeconds * 1000);
  const controller = new AbortController();
  let timedOut = false;
  let budgetExceeded = false;
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, budgets.totalDeadlineSeconds * 1000);
  const resources = new Resources();
  const checks = resolveChecks(options.checks);
  const pinFiles = (paths: readonly string[]) => paths.map((path) => { const full = resolve(options.root, path); const rel = relative(options.root, full).replace(/\\/g, '/'); if (rel.startsWith('../') || !rel) throw new Error('qualification source pin escapes its root'); const hash = fileDigest(full); if (!hash) throw new Error(`qualification input is unreadable: ${rel}`); return { path: rel, hash }; });
  const implementationPins = pinFiles(options.implementationFiles ?? options.fixtures?.conforming?.sql ?? []);
  const fixturePins = pinFiles(options.fixtureFiles ?? []);
  const assertionPins = pinFiles(options.assertionFiles ?? []);
  const nativeSql = checks.some((c) => ['sql-catalog', 'sql-behavior', 'sql-transaction', 'sql-migration', 'sql-operations'].includes(c.runner));
  let lifecycle: Lifecycle | undefined;
  let releaseLease: (() => void) | undefined;
  let reserveFailure: string | undefined;
  let selectedProvider: ProviderEntry | undefined;
  if (nativeSql) {
    try {
      const provisioned = readProviderConfiguration();
      const providerId = options.provider?.id ?? options.policy?.execution?.providers[0] ?? 'localdb';
      if (options.policy && !options.policy.execution.providers.includes(providerId)) throw new Error('provider is outside the trusted execution policy');
      selectedProvider = provisioned?.providers.find((p) => p.id === providerId);
      if ((options.provider || provisioned) && !selectedProvider) throw new Error('selected provider has no trusted machine-local provisioning');
      if ((!selectedProvider || selectedProvider.kind === 'localdb') && (options.targetCapabilities ?? []).some((c) => !['relational', 'transactions', 'stored-procedures', 'backup', 'json', 'foreign-keys'].includes(c))) throw new Error('insufficient-resources: declared target capabilities exceed LocalDB Express capability policy');
      const journals = join(lifecycleRoot, 'journals');
      const localdb = await tools('sqllocaldb', { minimum: '15.0' });
      if (existsSync(journals)) for (const file of readdirSync(journals).filter((f) => f.endsWith('.json') && !f.endsWith('.cleanup.json'))) {
        const previous = JSON.parse(readFileSync(join(journals, file), 'utf8')) as AllocationJournal;
        if (previous.resources.some((r) => r.state !== 'removed') && !sameProcess(previous.owner.process)) {
          if (previous.provider.kind === 'localdb' && localdb.status !== 'found') throw new Error('unresolved journal requires a provisioned recovery provider');
          const recovered = await recoverRun(join(journals, file), localdb.status === 'found' ? localdb.tool.path : 'service', budgets.cleanupDeadlineSeconds * 1000);
          if (recovered.state !== 'clean') throw new Error('unresolved engine or files block native allocation');
        }
      }
      releaseLease = await acquireLease(lifecycleRoot, runId, controller.signal, budgets.totalDeadlineSeconds * 1000);
      lifecycle = new Lifecycle(lifecycleRoot, runId, { kind: selectedProvider?.kind ?? 'localdb', id: providerId });
      lifecycle.phase('preflight'); lifecycle.intend('directory', runDir, runDir); lifecycle.state(runDir, 'created'); lifecycle.phase('reserve');
    } catch (e) { reserveFailure = String(e); }
  }
  const findings: Finding[] = [];
  const startedAt = new Date().toISOString();
  const runner = options.runner ?? 'local';
  const key = options.signer ? process.env[options.signer.keyEnv ?? 'LOOM_EVIDENCE_KEY'] : undefined;
  const sign = <T extends object>(record: T): T => (key && options.signer ? signRecord(record, key, options.signer.keyId) : record);

  let sources: SourceRevision[] = [];
  try {
    const pinned = pinRevisionSet(options.root);
    sources = pinned.sources;
    findings.push(...pinned.findings);
  } catch {
    // a root outside any repository has no revisions to pin
  }

  const evidence: EvidenceRecord[] = [];
  const outcomes: RunRecord['checks'] = [];
  let cleanup: RunCleanup = { state: 'clean', outcomes: [], actions: [], residual: [] };
  let peakDiskBytes = 0;
  let monitoring: Promise<void> = Promise.resolve();
  let sampling = false;
  const monitor = setInterval(() => { if (sampling) return; sampling = true; monitoring = (async () => { peakDiskBytes = Math.max(peakDiskBytes, diskBytes(runDir)); await lifecycle?.sampleEngine(); if (peakDiskBytes > budgets.fixtureFileBytes || (lifecycle?.peakWorkingSetBytes ?? 0) > budgets.maxServerMemoryMiB * 1048576) { budgetExceeded = true; controller.abort(); } })().catch((e) => log(`resource monitoring unavailable: ${String(e)}`)).finally(() => { sampling = false; }); }, 1000);
  try {
    const inputs = options.inputs ?? {};
    // Absent inputs and empty inputs render different views: 'not evaluated' against 'evaluated with nothing supplied'.
    const artifacts = options.artifacts ?? materialize(options.model, join(runDir, 'artifacts'), options.inputs ? { inputs } : {});
    const index = indexModel(options.model);
    for (const check of checks) {
      const checkStarted = new Date().toISOString();
      const required = isRequired(check, options.policy);
      const dir = join(runDir, check.id.replace(/[^A-Za-z0-9.-]/g, '_'));
      mkdirSync(dir, { recursive: true });
      let result: RunnerOutcome;
      let toolRecord = { name: check.tool.name as string, version: 'unknown' };
      const env = environmentFor(check, options.policy, options.environmentId);
      const resolved = await tools(check.tool.name, check.tool.versionPolicy);
      const run = runners[check.runner];
      if (controller.signal.aborted) result = { result: 'UNKNOWN', reason: budgetExceeded ? 'run exceeded its measured file or memory budget' : timedOut ? 'run total deadline exceeded' : 'run cancelled', cause: budgetExceeded ? 'insufficient-resources' : timedOut ? 'timeout' : 'cancelled' };
      else if (reserveFailure && check.runner.startsWith('sql-')) result = { result: 'UNKNOWN', reason: reserveFailure, cause: 'provider-blocked' };
      else if (options.requireHardMemoryLimit && check.runner.startsWith('sql-')) result = { result: 'UNKNOWN', reason: 'the provider cannot enforce a hard OS process memory guarantee; SQL max server memory does not bound every allocation', cause: 'insufficient-resources' };
      else if (!env.ok) result = { result: 'UNKNOWN', reason: env.reason, cause: 'provider-blocked' };
      else if (resolved.status === 'missing') result = { result: 'UNKNOWN', reason: resolved.reason };
      else if (resolved.status === 'out-of-policy') {
        toolRecord = { name: resolved.tool.name, version: resolved.tool.version };
        result = { result: 'UNKNOWN', reason: resolved.reason };
      } else if (!run) result = { result: 'UNKNOWN', reason: `no built-in runner '${check.runner}' exists for ${check.id}` };
      else {
        toolRecord = { name: resolved.tool.name, version: resolved.tool.version };
        log(`check ${check.id}: running ${check.runner} with ${resolved.tool.name} ${resolved.tool.version}`);
        try {
          const checkController = new AbortController();
          const abort = () => checkController.abort();
          controller.signal.addEventListener('abort', abort, { once: true });
          const checkDeadline = setTimeout(() => checkController.abort(), timeoutMs);
          lifecycle?.phase('execute');
          try { result = await run({ check, runId, dir, root: options.root, model: options.model, artifacts, fixtures: options.fixtures ?? {}, inputs, tool: resolved.tool, tools, timeoutMs, resources, signal: checkController.signal, budgets, ...(lifecycle ? { lifecycle } : {}), ...(selectedProvider ? { provider: selectedProvider } : {}) }); }
          finally { clearTimeout(checkDeadline); controller.signal.removeEventListener('abort', abort); }
          if (checkController.signal.aborted) result = { result: 'UNKNOWN', reason: budgetExceeded ? 'measured resource budget exceeded and child processes awaited' : controller.signal.aborted && !timedOut ? 'run cancelled and child processes awaited' : 'check deadline exceeded and child processes awaited', cause: budgetExceeded ? 'insufficient-resources' : controller.signal.aborted && !timedOut ? 'cancelled' : 'timeout' };
        } catch (e) {
          result = { result: 'UNKNOWN', reason: `${check.runner} stopped with an error: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      if (result.result === 'NOT_APPLICABLE' && !result.reason.trim()) result = { result: 'UNKNOWN', reason: 'NOT_APPLICABLE was returned without a justification' };
      if (artifacts.draft && result.result === 'PASS') result = { ...result, result: 'UNKNOWN', reason: `${result.reason}; the artifacts are an incomplete draft, which cannot qualify` };
      const record = buildEvidence({ runId, runner, check, required, result, toolRecord, env, artifacts, sources, startedAt: checkStarted, model: options.model, index });
      const signed = sign(record);
      evidence.push(signed);
      const entry: RunRecord['checks'][number] = { check: check.id, required, result: result.result };
      if (result.reason) entry.reason = result.reason;
      if (result.result === 'UNKNOWN') { entry.cause = result.cause ?? unavailableCause(result.reason); entry.dependency = result.dependency ?? check.tool.name; }
      outcomes.push(entry);
      log(`check ${check.id}: ${result.result} - ${result.reason}`);
      peakDiskBytes = Math.max(peakDiskBytes, diskBytes(runDir));
    }
  } finally {
    clearTimeout(deadline); options.signal?.removeEventListener('abort', cancel);
    clearInterval(monitor); await monitoring;
    lifecycle?.phase('capture');
    // Durable evidence capture precedes every destructive lifecycle action.
    mkdirSync(join(lifecycleRoot, 'evidence'), { recursive: true });
    writeFileSync(join(lifecycleRoot, 'evidence', `${runId}.json`), JSON.stringify({ evidence, checks: outcomes }));
    if (options.store) for (const record of evidence) findings.push(...putEvidence(options.root, record).findings);
    lifecycle?.phase('quiesce');
    const releaseClaim = lifecycle ? claimCleanup(lifecycle.file, 'coordinator') : undefined;
    if (lifecycle && !releaseClaim) throw new Error('cleanup is already claimed by another actor');
    try { cleanup = await resources.releaseAll(runId); }
    finally { releaseClaim?.(); }
    if (!options.keepRunDir && cleanup.state === 'clean') {
      try { rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); lifecycle?.state(runDir, 'removed'); }
      catch (e) { cleanup.state = 'failed'; cleanup.residual.push({ kind: 'directory', identity: runDir }); cleanup.recovery = { journal: runId, action: String(e) }; }
    }
    lifecycle?.phase('release');
    if (lifecycle) {
      const unresolved = lifecycle.journal.resources.filter((r) => r.state !== 'removed');
      cleanup.outcomes = lifecycle.journal.resources.map((r) => ({ kind: r.kind, identity: r.identity, outcome: r.state === 'removed' ? 'done' : 'failed' }));
      cleanup.residual = unresolved.map((r) => ({ kind: r.kind, identity: r.identity }));
      cleanup.state = unresolved.length ? 'failed' : 'clean';
      if (unresolved.length) cleanup.recovery = { journal: runId, action: 'recover the durable allocation journal with its trusted provider' }; else delete cleanup.recovery;
      cleanup.actions = lifecycle.journal.phases.filter((p) => ['quiesce', 'remove-databases', 'stop', 'release'].includes(p.phase)).map((p) => ({ phase: p.phase, action: `${p.phase}: verify recorded run-owned resources`, outcome: cleanup.state === 'clean' ? 'done' : 'failed' }));
    }
    if (cleanup.state === 'clean') releaseLease?.();
    lifecycle?.stopGuardian();
    writeFileSync(join(lifecycleRoot, 'evidence', `${runId}.cleanup.json`), JSON.stringify(cleanup));
  }
  // The generated views summarize the store, so a record stored while checks still run would change what a later check of the same run reads.

  const profiles = [...new Map(checks.map((c) => profileOf(c)).filter((p) => p !== undefined).map((p) => [p!.id, p!])).values()];
  const revisionSet: RunRecord['revisionSet'] = {
    contractDigest: CONTRACT_DIGEST,
    sources,
    model: modelRevision(options.model),
    profiles: profiles.map((p) => ({ id: p.id, version: p.version, hash: canonicalHash(p) })),
    ...(options.policy ? { policy: { ref: options.policy.id, revision: options.policy.revision, hash: canonicalHash(options.policy) } } : {}),
    ...(implementationPins.length ? { implementation: implementationPins } : {}),
    ...(fixturePins.length ? { fixtures: fixturePins } : {}),
    ...(assertionPins.length ? { assertions: assertionPins } : {}),
  };
  const run: RunRecord = {
    runVersion: 1,
    runId,
    inputDigest: runInputDigest(revisionSet, checks),
    runner,
    startedAt,
    finishedAt: new Date().toISOString(),
    revisionSet,
    checks: outcomes,
    evidenceRefs: evidence.map((e) => e.id),
    testOutcome: aggregate(outcomes),
    ...(nativeSql ? { target: { platform: options.model.storage[0]?.platform ?? 'sqlserver-2022', capabilities: [...(options.targetCapabilities ?? [])] }, provider: lifecycle?.journal.provider ?? options.provider ?? { kind: 'localdb' as const, id: 'localdb' }, ...(lifecycle?.engineVersion ? { engineVersion: lifecycle.engineVersion } : {}) } : {}),
    cleanup,
    outcome: controller.signal.aborted && !timedOut && !budgetExceeded ? 'cancelled' : aggregate(outcomes) === 'PASS' && cleanup.state === 'clean' ? 'succeeded' : 'unsuccessful',
    resourceUsage: { peakWorkingSetBytes: lifecycle?.peakWorkingSetBytes ?? 0, diskBytes: peakDiskBytes, phaseDurations: lifecycle?.journal.phases.map((p) => ({ phase: p.phase, milliseconds: Date.parse(p.finishedAt ?? new Date().toISOString()) - Date.parse(p.startedAt) })) ?? [] },
    limits: { budgets, enforcement: (Object.keys(budgets) as (keyof RunBudgets)[]).map((limit) => ({ limit, enforced: ['totalDeadlineSeconds', 'commandDeadlineSeconds', 'engineStartDeadlineSeconds', 'cleanupDeadlineSeconds'].includes(limit), mechanism: 'bounded child process execution; SQL configuration recorded by native provider' })).concat([{ limit: 'processMemory' as keyof RunBudgets, enforced: false, mechanism: 'SQL max server memory does not constrain all engine allocations; no OS hard memory limit is available' }]) },
  };
  assertLifecycleResult(run.testOutcome, cleanup, run.outcome!);
  return { run: sign(run), evidence, findings, runDir };
}

interface EvidenceInput {
  runId: string;
  runner: string;
  check: CheckDefinition;
  required: boolean;
  result: RunnerOutcome;
  toolRecord: { name: string; version: string };
  env: ReturnType<typeof environmentFor>;
  artifacts: ArtifactSet;
  sources: SourceRevision[];
  startedAt: string;
  model: Model;
  index: ReturnType<typeof indexModel>;
}

function buildEvidence(i: EvidenceInput): EvidenceRecord {
  const used = i.result.instances
    ? i.artifacts.files.filter((f) => i.result.instances!.includes(f.instance))
    : i.artifacts.files.filter((f) => i.check.inputs.includes(f.target));
  const recordInputs = (i.result.records ?? []).flatMap((ref) => {
    const parsed = parseRefKey(ref, i.index);
    const hash = parsed ? recordHash(i.model, parsed) : null;
    return hash ? [{ ref, hash }] : [];
  });
  const claims: EvidenceRecord['claims'] = [
    { kind: 'check', ref: i.check.id },
    ...(i.result.claims ?? []),
    ...(i.result.records ?? []).map((ref) => ({ kind: 'contract' as const, ref })),
  ];
  const record: EvidenceRecord = {
    evidenceVersion: 1,
    id: `ev.${i.runId.slice(4)}.${i.check.id}`.slice(0, 128),
    claims,
    kind: i.check.evidence,
    check: { id: i.check.id, revision: i.check.revision, definitionHash: canonicalHash(i.check) },
    artifacts: used.map((f) => ({ instance: f.instance, hash: f.hash })),
    sources: i.sources,
    environment: i.env.ok ? i.env.environment : { id: 'none', kind: 'process' },
    tool: i.result.tool ?? i.toolRecord,
    result: i.result.result,
    run: { id: i.runId, runner: i.runner, startedAt: i.startedAt, finishedAt: new Date().toISOString() },
    boundaries: i.result.boundaries ?? [],
    limits: i.check.limits,
    inputs: [...used.map((f) => ({ ref: `artifact:${f.instance}`, hash: f.hash })), ...recordInputs],
  };
  if (i.result.reason) record.reason = i.result.reason;
  return record;
}

export type { CheckResult };
