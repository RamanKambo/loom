import { execFile } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname } from 'node:path';
import type { ProcessIdentity } from '@loom/core';

export type { ProcessIdentity };

const WAIT_MS = 15_000;
const POLL_MS = 20;

/** A timer-based wait that never blocks the event loop, unlike Atomics.wait. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user, so it still holds the lock.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * The OS creation time of a process, read through PowerShell on Windows and
 * through `ps` on POSIX. Null when it cannot be determined, which the caller
 * never treats as proof the process is gone: liveness is checked separately.
 * Reused later by SQL run coordination, so it names no lock-specific concept.
 */
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    if (platform() === 'win32') {
      const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`]);
      const text = out.trim();
      if (!text) return null;
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime()) ? null : { pid, createdAt: parsed.toISOString() };
    }
    const out = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const text = out.trim();
    if (!text) return null;
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : { pid, createdAt: parsed.toISOString() };
  } catch {
    return null;
  }
}

/** This process's own identity under the real probe, queried once and reused: its own creation time never changes during its lifetime. A test-supplied probe bypasses the cache, so it governs every identity query withLock makes, not only the retry loop's. */
let own: Promise<ProcessIdentity> | null = null;
function ownIdentity(identity: (pid: number) => Promise<ProcessIdentity | null>): Promise<ProcessIdentity> {
  const resolve = (p: ProcessIdentity | null): ProcessIdentity => p ?? { pid: process.pid, createdAt: new Date().toISOString() };
  if (identity !== processIdentity) return identity(process.pid).then(resolve);
  if (!own) own = processIdentity(process.pid).then(resolve);
  return own;
}

interface LockFile {
  identity: ProcessIdentity;
}

/**
 * Whether a recorded holder no longer holds the lock: its pid is gone, or its
 * pid is alive but its current creation time differs from the recorded one,
 * which means the OS reused the pid for another process. A creation time this
 * process cannot read keeps the lock held, never taken over on a guess. The
 * identity query is injectable so a test can force the unreadable case without
 * depending on an OS failure.
 */
export async function abandoned(holder: ProcessIdentity, identity: (pid: number) => Promise<ProcessIdentity | null> = processIdentity): Promise<boolean> {
  if (!pidAlive(holder.pid)) return true;
  const actual = await identity(holder.pid);
  if (actual === null) return false;
  return actual.createdAt !== holder.createdAt;
}

export type Locked<T> = { ok: true; value: T } | { ok: false; holder: string };

/** The identity probe the retry loop uses to decide whether a recorded holder is abandoned; a test replaces it to resolve instantly, isolating the timer wait from the real OS process query the default spawns on every retry. */
export type IdentityProbe = (pid: number) => Promise<ProcessIdentity | null>;

/**
 * Run `fn` while holding an exclusive lock file created with 'wx', so two
 * writers in different processes serialize. The holder is a ProcessIdentity;
 * a lock whose pid is gone, or whose pid now belongs to a differently timed
 * process, is taken over, after the holder is re-read just before removal so
 * a lock another waiter already took over is never deleted out from under it.
 * Waiting uses a timer, never Atomics.wait, so it never blocks the event loop.
 */
export async function withLock<T>(lockPath: string, fn: () => T | Promise<T>, identity: IdentityProbe = processIdentity): Promise<Locked<T>> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const self = await ownIdentity(identity);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, JSON.stringify({ identity: self } satisfies LockFile));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let text = '';
      try {
        text = readFileSync(lockPath, 'utf8');
      } catch {
        continue;
      }
      let holder: LockFile | null = null;
      try {
        const parsed = JSON.parse(text) as Partial<LockFile>;
        if (parsed.identity) holder = parsed as LockFile;
      } catch {
        holder = null;
      }
      if (holder && (await abandoned(holder.identity, identity))) {
        let again = '';
        try {
          again = readFileSync(lockPath, 'utf8');
        } catch {
          continue;
        }
        if (again === text) rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) return { ok: false, holder: text || 'unknown' };
      await sleep(POLL_MS);
    }
  }
  try {
    return { ok: true, value: await fn() };
  } finally {
    rmSync(lockPath, { force: true });
  }
}
