import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, rmSync, mkdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { exec, type ExecOptions, type ExecResult } from '../exec.js';
import type { RunnerContext } from '../types.js';
import { ownedPath, processIdentity, sameProcess } from '../lifecycle.js';
import { acquireDeveloperService, windowsServiceController, acquireMachineLease } from '../provider.js';

/** One LocalDB instance owned by one run: created for it, and stopped and deleted when it ends. */
export interface LocalDbInstance {
  name: string;
  server: string;
  engineVersion: string;
  ownedFiles?: Map<string, string[]>;
  /** The located sqlcmd, run with a fixed argument array. */
  sqlcmd: (args: readonly string[], options: ExecOptions) => Promise<ExecResult>;
}

export type Acquired<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * A sqlcmd result. A failure to reach, log in to or stay connected to the
 * server, and a query timeout, are failures to run the script, never results
 * of it, so they arrive as `ok: false` like a missing or stopped process.
 */
export type SqlResult = ExecResult | { ok: false; kind: 'connection'; reason: string; stdout: string; stderr: string };

const firstLine = (r: ExecResult): string => (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? '';

/**
 * The run's own instance. A per-run instance, rather than a database on the
 * shared default instance, is what keeps parallel runs from deleting or
 * stopping each other's state.
 */
export async function runInstance(ctx: RunnerContext): Promise<Acquired<LocalDbInstance>> {
  if (ctx.provider?.kind === 'developer-service') return runServiceInstance(ctx);
  const localdb = await ctx.tools('sqllocaldb', { minimum: '15.0' });
  if (localdb.status !== 'found') return { ok: false, reason: localdb.reason };
  const sqlcmd = await ctx.tools('sqlcmd', { minimum: '15.0' });
  if (sqlcmd.status !== 'found') return { ok: false, reason: sqlcmd.reason };
  const localdbExecutable = ctx.provider?.kind === 'localdb' ? ctx.provider.executable : localdb.tool.path;
  let partial: LocalDbInstance | undefined;
  try {
    const value = await ctx.resources.acquire(
      'localdb',
      async (): Promise<LocalDbInstance> => {
        const name = `loom-${ctx.runId.replace(/[^A-Za-z0-9]/g, '').slice(-12)}-${randomBytes(3).toString('hex')}`;
        const instanceDirectory = join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'Microsoft SQL Server Local DB', 'Instances', name);
        ctx.lifecycle?.phase('start'); ctx.lifecycle?.intend('instance', name, instanceDirectory);
        partial = { name, server: `(localdb)\\${name}`, engineVersion: 'unmeasured', ownedFiles: new Map(), sqlcmd: (args, options) => exec(sqlcmd.tool.path, args, options) };
        ctx.lifecycle?.startGuardian(localdbExecutable, (ctx.budgets?.cleanupDeadlineSeconds ?? 60) * 1000);
        const disk = statfsSync(ctx.dir);
        if (disk.bavail * disk.bsize < (ctx.budgets?.fixtureFileBytes ?? 2147483648)) throw new Error('insufficient-resources: free disk below fixture budget');
        const version = ctx.provider?.kind === 'localdb' ? ctx.provider.version : localdb.tool.version.split('.').slice(0, 2).join('.');
        const create = await exec(localdbExecutable, ['create', name, version, '-s'], { timeoutMs: (ctx.budgets?.engineStartDeadlineSeconds ?? 60) * 1000, signal: ctx.signal });
        if (!create.ok || create.status !== 0) throw new Error(`SqlLocalDB could not create instance ${name}: ${create.ok ? firstLine(create) : create.reason}`);
        ctx.lifecycle?.state(name, 'created');
        const info = await exec(localdbExecutable, ['info', name], { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
        const engineVersion = info.ok ? (/Version:\s*([\d.]+)/i.exec(info.stdout)?.[1] ?? localdb.tool.version) : localdb.tool.version;
        const inst: LocalDbInstance = partial;
        inst.engineVersion = engineVersion;
        const configure = await runSql(ctx, inst, `EXEC sp_configure 'show advanced options', 1; RECONFIGURE; EXEC sp_configure 'max server memory (MB)', ${ctx.budgets?.maxServerMemoryMiB ?? 512}; RECONFIGURE; EXEC sp_configure 'max degree of parallelism', ${ctx.budgets?.maxDegreeOfParallelism ?? 1}; RECONFIGURE; SELECT CONCAT('LOOM_PROCESS|', CONVERT(nvarchar(32), SERVERPROPERTY('ProcessID')));`);
        if (!configure.ok || configure.status !== 0) throw new Error(`could not apply trusted SQL execution limits: ${configure.ok ? firstLine(configure) : configure.reason}`);
        if (ctx.lifecycle) {
          ctx.lifecycle.engineVersion = engineVersion;
          const pid = Number(/LOOM_PROCESS\|(\d+)/.exec(configure.stdout)?.[1]);
          const engine = pid ? processIdentity(pid) : null;
          if (!engine) throw new Error('owned engine process identity could not be verified');
          ctx.lifecycle.engineProcess = engine;
          ctx.lifecycle.intend('process', `engine.${pid}`); const resource = ctx.lifecycle.journal.resources.find((r) => r.identity === `engine.${pid}`)!; resource.process = engine; ctx.lifecycle.state(`engine.${pid}`, 'created');
          await ctx.lifecycle.sampleEngine();
        }
        return inst;
      },
      async (inst) => {
        const deadline = Date.now() + (ctx.budgets?.cleanupDeadlineSeconds ?? 60) * 1000;
        const remaining = () => Math.max(1, deadline - Date.now());
        const cleanupExec = (args: string[]) => exec(localdbExecutable, args, { timeoutMs: remaining() });
        ctx.lifecycle?.phase('remove-databases');
        for (const name of inst.ownedFiles?.keys() ?? []) await dropDatabase({ ...ctx, signal: undefined, timeoutMs: remaining() }, inst, name);
        ctx.lifecycle?.phase('stop');
        const stop = await cleanupExec(['stop', inst.name]);
        const info = await cleanupExec(['info', inst.name]);
        if (!stop.ok || stop.status !== 0 || !info.ok || /State:\s*Running/i.test(info.stdout)) throw new Error(`owned instance stop could not be verified: ${inst.name}`);
        if (ctx.lifecycle?.engineProcess) { if (sameProcess(ctx.lifecycle.engineProcess)) throw new Error('owned engine process remains after stop'); ctx.lifecycle.state(`engine.${ctx.lifecycle.engineProcess.pid}`, 'removed'); }
        const del = await cleanupExec(['delete', inst.name]);
        const list = await cleanupExec(['info']);
        if (!del.ok || del.status !== 0 || !list.ok || list.status !== 0 || list.stdout.split(/\r?\n/).some((s) => s.trim() === inst.name)) throw new Error(`owned instance deletion could not be verified: ${inst.name}`);
        const instances = join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'Microsoft SQL Server Local DB', 'Instances');
        const directory = join(instances, inst.name);
        if (existsSync(directory)) rmSync(ownedPath(instances, directory), { recursive: true });
        if (existsSync(directory)) throw new Error(`owned instance directory remains: ${inst.name}`);
        ctx.lifecycle?.state(inst.name, 'removed');
      },
      () => partial,
    );
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function runServiceInstance(ctx: RunnerContext): Promise<Acquired<LocalDbInstance>> {
  const entry = ctx.provider;
  if (!entry || entry.kind !== 'developer-service') return { ok: false, reason: 'no trusted dedicated provider selected' };
  const sqlcmd = await ctx.tools('sqlcmd', { minimum: '15.0' }); if (sqlcmd.status !== 'found') return { ok: false, reason: sqlcmd.reason };
  try {
    const instance = await ctx.resources.acquire('developer-service', async () => {
      const machineRoot = join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'Loom', 'qualification', 'leases', entry.id);
      // Common-root ACLs must already be provisioned; never silently create a user-private machine lock.
      if (!existsSync(machineRoot)) throw new Error('provider-blocked: provision the shared machine lease directory and ACLs before using the dedicated service');
      const releaseMachine = await acquireMachineLease(machineRoot, ctx.runId, ctx.signal, (ctx.budgets?.totalDeadlineSeconds ?? 900) * 1000);
      const controller = windowsServiceController((ctx.budgets?.engineStartDeadlineSeconds ?? 60) * 1000);
      const original = await controller.inspect(entry.serviceName);
      if (!original) { releaseMachine(); throw new Error('provider-blocked: dedicated service is unavailable'); }
      ctx.lifecycle?.intend('service-startup', `${entry.serviceName}:${original.startup}`);
      ctx.lifecycle?.startGuardian('service', (ctx.budgets?.cleanupDeadlineSeconds ?? 60) * 1000);
      const acquired = await acquireDeveloperService(entry, controller);
      if (!acquired.ok) { ctx.lifecycle?.state(`${entry.serviceName}:${original.startup}`, 'removed'); releaseMachine(); throw new Error(acquired.reason); }
      ctx.lifecycle?.state(`${entry.serviceName}:${original.startup}`, 'created');
      const value: LocalDbInstance & { restore: () => Promise<void> } = { name: entry.serviceName, server: acquired.server, engineVersion: 'unmeasured', ownedFiles: new Map(), sqlcmd: (args, opts) => exec(sqlcmd.tool.path, args, opts), restore: async () => { await acquired.restore(); ctx.lifecycle?.state(`${entry.serviceName}:${original.startup}`, 'removed'); releaseMachine(); } };
      const configure = await runSql(ctx, value, `EXEC sp_configure 'show advanced options', 1; RECONFIGURE; EXEC sp_configure 'max server memory (MB)', ${ctx.budgets?.maxServerMemoryMiB ?? 512}; RECONFIGURE; EXEC sp_configure 'max degree of parallelism', ${ctx.budgets?.maxDegreeOfParallelism ?? 1}; RECONFIGURE; SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion'));`);
      if (!configure.ok || configure.status !== 0) { await value.restore(); throw new Error('dedicated service execution limits could not be applied'); }
      value.engineVersion = /\d+\.\d+\.\d+\.\d+/.exec(configure.stdout)?.[0] ?? 'unmeasured';
      if (ctx.lifecycle) ctx.lifecycle.engineVersion = value.engineVersion;
      return value;
    }, async (value) => { for (const db of value.ownedFiles?.keys() ?? []) await dropDatabase({ ...ctx, signal: undefined }, value, db); await value.restore(); });
    return { ok: true, value: instance };
  } catch (e) { return { ok: false, reason: `provider-blocked: ${String(e)}` }; }
}

/** Run T-SQL through sqlcmd -b from a file in the check directory, so no shell quoting is involved. */
export async function runSql(ctx: RunnerContext, inst: LocalDbInstance, sql: string, database?: string): Promise<SqlResult> {
  const file = join(ctx.dir, `batch-${randomBytes(4).toString('hex')}.sql`);
  writeFileSync(file, sql, 'utf8');
  const args = ['-S', inst.server, '-b', '-I', '-y', '0', '-i', file];
  if (database) args.splice(2, 0, '-d', database);
  const r = await inst.sqlcmd(args, { timeoutMs: ctx.timeoutMs, cwd: ctx.dir, signal: ctx.signal });
  if (!r.ok || r.status === 0) return r;
  const lost = connectionFailure(`${r.stdout}\n${r.stderr}`);
  if (!lost) return r;
  return { ok: false, kind: 'connection', reason: `the sqlcmd connection to ${inst.server}${database ? ` (database ${database})` : ''} failed: ${lost}`, stdout: r.stdout, stderr: r.stderr };
}

/** sqlcmd's own client error lines that concern the connection, the login or a timeout. */
const CLIENT_ERROR = /^Sqlcmd: Error: (.+?)\s*$/gm;
const CONNECTION_TERMS = /connect|login|timeout expired|network|provider|instance|handshake|communication link|not found or not accessible/i;

/** Server messages that refuse the login itself: 4060 cannot open the requested database, the 184xx family login failed. */
const LOGIN_REFUSED = new Set([4060, 18452, 18456, 18470, 18486, 18487, 18488]);

/**
 * The reason sqlcmd output names when it could not reach the server, log in,
 * open the requested database or keep the connection, or when a timeout
 * expired; null when the script reached the server and its own statements
 * failed.
 */
export function connectionFailure(output: string): string | null {
  const client = [...new Set([...output.matchAll(CLIENT_ERROR)].map((m) => m[1]!).filter((line) => CONNECTION_TERMS.test(line)))];
  if (client.length) return client.join(' ');
  for (const m of output.matchAll(/Msg (\d+), Level \d+, State \d+,[^\n]*\r?\n(.+)/g)) {
    if (LOGIN_REFUSED.has(Number(m[1]))) return `Msg ${m[1]}: ${m[2]!.trim()}`;
  }
  return null;
}

/** A query whose single nvarchar(max) column carries JSON, parsed; null when the output is unreadable. */
export async function queryJson<T>(ctx: RunnerContext, inst: LocalDbInstance, database: string, select: string): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const r = await runSql(ctx, inst, `SET NOCOUNT ON;\n${select}`, database);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.status !== 0) return { ok: false, reason: `the catalog query failed: ${throwMessage(`${r.stdout}\n${r.stderr}`).message}` };
  const text = r.stdout.replace(/\r?\n/g, '').trim();
  const start = text.search(/[[{]/);
  if (start < 0) return { ok: false, reason: 'the catalog query returned no JSON' };
  try {
    return { ok: true, value: JSON.parse(text.slice(start)) as T };
  } catch {
    return { ok: false, reason: 'the catalog query returned unreadable JSON' };
  }
}

/** A fresh database on the run's instance, named so the check that created it is recognisable. */
export async function createDatabase(ctx: RunnerContext, inst: LocalDbInstance, purpose: string): Promise<Acquired<string>> {
  const name = `loom_${purpose.replace(/[^A-Za-z0-9]/g, '_')}_${randomBytes(4).toString('hex')}`;
  const directory = join(ctx.dir, 'databases'); mkdirSync(directory, { recursive: true });
  const data = join(directory, `${name}.mdf`); const log = join(directory, `${name}.ldf`);
  const maxMiB = Math.floor((ctx.budgets?.fixtureFileBytes ?? 2147483648) / 1048576 / 2);
  if (maxMiB < 8) return { ok: false, reason: 'insufficient-resources: fixture file budget is below the minimum database allocation' };
  ctx.lifecycle?.phase('prepare'); ctx.lifecycle?.intend('database', name);
  for (const file of [data, log]) ctx.lifecycle?.intend('file', file, file);
  inst.ownedFiles?.set(name, [data, log]);
  const quote = (s: string) => s.replace(/'/g, "''");
  const r = await runSql(ctx, inst, `CREATE DATABASE [${name}] ON (NAME=N'${name}', FILENAME=N'${quote(data)}', SIZE=8MB, MAXSIZE=${maxMiB}MB, FILEGROWTH=8MB) LOG ON (NAME=N'${name}_log', FILENAME=N'${quote(log)}', SIZE=8MB, MAXSIZE=${maxMiB}MB, FILEGROWTH=8MB);`);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.status !== 0) return { ok: false, reason: `CREATE DATABASE failed: ${throwMessage(`${r.stdout}\n${r.stderr}`).message}` };
  ctx.lifecycle?.state(name, 'created'); for (const file of [data, log]) ctx.lifecycle?.state(file, 'created');
  return { ok: true, value: name };
}

export async function dropDatabase(ctx: RunnerContext, inst: LocalDbInstance, name: string): Promise<void> {
  if (!/^loom_[A-Za-z0-9_]+$/.test(name) || (inst.ownedFiles && !inst.ownedFiles.has(name))) throw new Error('refusing to drop an unowned database');
  const r = await runSql({ ...ctx, signal: undefined }, inst, [`IF DB_ID(N'${name}') IS NOT NULL`, 'BEGIN', `    ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`, `    DROP DATABASE [${name}];`, 'END', `IF DB_ID(N'${name}') IS NOT NULL THROW 51001, 'owned database remains', 1;`].join('\n'));
  if (!r.ok || r.status !== 0) throw new Error(`owned database drop failed: ${name}`);
  for (const file of inst.ownedFiles?.get(name) ?? []) { if (existsSync(file)) throw new Error(`database file remains after drop: ${file}`); ctx.lifecycle?.state(file, 'removed'); }
  ctx.lifecycle?.state(name, 'removed'); inst.ownedFiles?.delete(name);
}

/** The first `Msg <n>, Level ..., State ...` line of sqlcmd output and the message text that follows it. */
export function throwMessage(output: string): { code: number | null; message: string } {
  const m = /Msg (\d+), Level \d+, State \d+,[^\n]*\r?\n(.+)/.exec(output);
  if (m) return { code: Number(m[1]), message: m[2]!.trim() };
  const last = output.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  return { code: null, message: last };
}

/** Every message number sqlcmd reported, in order. */
export function messageCodes(output: string): number[] {
  return [...output.matchAll(/Msg (\d+), Level \d+/g)].map((m) => Number(m[1]));
}
