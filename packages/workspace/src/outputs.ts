import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONTRACT_DIGEST, LoomInvalidModelError, PROJECTION_PROFILES, PROJECTION_TARGETS, canonicalHash, envelope, modelRevision, renderTarget, textHash } from '@loom/core';
import type { EvaluationInputs, Finding, InstallJournal, ManifestArtifact, OutputManifest, ProjectionTarget, ResultEnvelope } from '@loom/core';
import { CACHE_DIR, LOOM_DIR, profileOf, type Workspace } from './config.js';
import { ancestorDescriptors, readDescriptor } from './discover.js';
import { finding, hasErrors, refusal } from './findings.js';
import { documentText, readJson, toPosix, writeFileAtomic } from './fsx.js';
import { containsPath, isCaseSensitive, normalizeRelative, realPathOf, relativePathProblem, segmentsOf, samePath } from './paths.js';
import { findBoundary } from './repo.js';
import { ENGINE_VERSION } from './version.js';
import { checkFederation, compositionModels } from './composition.js';

export const MANIFEST_FILE = 'manifest.json';
export const JOURNAL_FILE = 'install-journal.json';
/** Explicit members, ancestors and their output claims; never scan unrelated source trees. */
function outputDescriptors(ws: Workspace) {
  const boundary=findBoundary(ws.root), descriptors=ancestorDescriptors(ws.root,boundary), seen=new Set<string>();
  const visit=(home:string,depth:number):void=>{const real=realPathOf(home);if(seen.has(real)||depth>32)return;seen.add(real);const d=readDescriptor(home,boundary);if(!descriptors.some(other=>samePath(other.home,home)))descriptors.push(d);for(const member of d.config?.composition?.members??[]){if(relativePathProblem(member.repositoryPath))continue;const child=join(home,...member.repositoryPath.split('/'));if(containsPath(real,realPathOf(child))&&!samePath(child,home)&&existsSync(join(child,LOOM_DIR)))visit(child,depth+1);}};
  for(const descriptor of [...descriptors])visit(descriptor.home,0);visit(ws.root,0);return descriptors;
}
const STAGED_SUFFIX = '.loom-staged';
const DEFAULT_OUTPUT_DIR = 'Docs/Loom';

/** The two filesystem operations installation performs on a planned artifact's path. A test replaces one to plant a link or reparse point between planning and the operation it guards, forcing the recheck that must catch it. */
export interface OutputSteps {
  write(path: string, content: string): void;
  rename(from: string, to: string): void;
}

export const OUTPUT_STEPS: OutputSteps = {
  write: (path, content) => writeFileSync(path, content),
  rename: (from, to) => renameSync(from, to),
};

export interface PlannedArtifact {
  instance: string;
  target: ProjectionTarget;
  file: string;
  component?: string;
  /** Repository-relative installed path. */
  path: string;
  abs: string;
  content: string;
  hash: string;
  draft: boolean;
}

export interface BundlePlan {
  artifacts: PlannedArtifact[];
  manifest: OutputManifest;
  findings: Finding[];
}

export interface OutputOptions {
  /** Targets to render instead of the projection profile's set. */
  targets?: ProjectionTarget[];
  draft?: boolean;
  /** Baselines, acceptance, evidence and policy for the views that report readiness and evidence; without them those views say they were not evaluated. */
  inputs?: EvaluationInputs;
}

/** The targets the configured projection profile enables; selection, never routing, decides this list. */
export function enabledTargets(ws: Workspace): ProjectionTarget[] {
  const profile = PROJECTION_PROFILES.find((p) => p.id === profileOf(ws.config));
  return profile ? [...profile.enables] : [];
}

const fold = (p: string, sensitive: boolean): string => (sensitive ? p : p.toLowerCase());
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

export const manifestPath = (ws: Workspace): string => join(ws.loomDir, MANIFEST_FILE);
export const journalPath = (ws: Workspace): string => join(ws.loomDir, CACHE_DIR, JOURNAL_FILE);

