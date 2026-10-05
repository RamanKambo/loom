import { FINDING_RULES } from '@loom/core';
import type { Finding, FindingCode, RecordRef, Refusal } from '@loom/core';

/** A finding whose severity comes from the core rule table, never chosen locally. */
export function finding(code: FindingCode, path: string, message: string, fix: string, refs?: RecordRef[]): Finding {
  const f: Finding = { code, severity: FINDING_RULES[code].severity, path, message, fix };
  if (refs && refs.length) f.refs = refs;
  return f;
}

export const hasErrors = (findings: readonly Finding[]): boolean => findings.some((f) => f.severity === 'error');

export const refusal = (cause: Refusal['cause'], message: string, nextActions: NonNullable<Refusal['nextActions']> = []): Refusal => (nextActions.length ? { cause, message, nextActions } : { cause, message });

/** A read result: the value when it could be established, and every finding met on the way. */
export interface Outcome<T> {
  value: T | null;
  findings: Finding[];
}
