import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { QualifyRunStatus, QualifyCancelData, RunCleanup } from '@loom/core';
import { resolveChecks, runChecks, type RunOptions, type RunOutput } from './run.js';
import { recoverRun, defaultLifecycleRoot } from './lifecycle.js';
import { defaultToolLocator } from './tools.js';
import { readProviderConfiguration } from './provider.js';

export interface AuthorizedQualification {
  /** Constructed by the trusted handle/policy adapter, never by the caller. */
  options: RunOptions;
  workspaceId: string;
  executionPolicy: string;
  qualifyGranted: boolean;
  /** Exact authorized check ids; an empty list authorizes nothing. */
  checks: readonly string[];
  /** Compare the source vector immediately before enqueueing. */
  assertCurrent: () => void | Promise<void>;
}
export interface QualificationStartRequest { workspace: string; executionPolicy: string; checks: readonly string[]; }
export type QualificationAuthorizer = (sessionId: string, request: QualificationStartRequest) => Promise<AuthorizedQualification>;
interface Entry { session: string; workspace: string; status: QualifyRunStatus; controller: AbortController; settled: Promise<void>; output?: RunOutput; failure?: string; cleanup: RunCleanup; options: RunOptions; }

/** Session-owned handles; authorization and workspace selection belong to the adapter. */
export class RunRegistry {
  private readonly runs = new Map<string, Entry>();
  constructor(private readonly authorize: QualificationAuthorizer) {}
  async start(sessionId: string, request: QualificationStartRequest): Promise<QualifyRunStatus> {
    const grant = await this.authorize(sessionId, request);
    if (!grant.qualifyGranted || request.executionPolicy !== grant.executionPolicy || grant.options.policy?.id !== grant.executionPolicy) throw new Error('qualification execution policy or qualify grant refused');
    if (!request.checks.length || request.checks.some((check) => !grant.checks.includes(check))) throw new Error('qualification check is outside its authorized policy');
    resolveChecks(request.checks);
    await grant.assertCurrent();
    const runId = `run.${randomUUID().replace(/-/g, '')}`;
    const controller = new AbortController();
    const entry: Entry = { session: sessionId, workspace: grant.workspaceId, options: grant.options, controller, status: { runId, phase: 'queued', progress: { completed: 0, total: request.checks.length, events: [] }, evidence: [], cleanup: 'pending' }, cleanup: { state: 'pending', outcomes: [], actions: [], residual: [] }, settled: Promise.resolve() };
    this.runs.set(runId, entry);
    // The handle is returned before the run acquires a lease or starts native work.
    entry.settled = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      try {
        await grant.assertCurrent();
        if (!controller.signal.aborted) entry.status.phase = 'running';
        entry.output = await runChecks({ ...grant.options, checks: [...request.checks], signal: controller.signal, runId, log: (line) => {
          grant.options.log?.(line);
          const match = /^check ([^:]+): (.+)/.exec(line);
          if (!match) return;
          const result = /^(PASS|FAIL|UNKNOWN|NOT_APPLICABLE)\b/.exec(match[2]!);
          const event: QualifyRunStatus['progress']['events'][number] = { sequence: (entry.status.progress.events.at(-1)?.sequence ?? 0) + 1, check: match[1]!, state: result ? 'finished' : 'started' };
          if (result) { event.result = result[1] as 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE'; entry.status.progress.completed++; }
          entry.status.progress.events.push(event); if (entry.status.progress.events.length > 200) entry.status.progress.events.shift();
        } });
        entry.cleanup = entry.output.run.cleanup!;
        entry.status.cleanup = entry.cleanup.state;
        entry.status.evidence = [...entry.output.run.evidenceRefs];
        entry.status.phase = entry.output.run.outcome === 'cancelled' ? 'cancelled' : entry.output.run.outcome === 'succeeded' ? 'completed' : 'failed';
        for (const event of entry.status.progress.events) { const check = entry.output.run.checks.find((c) => c.check === event.check); if (event.result === 'UNKNOWN' && check?.cause) event.cause = check.cause; }
      } catch (e) {
        entry.failure = String(e); entry.status.phase = 'failed'; entry.status.cleanup = 'failed';
        entry.cleanup = { state: 'failed', outcomes: [], actions: [], residual: [] };
      }
    });
    return structuredClone(entry.status);
  }
  private entry(sessionId: string, runId: string): Entry { const entry = this.runs.get(runId); if (!entry || entry.session !== sessionId) throw new Error('unknown qualification run handle'); return entry; }
  status(sessionId: string, runId: string): QualifyRunStatus { return structuredClone(this.entry(sessionId, runId).status); }
  output(sessionId: string, runId: string): RunOutput | undefined { return this.entry(sessionId, runId).output; }
  async wait(sessionId: string, runId: string): Promise<RunOutput | undefined> { const entry = this.entry(sessionId, runId); await entry.settled; return entry.output; }
  cancel(sessionId: string, runId: string): QualifyCancelData {
    const entry = this.entry(sessionId, runId);
    const terminal = ['cancelled', 'completed', 'failed'].includes(entry.status.phase);
    if (!terminal) { entry.status.phase = 'cancelling'; entry.controller.abort(); }
    return { runId, cancellation: terminal ? 'completed' : 'requested', phase: entry.status.phase, cleanup: structuredClone(entry.cleanup) };
  }
  async close(sessionId: string, workspaceId?: string): Promise<void> {
    const entries = [...this.runs.values()].filter((e) => e.session === sessionId && (!workspaceId || e.workspace === workspaceId));
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map((e) => e.settled));
  }
  async recover(sessionId: string, runId: string): Promise<RunCleanup> {
    const entry = this.entry(sessionId, runId); await entry.settled;
    if (entry.cleanup.state === 'clean') return structuredClone(entry.cleanup);
    const provider = readProviderConfiguration()?.providers.find((p) => p.id === entry.options.provider?.id);
    const located = await (entry.options.toolLocator ?? defaultToolLocator())('sqllocaldb', { minimum: '15.0' });
    if (provider?.kind === 'developer-service' || (!provider && located.status !== 'found')) throw new Error('recovery needs its provisioned native provider');
    const executable = provider?.kind === 'localdb' ? provider.executable : located.status === 'found' ? located.tool.path : '';
    entry.cleanup = await recoverRun(join(entry.options.lifecycleRoot ?? defaultLifecycleRoot(), 'journals', `${runId}.json`), executable, (entry.options.policy?.execution.budgets.cleanupDeadlineSeconds ?? 60) * 1000, 'coordinator');
    entry.status.cleanup = entry.cleanup.state;
    return structuredClone(entry.cleanup);
  }
}