export function readManifest(path: string): OutputManifest | null {
  const r = readJson(path);
  return r.ok ? (r.value as OutputManifest) : null;
}

/**
 * Render every enabled artifact, route each instance to one destination and
 * check the destinations. Rendering is complete before any check, and
 * installation uses only a plan with no error, so a failure is found before a
 * single file is written. `install` adds the overwrite protections: nothing
 * under .loom, nothing another model's manifest lists, and no existing file
 * this model's manifest does not already list (source code and hand-authored
 * files are never overwritten).
 */
export function planOutputs(ws: Workspace, options: OutputOptions & { install?: boolean; allowPaths?: readonly string[] } = {}): BundlePlan {
  const findings: Finding[] = [];
  const artifacts: PlannedArtifact[] = [];
  const targets = options.targets ?? enabledTargets(ws);
  const sensitive = isCaseSensitive(ws.root);
  const rootReal = realPathOf(ws.root);
  if(ws.config.composition?.members.length&&!options.inputs?.composition){const checked=checkFederation(ws.root),models=compositionModels(ws.root);if(checked.data)options={...options,inputs:{...options.inputs,composition:{models:models.models.map(m=>({modelId:m.modelId,model:m.model})),snapshotDigest:checked.data.snapshotDigest}}};}
  for (const target of targets) {
    if (!PROJECTION_TARGETS.includes(target)) {
      findings.push(finding('PROJECTION_INVALID', target, `enabled target '${target}' is not rendered by this engine`, 'select a profile whose targets this engine renders'));
      continue;
    }
    let rendered;
    try {
      rendered = renderTarget(ws.model, target, options.inputs ? { draft: options.draft === true, inputs: options.inputs } : { draft: options.draft === true });
    } catch (err) {
      if (err instanceof LoomInvalidModelError) {
        findings.push(...err.findings);
        continue;
      }
      throw err;
    }
    findings.push(...rendered.findings);
    for (const f of rendered.files) {
      const mapped = ws.config.outputs[f.instance] ?? (f.component ? undefined : ws.config.outputs[f.file]);
      const dir = mapped ?? (f.component ? `${DEFAULT_OUTPUT_DIR}/${f.component}` : DEFAULT_OUTPUT_DIR);
      const problem = relativePathProblem(dir);
      if (problem) {
        findings.push(finding('OUTPUT_OUTSIDE_WORKSPACE', `${LOOM_DIR}/loom.json#/outputs/${f.instance}`, `output directory '${dir}' for ${f.instance} ${problem}`, 'route the artifact to a repository-relative directory'));
        continue;
      }
      const path = normalizeRelative(`${dir}/${f.file}`);
      const abs = join(ws.root, ...path.split('/'));
      if (!containsPath(rootReal, realPathOf(abs), sensitive)) {
        findings.push(finding('OUTPUT_OUTSIDE_WORKSPACE', path, `${f.instance} resolves outside the workspace through a link or junction`, 'route the artifact to a directory whose real path stays inside the workspace'));
        continue;
      }
      const a: PlannedArtifact = { instance: f.instance, target, file: f.file, path, abs, content: f.content, hash: f.hash, draft: rendered.draft };
      if (f.component) a.component = f.component;
      artifacts.push(a);
    }
  }

  findings.push(...collisionFindings(artifacts, sensitive));

  if (options.install) {
    const own = readManifest(manifestPath(ws));
    // Files an earlier, interrupted installation of this model already replaced are its own, though no manifest lists them yet.
    const journal = readJson(journalPath(ws));
    const journaled = journal.ok ? (journal.value as InstallJournal).entries.map((e) => e.path) : [];
    const listed = new Set([...(own?.artifacts ?? []).map((m) => m.path), ...journaled, ...(options.allowPaths ?? [])].map((p) => fold(p, sensitive)));
    const boundary = findBoundary(ws.root);
    for (const a of artifacts) {
      if (segmentsOf(a.path).includes(LOOM_DIR)) {
        findings.push(finding('OUTPUT_PROTECTED_TARGET', a.path, `${a.instance} would write inside a .loom directory, which holds authority files`, 'route the artifact outside .loom'));
        continue;
      }
      const owner = [...ancestorDescriptors(dirname(a.abs), boundary),...outputDescriptors(ws)].find((d) => {
        if (samePath(d.home, ws.root)) return false;
        if((d.config?.composition?.outputClaims??[]).some(root=>containsPath(realPathOf(join(d.home,...root.split('/'))),realPathOf(a.abs))))return true;
        const theirs = readManifest(join(d.loomDir, MANIFEST_FILE));
        return theirs?.artifacts.some((m) => samePath(join(d.home, ...m.path.split('/')), a.abs)) ?? false;
      });
      if (owner) {
        findings.push(finding('OUTPUT_COLLISION', a.path, `'${a.path}' is a generated artifact of the model at ${toPosix(owner.location)}`, 'route the artifact to a destination no other model owns'));
        continue;
      }
      if (existsSync(a.abs) && !listed.has(fold(a.path, sensitive))) {
        findings.push(finding('OUTPUT_PROTECTED_TARGET', a.path, `${a.instance} would overwrite '${a.path}', which this model's manifest does not list`, 'route the artifact elsewhere, or remove the existing file if it is a stale generated copy'));
      }
    }
  }

  const profile = PROJECTION_PROFILES.find((p) => p.id === profileOf(ws.config));
  const manifestArtifacts: ManifestArtifact[] = artifacts
    .map((a) => {
      const m: ManifestArtifact = { instance: a.instance, target: a.target, file: a.file, path: a.path, required: true, draft: a.draft, hash: a.hash };
      if (a.component) m.component = a.component;
      return m;
    })
    .sort((x, y) => (x.instance < y.instance ? -1 : x.instance > y.instance ? 1 : 0));
  const manifest: OutputManifest = {
    manifestVersion: 1,
    model: { hash: modelRevision(ws.model) },
    config: { hash: canonicalHash(ws.config) },
    profile: { id: profileOf(ws.config), version: profile?.version ?? 1, enables: [...(options.targets ?? profile?.enables ?? [])] },
    generator: { version: ENGINE_VERSION, contractDigest: CONTRACT_DIGEST },
    artifacts: manifestArtifacts,
  };
  return { artifacts, manifest, findings };
}

