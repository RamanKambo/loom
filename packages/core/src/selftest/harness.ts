import type { Finding, FindingCode, Model } from '../generated/types.js';
import { deepClone } from '../canonical.js';
import { sampleModel } from '../sample.js';

/** Thrown on the first failed assertion; its message names the assertion. */
export class SelfTestFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfTestFailure';
  }
}

export interface Tally {
  assertions: number;
  /** Every finding code any section observed being raised. */
  raised: Set<FindingCode>;
  /** Every comparison rule any section observed being emitted. */
  emitted: Set<string>;
}

export function assert(t: Tally, condition: unknown, message: string): asserts condition {
  t.assertions++;
  if (!condition) throw new SelfTestFailure(message);
}

export function assertThrows(t: Tally, fn: () => unknown, message: string, match?: (e: unknown) => boolean): unknown {
  t.assertions++;
  try {
    fn();
  } catch (e) {
    if (match && !match(e)) throw new SelfTestFailure(`${message}: threw the wrong error: ${e instanceof Error ? e.message : String(e)}`);
    return e;
  }
  throw new SelfTestFailure(`${message}: did not throw`);
}

export const errorsOf = (findings: readonly Finding[]): Finding[] => findings.filter((f) => f.severity === 'error');
export const codesOf = (findings: readonly Finding[]): FindingCode[] => findings.map((f) => f.code);

/** Record every code in `findings` as raised, then return them. */
export function observe(t: Tally, findings: readonly Finding[]): readonly Finding[] {
  for (const f of findings) t.raised.add(f.code);
  return findings;
}

/** A fresh sample to break; every case starts from the valid fixture. */
export const fresh = (): Model => deepClone(sampleModel());

/** Find one element by id in a list, or fail the self-test naming what was missing. */
export function pick<T extends { id?: string; name?: string }>(list: readonly T[] | undefined, key: string): T {
  const found = (list ?? []).find((x) => x.id === key || x.name === key);
  if (!found) throw new SelfTestFailure(`the sample has no element '${key}'`);
  return found;
}
