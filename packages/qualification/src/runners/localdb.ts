import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec, type ExecOptions, type ExecResult } from '../exec.js';
import type { RunnerContext } from '../types.js';

/** One LocalDB instance owned by one run: created for it, and stopped and deleted when it ends. */
export interface LocalDbInstance {
  name: string;
  server: string;
  engineVersion: string;
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
  const localdb = await ctx.tools('sqllocaldb', { minimum: '15.0' });
  if (localdb.status !== 'found') return { ok: false, reason: localdb.reason };
  const sqlcmd = await ctx.tools('sqlcmd', { minimum: '15.0' });
  if (sqlcmd.status !== 'found') return { ok: false, reason: sqlcmd.reason };
  try {
    const value = await ctx.resources.acquire(
      'localdb',
      async (): Promise<LocalDbInstance> => {
        const name = `loom-${ctx.runId.replace(/[^A-Za-z0-9]/g, '').slice(-12)}-${randomBytes(3).toString('hex')}`;
        const create = await exec(localdb.tool.path, ['create', name, '-s'], { timeoutMs: 180_000 });
        if (!create.ok || create.status !== 0) throw new Error(`SqlLocalDB could not create instance ${name}: ${create.ok ? firstLine(create) : create.reason}`);
        const info = await exec(localdb.tool.path, ['info', name], { timeoutMs: 60_000 });
        const version = info.ok ? (/Version:\s*([\d.]+)/i.exec(info.stdout)?.[1] ?? localdb.tool.version) : localdb.tool.version;
        return { name, server: `(localdb)\\${name}`, engineVersion: version, sqlcmd: (args, options) => exec(sqlcmd.tool.path, args, options) };
      },
      async (inst) => {
        await exec(localdb.tool.path, ['stop', inst.name, '-k'], { timeoutMs: 120_000 });
        await exec(localdb.tool.path, ['delete', inst.name], { timeoutMs: 120_000 });
      },
    );
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Run T-SQL through sqlcmd -b from a file in the check directory, so no shell quoting is involved. */
export async function runSql(ctx: RunnerContext, inst: LocalDbInstance, sql: string, database?: string): Promise<SqlResult> {
  const file = join(ctx.dir, `batch-${randomBytes(4).toString('hex')}.sql`);
  writeFileSync(file, sql, 'utf8');
  const args = ['-S', inst.server, '-b', '-I', '-y', '0', '-i', file];
  if (database) args.splice(2, 0, '-d', database);
  const r = await inst.sqlcmd(args, { timeoutMs: ctx.timeoutMs, cwd: ctx.dir });
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
  const r = await runSql(ctx, inst, `CREATE DATABASE [${name}];`);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.status !== 0) return { ok: false, reason: `CREATE DATABASE failed: ${throwMessage(`${r.stdout}\n${r.stderr}`).message}` };
  return { ok: true, value: name };
}

export async function dropDatabase(ctx: RunnerContext, inst: LocalDbInstance, name: string): Promise<void> {
  await runSql(ctx, inst, [`IF DB_ID(N'${name}') IS NOT NULL`, 'BEGIN', `    ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`, `    DROP DATABASE [${name}];`, 'END'].join('\n'));
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
