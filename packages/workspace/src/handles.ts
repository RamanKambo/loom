import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CONTRACT_DIGEST,
  DISCOVERY_LIMITS,
  canonicalHash,
  deriveObligations,
  envelope,
  evaluateEvidence,
  fillPage,
  importPinsOf,
  modelRevision,
  nextAction,
  pageCompleteness,
  resolveBudget,
  revisionVectorOf,
  schemaErrors,
  textHash,
  validate,
} from '@loom/core';
import type {
  CleanupReport,
  Completeness,
  Finding,
  InstallJournal,
  LoomConfig,
  PageEntry,
  ResultEnvelope,
  ResumeInputs,
  RevisionSet,
  WorkspaceAccess,
  WorkspaceCloseData,
  WorkspaceHandle,
  WorkspaceInitializeData,
  WorkspaceInspectData,
  WorkspaceStatus,
  WorkspaceSummary,
} from '@loom/core';
import { CACHE_DIR, CONFIG_FILE, LOOM_DIR, STATE_FILE, checkConfig, openWorkspace, readConfig, type Workspace } from './config.js';
import { ancestorDescriptors, discoverAll, hasDescriptor, resolveOwner } from './discover.js';
import { finding, hasErrors, refusal } from './findings.js';
import { documentText, readJson, toPosix, writeFileAtomic } from './fsx.js';
import { GITIGNORE, GITIGNORE_TEXT, MODEL_FILE, overlapWith, scaffoldModel, scaffoldState } from './init.js';
import { withLock } from './lock.js';
import { containsPath, realPathOf, relativeTo, samePath } from './paths.js';
import { declaredSubmodules, findBoundary, findRepositoryRoot, gitDirOf, headRevision, isDirty, trackedPaths, untrackedPaths } from './repo.js';
import { gatherEvaluationInputs } from './trust.js';
import { ENGINE_VERSION } from './version.js';
import { currentInputs, currentRevisions, type CurrentInputs } from './write.js';

const STAGING_PREFIX = '.loom-staging-';
const INIT_JOURNAL_FILE = 'init-journal.json';
const INIT_LOCK_FILE = 'loom-init.lock';

/** The optional effects an edit handle may be granted beyond read and edit; a read handle never gains either. */
export interface Grants {
  qualify?: boolean;
  publish?: boolean;
}

export interface HandleRegistryOptions {
  /** Real, server-configured roots a path must resolve inside before any session may inspect or open it. */
  allowedRoots: readonly string[];
  grants?: Grants;
  /** Returns a loopback view URL for an open workspace, or null while no browser view exists for it. */
  viewProvider?: (workspaceId: string) => string | null;
}

/** Reads the immediate entries of a directory; a test replaces it to count calls and prove inspection never descends into an unrelated tree. */
export type DirReader = (dir: string) => string[];

const REAL_READDIR: DirReader = (dir) => readdirSync(dir);

/** A close step's outcome: done or not needed clears it; a residual resource names what close could not release and how to recover it. */
export interface CloseStepResult {
  outcome: CleanupReport['steps'][number]['outcome'];
  detail?: string;
  residual?: CleanupReport['residual'][number];
}

/** One resource a handle owns, released when the handle closes. A watcher or a browser session registers its own step through `registerCloseStep`; nothing registers one yet. */
export interface CloseStep {
  step: CleanupReport['steps'][number]['step'];
  run: () => CloseStepResult;
}

interface OpenEntry {
  access: WorkspaceAccess;
  ws: Workspace;
  /** Resources this handle owns, run in order when the handle closes; 'release-handle' itself is never one of these. */
  steps: CloseStep[];
}

function newWorkspaceId(): string {
  return `ws_${randomBytes(12).toString('hex')}`;
}

/** Every descriptor directly inside `dir`, one level only; a test's reader proves this never recurses into an unrelated subtree. */
function nestedDescriptors(dir: string, readdir: DirReader): string[] {
  let entries: string[];
  try {
    entries = readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => hasDescriptor(join(dir, name)));
}

/** The nearest readable ancestor descriptor above `repoRoot`, up to `boundary`, that declares a composition; null when `repoRoot` is the boundary or none declares one. */
function enclosingCompositionDescriptor(repoRoot: string, boundary: string): ReturnType<typeof ancestorDescriptors>[number] | null {
  if (samePath(repoRoot, boundary)) return null;
  return ancestorDescriptors(dirname(repoRoot), boundary).find((d) => d.readable && d.config?.composition) ?? null;
}

/**
 * The composition that encloses `repoRoot`, with whether it lists `repoRoot`
 * as one of its members. Null when none encloses it.
 */
