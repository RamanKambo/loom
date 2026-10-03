import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_DIGEST, PROJECTION_PROFILES, canonicalHash, modelRevision, recordHash, schemaErrors } from '@loom/core';
import type { Acceptance, Baseline, Finding, Model, Policy, RecordRef } from '@loom/core';
import { LOOM_DIR, openWorkspace, profileOf } from './config.js';
import { finding, hasErrors } from './findings.js';
import { documentText } from './fsx.js';
import { manifestPath, readManifest } from './outputs.js';
import { pinRevisionSet, readPolicy, resolveTrustedRef } from './trust.js';
import { ENGINE_VERSION } from './version.js';

export const BASELINES_DIR = 'baselines';
export const ACCEPTANCE_DIR = 'acceptance';

export interface CreateBaselineOptions {
  id: string;
  /** Id of the acceptance record that accepts this baseline. */
  acceptance: string;
  predecessor?: string;
  /** The trusted policy; read from the trusted ref when omitted. */
  policy?: Policy;
  trustedRef?: string;
  /** Freeze every component; defaults to the policy's freeze-on-acceptance rule. */
  frozen?: boolean;
  commitments?: Baseline['commitments'];
}

/** Collections whose records name an owning component. */
const OWNED: readonly (keyof Model)[] = ['types', 'operations', 'routines', 'mutations', 'storage', 'mappings'];

function ownedBy(model: Model, component: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const c of OWNED) out[c] = (model[c] as { owner?: string }[]).filter((r) => r.owner === component);
  return out;
}

export type RecordOutcome<T> = { value: T | null; findings: Finding[]; refused?: string };

/**
 * Write a baseline record and the canonical snapshot it pins. Creating the
 * files grants nothing: a baseline counts as accepted only once it is
 * committed at the trusted ref and its acceptance record is trusted there or
 * signed under a key the trusted policy lists.
 */
export function createBaseline(root: string, options: CreateBaselineOptions): RecordOutcome<Baseline> {
  const ws = openWorkspace(root);
  if (!ws.value || hasErrors(ws.findings)) return { value: null, findings: ws.findings, refused: 'the workspace does not validate' };
  const { config, model, loomDir } = ws.value;
  let policy = options.policy ?? null;
  const findings: Finding[] = [];
  if (!policy && config.gates.policyRef) {
    const ref = resolveTrustedRef(root, options.trustedRef);
    findings.push(...ref.findings);
    if (ref.ref) {
      const p = readPolicy(root, config.gates.policyRef, ref.ref);
      findings.push(...p.findings);
      policy = p.policy;
    }
  }
  if (!policy) return { value: null, findings: [...findings, finding('POLICY_UNRESOLVED', `${LOOM_DIR}/loom.json#/gates/policyRef`, 'a baseline records the trusted policy it was accepted under, and none resolves', 'bind gates.policyRef and commit the policy at the trusted ref')], refused: 'no trusted policy' };
  const recordFile = join(loomDir, BASELINES_DIR, `${options.id}.json`);
  const snapshotRel = `${BASELINES_DIR}/${options.id}.model.json`;
  if (existsSync(recordFile) || existsSync(join(loomDir, ...snapshotRel.split('/')))) return { value: null, findings, refused: `baseline '${options.id}' already exists; baselines are never rewritten` };
  const frozen = options.frozen ?? policy.freeze?.onAcceptance ?? false;
  const contracts: Baseline['contracts'] = [];
  for (const [kind, list] of [['type', model.types], ['operation', model.operations], ['routine', model.routines]] as const) {
    for (const r of list) {
      const ref: RecordRef = { kind, id: r.id };
      contracts.push({ ref, version: r.version, hash: recordHash(model, ref) as string });
    }
  }
  const manifest = readManifest(manifestPath(ws.value));
  const profile = PROJECTION_PROFILES.find((p) => p.id === profileOf(config));
  const baseline: Baseline = {
    baselineVersion: 1,
    id: options.id,
    model: { hash: modelRevision(model), formatVersion: model.version, snapshot: snapshotRel },
    config: { hash: canonicalHash(config), configVersion: config.configVersion },
    policy: { ref: policy.id, revision: policy.revision, hash: canonicalHash(policy) },
    profile: { id: profileOf(config), version: profile?.version ?? 1 },
    generator: { version: ENGINE_VERSION, contractDigest: CONTRACT_DIGEST },
    contracts,
    components: model.components.map((c) => ({ id: c.id, hash: canonicalHash(ownedBy(model, c.id)), frozen })),
    artifacts: (manifest?.artifacts ?? []).map((a) => ({ instance: a.instance, hash: a.hash })),
    sources: pinRevisionSet(root).sources,
    commitments: options.commitments ?? [],
    acceptance: options.acceptance,
  };
  if (options.predecessor) baseline.predecessor = options.predecessor;
  const errs = schemaErrors('Baseline', baseline);
  if (errs.length) return { value: null, findings: errs.map((e) => finding('STRUCTURAL_INVALID', `${LOOM_DIR}/${BASELINES_DIR}/${options.id}.json#${e.pointer}`, e.message, 'correct the baseline inputs')), refused: 'the baseline does not satisfy its contract' };
  mkdirSync(join(loomDir, BASELINES_DIR), { recursive: true });
  writeFileSync(join(loomDir, ...snapshotRel.split('/')), documentText(model), { flag: 'wx' });
  writeFileSync(recordFile, documentText(baseline), { flag: 'wx' });
  return { value: baseline, findings };
}

/** Write an acceptance record. It is a claim until committed at the trusted ref or signed under a listed key. */
export function createAcceptance(root: string, record: Acceptance): RecordOutcome<Acceptance> {
  const rel = `${LOOM_DIR}/${ACCEPTANCE_DIR}/${record.id}.json`;
  const errs = schemaErrors('Acceptance', record);
  if (errs.length) return { value: null, findings: errs.map((e) => finding('STRUCTURAL_INVALID', `${rel}#${e.pointer}`, e.message, 'correct the acceptance record')), refused: 'the acceptance record does not satisfy its contract' };
  const dir = join(root, LOOM_DIR, ACCEPTANCE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${record.id}.json`);
  if (existsSync(file)) return { value: null, findings: [], refused: `acceptance '${record.id}' already exists; acceptance records are never rewritten` };
  writeFileSync(file, documentText(record), { flag: 'wx' });
  return { value: record, findings: [] };
}
