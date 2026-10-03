export type * from './generated/types.js';
export { SCHEMA_BUNDLE, SCHEMA_BUNDLE_ID } from './generated/schemas.js';
export { CONTRACT_DIGEST, SCHEMA_VOCABULARY } from './generated/digest.js';
export { COLLECTIONS, FIELD_PATHS, REFERENCE_FIELDS, KEYED_ARRAYS, ORDERED_ARRAYS, PATCH_VARIANTS } from './generated/registry.js';
export { PROFILES, PROJECTION_PROFILES, ICDS } from './generated/contracts.js';

export { FINDING, FINDING_RULES } from './codes.js';
export type { FindingRule } from './codes.js';
export { LoomStructuralError, LoomInvalidModelError } from './errors.js';
export { MODEL_FORMAT, loadModel, structuralFindings } from './load.js';
export { validatorFor, schemaErrors } from './schema-runtime.js';
export type { SchemaError } from './schema-runtime.js';
export { migrateModel, MODEL_MIGRATIONS } from './migrate.js';
export type { MigrationStep, MigrationResult } from './migrate.js';
export { validate, isValid, RULES } from './validate.js';
export type { Rule, RuleContext } from './rules/context.js';
export { diff, needsAcknowledgement, reachablePolicyKeys, DIFF_RULES, FIELD_POLICY } from './diff.js';
export type { DiffRule, DiffRuleId, FieldPolicy, Delta, DiffOptions } from './diff.js';
export { mutate, checkPatch } from './mutate.js';
export type { MutateOptions, MutateResult } from './mutate.js';
export {
  project,
  projectToFiles,
  renderTarget,
  renderAll,
  instancesOf,
  enabledTargets,
  artifactProfile,
  unsupportedConstructs,
  filesOf,
  projectedPath,
  PROJECTION_TARGETS,
  PROJECTION_FILES,
  JSON_SCHEMA_ID,
  SOURCE_NOTICE,
} from './project.js';
export type { ProjectOptions, RenderedTarget, RenderedBundle, ArtifactProfile } from './project.js';
export { sqlDeploymentOrder, procedureName } from './projections/sql.js';
export { sampleValue, sampleObject, decimalSample } from './projections/samples.js';
export { exportModel, exportYaml, importModel } from './exportModel.js';
export {
  envelope,
  defaultStates,
  validationState,
  revisionsOf,
  validateTool,
  mutateTool,
  diffTool,
  projectTool,
  projectAllTool,
  exportTool,
  importTool,
  checkRevision,
  loadOrRefuse,
  workspaceRefusal,
  refusal,
  asFinding,
} from './envelope.js';
export type { EnvelopeParts, MutateToolInput } from './envelope.js';
export { canonicalStringify, canonicalJson, deepEqual, deepClone } from './canonical.js';
export { sha256Hex } from './sha256.js';
export { canonicalHash, textHash, modelRevision, recordHash } from './hash.js';
export {
  ABSENT_STATE,
  KEY_SEPARATOR,
  KIND_OF_COLLECTION,
  COLLECTION_OF_KIND,
  VERSIONED_KINDS,
  indexModel,
  findRecord,
  resolveProperty,
  recordKey,
  keyOf,
  keyFieldsAt,
  columnOf,
} from './records.js';
export type { ModelIndex, CollectionName, PropertyRef } from './records.js';
export { DependencyGraph, dependencyGraph, changeImpact, coHosted } from './graph.js';
export { collectReferences, resolveReference, renameReferences, splitQualified } from './refs.js';
export type { Reference, Resolution } from './refs.js';
export { sqlTypeText, SQL_KIND_FAMILY } from './sql-types.js';
export { predicateText, expressionText } from './projections/context.js';
export { artifactInputs, effectiveGates, durationSeconds } from './inputs.js';
export type { EvaluationInputs, EffectiveGates, ImplementationGate } from './inputs.js';
export { resolveScope, ownersOf, makeAcceptanceCheck, trustedAcceptances, baselineAccepted, acceptanceScopeCovers, CONTRACT_KINDS, refKey, parseRefKey } from './scope.js';
export type { Scope } from './scope.js';
export { CONCERNS } from './rules/concerns.js';
export { compareBaseline, classifyChange, derivedSeal, gateFindings, retirementFindings } from './baseline.js';
export type { BaselineComparison, Approval } from './baseline.js';
export { deriveObligations, evaluateEvidence, invalidatedBy, changedInputs, isEngineSelfTest } from './evidence.js';
export type { EvidenceEvaluation } from './evidence.js';
export { checkReadiness, recomputeReadiness, designOrder, makeMaturity } from './readiness.js';
export type { ReadinessResult, Recompute } from './readiness.js';
export { retrieveContext, continuationToken } from './retrieval.js';
export type { ContextRequest, ContextResult } from './retrieval.js';
export { describe, TOOL_EFFECTS } from './describe.js';
export { describeTool, contextTool, checkReadinessTool, planChangeTool, compareBaselineTool, evaluateEvidenceTool } from './tools.js';
export type { PlanChangeToolInput } from './tools.js';
export { sampleModel } from './sample.js';
export { selfTest } from './selftest/index.js';