function enclosingComposition(repoRoot: string, boundary: string): WorkspaceInspectData['composition'] {
  const found = enclosingCompositionDescriptor(repoRoot, boundary);
  const composition = found?.config?.composition;
  if (!found || !found.config || !composition) return null;
  const listed = composition.members.some((m) => samePath(join(found.home, ...m.repositoryPath.split('/')), repoRoot));
  return { descriptor: relativeTo(boundary, found.loomDir), modelId: found.config.modelId, listed };
}

/** The {modelId, memberId} of the composition that directly lists `repoRoot` as a member, for WorkspaceHandle.parent; undefined when none lists it. */
function enclosingMembership(repoRoot: string, boundary: string): WorkspaceHandle['parent'] {
  const found = enclosingCompositionDescriptor(repoRoot, boundary);
  const composition = found?.config?.composition;
  if (!found || !found.config || !composition) return undefined;
  const member = composition.members.find((m) => samePath(join(found.home, ...m.repositoryPath.split('/')), repoRoot));
  return member ? { modelId: found.config.modelId, memberId: member.memberId } : undefined;
}

/** The existing models of `repoRoot` and its direct, checked-out submodules, each with whether its descriptor is readable. */
function modelsOf(repoRoot: string): WorkspaceInspectData['models'] {
  const entries = [
    { dir: repoRoot, rel: '.' },
    ...declaredSubmodules(repoRoot)
      .filter((s) => s.checkedOut)
      .map((s) => ({ dir: join(repoRoot, ...s.path.split('/')), rel: s.path })),
  ];
  const out: WorkspaceInspectData['models'] = [];
  for (const e of entries) {
    if (!hasDescriptor(e.dir)) continue;
    const descriptor = e.rel === '.' ? LOOM_DIR : `${e.rel}/${LOOM_DIR}`;
    const cfg = readConfig(join(e.dir, LOOM_DIR));
    out.push(cfg.value ? { descriptor, readable: true, modelId: cfg.value.modelId, modelKind: cfg.value.modelKind } : { descriptor, readable: false });
  }
  return out;
}

/** The direct submodules `repoRoot`'s .gitmodules declares, each with whether its checkout is present and holds a descriptor; a missing checkout also raises CHECKOUT_MISSING. */
function submodulesOf(repoRoot: string): { submodules: WorkspaceInspectData['submodules']; findings: Finding[] } {
  const findings: Finding[] = [];
  const submodules = declaredSubmodules(repoRoot).map((s) => {
    if (!s.checkedOut) {
      findings.push(finding('CHECKOUT_MISSING', s.path, `declared submodule '${s.path}' has no checkout`, 'check out the submodule, then inspect again'));
    }
    const hasDesc = s.checkedOut && hasDescriptor(join(repoRoot, ...s.path.split('/')));
    return { path: s.path, checkedOut: s.checkedOut, hasDescriptor: hasDesc };
  });
  return { submodules, findings };
}

/** One list of affected paths, bounded by the discovery budget's item limit, with what it left out. */
function boundedPaths(items: readonly string[], section: string): { kept: string[]; completeness: Completeness } {
  const budget = resolveBudget({ maxRecords: DISCOVERY_LIMITS.defaultRecords, maxBytes: DISCOVERY_LIMITS.maxBytes });
  const entries: PageEntry[] = items.map((p) => ({ member: 'items', section, key: p, value: p }));
  const page = fillPage({}, entries, 0, budget);
  const completeness = pageCompleteness(entries, 0, page, undefined);
  return { kept: (page.data['items'] as string[]) ?? [], completeness };
}

/** A path under a `.loom-staging-*` directory: this adapter's own interrupted-write artifact, never meaningful repository content. */
const isStagingPath = (p: string): boolean => p.split('/')[0]?.startsWith(STAGING_PREFIX) ?? false;

/** The paths Git tracks and the paths Git reports untracked and not ignored under the inspected path, each bounded independently. */
function affectedPathsOf(repoRoot: string, abs: string): { data: WorkspaceInspectData['affectedPaths']; completeness: Completeness } {
  const pathspec = relativeTo(repoRoot, abs);
  const tracked = boundedPaths(trackedPaths(repoRoot, pathspec).filter((p) => !isStagingPath(p)), 'affectedPaths/tracked');
  const untracked = boundedPaths(untrackedPaths(repoRoot, pathspec).filter((p) => !isStagingPath(p)), 'affectedPaths/untracked');
  return {
    data: { tracked: tracked.kept, untracked: untracked.kept },
    completeness: {
      complete: tracked.completeness.complete && untracked.completeness.complete,
      truncated: tracked.completeness.truncated || untracked.completeness.truncated,
      omitted: [...tracked.completeness.omitted, ...untracked.completeness.omitted],
    },
  };
}

const EMPTY_COMPLETENESS: Completeness = { complete: true, truncated: false, omitted: [] };

type ScaffoldWrite = { path: string; role: 'model' | 'config' | 'state' | 'gitignore'; hash: string };