/** Two artifact instances resolving to one file, compared under the volume's case rules. */
export function collisionFindings(artifacts: readonly { instance: string; path: string }[], caseSensitive: boolean): Finding[] {
  const byPath = new Map<string, { instance: string; path: string }[]>();
  for (const a of artifacts) {
    const k = fold(a.path, caseSensitive);
    byPath.set(k, [...(byPath.get(k) ?? []), a]);
  }
  return [...byPath.values()]
    .filter((group) => group.length > 1)
    .map((group) => finding('OUTPUT_COLLISION', group[0]?.path ?? '', `${group.map((g) => g.instance).join(' and ')} resolve to one file '${group[0]?.path}'`, 'route each artifact instance to its own destination'));
}

export interface OutputStatus {
  instance: string;
  path: string;
  status: 'current' | 'drift' | 'missing';
}

/**
 * Drift check: every enabled artifact against its mapped destination (bytes
 * compared after folding CRLF to LF), the manifest against a fresh render, and
 * any installation the journal shows as unfinished. It never writes.
 */
export function checkOutputs(ws: Workspace, options: OutputOptions = {}): { findings: Finding[]; artifacts: OutputStatus[]; manifest: OutputManifest } {
  const plan = planOutputs(ws, options);
  const findings = [...plan.findings];
  const artifacts: OutputStatus[] = [];
  for (const a of plan.artifacts) {
    if (!existsSync(a.abs)) {
      artifacts.push({ instance: a.instance, path: a.path, status: 'missing' });
      findings.push(finding('OUTPUT_MISSING', a.path, `${a.instance} is not installed at '${a.path}'`, 'install the outputs'));
      continue;
    }
    const current = lf(readFileSync(a.abs, 'utf8'));
    if (current !== a.content) {
      artifacts.push({ instance: a.instance, path: a.path, status: 'drift' });
      findings.push(finding('OUTPUT_DRIFT', a.path, `${a.instance} at '${a.path}' differs from a fresh projection`, 'edit the model, never the generated file, and install the outputs again'));
      continue;
    }
    artifacts.push({ instance: a.instance, path: a.path, status: 'current' });
  }
  const stored = readManifest(manifestPath(ws));
  if (!stored) {
    findings.push(finding('MANIFEST_MISSING', `${LOOM_DIR}/${MANIFEST_FILE}`, 'the output manifest is missing', 'install the outputs so the manifest records the bundle'));
  } else {
    const parts = (['model', 'config', 'profile', 'generator', 'artifacts'] as const).filter((k) => canonicalHash(stored[k]) !== canonicalHash(plan.manifest[k]));
    if (parts.length) {
      findings.push(finding('MANIFEST_STALE', `${LOOM_DIR}/${MANIFEST_FILE}`, `the output manifest is stale in: ${parts.join(', ')}`, 'install the outputs again from the current model and configuration'));
    }
  }
  findings.push(...journalFindings(ws));
  return { findings, artifacts, manifest: plan.manifest };
}

