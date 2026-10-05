import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo, hostname } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AllocationJournal, LifecyclePhase, ProcessIdentity, ProviderRef, RunCleanup } from '@loom/core';
import { exec, runPwsh, which } from './exec.js';

export const defaultLifecycleRoot = (): string => join(process.env['LOCALAPPDATA'] ?? join(homedir(), '.local', 'state'), 'Loom', 'qualification');
export const providerConfigurationPath = (): string => join(defaultLifecycleRoot(), 'providers.json');

/** Compare canonical locations, including junctions. Lexical prefixes never prove containment. */
export function ownedPath(root: string, path: string): string {
  const canonicalRoot = realpathSync(root);
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(ancestor)) { missing.unshift(ancestor.slice(dirname(ancestor).length + 1)); const parent = dirname(ancestor); if (parent === ancestor) throw new Error('path has no existing ancestor'); ancestor = parent; }
  const canonical = resolve(realpathSync(ancestor), ...missing);
  const rel = relative(canonicalRoot, canonical);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`resource is outside its owned root: ${path}`);
  return canonical;
}

export function processIdentity(pid = process.pid): ProcessIdentity | null {
  if (process.platform === 'win32') {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    const value = r.stdout?.trim();
    if (!value || Number.isNaN(Date.parse(value))) return null;
    return { pid, createdAt: new Date(value).toISOString() };
  }
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').slice(readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 2).split(' ');
    const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
    const hz = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim());
    return { pid, createdAt: new Date((boot + Number(fields[19]) / hz) * 1000).toISOString() };
  } catch { return null; }
}
export const sameProcess = (identity: ProcessIdentity): boolean => processIdentity(identity.pid)?.createdAt === identity.createdAt;
const identity = (): ProcessIdentity => { const p = processIdentity(); if (!p) throw new Error('cannot establish process creation identity'); return p; };
const atomically = (file: string, value: unknown): void => { const temp = `${file}.${randomUUID()}.tmp`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, file); };
const pause = (signal?: AbortSignal): Promise<void> => new Promise((res, rej) => { const abort = () => { clearTimeout(timer); rej(new Error('lease acquisition cancelled')); }; const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); res(); }, 100); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); });

/** Atomic directory acquisition is shared across independent server/CLI processes. */
export async function acquireLease(root: string, runId: string, signal?: AbortSignal, deadlineMs = 900_000): Promise<() => void> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, 'user.lease');
  const owner = identity();
  const until = Date.now() + deadlineMs;
  while (true) {
    if (signal?.aborted) throw new Error('lease acquisition cancelled');
    try {
      mkdirSync(lock);
      try { atomically(join(lock, 'holder.json'), { leaseVersion: 1, scope: 'user', holder: { process: owner, session: runId }, runId, acquiredAt: new Date().toISOString() }); }
      catch (e) { rmSync(lock, { recursive: true, force: true }); throw e; }
      return () => { const held = JSON.parse(readFileSync(join(lock, 'holder.json'), 'utf8')); if (held.runId !== runId || held.holder.process.createdAt !== owner.createdAt) throw new Error('lease ownership changed'); rmSync(lock, { recursive: true }); };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const holder = JSON.parse(readFileSync(join(lock, 'holder.json'), 'utf8'));
        if (!sameProcess(holder.holder.process)) {
          const journals = join(root, 'journals');
          if (existsSync(journals) && readdirSync(journals).some((f) => { if (!f.endsWith('.json') || f.endsWith('.cleanup.json')) return false; const j = JSON.parse(readFileSync(join(journals, f), 'utf8')) as AllocationJournal; return j.runId === holder.runId && j.resources.some((r) => r.state !== 'removed'); })) throw new Error(`unresolved owned resources block allocation; recover ${holder.runId}`);
          const stale = `${lock}.stale.${randomUUID()}`; renameSync(lock, stale); rmSync(stale, { recursive: true, force: true }); continue;
        }
      } catch (err) { if (/unresolved owned/.test(String(err))) throw err; /* acquisition window: do not steal an incomplete holder */ }
      if (Date.now() >= until) throw new Error('lease deadline exceeded');
      await pause(signal);
    }
  }
}