/** The four scaffold files a declaration proposes, repository-relative, and the canonical hash of that set without the journal (D23's `bundle`). */
function scaffoldWrites(declaration: LoomConfig): { writes: ScaffoldWrite[]; bundleHash: string } {
  const model = scaffoldModel();
  const state = scaffoldState();
  const writes: ScaffoldWrite[] = [
    { path: `${LOOM_DIR}/${MODEL_FILE}`, role: 'model', hash: canonicalHash(model) },
    { path: `${LOOM_DIR}/${CONFIG_FILE}`, role: 'config', hash: canonicalHash(declaration) },
    { path: `${LOOM_DIR}/${STATE_FILE}`, role: 'state', hash: canonicalHash(state) },
    { path: `${LOOM_DIR}/${GITIGNORE}`, role: 'gitignore', hash: textHash(GITIGNORE_TEXT) },
  ];
  return { writes, bundleHash: canonicalHash(writes) };
}

/** The journal a scaffold install writes, 'staged' with its entries pending, or 'complete' with them installed. */
function scaffoldJournal(bundleHash: string, writes: readonly ScaffoldWrite[], state: 'staged' | 'complete'): InstallJournal {
  return {
    journalVersion: 1,
    bundle: bundleHash,
    state,
    entries: writes.map((w) => ({ path: w.path, hash: w.hash, previousHash: null, status: state === 'complete' ? ('installed' as const) : ('pending' as const) })),
  };
}

/** The content a staged scaffold file holds for one journal entry, relative to the staging directory rather than the eventual repository-relative path. */
const stagedPathOf = (staging: string, entry: InstallJournal['entries'][number]): string => join(staging, ...entry.path.split('/').slice(1));

/**
 * An interrupted initialization left staged beside `.loom`: removed only
 * while every file it staged still hashes to its journal entry, otherwise
 * left in place and reported. Null once no staging directory remains.
 */
function repairStaging(repoRoot: string): Finding | null {
  let entries: string[];
  try {
    entries = readdirSync(repoRoot);
  } catch {
    return null;
  }
  for (const name of entries.filter((n) => n.startsWith(STAGING_PREFIX))) {
    const staging = join(repoRoot, name);
    const rel = toPosix(relativeTo(repoRoot, staging));
    const r = readJson(join(staging, CACHE_DIR, INIT_JOURNAL_FILE));
    const clean = r.ok && (r.value as InstallJournal).entries.every((e) => {
      try {
        return textHash(readFileSync(stagedPathOf(staging, e), 'utf8')) === e.hash;
      } catch {
        return false;
      }
    });
    if (clean) {
      rmSync(staging, { recursive: true, force: true });
      continue;
    }
    return finding('INIT_REPAIR_REQUIRED', rel, `an interrupted initialization is staged at '${rel}' and could not be verified against its journal`, 'repair or remove the staging directory, then initialize again');
  }
  return null;
}

/**
 * A session's handles on opened workspaces: the paths it may reach, what each
 * handle is authorized to do, and the open workspaces themselves, keyed by an
 * opaque id another session's handle never resolves. Inspection and opening
 * both recheck the allowed roots fresh, so narrowing takes effect immediately.
 */
export class HandleRegistry {
  private roots: string[];
  private readonly grants: Grants;
  private readonly viewProvider: ((workspaceId: string) => string | null) | undefined;
  private readonly handles = new Map<string, OpenEntry>();
  /** The declaration hash a dry run proposed for a real repository path, so apply can tell a changed declaration from a changed inspection. */
  private readonly pendingInitializations = new Map<string, string>();

  constructor(options: HandleRegistryOptions) {
    this.roots = options.allowedRoots.map((r) => realPathOf(r));
    this.grants = options.grants ?? {};
    this.viewProvider = options.viewProvider;
  }

  /**
   * Narrow this session's allowed roots to those a client root also reaches.
   * A client root inside a configured root replaces it with the narrower
   * path; a client root outside every configured root contributes nothing, so
   * this can only shrink the set the server already granted, never widen it.
   */
  narrow(clientRoots: readonly string[]): void {
    if (!clientRoots.length) return;
    const client = clientRoots.map((r) => realPathOf(r));
    const narrowed = this.roots.flatMap((root) =>
      client.filter((c) => containsPath(root, c) || containsPath(c, root)).map((c) => (containsPath(root, c) ? c : root)),
    );
    this.roots = [...new Set(narrowed)];
  }

  private withinAllowedRoots(abs: string): boolean {
    const real = realPathOf(abs);
    return this.roots.some((root) => containsPath(root, real));
  }

  /** The open workspace a handle resolves to, for a model tool to evaluate against; null for an id this session never opened. */
  resolve(workspaceId: string): Workspace | null {
    const entry = this.handles.get(workspaceId);
    if (!entry || !this.withinAllowedRoots(entry.ws.root)) return null;
    const ws = openWorkspace(entry.ws.root).value;
    if (ws) entry.ws = ws;
    return ws ?? null;
  }

