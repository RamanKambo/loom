import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const WAIT_MS = 15_000;
const POLL_MS = 20;

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user, so it still holds the lock.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type Locked<T> = { ok: true; value: T } | { ok: false; holder: string };

/**
 * Run `fn` while holding an exclusive lock file created with 'wx', so two
 * writers in different processes serialize. A lock left by a process that no
 * longer exists is taken over; the holder is re-read just before removal so a
 * lock another waiter took over in the meantime is not deleted.
 */
export function withLock<T>(lockPath: string, fn: () => T): Locked<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder = '';
      try {
        holder = readFileSync(lockPath, 'utf8');
      } catch {
        continue;
      }
      let pid: number | null = null;
      try {
        pid = (JSON.parse(holder) as { pid: number }).pid;
      } catch {
        pid = null;
      }
      if (pid !== null && !pidAlive(pid)) {
        let again = '';
        try {
          again = readFileSync(lockPath, 'utf8');
        } catch {
          continue;
        }
        if (again === holder) rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) return { ok: false, holder: holder || 'unknown' };
      pause(POLL_MS);
    }
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    rmSync(lockPath, { force: true });
  }
}