export class Lifecycle {
  readonly journal: AllocationJournal;
  readonly file: string;
  readonly cleanup: RunCleanup = { state: 'pending', outcomes: [], actions: [], residual: [] };
  private guardian?: ReturnType<typeof spawn>;
  engineVersion?: string;
  engineProcess?: ProcessIdentity;
  peakWorkingSetBytes = 0;
  async sampleEngine(): Promise<void> {
    if (!this.engineProcess) return;
    if (process.platform === 'win32') {
      const result = await runPwsh('powershell.exe', `$p=Get-Process -Id ${this.engineProcess.pid} -ErrorAction SilentlyContinue; if ($p) { @{createdAt=$p.StartTime.ToUniversalTime().ToString('o');bytes=$p.WorkingSet64} | ConvertTo-Json -Compress }`, { timeoutMs: 10000 });
      if (result.ok && new Date(String(result.json['createdAt'])).toISOString() === this.engineProcess.createdAt) this.peakWorkingSetBytes = Math.max(this.peakWorkingSetBytes, Number(result.json['bytes']));
    } else { try { const rss = /^VmRSS:\s*(\d+)/m.exec(readFileSync(`/proc/${this.engineProcess.pid}/status`, 'utf8')); if (rss) this.peakWorkingSetBytes = Math.max(this.peakWorkingSetBytes, Number(rss[1]) * 1024); } catch { /* engine exited */ } }
  }
  constructor(readonly root: string, runId: string, provider: ProviderRef) {
    mkdirSync(join(root, 'journals'), { recursive: true, mode: 0o700 });
    this.file = join(root, 'journals', `${runId}.json`);
    this.journal = { journalVersion: 1, runId, owner: { user: `sha256:${createHash('sha256').update(userInfo().username).digest('hex')}`, session: runId, process: identity() }, provider, phases: [], resources: [] };
    this.save();
  }
  save(): void { if (existsSync(this.file)) { const previous = JSON.parse(readFileSync(this.file, 'utf8')) as AllocationJournal; if (previous.cleanupClaim) this.journal.cleanupClaim = previous.cleanupClaim; else delete this.journal.cleanupClaim; } atomically(this.file, this.journal); }
  phase(phase: LifecyclePhase): void { const last = this.journal.phases.at(-1); if (last && !last.finishedAt) last.finishedAt = new Date().toISOString(); this.journal.phases.push({ phase, startedAt: new Date().toISOString() }); this.save(); }
  intend(kind: AllocationJournal['resources'][number]['kind'], identity: string, path?: string): void { this.journal.resources.push({ kind, identity, state: 'intended', ...(path ? { path } : {}) }); this.save(); }
  state(identity: string, state: AllocationJournal['resources'][number]['state']): void { const resource = this.journal.resources.find((r) => r.identity === identity); if (!resource) throw new Error('resource has no allocation intent'); resource.state = state; this.save(); }
  startGuardian(executable: string, timeoutMs: number): void {
    this.guardian = spawn(process.execPath, [fileURLToPath(new URL('./guardian.js', import.meta.url)), this.file, executable, String(timeoutMs)], { detached: true, stdio: 'ignore', windowsHide: true });
    this.guardian.unref();
  }
  stopGuardian(): void { this.guardian?.kill(); }
}

/** One cleanup claimant; a live coordinator, guardian or recovery actor cannot be superseded. */
export function claimCleanup(file: string, holder: 'coordinator' | 'guardian' | 'recovery'): (() => void) | null {
  const claim = `${file}.claim`;
  try { mkdirSync(claim); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; try { const recorded = JSON.parse(readFileSync(join(claim, 'owner.json'), 'utf8')) as ProcessIdentity; if (!sameProcess(recorded)) { const stale = `${claim}.stale.${randomUUID()}`; renameSync(claim, stale); rmSync(stale, { recursive: true }); return claimCleanup(file, holder); } } catch { /* another process is publishing its claim */ } return null; }
  const owner = identity(); atomically(join(claim, 'owner.json'), owner);
  let journal = JSON.parse(readFileSync(file, 'utf8')) as AllocationJournal;
  journal.cleanupClaim = { holder, process: owner, claimedAt: new Date().toISOString() }; atomically(file, journal);
  return () => { const j = JSON.parse(readFileSync(file, 'utf8')) as AllocationJournal; delete j.cleanupClaim; atomically(file, j); rmSync(claim, { recursive: true }); };
}

