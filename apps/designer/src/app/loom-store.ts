import { Injectable, computed, signal } from '@angular/core';
import {
  LoomInvalidModelError,
  PROJECTION_TARGETS,
  canonicalHash,
  canonicalStringify,
  checkReadinessTool,
  checkRevision,
  compareBaseline,
  compareBaselineTool,
  diffTool,
  evaluateEvidenceTool,
  exportModel,
  importModel,
  modelRevision,
  mutate,
  planChangeTool,
  project,
  projectedPath,
  renderTarget,
  sampleModel,
  schemaErrors,
  validate,
  withArtifactHashes,
  type Acceptance,
  type AffectedElement,
  type Baseline,
  type Change,
  type DiffData,
  type EvaluationInputs,
  type EvidenceRecord,
  type Finding,
  type Model,
  type Patch,
  type PlanChangeData,
  type Policy,
  type ProjectionTarget,
  type PublishedContract,
  type ReadinessData,
  type RecordRef,
  type RenderedTarget,
  type Repair,
  type ResultEnvelope,
  type SchemaError,
  type TaskSpec,
} from '@loom/core';
import type { ModelFile } from './model-file';

/** What one mutate() call decided, kept for display. */
export interface MutationOutcome {
  accepted: boolean;
  findings: Finding[];
  changes: Change[];
  impact: AffectedElement[];
  repairs: Repair[];
}

export interface Failure {
  ok: false;
  error: string;
  /** The engine's findings when it refused for an invalid model; empty otherwise. */
  findings: Finding[];
}

export type ProjectionOutcome =
  | { ok: true; target: ProjectionTarget; text: string }
  | (Failure & { target: ProjectionTarget });

/** Every file a target writes; a per-component target writes one per component, under <component>/. */
export type FileOutcome = { ok: true; files: Array<{ fileName: string; text: string }> } | Failure;

export type ExportOutcome = { ok: true; text: string } | Failure;

export type DiffOutcome = { ok: true; changes: Change[] } | Failure;

export type ViewOutcome = { ok: true; rendered: RenderedTarget } | Failure;

/** An accepted baseline as the user selected it: its record and the snapshot the record names. */
export interface SelectedBaseline {
  record: Baseline;
  model: Model;
  source: string;
}

export type SaveOutcome =
  | { kind: 'saved'; revision: string }
  | { kind: 'refused'; reason: string; findings: Finding[]; diskRevision: string | null; expectedRevision: string }
  | { kind: 'download'; files: Array<{ fileName: string; text: string }>; expectedRevision: string | null };

export type RecordLoad = { ok: true } | { ok: false; error: string; errors: SchemaError[] };

export type PublishOutcome = { ok: true; bundle: PublishedContract; fileName: string; text: string } | { ok: false; error: string; errors: SchemaError[] };

/**
 * Why nothing the designer loads is ever trusted: trust is established by reading the trusted Git
 * ref or verifying a signature against a policy read from it, and a browser page can do neither.
 */
export const TRUST_LIMIT =
  'The designer cannot read the trusted Git ref, so every baseline, acceptance, policy and evidence record it loads is evaluated as untrusted.';

function failure(e: unknown): Failure {
  return {
    ok: false,
    error: e instanceof Error ? e.message : String(e),
    findings: e instanceof LoomInvalidModelError ? e.findings : [],
  };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
}

/**
 * The designer's single state holder. Every validation, mutation, diff, readiness, acceptance,
 * evidence and projection result is computed by @loom/core; this service only holds the inputs and
 * the engine's results in signals. A model is replaced only by the model that mutate() returns, so a
 * refused batch can never reach the view.
 */
@Injectable({ providedIn: 'root' })
export class LoomStore {
  /** Projection targets as the engine publishes them. */
  readonly targets: readonly ProjectionTarget[] = PROJECTION_TARGETS;

  private readonly current = signal<Model | null>(null);
  private readonly opened = signal<Model | null>(null);
  private readonly undoStack = signal<readonly Model[]>([]);
  private readonly source = signal<string | null>(null);
  private readonly loadFailure = signal<string | null>(null);
  private readonly mutation = signal<MutationOutcome | null>(null);
  private readonly plan = signal<ResultEnvelope | null>(null);
  private readonly file = signal<ModelFile | null>(null);
  private readonly base = signal<string | null>(null);
  private readonly conflict = signal<Extract<SaveOutcome, { kind: 'refused' }> | null>(null);

