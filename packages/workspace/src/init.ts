import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COLLECTIONS, envelope, revisionsOf, schemaErrors, validate } from '@loom/core';
import type { Finding, LoomConfig, Model, ModelKind, ResultEnvelope, WorkflowState } from '@loom/core';
import { CONFIG_FILE, LOOM_DIR, STATE_FILE, checkConfig, readConfig, readModelDocument, readState } from './config.js';
import { ancestorDescriptors, discoverAll, type Descriptor } from './discover.js';
import { finding, hasErrors, refusal } from './findings.js';
import { documentText, toPosix } from './fsx.js';
import { containsPath, realPathOf, relativeTo, samePath } from './paths.js';
import { findBoundary, findRepositoryRoot } from './repo.js';

export const MODEL_FILE = 'model.json';
export const GITIGNORE = '.gitignore';
export const GITIGNORE_TEXT = '/cache\n';

/** The initial model: one placeholder component whose purpose says its responsibilities are unspecified, every other record array empty. */
export function scaffoldModel(): Model {
  const model = { version: 1, ...Object.fromEntries(COLLECTIONS.map((c) => [c.collection, []])) } as unknown as Model;
  model.components = [{ id: 'workspace', purpose: 'Responsibilities are unspecified.', responsibilities: [] }];
  return model;
}

/** The declared stable model identity and kind. Product code invents neither: both are required, real values the caller declares. */
export const scaffoldConfig = (modelId: string, modelKind: ModelKind): LoomConfig => ({
  configVersion: 1,
  modelId,
  modelKind,
  model: MODEL_FILE,
  projectionProfile: 'none',
  scope: { workspace: ['.'] },
  outputs: {},
  gates: {},
});

export const scaffoldState = (): WorkflowState => ({ stateVersion: 1, phase: 'unplanned', sealed: false });

/** What init installs and the filesystem steps that install it; a test replaces one to force the failure init must survive. */
export interface InitSteps {
  scaffold(modelId: string, modelKind: ModelKind): { model: Model; config: LoomConfig; state: WorkflowState };
  /** Creates an empty staging directory inside `parent` and returns its path. */
  stage(parent: string): string;
  write(path: string, text: string): void;
  /** Renames the staging directory to the .loom path. */
  install(staging: string, loomDir: string): void;
  discard(staging: string): void;
}

export const INIT_STEPS: InitSteps = {
  scaffold: (modelId, modelKind) => ({ model: scaffoldModel(), config: scaffoldConfig(modelId, modelKind), state: scaffoldState() }),
  stage: (parent) => mkdtempSync(join(parent, '.loom-staging-')),
  write: (path, text) => writeFileSync(path, text),
  install: (staging, loomDir) => renameSync(staging, loomDir),
  discard: (staging) => rmSync(staging, { recursive: true, force: true }),
};

export interface InitOptions {
  /** Restore missing non-authoritative scaffolding (.gitignore) in an existing .loom; never replaces an authority file. */
  force?: boolean;
  boundary?: string;
  /** The declared stable model identity. Product code invents no default. */
  modelId: string;
  modelKind: ModelKind;
}

const result = (findings: Finding[], data: { written: string[] }, model: Model | null, refused?: { cause: 'invalid-input' | 'unresolved-context' | 'unmet-prerequisite' | 'policy-failure' | 'stale-base'; message: string }): ResultEnvelope =>
  envelope('workspace.init', { model, findings, data, ...(refused ? { refusal: refusal(refused.cause, refused.message) } : {}) });

/** Disjointness of the proposed scope against every readable descriptor; an unreadable one makes disjointness unverifiable. */
export function overlapWith(proposedRoot: string, others: readonly Descriptor[]): Finding[] {
  const out: Finding[] = [];
  const proposed = realPathOf(proposedRoot);
  for (const d of others) {
    if (!d.readable) {
      out.push(finding('DESCRIPTOR_UNREADABLE', d.location, `descriptor ${d.location} cannot be read, so disjointness of the proposed scope cannot be verified`, `repair ${d.location}, then run init again`));
      continue;
    }
    const hit = d.claims.find((c) => containsPath(c.real, proposed) || containsPath(proposed, c.real));
    if (hit) {
      out.push(finding('SCOPE_OVERLAP', d.location, `the proposed scope '.' overlaps '${hit.rel}' claimed by '${hit.component}' in ${d.location}`, `narrow the scope in ${d.location} or initialize the owning model instead`));
    }
  }
  return out;
}

/**
 * Initialize .loom at a repository root. The candidate is validated and staged
 * in a sibling directory, then renamed into place, so a failure never leaves an
 * apparently initialized workspace behind. Init writes no acceptance, evidence
 * or phase completion, never touches a child repository, and never stages or
 * commits: the four files are left for their owner to review and track.
 */