function journalFindings(ws: Workspace): Finding[] {
  const r = readJson(journalPath(ws));
  if (!r.ok) return [];
  const journal = r.value as InstallJournal;
  if (journal.state === 'complete') return [];
  const open = journal.entries.filter((e) => e.status !== 'installed').map((e) => e.path);
  return [finding('INSTALL_INCOMPLETE', `${LOOM_DIR}/${CACHE_DIR}/${JOURNAL_FILE}`, `an installation is '${journal.state}' with ${open.length} file(s) not installed: ${open.join(', ')}`, 'run the installation again to complete or replace the bundle')];
}

const writeJournal = (ws: Workspace, journal: InstallJournal): void => writeFileAtomic(journalPath(ws), documentText(journal));

/**
 * Install the bundle: stage every file beside its destination, then replace
 * each destination atomically while the journal records progress, and write
 * the manifest last. Atomicity is per file; a multi-repository bundle that
 * fails part-way stays visibly incomplete in the journal and the manifest, and
 * no commit or gitlink update is ever made. Every write and rename target's
 * real-path containment is rechecked immediately before the operation: a link
 * or reparse point swapped in since planning must not redirect a write outside
 * the workspace it was planned against.
 */
export function installOutputs(ws: Workspace, options: OutputOptions & { allowPaths?: readonly string[] } = {}, steps: OutputSteps = OUTPUT_STEPS): ResultEnvelope {
  const plan = planOutputs(ws, { ...options, install: true });
  if (hasErrors(plan.findings)) {
    return envelope('workspace.installOutputs', { model: ws.model, findings: plan.findings, data: { installed: [] }, refusal: refusal('policy-failure', 'the bundle failed its checks; nothing was written') });
  }
  const rootReal = realPathOf(ws.root);
  const sensitive = isCaseSensitive(ws.root);
  const stillContained = (abs: string): boolean => containsPath(rootReal, realPathOf(abs), sensitive);
  const journal: InstallJournal = {
    journalVersion: 1,
    bundle: canonicalHash(plan.manifest),
    state: 'staged',
    entries: plan.artifacts.map((a) => ({ path: a.path, hash: a.hash, previousHash: existsSync(a.abs) ? textHash(lf(readFileSync(a.abs, 'utf8'))) : null, status: 'pending' })),
  };
  mkdirSync(join(ws.loomDir, CACHE_DIR), { recursive: true });
  writeJournal(ws, journal);
  const staged: string[] = [];
  const cleanup = (): void => staged.forEach((s) => rmSync(s, { force: true }));
  const redirected = (a: PlannedArtifact): ResultEnvelope => {
    journal.state = 'failed';
    writeJournal(ws, journal);
    cleanup();
    const f = finding('WRITE_OUTSIDE_WORKSPACE', a.path, `${a.instance} no longer resolves inside the workspace at '${a.path}'; a link or reparse point redirected it after it was planned`, 'repair or remove the link, then install the outputs again');
    return envelope('workspace.installOutputs', {
      model: ws.model,
      findings: [...plan.findings, f, ...journalFindings(ws)],
      data: { installed: journal.entries.filter((e) => e.status === 'installed').map((e) => e.path) },
      refusal: refusal('policy-failure', `the write target for '${a.path}' no longer resolves inside the workspace; nothing further was written`),
    });
  };
  try {
    for (const a of plan.artifacts) {
      if (!stillContained(a.abs)) return redirected(a);
      mkdirSync(dirname(a.abs), { recursive: true });
      steps.write(`${a.abs}${STAGED_SUFFIX}`, a.content);
      staged.push(`${a.abs}${STAGED_SUFFIX}`);
    }
    journal.state = 'installing';
    writeJournal(ws, journal);
    for (let i = 0; i < plan.artifacts.length; i++) {
      const a = plan.artifacts[i] as PlannedArtifact;
      const entry = journal.entries[i] as InstallJournal['entries'][number];
      if (!stillContained(a.abs)) return redirected(a);
      try {
        steps.rename(`${a.abs}${STAGED_SUFFIX}`, a.abs);
      } catch (err) {
        entry.status = 'failed';
        throw err;
      }
      entry.status = 'installed';
      writeJournal(ws, journal);
    }
  } catch (err) {
    journal.state = 'failed';
    writeJournal(ws, journal);
    cleanup();
    return envelope('workspace.installOutputs', {
      model: ws.model,
      findings: [...plan.findings, ...journalFindings(ws)],
      data: { installed: journal.entries.filter((e) => e.status === 'installed').map((e) => e.path), error: (err as Error).message },
      refusal: refusal('unresolved-context', `installation stopped: ${(err as Error).message}`),
    });
  }
  writeFileAtomic(manifestPath(ws), documentText(plan.manifest));
  journal.state = 'complete';
  writeJournal(ws, journal);
  return envelope('workspace.installOutputs', { model: ws.model, findings: plan.findings, data: { installed: plan.artifacts.map((a) => a.path), manifest: plan.manifest } });
}

