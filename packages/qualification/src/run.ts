import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from '@loom/core';
import { pinRevisionSet, putEvidence, signRecord } from '@loom/workspace';
import { materialize } from './artifacts.js';
import { aggregate, environmentFor, isRequired } from './policy.js';
import { RUNNERS } from './runners/index.js';
import { defaultToolLocator, type ToolLocator } from './tools.js';
import type { ArtifactSet, Fixtures, Runner, RunnerOutcome, RunResources } from './types.js';

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

const newRunId = (): string => `run.${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.${randomBytes(4).toString('hex')}`;

class Resources implements RunResources {
  private readonly held = new Map<string, { value: Promise<unknown>; release: (v: unknown) => Promise<void> }>();

  acquire<T>(key: string, create: () => Promise<T>, release: (value: T) => Promise<void>): Promise<T> {
    const existing = this.held.get(key);
    if (existing) return existing.value as Promise<T>;
    const value = create();
    this.held.set(key, { value, release: release as (v: unknown) => Promise<void> });
    // A resource whose creation failed is forgotten, so a later check can retry and the release never runs on nothing.
    value.catch(() => this.held.delete(key));
    return value;
  }

  async releaseAll(): Promise<void> {
    for (const [, h] of [...this.held].reverse()) {
      try {
        await h.release(await h.value);
      } catch {
        // creation failed or release failed; nothing of this run is left to undo
      }
    }
    this.held.clear();
  }
}

function withTimeout(p: Promise<RunnerOutcome>, ms: number, id: string): Promise<RunnerOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<RunnerOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ result: 'UNKNOWN', reason: `${id} did not finish within ${ms} ms` }), ms + 5_000);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Run checks and return signed, revision-bound evidence. Checks run one at a
 * time so native tools never compete for memory. A missing or out-of-policy
 * tool, an undesignated environment, an unreadable result, a crash or a
 * timeout is UNKNOWN with its reason, never PASS.
 */
export async function runChecks(options: RunOptions): Promise<RunOutput> {
  const log = options.log ?? (() => undefined);
  const runId = newRunId();
  const runDir = mkdtempSync(join(tmpdir(), 'loom-qualify-'));
  const tools = options.toolLocator ?? defaultToolLocator();
  const runners = { ...RUNNERS, ...(options.runners ?? {}) };
  const timeoutMs = options.timeoutMs ?? 900_000;
  const resources = new Resources();
  const checks = resolveChecks(options.checks);
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
      if (!env.ok) result = { result: 'UNKNOWN', reason: env.reason };
      else if (resolved.status === 'missing') result = { result: 'UNKNOWN', reason: resolved.reason };
      else if (resolved.status === 'out-of-policy') {
        toolRecord = { name: resolved.tool.name, version: resolved.tool.version };
        result = { result: 'UNKNOWN', reason: resolved.reason };
      } else if (!run) result = { result: 'UNKNOWN', reason: `no built-in runner '${check.runner}' exists for ${check.id}` };
      else {
        toolRecord = { name: resolved.tool.name, version: resolved.tool.version };
        log(`check ${check.id}: running ${check.runner} with ${resolved.tool.name} ${resolved.tool.version}`);
        try {
          result = await withTimeout(
            run({ check, runId, dir, root: options.root, model: options.model, artifacts, fixtures: options.fixtures ?? {}, inputs, tool: resolved.tool, tools, timeoutMs, resources }),
            timeoutMs,
            check.id,
          );
        } catch (e) {
          result = { result: 'UNKNOWN', reason: `${check.runner} stopped with an error: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      if (result.result === 'NOT_APPLICABLE' && !result.reason.trim()) result = { result: 'UNKNOWN', reason: 'NOT_APPLICABLE was returned without a justification' };
      if (artifacts.draft && result.result === 'PASS') result = { ...result, result: 'UNKNOWN', reason: `${result.reason}; the artifacts are an incomplete draft, which cannot qualify` };
      const record = buildEvidence({ runId, runner, check, required, result, toolRecord, env, artifacts, sources, startedAt: checkStarted, model: options.model, index });
      const signed = sign(record);
      evidence.push(signed);
      const entry: RunRecord['checks'][number] = { check: check.id, required, result: result.result, evidence: signed.id };
      if (result.reason) entry.reason = result.reason;
      outcomes.push(entry);
      log(`check ${check.id}: ${result.result} - ${result.reason}`);
    }
  } finally {
    await resources.releaseAll();
    if (!options.keepRunDir) rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  // The generated views summarize the store, so a record stored while checks still run would change what a later check of the same run reads.
  if (options.store) for (const record of evidence) findings.push(...putEvidence(options.root, record).findings);

  const profiles = [...new Map(checks.map((c) => profileOf(c)).filter((p) => p !== undefined).map((p) => [p!.id, p!])).values()];
  const run: RunRecord = {
    runVersion: 1,
    id: runId,
    runner,
    startedAt,
    finishedAt: new Date().toISOString(),
    revisionSet: {
      contractDigest: CONTRACT_DIGEST,
      sources,
      model: modelRevision(options.model),
      profiles: profiles.map((p) => ({ id: p.id, version: p.version, hash: canonicalHash(p) })),
    },
    checks: outcomes,
    aggregate: aggregate(outcomes),
  };
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
