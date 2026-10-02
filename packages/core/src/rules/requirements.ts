import { FINDING } from '../codes.js';
import { ref, type Rule } from './context.js';

/**
 * Criteria coverage. Each required criterion verified by scenario is covered
 * by a scenario that names it; covering one criterion of a requirement never
 * covers another.
 */
export const requirementRules: Rule = (ctx) => {
  const covered = new Set(ctx.model.scenarios.flatMap((s) => s.criteria));
  for (const req of ctx.model.requirements) {
    if (req.status === 'retired') continue;
    const about = [ref('requirement', req.id)];
    if (req.status === 'active' && req.criteria.length === 0) {
      ctx.report(FINDING.REQUIREMENT_WITHOUT_CRITERIA, `requirements/${req.id}/criteria`, `active requirement '${req.id}' states no acceptance criterion`, about, `state at least one independently verifiable criterion on requirement '${req.id}'`);
    }
    if (req.status !== 'active') continue;
    for (const c of req.criteria) {
      if (!c.required || c.verification !== 'scenario' || covered.has(c.id)) continue;
      ctx.report(
        FINDING.CRITERION_UNCOVERED,
        `requirements/${req.id}/criteria/${c.id}`,
        `required criterion '${c.id}' of requirement '${req.id}' is verified by scenario, but no scenario names it`,
        [ref('criterion', c.id), ...about],
        `add an independently authored scenario that lists '${c.id}' in its criteria`,
      );
    }
  }
};
