import { FINDING_RULES, canonicalJson, type EvidenceRecord, type Finding, type RunRecord, type SourceRevision } from '@loom/core';
import { verifyRevisionSet } from '@loom/workspace';

const finding = (path: string, message: string, fix: string): Finding => ({
  code: 'EVIDENCE_REVISION_SET_INCONSISTENT',
  severity: FINDING_RULES.EVIDENCE_REVISION_SET_INCONSISTENT.severity,
  path,
  message,
  fix,
});

/**
 * One coordinated revision set: every evidence record of a run pins the run's
 * sources, and those sources equal the checkout being qualified. Separately
 * green runs at different revisions therefore never qualify together.
 */
export function verifyRunRevisionSet(run: RunRecord, evidence: readonly EvidenceRecord[], current: readonly SourceRevision[]): Finding[] {
  const out: Finding[] = [];
  const pinned = canonicalJson(run.revisionSet.sources);
  for (const e of evidence) {
    if (e.run.id !== run.runId) out.push(finding(`evidence/${e.id}`, `evidence ${e.id} belongs to run ${e.run.id}, not ${run.runId}`, 'qualify with evidence of one coordinated run'));
    else if (canonicalJson(e.sources) !== pinned) out.push(finding(`evidence/${e.id}`, `evidence ${e.id} pins sources that differ from its run's revision set`, 'rerun the check in one coordinated run'));
  }
  out.push(...verifyRevisionSet(run.revisionSet.sources, current));
  return out;
}