  can(workspaceId: string, capability: 'read' | 'edit' | 'publish' | 'qualify'): boolean {
    const entry = this.handles.get(workspaceId);
    if (!entry || !this.withinAllowedRoots(entry.ws.root)) return false;
    return capability === 'read' || (entry.access === 'edit' && (capability === 'edit' || this.grants[capability] === true));
  }

  ids(): string[] { return [...this.handles.keys()]; }

  /** Model, config, policy and import revisions read fresh, and the single-workspace revision vector (and its digest) built from them. */
  private evaluate(ws: Workspace): { current: CurrentInputs; revisions: RevisionSet; vector: ReturnType<typeof revisionVectorOf>; vectorDigest: string; findings: Finding[] } {
    const { current, findings } = currentInputs(ws.root, ws.loomDir, ws.config);
    const revisions = currentRevisions(current);
    const vector = revisionVectorOf([
      {
        modelId: ws.config.modelId,
        model: current.model ?? modelRevision(ws.model),
        config: current.config.hash,
        policy: current.policy?.hash ?? null,
        contract: CONTRACT_DIGEST,
        generator: canonicalHash({ version: ENGINE_VERSION, contractDigest: CONTRACT_DIGEST }),
        imports: importPinsOf(ws.config),
      },
    ]);
    return { current, revisions, vector, vectorDigest: canonicalHash(vector), findings };
  }

  private handleOf(workspaceId: string, access: WorkspaceAccess, ws: Workspace, revisions: RevisionSet, wantView: boolean): WorkspaceHandle {
    const capabilities: WorkspaceHandle['capabilities'] = access === 'edit' ? ['read', 'edit'] : ['read'];
    if (access === 'edit') {
      if (this.grants.qualify) capabilities.push('qualify');
      if (this.grants.publish) capabilities.push('publish');
    }
    const handle: WorkspaceHandle = { workspaceId, modelId: ws.config.modelId, modelKind: ws.config.modelKind, displayName: ws.config.modelId, capabilities, revisions };
    const parent = enclosingMembership(ws.root, findBoundary(ws.root));
    if (parent) handle.parent = parent;
    const view = wantView ? this.viewProvider?.(workspaceId) ?? null : null;
    if (view) handle.viewUrl = view;
    return handle;
  }

  private summary(workspaceId: string, access: WorkspaceAccess, ws: Workspace, wantView: boolean): { summary: WorkspaceSummary; findings: Finding[] } {
    const { revisions, vectorDigest, findings } = this.evaluate(ws);
    const workspace = this.handleOf(workspaceId, access, ws, revisions, wantView);
    const scope = Object.entries(ws.config.scope).map(([component, roots]) => ({ component, roots: roots ?? [] }));
    const pendingWork = (ws.state?.tasks ?? [])
      .filter((t) => t.status !== 'done')
      .map((t) => ({ workPackage: t.workPackage, status: t.status as 'planned' | 'in-progress' | 'blocked' }));
    const omitted: WorkspaceSummary['completeness']['omitted'] = workspace.viewUrl
      ? []
      : [{ section: 'viewUrl', reason: wantView ? ('unavailable' as const) : ('not-requested' as const) }];
    const summary: WorkspaceSummary = {
      workspace,
      revisionVector: vectorDigest,
      phase: ws.state?.phase ?? 'unplanned',
      scope,
      imports: importPinsOf(ws.config),
      unknowns: ws.model.unknowns,
      pendingWork,
      nextActions: [],
      completeness: { complete: omitted.length === 0, truncated: false, omitted },
    };
    return { summary, findings };
  }

  /**
   * Where a new workspace could be placed when nothing claims the inspected
   * path: the path itself, with the reasons, including whether it already
   * holds nested descriptors one level down. Empty once a workspace already
   * governs the path.
   */
  private placements(abs: string, boundary: string, status: WorkspaceInspectData['ownership']['status'], readdir: DirReader): WorkspaceInspectData['placements'] {
    if (status !== 'ungoverned') return [];
    const rel = relativeTo(boundary, abs);
    const nested = nestedDescriptors(abs, readdir);
    const reasons = nested.length
      ? [`No descriptor claims '${rel}'; it already holds ${nested.length} nested '.loom' director${nested.length === 1 ? 'y' : 'ies'} one level down.`]
      : [`No descriptor claims '${rel}'.`];
    return [{ root: rel, modelKind: 'implementation', reasons }];
  }

