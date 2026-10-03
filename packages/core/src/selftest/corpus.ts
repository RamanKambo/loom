import { validate } from '../validate.js';
import { CONTRADICTIONS } from './contradictions.js';
import { REGRESSIONS } from './regressions.js';
import { fresh, SelfTestFailure, type Tally } from './harness.js';

/** One entry of a seeded corpus, run on its own. */
export interface CorpusOutcome {
  id: string;
  caught: boolean;
  detail: string;
}

/** Every seeded regression: caught when each assertion it makes about the engine holds. */
export function seededRegressions(): CorpusOutcome[] {
  return REGRESSIONS.map((r) => {
    const t: Tally = { assertions: 0, raised: new Set(), emitted: new Set() };
    try {
      r.run(t);
      return { id: r.behavior, caught: true, detail: `${t.assertions} assertion(s) hold` };
    } catch (e) {
      if (e instanceof SelfTestFailure) return { id: r.behavior, caught: false, detail: e.message };
      throw e;
    }
  });
}

/** Every declared contradiction of the sample: caught when validation raises its code where the entry says. */
export function declaredContradictions(): CorpusOutcome[] {
  return CONTRADICTIONS.map((c) => {
    const m = fresh();
    c.break(m);
    const findings = validate(m);
    const caught = findings.some((f) => f.code === c.code && (c.pathIncludes === undefined || f.path.includes(c.pathIncludes)));
    return { id: c.label, caught, detail: caught ? c.code : `expected ${c.code}, got ${findings.map((f) => f.code).join(', ') || 'no finding'}` };
  });
}
