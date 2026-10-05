export { finding, hasErrors, refusal } from './findings.js';
export type { Outcome } from './findings.js';
export { documentText, readJson, toPosix, writeFileAtomic } from './fsx.js';
export {
  containsPath,
  isCaseSensitive,
  normalizeRelative,
  realPathOf,
  relativePathProblem,
  relativeTo,
  resolveRoot,
  samePath,
  segmentsOf,
} from './paths.js';
export type { ResolvedRoot } from './paths.js';
export { declaredSubmodules, findBoundary, findRepositoryRoot, gitDirOf, headRevision, isDirty, isRepositoryRoot, listAt, refExists, showAt, trackedPaths, untrackedPaths } from './repo.js';
export type { Submodule } from './repo.js';
export { CACHE_DIR, CONFIG_FILE, LOOM_DIR, STATE_FILE, checkConfig, loomDirOf, openWorkspace, profileOf, readConfig, readModelDocument, readState, workspaceUsable } from './config.js';
export type { Workspace } from './config.js';
export { GITIGNORE, GITIGNORE_TEXT, MODEL_FILE, initWorkspace, overlapWith, scaffoldConfig, scaffoldModel, scaffoldState } from './init.js';
export type { InitOptions } from './init.js';
export { DEFAULT_TRAVERSAL, ancestorDescriptors, discoverAll, hasDescriptor, overlapFindings, readDescriptor, resolveModel, resolveOwner } from './discover.js';
export type { Descriptor, DiscoveryResult, ModelResolution, OwnerOutcome, Traversal } from './discover.js';
export { JOURNAL_FILE, MANIFEST_FILE, checkOutputs, collisionFindings, enabledTargets, installOutputs, journalPath, manifestPath, planOutputs, readManifest, recoverInstall } from './outputs.js';
export type { BundlePlan, OutputOptions, OutputStatus, PlannedArtifact } from './outputs.js';
export { abandoned, processIdentity, withLock } from './lock.js';
export type { Locked } from './lock.js';
export { currentInputs, currentRevisions, mutateWorkspace, stateRevision, writeModel, writeState } from './write.js';
export type { CurrentInputs, WorkspaceChange } from './write.js';
export { EVIDENCE_DIR, listEvidence, putEvidence, readEvidence } from './evidence.js';
export type { StoreOutcome } from './evidence.js';
export { CONTRACTS_DIR, bundleLocation, resolvePublishedContracts } from './published.js';
export {
  currentPolicy,
  gatherEvaluationInputs,
  pinRevisionSet,
  policyHash,
  readAcceptances,
  readBaselines,
  readPolicy,
  readTrustedEvidence,
  resolveTrustedRef,
  signRecord,
  verifyRecord,
  verifyRevisionSet,
} from './trust.js';
export type { EvaluationInputs, TrustedBaseline } from './trust.js';
export { ACCEPTANCE_DIR, BASELINES_DIR, createAcceptance, createBaseline } from './records.js';
export type { CreateBaselineOptions, RecordOutcome } from './records.js';
export { ENGINE_VERSION } from './version.js';
export { openSession, sessionRevisions, stampSession } from './session.js';
export type { Session, SessionOptions } from './session.js';
export { HandleRegistry } from './handles.js';
export type { CloseStep, CloseStepResult, DirReader, Grants, HandleRegistryOptions } from './handles.js';