  /**
   * Inspect a path without writing: the repository it sits in, who owns it
   * among the descriptors between it and the boundary, and where a new
   * workspace could be placed. It reads only ancestor descriptors, direct
   * submodule declarations and git metadata; `readdir` is called at most
   * once, on the inspected path itself, never on an unrelated tree.
   */
  inspect(path: string, options: { boundary?: string; readdir?: DirReader } = {}): ResultEnvelope {
    const tool = 'workspace.inspect';
    const abs = resolve(path);
    if (!this.withinAllowedRoots(abs)) {
      const f = finding('ROOT_INACCESSIBLE', path, `'${path}' is outside the server's configured allowed roots`, 'inspect a path inside an allowed root');
      const withoutDigest = {
        path,
        repository: { isRepository: false, isRoot: false },
        ownership: { path: '.', status: 'unresolved' as const, candidates: [] },
        composition: null,
        models: [],
        submodules: [],
        affectedPaths: { tracked: [], untracked: [] },
        placements: [],
      };
      const data: WorkspaceInspectData = { ...withoutDigest, inspectionDigest: canonicalHash(withoutDigest) };
      return envelope(tool, { model: null, findings: [f], data });
    }
    const boundary = findBoundary(abs, options.boundary);
    const readdir = options.readdir ?? REAL_READDIR;
    const repoRoot = findRepositoryRoot(abs);
    const repository: WorkspaceInspectData['repository'] = { isRepository: repoRoot !== null, isRoot: repoRoot !== null && samePath(repoRoot, abs) };
    if (repoRoot) {
      const commit = headRevision(repoRoot);
      if (commit) repository.commit = commit;
      repository.dirty = isDirty(repoRoot);
    }
    const owner = resolveOwner(abs, { boundary });
    // Decision 30: 'ungoverned' is a placement opportunity at a real path; a path that does not exist and
    // claims no owner is refused invalid-input instead. A missing checkout or an unreadable descriptor
    // under it resolves 'unresolved', never 'ungoverned', so that exception needs no extra check here.
    if (owner.result.status === 'ungoverned' && !existsSync(abs)) {
      return envelope(tool, { model: null, findings: [], refusal: refusal('invalid-input', `'${path}' does not exist`) });
    }
    const placements = this.placements(abs, boundary, owner.result.status, readdir);
    const composition = repoRoot ? enclosingComposition(repoRoot, boundary) : null;
    const models = repoRoot ? modelsOf(repoRoot) : [];
    const submoduleResult = repoRoot ? submodulesOf(repoRoot) : { submodules: [], findings: [] };
    const affected = repoRoot ? affectedPathsOf(repoRoot, abs) : { data: { tracked: [], untracked: [] }, completeness: EMPTY_COMPLETENESS };
    const withoutDigest = { path, repository, ownership: owner.result, composition, models, submodules: submoduleResult.submodules, affectedPaths: affected.data, placements };
    const data: WorkspaceInspectData = { ...withoutDigest, inspectionDigest: canonicalHash(withoutDigest) };
    return envelope(tool, { model: null, findings: [...owner.findings, ...submoduleResult.findings], data, completeness: affected.completeness });
  }

