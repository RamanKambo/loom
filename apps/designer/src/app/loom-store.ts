import { Injectable, computed, signal } from '@angular/core';
import {
  LoomInvalidModelError,
  PROJECTION_FILES,
  PROJECTION_TARGETS,
  canonicalStringify,
  diff,
  exportModel,
  importModel,
  mutate,
  project,
  projectToFiles,
  sampleModel,
  validate,
  type Change,
  type Finding,
  type Model,
  type Patch,
  type ProjectionTarget,
} from '@loom/core';

/** What one mutate() call decided, kept for display. */
export interface MutationOutcome {
  accepted: boolean;
  findings: Finding[];
  changes: Change[];
  impact: string[];
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

export type FileOutcome = { ok: true; fileName: string; text: string } | Failure;

export type ExportOutcome = { ok: true; text: string } | Failure;

export type DiffOutcome = { ok: true; changes: Change[] } | Failure;

function failure(e: unknown): Failure {
  return {
    ok: false,
    error: e instanceof Error ? e.message : String(e),
    findings: e instanceof LoomInvalidModelError ? e.findings : [],
  };
}

/**
 * The designer's single state holder. Every validation, mutation, diff,
 * projection, import and export is delegated to @loom/core; this service only
 * holds the engine's results in signals. A model is replaced only by the model
 * that mutate() returns, so a refused batch can never reach the view.
 */
@Injectable({ providedIn: 'root' })
export class LoomStore {
  /** Projection targets as the engine publishes them. */
  readonly targets: readonly ProjectionTarget[] = PROJECTION_TARGETS;

  private readonly current = signal<Model | null>(null);
  private readonly loaded = signal<Model | null>(null);
  private readonly undoStack = signal<readonly Model[]>([]);
  private readonly source = signal<string | null>(null);
  private readonly loadFailure = signal<string | null>(null);
  private readonly mutation = signal<MutationOutcome | null>(null);

  readonly model = this.current.asReadonly();
  /** The last loaded model, the baseline for diff. */
  readonly baseline = this.loaded.asReadonly();
  /** Models replaced by accepted mutations, oldest first. */
  readonly history = this.undoStack.asReadonly();
  readonly sourceName = this.source.asReadonly();
  readonly loadError = this.loadFailure.asReadonly();
  readonly lastMutation = this.mutation.asReadonly();

  readonly findings = computed<Finding[]>(() => {
    const m = this.current();
    return m ? validate(m) : [];
  });
  readonly errorCount = computed(() => this.findings().filter((f) => f.severity === 'error').length);
  readonly warningCount = computed(() => this.findings().filter((f) => f.severity === 'warning').length);

  readonly changesSinceBaseline = computed<DiffOutcome>(() => {
    const before = this.loaded();
    const after = this.current();
    if (!before || !after) return { ok: true, changes: [] };
    try {
      return { ok: true, changes: diff(before, after) };
    } catch (e) {
      return failure(e);
    }
  });

  /** Import a model file's text; on a structural error keep the current model and record the error. */
  loadText(text: string, sourceName: string): boolean {
    try {
      this.install(importModel(text), sourceName);
      return true;
    } catch (e) {
      this.loadFailure.set(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  loadSample(): void {
    this.install(sampleModel(), 'sample');
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
    };
    if (result.model !== null) {
      this.undoStack.update((h) => [...h, before]);
      this.current.set(result.model);
    }
    this.mutation.set(outcome);
    return outcome;
  }

  undo(): void {
    const h = this.undoStack();
    const previous = h[h.length - 1];
    if (previous === undefined) return;
    this.undoStack.set(h.slice(0, -1));
    this.current.set(previous);
    this.mutation.set(null);
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

  /** The target as the engine writes it to a file (`loom --write`): its file name and exact text. */
  projectionFile(target: ProjectionTarget): FileOutcome {
    const m = this.current();
    if (!m) return { ok: false, error: 'no model is loaded', findings: [] };
    const fileName = Object.keys(PROJECTION_FILES).find((f) => PROJECTION_FILES[f] === target);
    if (fileName === undefined) return { ok: false, error: `no file is defined for '${target}'`, findings: [] };
    try {
      const text = projectToFiles(m)[fileName];
      if (text === undefined) return { ok: false, error: `the engine wrote no '${fileName}'`, findings: [] };
      return { ok: true, fileName, text };
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

  private install(model: Model, sourceName: string): void {
    this.current.set(model);
    this.loaded.set(model);
    this.undoStack.set([]);
    this.mutation.set(null);
    this.loadFailure.set(null);
    this.source.set(sourceName);
  }
}
