export type * from './generated/types.js';
export { SCHEMA_BUNDLE, SCHEMA_BUNDLE_ID } from './generated/schemas.js';
export { CONTRACT_DIGEST, SCHEMA_VOCABULARY } from './generated/digest.js';
export { COLLECTIONS, FIELD_PATHS, REFERENCE_FIELDS, KEYED_ARRAYS, ORDERED_ARRAYS, PATCH_VARIANTS } from './generated/registry.js';
export { PROFILES, PROJECTION_PROFILES, ICDS } from './generated/contracts.js';
export { OPERATION_CATALOGUE, MCP_TOOLS, AGENT_TOOLS, MCP_TOOL_BUDGET, MCP_INSTRUCTIONS_BUDGET, TOOL_EXAMPLES, WORKFLOW, CLI_COMMANDS, CLI_USAGE } from './generated/operations.js';
export type { CatalogueTool, AgentTool, AgentToolAction } from './generated/operations.js';
export { handlerGaps, unmetPresenceRules } from './operations.js';

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
  withArtifactHashes,
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
export { deriveObligations, evaluateEvidence, invalidatedBy, changedInputs, unhashedArtifacts, isEngineSelfTest } from './evidence.js';
export type { EvidenceEvaluation } from './evidence.js';
export { checkReadiness, recomputeReadiness, designOrder, makeMaturity } from './readiness.js';
export type { ReadinessResult, Recompute } from './readiness.js';
export {
  DISCOVERY_LIMITS,
  resolveBudget,
  utf8Bytes,
  dataBytes,
  continuationToken,
  readContinuation,
  filtersDigest,
  checkContinuation,
  fillPage,
  pageCompleteness,
  toolEffects,
  nextAction,
} from './discovery.js';
export type { ResolvedBudget, ContinuationKind, Continuation, ContinuationCheck, PageEntry, Page } from './discovery.js';
export { retrieveContext } from './retrieval.js';
export type { ContextRequest, ContextResult } from './retrieval.js';
export { resumeContext, RESUME_TARGET } from './resume.js';
export type { ResumeInputs, ResumeResult } from './resume.js';
export { ORIENTATION_TEXT, GUIDANCE_REVISION, guides, guide } from './guidance.js';
export { describe, proofLimits, toolDescriptions, descriptionProblems, TOOL_SUMMARIES, DESCRIBE_SECTIONS } from './describe.js';
export type { DescribeResult } from './describe.js';
export { describeTool, contextTool, checkReadinessTool, planChangeTool, compareBaselineTool, evaluateEvidenceTool } from './tools.js';
export type { PlanChangeToolInput, ContextOptions } from './tools.js';
export { prohibitedMarkers } from './wording.js';
export type { MarkerKind, ProhibitedMarker } from './wording.js';
export { importPinsOf, revisionVectorOf } from './imports.js';
export type { RevisionVectorEntry } from './imports.js';
export { sampleModel } from './sample.js';
export { selfTest } from './selftest/index.js';
export { seededRegressions, declaredContradictions } from './selftest/corpus.js';
export type { CorpusOutcome } from './selftest/corpus.js';