  /**
   * Initialize a workspace from a declaration validated as persistent
   * configuration. A dry run proposes every write, including the journal,
   * and writes nothing. Apply needs `expectedInspection` and the same
   * declaration the dry run for this path used; it re-inspects and repairs
   * any interrupted staging directory under the initialization lock in the
   * repository's Git directory, stages the scaffold with its recovery
   * journal, rechecks containment immediately before the rename, and renames
   * the staging directory into place. Never replaces an existing `.loom`,
   * stages or commits anything else, or writes acceptance.
   */
  async initialize(path: string, declaration: unknown, options: { dryRun: boolean; expectedInspection?: string }): Promise<ResultEnvelope> {
    const tool = 'workspace.initialize';
    const abs = resolve(path);
    if (!this.withinAllowedRoots(abs)) {
      return envelope(tool, { model: null, findings: [], refusal: refusal('invalid-input', "the path is outside the server's configured allowed roots") });
    }
    const errs = schemaErrors('LoomConfig', declaration);
    if (errs.length) {
      return envelope(tool, {
        model: null,
        findings: errs.map((e) => finding('CONFIG_INVALID', `declaration${e.pointer}`, e.message, 'correct the declaration to satisfy the loom.json contract')),
        refusal: refusal('invalid-input', 'the declaration does not satisfy the configuration contract'),
      });
    }
    const config = declaration as LoomConfig;
    const repoRoot = findRepositoryRoot(abs);
    if (!repoRoot || !samePath(repoRoot, abs)) {
      const where = repoRoot ? `the repository root is '${relativeTo(abs, repoRoot)}' relative to it` : 'it is not inside a Git repository';
      return envelope(tool, {
        model: null,
        findings: [finding('INIT_NOT_REPOSITORY_ROOT', '.', `initialize must run at a repository root; ${where}`, repoRoot ? `initialize at '${relativeTo(abs, repoRoot)}'` : 'initialize at the root of the repository that owns the code')],
        refusal: refusal('invalid-input', 'the path is not a repository root'),
      });
    }
    const loomDir = join(repoRoot, LOOM_DIR);
    if (existsSync(loomDir)) {
      return envelope(tool, {
        model: null,
        findings: [finding('INIT_ALREADY_INITIALIZED', LOOM_DIR, `${LOOM_DIR} already exists in '${toPosix(repoRoot)}'; initialize never replaces an existing workspace`, 'open the existing workspace instead')],
        refusal: refusal('invalid-input', '.loom already exists'),
      });
    }
    const model = scaffoldModel();
    const state = scaffoldState();
    const conflicts = (): Finding[] => {
      const boundary = findBoundary(repoRoot);
      const ancestors = containsPath(boundary, repoRoot) && !samePath(boundary, repoRoot) ? ancestorDescriptors(dirname(repoRoot), boundary) : [];
      const descendants = discoverAll(repoRoot, { cacheDir: null }).descriptors.filter((d) => !samePath(d.home, repoRoot));
      return overlapWith(repoRoot, [...ancestors, ...descendants]);
    };
    const conflictFindings = conflicts();
    const scaffoldFindings: Finding[] = [...validate(model).filter((f) => f.severity === 'error'), ...checkConfig(config, model, state, repoRoot).findings];
    const blocking = [...conflictFindings, ...scaffoldFindings];
    if (blocking.length) {
      const cause = conflictFindings.length ? 'policy-failure' : 'invalid-input';
      return envelope(tool, { model, findings: blocking, refusal: refusal(cause, 'the declaration was not installed') });
    }
    const { writes, bundleHash } = scaffoldWrites(config);
    const journalHash = canonicalHash(scaffoldJournal(bundleHash, writes, 'complete'));
    const allWrites: WorkspaceInitializeData['writes'] = [...writes, { path: `${LOOM_DIR}/${CACHE_DIR}/${INIT_JOURNAL_FILE}`, role: 'journal', hash: journalHash }];
    const current = this.inspect(path);
    const currentDigest = (current.data as WorkspaceInspectData).inspectionDigest;

    if (options.dryRun) {
      this.pendingInitializations.set(realPathOf(repoRoot), canonicalHash(config));
      const data: WorkspaceInitializeData = {
        outcome: 'proposed',
        inspectionDigest: currentDigest,
        writes: allWrites,
        nextActions: [nextAction('Create the workspace against this inspection.', 'loom.workspace', { action: 'initialize', path, declaration: config, dryRun: false, expectedInspection: currentDigest })],
      };
      return envelope(tool, { model, findings: [...current.findings], data });
    }

    if (options.expectedInspection === undefined) {
      return envelope(tool, { model, findings: [], refusal: refusal('invalid-input', 'apply requires expectedInspection, the inspection digest the declaration was prepared against') });
    }
    const pendingHash = this.pendingInitializations.get(realPathOf(repoRoot));
    if (pendingHash !== undefined && pendingHash !== canonicalHash(config)) {
      return envelope(tool, { model, findings: [], refusal: refusal('invalid-input', 'the declaration differs from the dry run this inspection was prepared against') });
    }

    type LockOutcome =
      | { kind: 'repair'; f: Finding }
      | { kind: 'stale'; digest: string; findings: Finding[] }
      | { kind: 'conflict'; findings: Finding[] }
      | { kind: 'redirected' }
      | { kind: 'failed'; message: string }
      | { kind: 'created' };
    const locked = await withLock(join(gitDirOf(repoRoot), INIT_LOCK_FILE), (): LockOutcome => {
      const repair = repairStaging(repoRoot);
      if (repair) return { kind: 'repair', f: repair };
      const fresh = this.inspect(path);
      const freshData = fresh.data as WorkspaceInspectData;
      if (freshData.inspectionDigest !== options.expectedInspection) return { kind: 'stale', digest: freshData.inspectionDigest, findings: fresh.findings };
      const freshConflicts = conflicts();
      if (freshConflicts.length) return { kind: 'conflict', findings: freshConflicts };
      const rootReal = realPathOf(repoRoot);
      const stillContained = (p: string): boolean => containsPath(rootReal, realPathOf(p));
      let staging: string;
      try {
        staging = mkdtempSync(join(repoRoot, STAGING_PREFIX));
      } catch (err) {
        return { kind: 'failed', message: (err as Error).message };
      }
      try {
        for (const w of writes) {
          const rel = w.path.split('/').slice(1).join('/');
          const content = w.role === 'model' ? documentText(model) : w.role === 'config' ? documentText(config) : w.role === 'state' ? documentText(state) : GITIGNORE_TEXT;
          mkdirSync(dirname(join(staging, rel)), { recursive: true });
          writeFileSync(join(staging, rel), content);
        }
        mkdirSync(join(staging, CACHE_DIR), { recursive: true });
        writeFileAtomic(join(staging, CACHE_DIR, INIT_JOURNAL_FILE), documentText(scaffoldJournal(bundleHash, writes, 'staged')));
        if (!stillContained(loomDir)) {
          rmSync(staging, { recursive: true, force: true });
          return { kind: 'redirected' };
        }
        renameSync(staging, loomDir);
      } catch (err) {
        return { kind: 'failed', message: (err as Error).message };
      }
      writeFileAtomic(join(loomDir, CACHE_DIR, INIT_JOURNAL_FILE), documentText(scaffoldJournal(bundleHash, writes, 'complete')));
      return { kind: 'created' };
    });
    if (!locked.ok) {
      return envelope(tool, { model, findings: [], refusal: refusal('unresolved-context', `initialization is locked by ${locked.holder}`) });
    }
    this.pendingInitializations.delete(realPathOf(repoRoot));
    switch (locked.value.kind) {
      case 'repair':
        return envelope(tool, { model, findings: [locked.value.f], refusal: refusal('unresolved-context', 'an earlier initialization is staged and could not be verified; nothing further was written') });
      case 'stale':
        return envelope(tool, {
          model,
          findings: [finding('STALE_BASE_REVISION', LOOM_DIR, `the inspection changed since 'expectedInspection'; it is now ${locked.value.digest}`, 're-inspect the path and apply against its current digest'), ...locked.value.findings],
          refusal: refusal('stale-base', 'the inspection changed since expectedInspection; nothing was written'),
        });
      case 'conflict':
        return envelope(tool, { model, findings: locked.value.findings, refusal: refusal('policy-failure', 'another descriptor now claims a conflicting path; nothing was written') });
      case 'redirected':
        return envelope(tool, {
          model,
          findings: [finding('WRITE_OUTSIDE_WORKSPACE', LOOM_DIR, `'${LOOM_DIR}' no longer resolves inside the workspace at '${toPosix(repoRoot)}'; a link or reparse point redirected it after it was planned`, 'repair or remove the link, then initialize again')],
          refusal: refusal('policy-failure', 'the write target no longer resolves inside the workspace; nothing was written'),
        });
      case 'failed':
        return envelope(tool, {
          model,
          findings: [finding('INIT_REPAIR_REQUIRED', LOOM_DIR, `installing the scaffold failed: ${locked.value.message}`, 'resolve the filesystem error, then initialize again; an interrupted staging directory is repaired or reported on the next attempt')],
          refusal: refusal('unresolved-context', 'installation failed; nothing further was written'),
        });
      case 'created': {
        const data: WorkspaceInitializeData = { outcome: 'created', inspectionDigest: options.expectedInspection, writes: allWrites, nextActions: [nextAction('Open the created workspace.', 'loom.workspace', { action: 'open', path, access: 'edit' })] };
        return envelope(tool, { model, findings: [], data });
      }
    }
  }