  private readonly baselineSelection = signal<SelectedBaseline | null>(null);
  private readonly acceptanceRecords = signal<readonly Acceptance[]>([]);
  private readonly evidenceRecords = signal<readonly EvidenceRecord[]>([]);
  private readonly policyRecord = signal<Policy | null>(null);

  readonly model = this.current.asReadonly();
  /** The model as last opened or saved: a local comparison point for the diff view, never an accepted baseline. */
  readonly comparisonPoint = this.opened.asReadonly();
  /** Models replaced by accepted mutations, oldest first. Local to this page. */
  readonly history = this.undoStack.asReadonly();
  readonly sourceName = this.source.asReadonly();
  readonly loadError = this.loadFailure.asReadonly();
  readonly lastMutation = this.mutation.asReadonly();
  readonly lastPlan = this.plan.asReadonly();
  /** The revision persistent edits started from; a save is refused unless the file on disk is still at it. */
  readonly baseRevision = this.base.asReadonly();
  readonly saveConflict = this.conflict.asReadonly();
  readonly persistentFile = computed(() => this.file() !== null);

  readonly acceptedBaseline = this.baselineSelection.asReadonly();
  readonly acceptances = this.acceptanceRecords.asReadonly();
  readonly evidence = this.evidenceRecords.asReadonly();
  readonly policy = this.policyRecord.asReadonly();

  /** The date the engine judges expiry against; the core has no clock, so the adapter supplies it. */
  readonly asOf = signal(new Date().toISOString().slice(0, 10));
  /** The task whose readiness, work package and evidence obligations are shown. */
  readonly task = signal<TaskSpec>({ class: 'implementation', mode: 'component' });

  readonly revision = computed(() => {
    const m = this.current();
    return m ? modelRevision(m) : null;
  });

  /**
   * The evaluation inputs: every supplied record marked untrusted, for the reason in TRUST_LIMIT,
   * and the current hash of every artifact the evidence names, rendered from the current model.
   */
  readonly inputs = computed<EvaluationInputs>(() => {
    const out: EvaluationInputs = { asOf: this.asOf() };
    const b = this.baselineSelection();
    if (b) out.baseline = { record: b.record, model: b.model, verified: false };
    const acc = this.acceptanceRecords();
    if (acc.length) out.acceptances = acc.map((record) => ({ record, trusted: false }));
    const ev = this.evidenceRecords();
    if (ev.length) out.evidence = ev.map((record) => ({ record, trusted: false, reason: TRUST_LIMIT }));
    const p = this.policyRecord();
    if (p) out.policy = p;
    const m = this.current();
    return m && ev.length ? withArtifactHashes(m, out) : out;
  });

  /** The exact revisions every state below was evaluated against. */
  readonly evaluated = computed(() => {
    const b = this.baselineSelection();
    const p = this.policyRecord();
    return {
      model: this.revision(),
      baseline: b ? { id: b.record.id, hash: b.record.model.hash } : null,
      policy: p ? { id: p.id, revision: p.revision } : null,
      acceptances: this.acceptanceRecords().length,
      evidence: this.evidenceRecords().length,
      asOf: this.asOf(),
    };
  });

  readonly findings = computed<Finding[]>(() => {
    const m = this.current();
    return m ? validate(m, this.inputs()) : [];
  });
  readonly errorCount = computed(() => this.findings().filter((f) => f.severity === 'error').length);
  readonly warningCount = computed(() => this.findings().filter((f) => f.severity === 'warning').length);

  readonly readiness = computed<ResultEnvelope | null>(() => {
    const m = this.current();
    return m ? checkReadinessTool({ model: m, task: this.task() }, this.inputs()) : null;
  });
  readonly readinessData = computed(() => (this.readiness()?.data as ReadinessData | undefined) ?? null);

