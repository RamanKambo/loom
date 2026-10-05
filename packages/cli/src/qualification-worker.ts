import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { artifactInputs } from '@loom/core';
import { openSession } from '@loom/workspace';
import { runChecks, defaultLifecycleRoot, processIdentity } from '@loom/qualification';
import { controlFile, qualificationVector, type QualificationControl } from './qualification-commands.js';

const runId = process.argv[2]!; const file = controlFile(runId);
const control = JSON.parse(readFileSync(file, 'utf8')) as QualificationControl;
const persist = () => { const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(control), { mode: 0o600 }); renameSync(temp, file); };
const controller = new AbortController();
const cancellation = setInterval(() => { if (existsSync(`${file}.cancel`)) { control.status.phase = 'cancelling'; controller.abort(); } }, 100);
try {
  control.owner = processIdentity() ?? undefined;
  const session = openSession(control.root); const policy = session.inputs.policy;
  if (!session.workspace || !session.model || !policy || policy.id !== control.executionPolicy || control.checks.some((check) => ![...policy.qualification.required, ...policy.qualification.optional].includes(check)) || qualificationVector(control.root) !== control.expectedVector) throw new Error('trusted execution policy or queued source vector changed');
  if (existsSync(`${file}.cancel`)) controller.abort();
  control.status.phase = controller.signal.aborted ? 'cancelling' : 'running'; persist();
  const rendering = artifactInputs(session.inputs);
  const out = await runChecks({ root: control.root, model: session.model, policy, checks: control.checks, runId, signal: controller.signal, store: true, ...(rendering ? { inputs: rendering } : {}), runner: 'loom-cli', log: (line) => {
    const match = /^check ([^:]+): (PASS|FAIL|UNKNOWN|NOT_APPLICABLE)\b/.exec(line); if (!match) return;
    control.status.progress.completed++; control.status.progress.events.push({ sequence: control.status.progress.completed, check: match[1]!, state: 'finished', result: match[2] as 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE' }); if (control.status.progress.events.length > 200) control.status.progress.events.shift(); persist();
  } });
  control.status.phase = out.run.outcome === 'cancelled' ? 'cancelled' : out.run.outcome === 'succeeded' ? 'completed' : 'failed'; control.status.cleanup = out.run.cleanup!.state; control.status.evidence = out.run.evidenceRefs;
  writeFileSync(join(defaultLifecycleRoot(), 'evidence', `${runId}.run.json`), JSON.stringify(out.run)); persist();
} catch (error) { control.status.phase = 'failed'; control.error = String(error); persist(); }
finally { clearInterval(cancellation); }