  /**
   * Open a governed workspace for this session: a handle, a bounded summary
   * and, unless declined, a browser view URL once a view provider exists.
   * Read access never gains the qualify or publish grant; edit access gains
   * each only when this registry was configured with it.
   */
  open(path: string, access: WorkspaceAccess, options: { view?: boolean } = {}): ResultEnvelope {
    const tool = 'workspace.open';
    const abs = resolve(path);
    if (!this.withinAllowedRoots(abs)) {
      return envelope(tool, {
        model: null,
        findings: [finding('ROOT_INACCESSIBLE', path, `'${path}' is outside the server's configured allowed roots`, 'open a path inside an allowed root')],
        refusal: refusal('access-denied', "the path is outside the server's configured allowed roots"),
      });
    }
    const opened = openWorkspace(abs);
    if (!opened.value) {
      return envelope(tool, { model: null, findings: opened.findings, refusal: refusal('unresolved-context', 'no workspace governs this path; inspect it, then initialize one') });
    }
    const ws = opened.value;
    const workspaceId = newWorkspaceId();
    const wantView = options.view !== false;
    const { summary, findings } = this.summary(workspaceId, access, ws, wantView);
    const steps: CloseStep[] = [
      { step: 'cancel-runs', run: () => ({ outcome: 'not-needed' }) },
      { step: 'detach-watchers', run: () => ({ outcome: 'not-needed' }) },
      { step: 'revoke-browser-access', run: () => ({ outcome: 'not-needed' }) },
    ];
    this.handles.set(workspaceId, { access, ws, steps });
    return envelope(tool, { model: ws.model, findings: [...opened.findings, ...findings], data: summary });
  }

  /** Register one more resource this handle owns, run when it closes; a test double proves a residual resource refuses close as cleanup-incomplete. */
  registerCloseStep(workspaceId: string, step: CloseStep): void {
    this.handles.get(workspaceId)?.steps.push(step);
  }