  /** The candidate against the selected accepted baseline; without one, acceptance is not evaluated. */
  readonly baselineComparison = computed<ResultEnvelope | null>(() => {
    const m = this.current();
    return m ? compareBaselineTool({ model: m }, this.inputs()) : null;
  });
  readonly baselineChanges = computed(() => (this.baselineComparison()?.data as DiffData | undefined) ?? null);
  /** Findings of the baseline comparison alone: trust, acceptance, frozen components, retirement and gates. */
  readonly baselineFindings = computed<Finding[]>(() => {
    const m = this.current();
    return m ? compareBaseline(m, this.inputs()).findings : [];
  });

  readonly evidenceEvaluation = computed<ResultEnvelope | null>(() => {
    const m = this.current();
    return m ? evaluateEvidenceTool({ model: m, task: this.task() }, this.inputs()) : null;
  });

  /** The four independent states, each from the engine result that owns it. */
  readonly states = computed(() => {
    const r = this.readiness();
    if (!r) return null;
    return {
      validation: r.states.validation,
      readiness: r.states.readiness,
      acceptance: this.baselineComparison()!.states.acceptance,
      qualification: this.evidenceEvaluation()!.states.qualification,
    };
  });

  /** Open questions: unknown records, applicable concerns nothing resolves, and unvalidated assumptions. */
  readonly openQuestions = computed(() => {
    const m = this.current();
    if (!m) return null;
    return {
      unknowns: m.unknowns.filter((u) => u.status === 'open'),
      concerns: this.findings().filter((f) => f.code === 'CONCERN_UNRESOLVED' || f.code === 'OPERATION_ENFORCEMENT_MISSING'),
      assumptions: m.assumptions.filter((a) => a.status !== 'validated'),
    };
  });

  /** Changes since the local comparison point, through the same diff tool the MCP server exposes. */
  readonly localDiff = computed<ResultEnvelope | null>(() => {
    const before = this.opened();
    const after = this.current();
    return before && after ? diffTool({ before, after }) : null;
  });

  readonly changesSinceOpened = computed<DiffOutcome>(() => {
    const d = this.localDiff();
    if (!d) return { ok: true, changes: [] };
    if (d.outcome === 'refused') return { ok: false, error: d.refusal?.message ?? 'the comparison was refused', findings: d.findings };
    return { ok: true, changes: (d.data as DiffData).changes };
  });

