import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProcessIdentity } from '@loom/core';
import { abandoned, processIdentity, withLock } from '../lock.js';
import { scratch } from '../testing/helpers.js';

test('an asynchronous callback retains its repository lock until settlement', async()=>{
  const path=join(scratch(),'async.lock');let finish!:()=>void;let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{finish=resolve;});
  const lock=withLock(path,async()=>{entered();await gate;assert.ok(existsSync(path),'the repository remains locked while asynchronous owner work is pending');return 'settled';},async pid=>({pid,createdAt:'2026-01-01T00:00:00.000Z'}));
  await started;assert.ok(existsSync(path));finish();const result=await lock;assert.deepEqual(result,{ok:true,value:'settled'});assert.equal(existsSync(path),false);
});

test('a holder with a live pid and another creation time is taken over', async () => {
  const self = await processIdentity(process.pid);
  assert.ok(self, 'this process reports its own creation time');
  assert.equal(await abandoned({ pid: process.pid, createdAt: '1970-01-01T00:00:00.000Z' }), true, 'the real creation time of a live self differs from a fabricated one');
});

test('an unreadable creation time holds', async () => {
  assert.equal(await abandoned({ pid: process.pid, createdAt: '1970-01-01T00:00:00.000Z' }, async () => null), false, 'a query that cannot determine the creation time never authorizes a takeover');
});

test('a pid that no longer exists is taken over', async () => {
  // A pid vanishingly unlikely to be alive on this host.
  assert.equal(await abandoned({ pid: 999_999, createdAt: '1970-01-01T00:00:00.000Z' }), true);
});

test('withLock takes over a stale lock recorded under this process, by its real identity', async () => {
  const dir = scratch();
  const lockPath = join(dir, 'x.lock');
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ identity: { pid: process.pid, createdAt: '1970-01-01T00:00:00.000Z' } }));
  const result = await withLock(lockPath, () => 'ran');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, 'ran');
});

test('a waiter does not block the event loop: a timer fires while it waits, and it proceeds once the lock is released', async () => {
  const dir = scratch();
  const lockPath = join(dir, 'held.lock');
  mkdirSync(dir, { recursive: true });
  const self = await processIdentity(process.pid);
  assert.ok(self, 'this process reports its own creation time');
  writeFileSync(lockPath, JSON.stringify({ identity: self }));
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 5);
  const release = setTimeout(() => rmSync(lockPath, { force: true }), 60);
  // Resolves without spawning a real OS process, so the only remaining source of
  // asynchrony in the retry loop is the wait itself: a busy-wait would starve the
  // timers above instead of letting them fire, and this probe would not mask that.
  const instant = async (pid: number): Promise<ProcessIdentity | null> => (pid === self.pid ? self : null);
  try {
    const result = await withLock(lockPath, () => 'ran-after-wait', instant);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, 'ran-after-wait');
    assert.ok(ticks > 0, 'the event loop kept running timers while withLock waited, so it never used Atomics.wait');
  } finally {
    clearInterval(timer);
    clearTimeout(release);
  }
});
