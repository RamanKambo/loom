import { readFileSync, existsSync } from 'node:fs';
import type { AllocationJournal } from '@loom/core';
import { sameProcess, recoverRun } from './lifecycle.js';
const [file, executable, timeout] = process.argv.slice(2);
if (file && executable) {
  const timer = setInterval(async () => {
    if (!existsSync(file)) { clearInterval(timer); return; }
    const journal = JSON.parse(readFileSync(file, 'utf8')) as AllocationJournal;
    if (journal.resources.every((r) => r.state === 'removed')) { clearInterval(timer); return; }
    if (!sameProcess(journal.owner.process)) { clearInterval(timer); try { await recoverRun(file, executable, Number(timeout), 'guardian'); } catch { /* durable journal remains for explicit recovery */ } }
  }, 1000);
}