export async function recoverRun(file: string, localdbExecutable: string, timeoutMs = 60_000, holder: 'coordinator' | 'guardian' | 'recovery' = 'recovery'): Promise<RunCleanup> {
  let journal = JSON.parse(readFileSync(file, 'utf8')) as AllocationJournal;
  const ownSettledRun = holder === 'coordinator' && journal.owner.process.pid === process.pid && journal.owner.process.createdAt === processIdentity()?.createdAt;
  if (sameProcess(journal.owner.process) && !ownSettledRun) throw new Error('recovery refuses a live owner');
  let release = claimCleanup(file, holder);
  const claimDeadline = Date.now() + timeoutMs;
  while (!release) { if (Date.now() >= claimDeadline) throw new Error('cleanup claim deadline exceeded'); await pause(); release = claimCleanup(file, holder); }
  journal = JSON.parse(readFileSync(file, 'utf8')) as AllocationJournal;
  const cleanup: RunCleanup = { state: 'running', outcomes: [], actions: [], residual: [] };
  try {
    const ordered = [...journal.resources].sort((a, b) => ['instance', 'database', 'process', 'file', 'directory', 'service-startup'].indexOf(a.kind) - ['instance', 'database', 'process', 'file', 'directory', 'service-startup'].indexOf(b.kind));
    for (const resource of ordered) {
      if (resource.state === 'removed') continue;
      try {
        if (sameProcess(journal.owner.process) && !ownSettledRun) throw new Error('owner identity became live; cleanup is refused');
        if (resource.kind === 'instance') {
          if (journal.provider.kind !== 'localdb' || !/^loom-[a-zA-Z0-9-]+$/.test(resource.identity)) throw new Error('unrecognized owned instance');
          const stop = await exec(localdbExecutable, ['stop', resource.identity], { timeoutMs });
          const info = await exec(localdbExecutable, ['info', resource.identity], { timeoutMs });
          if (info.ok && /State:\s*Running/i.test(info.stdout)) throw new Error(`engine did not stop: ${stop.ok ? stop.stderr : stop.reason}`);
          const del = await exec(localdbExecutable, ['delete', resource.identity], { timeoutMs });
          const list = await exec(localdbExecutable, ['info'], { timeoutMs });
          if (!list.ok || list.status !== 0 || list.stdout.split(/\r?\n/).some((n) => n.trim() === resource.identity)) throw new Error(`instance deletion unverified: ${del.ok ? del.stderr : del.reason}`);
          if (resource.path && existsSync(resource.path)) { const instances = join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'Microsoft SQL Server Local DB', 'Instances'); ownedPath(instances, resource.path); rmSync(resource.path, { recursive: true }); }
        } else if (resource.kind === 'database') {
          if (journal.provider.kind === 'developer-service') {
            const { readProviderConfiguration } = await import('./provider.js');
            const entry = readProviderConfiguration()?.providers.find((p) => p.id === journal.provider.id);
            if (entry?.kind !== 'developer-service' || !/^loom_[A-Za-z0-9_]+$/.test(resource.identity)) throw new Error('service database recovery requires its trusted provider and run-owned database identity');
            const executable = which('sqlcmd'); if (!executable) throw new Error('provisioned sqlcmd is unavailable');
            const server = entry.instanceName === 'MSSQLSERVER' ? hostname() : `${hostname()}\\${entry.instanceName}`;
            const sql = `IF DB_ID(N'${resource.identity}') IS NOT NULL BEGIN ALTER DATABASE [${resource.identity}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${resource.identity}]; END; IF DB_ID(N'${resource.identity}') IS NOT NULL THROW 51001, 'owned database remains', 1;`;
            const result = await exec(executable, ['-S', server, '-b', '-Q', sql], { timeoutMs }); if (!result.ok || result.status !== 0) throw new Error('owned service database drop is unverified');
          }
        } else if (resource.kind === 'directory') {
          if (journal.resources.some((r) => r.kind === 'instance' && r.state !== 'removed')) throw new Error('owned engine is unresolved; refusing to remove its directory');
          const runs = join(dirname(dirname(file)), 'runs'); if (resource.path && existsSync(resource.path)) rmSync(ownedPath(runs, resource.path), { recursive: true });
        } else if (resource.kind === 'process') {
          if (resource.process && sameProcess(resource.process)) throw new Error('owned process remains after engine stop');
        } else if (resource.kind === 'file') {
          if (journal.resources.some((r) => r.kind === 'instance' && r.state !== 'removed')) throw new Error('owned engine is unresolved; refusing to remove its files');
          const runs = join(dirname(dirname(file)), 'runs'); if (resource.path && existsSync(resource.path)) rmSync(ownedPath(runs, resource.path));
        } else if (resource.kind === 'service-startup') {
          const { readProviderConfiguration, windowsServiceController } = await import('./provider.js');
          const entry = readProviderConfiguration()?.providers.find((p) => p.id === journal.provider.id);
          const [name, startup] = resource.identity.split(':');
          if (entry?.kind !== 'developer-service' || entry.serviceName !== name || !['Manual', 'Disabled'].includes(startup ?? '') || (startup === 'Disabled' && !entry.startupChangeAuthorized)) throw new Error('service restoration authority is unavailable');
          const controller = windowsServiceController(timeoutMs); const snapshot = await controller.inspect(name!);
          if (!snapshot || !/Developer/i.test(snapshot.edition)) throw new Error('dedicated service identity cannot be verified');
          if (snapshot.state === 'Running') await controller.stop(name!);
          const stopped = await controller.inspect(name!); if (!stopped || stopped.state !== 'Stopped') throw new Error('dedicated service stop unverified');
          if (snapshot.startup !== startup) await controller.startup(name!, startup as 'Manual' | 'Disabled');
          const restored = await controller.inspect(name!); if (!restored || restored.startup !== startup) throw new Error('startup restoration unverified');
        } else throw new Error('resource needs a provisioned recovery action');
        resource.state = 'removed'; cleanup.outcomes.push({ kind: resource.kind, identity: resource.identity, outcome: 'done' });
      } catch (e) { resource.state = 'residual'; cleanup.outcomes.push({ kind: resource.kind, identity: resource.identity, outcome: 'failed', detail: String(e) }); cleanup.residual.push({ kind: resource.kind, identity: resource.identity }); }
      atomically(file, journal);
    }
    cleanup.state = cleanup.residual.length ? 'failed' : 'clean';
    if (cleanup.residual.length) cleanup.recovery = { journal: journal.runId, action: 'retry recovery with the trusted provider after resolving the recorded failure' };
    atomically(`${file}.cleanup.json`, cleanup); return cleanup;
  } finally {
    release();
    if (cleanup.state === 'clean') {
      const lock = join(dirname(dirname(file)), 'user.lease');
      if (existsSync(join(lock, 'holder.json'))) {
        const lease = JSON.parse(readFileSync(join(lock, 'holder.json'), 'utf8'));
        if (lease.runId === journal.runId && (!sameProcess(lease.holder.process) || ownSettledRun)) rmSync(lock, { recursive: true });
      }
    }
  }
}

export function diskBytes(root: string): number { if (!existsSync(root)) return 0; let size = 0; for (const item of readdirSync(root, { withFileTypes: true })) { const path = join(root, item.name); if (item.isSymbolicLink()) continue; size += item.isDirectory() ? diskBytes(path) : statSync(path).size; } return size; }
export function assertLifecycleResult(testOutcome: string, cleanup: RunCleanup, outcome: string): void { if (cleanup.residual.length && !cleanup.recovery) throw new Error('residual cleanup requires a recovery action'); if (outcome === 'succeeded' && (testOutcome !== 'PASS' || cleanup.state !== 'clean')) throw new Error('lifecycle success requires passing checks and verified clean cleanup'); }
