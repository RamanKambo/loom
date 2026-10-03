import type { Model, Finding } from './generated/types.js';
import { structuralFindings } from './load.js';
import { indexModel } from './records.js';
import { DependencyGraph } from './graph.js';
import { createContext, type Rule } from './rules/context.js';
import { duplicateIds, duplicateKeys, references } from './rules/identity.js';
import { valueShapes } from './rules/values.js';
import { typeRules } from './rules/types.js';
import { storageRules } from './rules/storage.js';
import { operationRules } from './rules/operations.js';
import { routineRules } from './rules/routines.js';
import { mutationRules } from './rules/mutations.js';
import { predicateRules } from './rules/predicates.js';
import { structureRules } from './rules/structure.js';
import { requirementRules } from './rules/requirements.js';
import { portabilityRules } from './rules/portability.js';
import { knowledgeRules } from './rules/knowledge.js';
import { concernRules } from './rules/concerns.js';
import { hostingRules, enforcementRules } from './rules/hosting.js';
import { representationRules, migrationRules } from './rules/representations.js';
import { versionRules, publishedRules } from './rules/versions.js';
import type { EvaluationInputs } from './inputs.js';

/** Every semantic rule pass, in the order validate() runs them. */
export const RULES: readonly Rule[] = [
  duplicateIds,
  duplicateKeys,
  references,
  valueShapes,
  typeRules,
  storageRules,
  operationRules,
  routineRules,
  mutationRules,
  predicateRules,
  structureRules,
  requirementRules,
  portabilityRules,
  knowledgeRules,
  concernRules,
  enforcementRules,
  hostingRules,
  representationRules,
  migrationRules,
  versionRules,
  publishedRules,
];

/**
 * Run every rule and return the findings. The structural contract runs first;
 * when it fails only those findings are returned, because the semantic passes
 * assume the documented shape. Pure and total: it never throws. A model is
 * valid when no finding has severity 'error'. Rules that compare against a
 * baseline, acceptance records, resolved bundles or a date run only when the
 * adapter supplies those inputs.
 */
export function validate(model: Model, inputs: EvaluationInputs = {}): Finding[] {
  const structural = structuralFindings(model);
  if (structural.length > 0) return structural;
  const index = indexModel(model);
  const graph = new DependencyGraph(index);
  const findings: Finding[] = [];
  const ctx = createContext(model, index, graph, findings, inputs);
  for (const rule of RULES) rule(ctx);
  return findings;
}

/** True when no finding is an error. */
export const isValid = (findings: readonly Finding[]): boolean => !findings.some((f) => f.severity === 'error');