export function initWorkspace(cwd: string, options: InitOptions, steps: InitSteps = INIT_STEPS): ResultEnvelope {
  const dir = resolve(cwd);
  const repoRoot = findRepositoryRoot(dir);
  if (!repoRoot || !samePath(repoRoot, dir)) {
    const where = repoRoot ? `the repository root is '${relativeTo(dir, repoRoot)}' relative to it` : 'it is not inside a Git repository';
    return result([finding('INIT_NOT_REPOSITORY_ROOT', '.', `init must run at a repository root; ${where}`, repoRoot ? `run init in '${relativeTo(dir, repoRoot)}'` : 'run init at the root of the repository that owns the code')], { written: [] }, null, { cause: 'invalid-input', message: 'not a repository root' });
  }
  const loomDir = join(dir, LOOM_DIR);
  if (existsSync(loomDir)) return reinit(dir, loomDir, options);

  const { model, config, state } = steps.scaffold(options.modelId, options.modelKind);
  const findings: Finding[] = [];
  findings.push(...validate(model).filter((f) => f.severity === 'error'));
  for (const e of schemaErrors('LoomConfig', config)) findings.push(finding('CONFIG_INVALID', `${LOOM_DIR}/${CONFIG_FILE}#${e.pointer}`, e.message, 'correct the scaffold'));
  for (const e of schemaErrors('WorkflowState', state)) findings.push(finding('CONFIG_INVALID', `${LOOM_DIR}/${STATE_FILE}#${e.pointer}`, e.message, 'correct the scaffold'));
  findings.push(...checkConfig(config, model, state, dir).findings);

  const boundary = findBoundary(dir, options.boundary);
  const ancestors = containsPath(boundary, dir) && !samePath(boundary, dir) ? ancestorDescriptors(join(dir, '..'), boundary) : [];
  const descendants = discoverAll(dir, { cacheDir: null }).descriptors.filter((d) => !samePath(d.home, dir));
  findings.push(...overlapWith(dir, [...ancestors, ...descendants]));
  if (hasErrors(findings)) return result(findings, { written: [] }, model, { cause: findings.some((f) => f.code === 'SCOPE_OVERLAP' || f.code === 'DESCRIPTOR_UNREADABLE' || f.code === 'CHECKOUT_MISSING') ? 'policy-failure' : 'invalid-input', message: 'the scaffold was not installed' });

  let staging: string | undefined;
  try {
    staging = steps.stage(dir);
    steps.write(join(staging, MODEL_FILE), documentText(model));
    steps.write(join(staging, CONFIG_FILE), documentText(config));
    steps.write(join(staging, STATE_FILE), documentText(state));
    steps.write(join(staging, GITIGNORE), GITIGNORE_TEXT);
    steps.install(staging, loomDir);
  } catch (err) {
    let left = '';
    if (staging !== undefined) {
      try {
        steps.discard(staging);
      } catch (discardErr) {
        left = `; the staging directory ${toPosix(relativeTo(dir, staging))} could not be removed: ${(discardErr as Error).message}`;
      }
    }
    return result([finding('INIT_REPAIR_REQUIRED', LOOM_DIR, `installing the scaffold failed: ${(err as Error).message}${left}`, 'resolve the filesystem error and run init again')], { written: [] }, model, { cause: 'unresolved-context', message: 'installation failed; nothing was installed' });
  }
  const written = [MODEL_FILE, CONFIG_FILE, STATE_FILE, GITIGNORE].map((f) => `${LOOM_DIR}/${f}`);
  return envelope('workspace.init', { model, findings, data: { written }, revisions: revisionsOf(model) });
}

/** An existing .loom: refused, or under force restore only the non-authoritative .gitignore. */
function reinit(dir: string, loomDir: string, options: InitOptions): ResultEnvelope {
  if (!options.force) {
    return result([finding('INIT_ALREADY_INITIALIZED', LOOM_DIR, `${LOOM_DIR} already exists in '${toPosix(dir)}'; nothing was changed`, 'edit the existing workspace files instead')], { written: [] }, null, { cause: 'invalid-input', message: '.loom already exists' });
  }
  const problems: Finding[] = [];
  const config = readConfig(loomDir);
  problems.push(...config.findings);
  let model: Model | null = null;
  if (config.value) {
    const m = readModelDocument(join(loomDir, ...config.value.model.split('/')), `${LOOM_DIR}/${config.value.model}`);
    model = m.value;
    problems.push(...m.findings);
  }
  problems.push(...readState(loomDir).findings);
  if (hasErrors(problems)) {
    const repairs = problems.map((p) => finding('INIT_REPAIR_REQUIRED', p.path, `authority file needs repair by its owner: ${p.message}`, 'repair or restore the file from version control; init never invents an authority file'));
    return result(repairs, { written: [] }, model, { cause: 'unmet-prerequisite', message: 'authority files are incomplete' });
  }
  const written: string[] = [];
  if (!existsSync(join(loomDir, GITIGNORE))) {
    writeFileSync(join(loomDir, GITIGNORE), GITIGNORE_TEXT);
    written.push(`${LOOM_DIR}/${GITIGNORE}`);
  }
  return envelope('workspace.init', { model, findings: [], data: { written } });
}
