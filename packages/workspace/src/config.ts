import { join } from 'node:path';
import { PROJECTION_PROFILES, schemaErrors, structuralFindings } from '@loom/core';
import type { Finding, LoomConfig, Model, WorkflowState } from '@loom/core';
import { finding, hasErrors, type Outcome } from './findings.js';
import { readJson, toPosix } from './fsx.js';
import { containsPath, resolveRoot, type ResolvedRoot } from './paths.js';

export const LOOM_DIR = '.loom';
export const CONFIG_FILE = 'loom.json';
export const STATE_FILE = 'state.json';
export const CACHE_DIR = 'cache';

export const loomDirOf = (root: string): string => join(root, LOOM_DIR);

const pointer = (file: string, p: string): string => `${file}#${p || '/'}`;

export function readConfig(loomDir: string): Outcome<LoomConfig> {
  const at = `${LOOM_DIR}/${CONFIG_FILE}`;
  const r = readJson(join(loomDir, CONFIG_FILE));
  if (!r.ok) return { value: null, findings: [finding('CONFIG_INVALID', at, `${at} ${r.error}`, `create ${at} or run init at the repository root`)] };
  const errs = schemaErrors('LoomConfig', r.value);
  if (errs.length) {
    return { value: null, findings: errs.map((e) => finding('CONFIG_INVALID', pointer(at, e.pointer), `${at}${e.pointer || ''}: ${e.message}`, 'correct the value to satisfy the loom.json contract')) };
  }
  return { value: r.value as LoomConfig, findings: [] };
}

export function readModelDocument(path: string, at: string): Outcome<Model> {
  const r = readJson(path);
  if (!r.ok) {
    return {
      value: null,
      findings: [r.missing
        ? finding('CONFIG_MODEL_MISSING', at, `the configured model ${at} does not exist`, 'restore the model document or correct loom.json "model"')
        : finding('STRUCTURAL_INVALID', at, `${at} ${r.error}`, 'repair the model document')],
    };
  }
  const structural = structuralFindings(r.value);
  if (structural.length) return { value: null, findings: structural.map((f) => ({ ...f, path: `${at}#${f.path === '(root)' ? '/' : f.path}` })) };
  return { value: r.value as Model, findings: [] };
}

export function readState(loomDir: string): Outcome<WorkflowState> {
  const at = `${LOOM_DIR}/${STATE_FILE}`;
  const r = readJson(join(loomDir, STATE_FILE));
  if (!r.ok) return { value: null, findings: [finding('CONFIG_INVALID', at, `${at} ${r.error}`, `restore ${at}; it records workflow state only`)] };
  const errs = schemaErrors('WorkflowState', r.value);
  if (errs.length) return { value: null, findings: errs.map((e) => finding('CONFIG_INVALID', pointer(at, e.pointer), `${at}${e.pointer}: ${e.message}`, 'correct the value to satisfy the state.json contract')) };
  return { value: r.value as WorkflowState, findings: [] };
}

export const profileOf = (config: LoomConfig): string => config.projectionProfile ?? 'none';

/**
 * Checks that bind loom.json to its model and state: the projection profile,
 * the gate binding a planned workspace needs, every scope component id, every
 * scope root, and disjoint component roots. Overlapping component roots are
 * rejected rather than resolved by the longest prefix, because ownership must
 * have one answer that does not depend on which root is more specific.
 */
export function checkConfig(config: LoomConfig, model: Model, state: WorkflowState | null, repoRoot: string): { roots: ResolvedRoot[]; findings: Finding[] } {
  const at = `${LOOM_DIR}/${CONFIG_FILE}`;
  const findings: Finding[] = [];
  const profile = profileOf(config);
  if (!PROJECTION_PROFILES.some((p) => p.id === profile)) {
    findings.push(finding('CONFIG_PROFILE_UNKNOWN', pointer(at, '/projectionProfile'), `projection profile '${profile}' is not defined`, `use one of ${PROJECTION_PROFILES.map((p) => p.id).join(', ')}`));
  }
  const unplanned = state === null || state.phase === 'unplanned';
  if (!unplanned && profile === 'none') {
    findings.push(finding('CONFIG_PROFILE_NOT_PERMITTED', pointer(at, '/projectionProfile'), `profile 'none' is permitted only while the workspace is unplanned; the phase is '${state?.phase}'`, 'select a projection profile that enables the artifacts this phase needs'));
  }
  if (!unplanned && !config.gates.policyRef) {
    findings.push(finding('CONFIG_PROFILE_NOT_PERMITTED', pointer(at, '/gates'), `a ${state?.phase} workspace binds gates.policyRef; empty gates are permitted only while unplanned`, 'bind gates.policyRef to the trusted policy'));
  }
  const components = new Set(model.components.map((c) => c.id));
  const roots: ResolvedRoot[] = [];
  for (const [component, rels] of Object.entries(config.scope)) {
    if (!components.has(component)) {
      findings.push(finding('SCOPE_COMPONENT_UNKNOWN', pointer(at, `/scope/${component}`), `scope names component '${component}', which the model does not declare`, 'add the component to the model or remove it from the scope', [{ kind: 'component', id: component }]));
    }
    (rels ?? []).forEach((rel, i) => {
      const r = resolveRoot(repoRoot, rel, component, pointer(at, `/scope/${component}/${i}`));
      findings.push(...r.findings);
      if (r.root) roots.push(r.root);
    });
  }
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i] as ResolvedRoot;
      const b = roots[j] as ResolvedRoot;
      if (a.component === b.component) continue;
      if (containsPath(a.real, b.real) || containsPath(b.real, a.real)) {
        findings.push(finding(
          'SCOPE_COMPONENT_ROOT_OVERLAP',
          pointer(at, '/scope'),
          `root '${a.rel}' of '${a.component}' and root '${b.rel}' of '${b.component}' overlap`,
          'narrow the roots so each governed path has exactly one owning component',
          [{ kind: 'component', id: a.component }, { kind: 'component', id: b.component }],
        ));
      }
    }
  }
  return { roots, findings };
}

export interface Workspace {
  /** Directory that holds .loom; the repository root the descriptor governs. */
  root: string;
  loomDir: string;
  config: LoomConfig;
  model: Model;
  modelPath: string;
  state: WorkflowState | null;
  roots: ResolvedRoot[];
}

/** Load and cross-check the descriptor, model and state of the .loom in `root`. */
export function openWorkspace(root: string): Outcome<Workspace> {
  const loomDir = loomDirOf(root);
  const config = readConfig(loomDir);
  if (!config.value) return { value: null, findings: config.findings };
  const modelPath = join(loomDir, ...toPosix(config.value.model).split('/'));
  const model = readModelDocument(modelPath, `${LOOM_DIR}/${toPosix(config.value.model)}`);
  if (!model.value) return { value: null, findings: [...config.findings, ...model.findings] };
  const state = readState(loomDir);
  const checked = checkConfig(config.value, model.value, state.value, root);
  const findings = [...config.findings, ...model.findings, ...state.findings, ...checked.findings];
  return {
    value: { root, loomDir, config: config.value, model: model.value, modelPath, state: state.value, roots: checked.roots },
    findings,
  };
}

export const workspaceUsable = (o: Outcome<Workspace>): boolean => o.value !== null && !hasErrors(o.findings);