  /** Import a model file's text; on a structural error keep the current model and record the error. */
  loadText(text: string, sourceName: string): boolean {
    try {
      this.install(importModel(text), sourceName, null);
      return true;
    } catch (e) {
      this.loadFailure.set(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  /** Open a file the designer can later save back to, after checking it is still at this revision. */
  async openFile(file: ModelFile): Promise<boolean> {
    let text: string;
    try {
      text = await file.read();
    } catch (e) {
      this.loadFailure.set(`could not read ${file.name}: ${(e as Error).message}`);
      return false;
    }
    try {
      this.install(importModel(text), file.name, file);
      return true;
    } catch (e) {
      this.loadFailure.set(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  loadSample(): void {
    this.install(sampleModel(), 'sample', null);
  }

  /** Run one patch or an atomic batch through mutate(); the model changes only if the engine accepts. */
  apply(patches: Patch | Patch[], acknowledgeBreaking: string[] = []): MutationOutcome {
    const before = this.current();
    if (!before) throw new Error('no model is loaded');
    const result = mutate(before, patches, { acknowledgeBreaking });
    const outcome: MutationOutcome = {
      accepted: result.model !== null,
      findings: result.findings,
      changes: result.changes,
      impact: result.impact,
      repairs: result.repairs,
    };
    if (result.model !== null) {
      this.undoStack.update((h) => [...h, before]);
      this.current.set(result.model);
    }
    this.mutation.set(outcome);
    this.plan.set(null);
    return outcome;
  }

  /** Preview a patch or batch with the engine's change planner; nothing is applied. */
  preview(patches: Patch | Patch[], acknowledgeBreaking: string[] = []): ResultEnvelope {
    const m = this.current();
    if (!m) throw new Error('no model is loaded');
    const request = Array.isArray(patches) ? { patches } : { patch: patches };
    const result = planChangeTool({ model: m, baseRevision: modelRevision(m), ...request, acknowledgeBreaking }, this.inputs());
    this.plan.set(result);
    return result;
  }

  readonly planData = computed(() => (this.plan()?.data as PlanChangeData | undefined) ?? null);

  undo(): void {
    const h = this.undoStack();
    const previous = h[h.length - 1];
    if (previous === undefined) return;
    this.undoStack.set(h.slice(0, -1));
    this.current.set(previous);
    this.mutation.set(null);
    this.plan.set(null);
  }

  /**
   * Save the candidate. With a reopened file, the file on disk must still be at the base revision:
   * a file another editor changed is refused and left untouched. Without one, the result is a
   * download of the model and the expected revision it was edited from.
   */
  async save(): Promise<SaveOutcome> {
    const m = this.current();
    if (!m) throw new Error('no model is loaded');
    const exported = this.exportCanonical();
    if (!exported.ok) {
      const refused: SaveOutcome = { kind: 'refused', reason: exported.error, findings: exported.findings, diskRevision: null, expectedRevision: this.base() ?? '' };
      this.conflict.set(refused);
      return refused;
    }
    const file = this.file();
    if (!file) {
      const name = (this.source() ?? 'model').replace(/\.(json|ya?ml)$/i, '');
      const note = canonicalStringify({ baseRevision: this.base(), revision: modelRevision(m) });
      return {
        kind: 'download',
        expectedRevision: this.base(),
        files: [
          { fileName: `${name}.json`, text: exported.text },
          { fileName: `${name}.revision.json`, text: `${note}\n` },
        ],
      };
    }
    const expected = this.base() ?? '';
    let disk: Model;
    try {
      disk = importModel(await file.read());
    } catch (e) {
      const refused: SaveOutcome = { kind: 'refused', reason: `the file on disk is not a readable model: ${(e as Error).message}`, findings: [], diskRevision: null, expectedRevision: expected };
      this.conflict.set(refused);
      return refused;
    }
    const check = checkRevision(disk, expected);
    if (check.outcome === 'refused') {
      const refused: SaveOutcome = { kind: 'refused', reason: check.refusal?.message ?? 'stale base revision', findings: check.findings, diskRevision: modelRevision(disk), expectedRevision: expected };
      this.conflict.set(refused);
      return refused;
    }
    await file.write(exported.text);
    const revision = modelRevision(m);
    this.base.set(revision);
    this.opened.set(m);
    this.conflict.set(null);
    return { kind: 'saved', revision };
  }

  /** Select the accepted baseline from its record and snapshot. It is evaluated as untrusted; see TRUST_LIMIT. */
  selectBaseline(recordText: string, snapshotText: string, source: string): RecordLoad {
    const parsed = parseJson(recordText);
    if (!parsed.ok) return { ok: false, error: `baseline record: ${parsed.error}`, errors: [] };
    const errors = schemaErrors('Baseline', parsed.value);
    if (errors.length) return { ok: false, error: 'the baseline record does not match the contract', errors };
    let model: Model;
    try {
      model = importModel(snapshotText);
    } catch (e) {
      return { ok: false, error: `baseline snapshot: ${(e as Error).message}`, errors: [] };
    }
    this.baselineSelection.set({ record: parsed.value as Baseline, model, source });
    return { ok: true };
  }

  clearBaseline(): void {
    this.baselineSelection.set(null);
    this.acceptanceRecords.set([]);
    this.policyRecord.set(null);
  }

  addAcceptance(text: string): RecordLoad {
    const r = this.contractRecord<Acceptance>('Acceptance', text);
    if (r.ok) this.acceptanceRecords.update((list) => [...list.filter((a) => a.id !== r.value.id), r.value]);
    return r.ok ? { ok: true } : r;
  }

  addEvidence(text: string): RecordLoad {
    const r = this.contractRecord<EvidenceRecord>('EvidenceRecord', text);
    if (r.ok) this.evidenceRecords.update((list) => [...list.filter((e) => e.id !== r.value.id), r.value]);
    return r.ok ? { ok: true } : r;
  }

  setPolicy(text: string): RecordLoad {
    const r = this.contractRecord<Policy>('Policy', text);
    if (r.ok) this.policyRecord.set(r.value);
    return r.ok ? { ok: true } : r;
  }

  clearEvidence(): void {
    this.evidenceRecords.set([]);
  }

  /**
   * Publish the selected records as a pinned contract bundle. The digest is the engine's canonical
   * hash of the content, and the bundle is checked against the published-contract contract.
   */
  publish(selection: readonly RecordRef[], meta: { publisher: string; contract: string; version: number }): PublishOutcome {
    const m = this.current();
    if (!m) return { ok: false, error: 'no model is loaded', errors: [] };
    if (this.errorCount() > 0) return { ok: false, error: 'the model has error findings; a contract is published only from a valid model', errors: [] };
    const pick = <T extends { id: string }>(kind: RecordRef['kind'], list: readonly T[]): T[] =>
      list.filter((r) => selection.some((s) => s.kind === kind && s.id === r.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const content = {
      types: pick('type', m.types),
      operations: pick('operation', m.operations),
      routines: pick('routine', m.routines),
      securitySchemes: pick('securityScheme', m.securitySchemes),
    };
    const bundle: PublishedContract = {
      bundleVersion: 1,
      publisher: meta.publisher,
      contract: meta.contract,
      version: meta.version,
      schemaVersion: 1,
      profiles: [],
      digest: canonicalHash(content),
      content,
    };
    const errors = schemaErrors('PublishedContract', bundle);
    if (errors.length) return { ok: false, error: 'the bundle does not match the published-contract contract', errors };
    return { ok: true, bundle, fileName: `${meta.contract}@${meta.version}.json`, text: `${canonicalStringify(bundle)}\n` };
  }

  /** Project the current model; the engine fails closed, so an invalid model yields its error and findings. */
  project(target: ProjectionTarget): ProjectionOutcome {
    const m = this.current();
    if (!m) return { ok: false, target, error: 'no model is loaded', findings: [] };
    try {
      const out = project(m, target);
      return { ok: true, target, text: typeof out === 'string' ? out : canonicalStringify(out) };
    } catch (e) {
      return { ...failure(e), target };
    }
  }

  /** A generated view rendered with the evaluation inputs, with its coverage manifest and draft flag. */
  view(target: ProjectionTarget, draft = false): ViewOutcome {
    const m = this.current();
    if (!m) return { ok: false, error: 'no model is loaded', findings: [] };
    try {
      return { ok: true, rendered: renderTarget(m, target, { draft, inputs: this.inputs() }) };
    } catch (e) {
      return failure(e);
    }
  }

  /** The target as the engine writes it to files (`loom write`): each file's relative path and exact text. */
  projectionFile(target: ProjectionTarget): FileOutcome {
    const m = this.current();
    if (!m) return { ok: false, error: 'no model is loaded', findings: [] };
    try {
      const files = renderTarget(m, target).files.map((f) => ({ fileName: projectedPath(f), text: f.content }));
      if (files.length === 0) return { ok: false, error: `the engine wrote no file for '${target}'`, findings: [] };
      return { ok: true, files };
    } catch (e) {
      return failure(e);
    }
  }

  /** Canonical model text; the engine refuses an invalid model, which blocks the download. */
  exportCanonical(): ExportOutcome {
    const m = this.current();
    if (!m) return { ok: false, error: 'no model is loaded', findings: [] };
    try {
      return { ok: true, text: exportModel(m) };
    } catch (e) {
      return failure(e);
    }
  }

  private contractRecord<T>(definition: string, text: string): { ok: true; value: T } | { ok: false; error: string; errors: SchemaError[] } {
    const parsed = parseJson(text);
    if (!parsed.ok) return { ok: false, error: parsed.error, errors: [] };
    const errors = schemaErrors(definition, parsed.value);
    if (errors.length) return { ok: false, error: `the record does not match the ${definition} contract`, errors };
    return { ok: true, value: parsed.value as T };
  }

  private install(model: Model, sourceName: string, file: ModelFile | null): void {
    this.current.set(model);
    this.opened.set(model);
    this.undoStack.set([]);
    this.mutation.set(null);
    this.plan.set(null);
    this.loadFailure.set(null);
    this.conflict.set(null);
    this.source.set(sourceName);
    this.file.set(file);
    this.base.set(modelRevision(model));
  }
}