/**
 * Resume an unfinished installation when the current inputs render the same
 * bundle the journal records; otherwise report it, because the files already
 * replaced belong to a bundle that can no longer be completed as recorded.
 */
export function recoverInstall(ws: Workspace, options: OutputOptions = {}): ResultEnvelope {
  const r = readJson(journalPath(ws));
  if (!r.ok || (r.value as InstallJournal).state === 'complete') {
    return envelope('workspace.recoverInstall', { model: ws.model, findings: [], data: { recovered: false } });
  }
  const journal = r.value as InstallJournal;
  for (const e of journal.entries) rmSync(join(ws.root, ...e.path.split('/')) + STAGED_SUFFIX, { force: true });
  const plan = planOutputs(ws, options);
  if (canonicalHash(plan.manifest) !== journal.bundle) {
    return envelope('workspace.recoverInstall', {
      model: ws.model,
      findings: journalFindings(ws),
      data: { recovered: false },
      refusal: refusal('stale-base', 'the inputs changed since the interrupted installation; install the current bundle instead'),
    });
  }
  const done = installOutputs(ws, { ...options, allowPaths: journal.entries.map((e) => e.path) });
  return envelope('workspace.recoverInstall', { model: ws.model, findings: done.findings, data: { recovered: done.outcome === 'ok' }, ...(done.refusal ? { refusal: done.refusal } : {}) });
}