  /** Current revisions, resources, pending runs and next actions of a handle this session opened; another session's handle is refused exactly like a missing one. */
  status(workspaceId: string): ResultEnvelope {
    const tool = 'workspace.status';
    const entry = this.handles.get(workspaceId);
    if (!entry) {
      return envelope(tool, { model: null, findings: [], refusal: refusal('unknown-handle', `'${workspaceId}' names no handle of this session`) });
    }
    const fresh = this.resolve(workspaceId);
    if (!fresh) return envelope(tool, { model: null, findings: [], refusal: refusal('unresolved-context', 'the workspace is no longer readable within the permitted roots') });
    const { revisions, vectorDigest, findings } = this.evaluate(fresh);
    const workspace = this.handleOf(workspaceId, entry.access, entry.ws, revisions, false);
    const status: WorkspaceStatus = {
      workspace,
      revisionVector: vectorDigest,
      resources: [{ uri: `loom://workspaces/${workspaceId}/status`, contents: 'WorkspaceStatus' }],
      pendingRuns: [],
      nextActions: [],
    };
    return envelope(tool, { model: entry.ws.model, findings, data: status });
  }

  /** Read the current summary without allocating another handle or changing its identity. */
  snapshot(workspaceId: string): ResultEnvelope {
    const entry = this.handles.get(workspaceId);
    const ws = this.resolve(workspaceId);
    if (!entry || !ws) return this.status(workspaceId);
    const { summary, findings } = this.summary(workspaceId, entry.access, ws, false);
    return envelope('workspace.open', { model: ws.model, findings, data: summary });
  }

  /**
   * Close a handle: run every step it registered, cancelling or awaiting
   * owned runs, detaching watchers and revoking browser access, then release
   * the handle itself. A step that leaves a resource stops the handle from
   * releasing: close is refused cleanup-incomplete, naming the resource and
   * its recovery, and the handle stays open for a retry.
   */
  close(workspaceId: string): ResultEnvelope {
    const tool = 'workspace.close';
    const entry = this.handles.get(workspaceId);
    if (!entry) {
      return envelope(tool, { model: null, findings: [], refusal: refusal('unknown-handle', `'${workspaceId}' names no handle of this session`) });
    }
    const steps: CleanupReport['steps'] = [];
    const residual: CleanupReport['residual'] = [];
    for (const s of entry.steps) {
      const r = s.run();
      const stepResult: CleanupReport['steps'][number] = { step: s.step, outcome: r.outcome };
      if (r.detail) stepResult.detail = r.detail;
      steps.push(stepResult);
      if (r.residual) residual.push(r.residual);
    }
    if (residual.length) {
      const cleanup: CleanupReport = { complete: false, steps, residual };
      const data: WorkspaceCloseData = { workspaceId, released: false, cleanup };
      const named = residual.map((r) => `${r.kind} '${r.identity}' (${r.recovery})`).join('; ');
      return envelope(tool, { model: null, findings: [], data, refusal: refusal('cleanup-incomplete', `closing left a resource: ${named}`) });
    }
    steps.push({ step: 'release-handle', outcome: 'done' });
    this.handles.delete(workspaceId);
    const cleanup: CleanupReport = { complete: true, steps, residual: [] };
    const data: WorkspaceCloseData = { workspaceId, released: true, cleanup };
    return envelope(tool, { model: null, findings: [], data });
  }

  /**
   * The recorded progress of an open workspace, read fresh from disk, for the
   * core's resumeContext: address, outcome, phase, owning scopes, revision
   * vector, trusted baseline, open unknowns, evidence obligations and pending
   * work. Null for a handle this session does not hold; a future run table
   * supplies pendingRuns.
   */
  resumeInputs(workspaceId: string): ResumeInputs | null {
    const entry = this.handles.get(workspaceId);
    if (!entry) return null;
    // Read the workspace fresh: a resumed session restates current recorded progress, not the state at open.
    const fresh = openWorkspace(entry.ws.root);
    const ws = fresh.value ?? entry.ws;
    const { vector } = this.evaluate(ws);
    const owningScopes = Object.entries(ws.config.scope).map(([component, roots]) => ({ modelId: ws.config.modelId, component, roots: roots ?? [] }));
    const pendingWork = (ws.state?.tasks ?? [])
      .filter((t) => t.status !== 'done')
      .map((t) => ({ workPackage: t.workPackage, status: t.status as 'planned' | 'in-progress' | 'blocked' }));
    const { inputs } = gatherEvaluationInputs(ws.root);
    const baseline = inputs.baseline ? { record: inputs.baseline.record, model: inputs.baseline.model } : null;
    const obligations = deriveObligations(ws.model, undefined, inputs);
    const evidence = evaluateEvidence(ws.model, obligations, inputs).obligations;
    return {
      address: { workspaceId },
      workspaceId,
      outcome: ws.state?.outcome ?? null,
      phase: ws.state?.phase ?? 'unplanned',
      owningScopes,
      revisionVector: vector,
      baseline,
      openUnknowns: ws.model.unknowns,
      evidence,
      pendingWork,
      pendingRuns: [],
    };
  }
}
