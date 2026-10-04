import type { Finding, ResultEnvelope } from '@loom/core';

export type Log = (line: string) => void;

export function renderFinding(f: Finding): string[] {
  const impact = f.impact && f.impact.length ? ` [impact: ${f.impact.map((a) => a.ref.id).join(', ')}]` : '';
  const lines = [`  ${f.severity.toUpperCase()} ${f.code} at ${f.path}: ${f.message}${impact}`];
  if (f.fix) lines.push(`    fix: ${f.fix}`);
  return lines;
}

/** A readable rendering of a result envelope; `--json` prints the envelope itself instead. */
export function renderEnvelope(env: ResultEnvelope, log: Log, detail: string[] = []): void {
  const head = env.outcome === 'refused' && env.refusal ? `refused (${env.refusal.cause}): ${env.refusal.message}` : 'ok';
  log(`${env.tool}: ${head}`);
  const s = env.states;
  log(`  states: validation=${s.validation.state} readiness=${s.readiness.state} qualification=${s.qualification.state} acceptance=${s.acceptance.state}`);
  if (env.revisions.model) log(`  model revision: ${env.revisions.model}`);
  for (const line of detail) log(`  ${line}`);
  const counts = (['error', 'warning', 'info'] as const).map((sev) => `${env.findings.filter((f) => f.severity === sev).length} ${sev}`).join(', ');
  log(`  findings: ${env.findings.length} (${counts})`);
  for (const f of env.findings) for (const line of renderFinding(f)) log(line);
  // loom.describe continues with --cursor, after its input member; every other paged command with --continuation.
  const resume = env.tool === 'loom.describe' ? '--cursor' : '--continuation';
  if (!env.completeness.complete) log(`  incomplete: ${env.completeness.omitted.length} omitted${env.completeness.continuation ? `; continue with ${resume} ${env.completeness.continuation}` : ''}`);
  for (const a of env.refusal?.nextActions ?? []) log(`  next: ${a.purpose}`);
}

/** Exit status: 0 when the result is ok with no error finding, 1 for a refusal or any error finding. */
export const exitStatus = (env: ResultEnvelope): number => (env.outcome === 'refused' || env.findings.some((f) => f.severity === 'error') ? 1 : 0);
