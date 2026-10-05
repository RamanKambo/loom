import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envelope, refusal, type QualifyRunStatus, type QualifyCancelData } from '@loom/core';
import { HandleRegistry, openSession } from '@loom/workspace';
import { defaultLifecycleRoot, defaultToolLocator, recoverRun, processIdentity, sameProcess } from '@loom/qualification';
import { flag, list, required, UsageError } from './args.js';
import { cmdQualify, type Context, type CommandResult } from './commands.js';

export interface QualificationControl { runId: string; root: string; expectedVector: string; executionPolicy: string; checks: string[]; status: QualifyRunStatus; owner?: { pid: number; createdAt: string }; error?: string; }
export const controlFile = (runId: string): string => { if (!/^run\.[A-Za-z0-9.-]+$/.test(runId)) throw new UsageError('invalid run id'); return join(defaultLifecycleRoot(), 'controls', `${runId}.json`); };
export function qualificationVector(root: string): string {
  const handles = new HandleRegistry({ allowedRoots: [root] }); const opened = handles.open(root, 'read');
  if (opened.refusal) throw new Error(opened.refusal.message);
  const id = (opened.data as { workspace: { workspaceId: string } }).workspace.workspaceId;
  return (handles.status(id).data as { revisionVector: string }).revisionVector;
}
export async function cmdQualification(ctx: Context): Promise<CommandResult> {
  const action = ctx.args.positionals[0];
  if (!['start', 'status', 'cancel', 'recover'].includes(action ?? '')) return cmdQualify(ctx);
  const session = openSession(ctx.cwd);
  if (!session.workspace || !session.model) return { env: envelope('cli.qualify', { model: null, findings: session.findings, refusal: refusal('unresolved-context', 'qualification requires a governed workspace') }) };
  const root = session.workspace.root;
  if (action === 'start') {
    if (flag(ctx.args, 'grant') !== 'qualify') throw new UsageError('qualify start requires --grant qualify');
    const executionPolicy = required(ctx.args, 'execution-policy'); const policy = session.inputs.policy;
    if (!policy || policy.id !== executionPolicy) throw new UsageError('the named execution policy is not the trusted workspace policy');
    const checks = list(ctx.args, 'checks') ?? []; const allowed = [...policy.qualification.required, ...policy.qualification.optional];
    if (!checks.length || checks.some((check) => !allowed.includes(check))) throw new UsageError('--checks must name checks authorized by the trusted policy');
    const expectedVector = required(ctx.args, 'expected-vector'); if (qualificationVector(root) !== expectedVector) return { env: envelope('cli.qualify', { model: session.model, findings: [], refusal: refusal('stale-base', 'source revision vector changed') }) };
    const runId = `run.${randomUUID().replace(/-/g, '')}`;
    const control: QualificationControl = { runId, root, expectedVector, executionPolicy, checks, status: { runId, phase: 'queued', progress: { completed: 0, total: checks.length, events: [] }, evidence: [], cleanup: 'pending' } };
    const file = controlFile(runId); mkdirSync(join(defaultLifecycleRoot(), 'controls'), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(control), { mode: 0o600 });
    const child = spawn(process.execPath, [fileURLToPath(new URL('./qualification-worker.js', import.meta.url)), runId], { detached: true, stdio: 'ignore', windowsHide: true }); child.unref();
    const owner = child.pid ? processIdentity(child.pid) : null; if (!owner) throw new Error('qualification worker did not start with a verifiable process identity');
    // The child publishes its identity and progress atomically; the parent must never race that writer.
    return { env: envelope('cli.qualify', { model: session.model, findings: [], data: control.status }) };
  }
  const runId = required(ctx.args, 'run'); const file = controlFile(runId);
  if (!existsSync(file)) throw new UsageError('unknown durable qualification run');
  const control = JSON.parse(readFileSync(file, 'utf8')) as QualificationControl; if (control.root !== root) throw new UsageError('qualification run belongs to another workspace');
  if (action === 'status') return { env: envelope('cli.qualify', { model: session.model, findings: [], data: control.status }) };
  if (action === 'cancel') {
    const terminal = ['completed', 'cancelled', 'failed'].includes(control.status.phase);
    if (!terminal) writeFileSync(`${file}.cancel`, '', { mode: 0o600 });
    const cleanupFile = join(defaultLifecycleRoot(), 'evidence', `${runId}.cleanup.json`);
    const cleanup = existsSync(cleanupFile) ? JSON.parse(readFileSync(cleanupFile, 'utf8')) : { state: 'pending', outcomes: [], actions: [], residual: [] };
    const data: QualifyCancelData = { runId, cancellation: terminal ? 'completed' : 'requested', phase: terminal ? control.status.phase : 'cancelling', cleanup };
    return { env: envelope('cli.qualify', { model: session.model, findings: [], data }) };
  }
  if (control.owner && sameProcess(control.owner)) throw new UsageError('recover refuses an active qualification owner; cancel it first');
  const existingCleanup = join(defaultLifecycleRoot(), 'evidence', `${runId}.cleanup.json`);
  if (existsSync(existingCleanup)) { const clean = JSON.parse(readFileSync(existingCleanup, 'utf8')); if (clean.state === 'clean') return { env: envelope('cli.qualify', { model: session.model, findings: [], data: clean }) }; }
  const located = await defaultToolLocator()('sqllocaldb', { minimum: '15.0' }); if (located.status !== 'found') throw new Error(located.reason);
  const cleanup = await recoverRun(join(defaultLifecycleRoot(), 'journals', `${runId}.json`), located.tool.path); control.status.cleanup = cleanup.state; writeFileSync(file, JSON.stringify(control));
  return { env: envelope('cli.qualify', { model: session.model, findings: [], data: cleanup }) };
}
