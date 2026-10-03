import type { CheckDefinition, CheckResult, EvidenceRecord, Policy } from '@loom/core';

/** A check the policy lists as required or optional follows the list; any other check follows its own default. */
export function isRequired(check: CheckDefinition, policy: Policy | undefined): boolean {
  if (policy?.qualification.required.includes(check.id)) return true;
  if (policy?.qualification.optional.includes(check.id)) return false;
  return check.requiredByDefault;
}

export type EnvironmentChoice = { ok: true; environment: EvidenceRecord['environment'] } | { ok: false; reason: string };

/**
 * The environment a check may execute in. A 'process' check runs in the
 * current process environment. A fixture or designated check runs only in an
 * environment the policy designates, so no check can reach an undesignated
 * database or service.
 */
export function environmentFor(check: CheckDefinition, policy: Policy | undefined, environmentId: string | undefined): EnvironmentChoice {
  if (check.environment === 'process') return { ok: true, environment: { id: 'process', kind: 'process' } };
  const designated = (policy?.environments ?? []).filter((e) => e.designated && (check.environment === 'designated' || e.kind === 'disposable-fixture'));
  const chosen = environmentId ? designated.find((e) => e.id === environmentId) : designated[0];
  if (!chosen) {
    const want = check.environment === 'disposable-fixture' ? 'a disposable-fixture environment' : 'an environment';
    return {
      ok: false,
      reason: environmentId
        ? `environment '${environmentId}' is not ${want} the policy designates for qualification`
        : `no policy designates ${want} for qualification, so ${check.id} did not run`,
    };
  }
  return { ok: true, environment: { id: chosen.id, kind: chosen.kind } };
}

export interface CheckOutcome {
  check: string;
  required: boolean;
  result: CheckResult;
  reason?: string;
}

/**
 * The run aggregate. PASS only when every required check passed or is
 * NOT_APPLICABLE with a reason; any required FAIL makes it FAIL, otherwise any
 * required UNKNOWN makes it UNKNOWN. Optional results never change it. A run
 * with no required check is UNKNOWN, because nothing was qualified.
 */
export function aggregate(outcomes: readonly CheckOutcome[]): CheckResult {
  const required = outcomes.filter((o) => o.required);
  if (required.length === 0) return 'UNKNOWN';
  if (required.some((o) => o.result === 'FAIL')) return 'FAIL';
  if (required.some((o) => o.result === 'UNKNOWN' || (o.result === 'NOT_APPLICABLE' && !o.reason?.trim()))) return 'UNKNOWN';
  return 'PASS';
}
