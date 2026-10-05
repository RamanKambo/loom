import type { CheckDefinition, CheckResult, EvaluationInputs, EvidenceClaim, EvidenceRecord, Model, ProjectedFile, ProjectionTarget, RunBudgets, RunRecord } from '@loom/core';
import type { Lifecycle } from './lifecycle.js';
import type { ProviderEntry } from './provider.js';
import type { ToolInfo, ToolLocator } from './tools.js';

/** One rendered artifact file, written into the run directory so native tools can read it. */
export interface ArtifactFile extends ProjectedFile {
  target: ProjectionTarget;
  /** Absolute path of the written copy. */
  path: string;
}

export interface ArtifactSet {
  /** Directory the files were written to. */
  dir: string;
  files: ArtifactFile[];
  /** True when any file is an incomplete draft; a draft never qualifies. */
  draft: boolean;
}

/**
 * The implementations a conformance check runs against: Loom's own fixtures,
 * or an adopting system's real artifacts. Paths resolve against the run root.
 */
export interface ImplementationSet {
  /** T-SQL files deployed after the generated DDL and before the contract tests, in order. */
  sql?: readonly string[];
  /** Directory the generated Pester tests resolve each routine's relative source against. */
  powershellRoot?: string;
  /** C# implementation project per module named in a component's csharp implementation. */
  csharp?: Readonly<Record<string, string>>;
  /** TypeScript entry file per module named in a component's typescript implementation. */
  typescript?: Readonly<Record<string, string>>;
}

export interface MigrationFixture {
  /** Id of the migration record in the candidate model. */
  migration: string;
  /** Model whose storage holds the shape before the migration. */
  previous: Model;
  /** Model holding the migration record and the shape after it; the run's model when absent. */
  candidate?: Model;
  /** T-SQL inserting representative rows in the previous shape. */
  rows: string;
  /** Column values every migrated row must hold, beyond the preserved columns. */
  expectColumns?: Readonly<Record<string, string>>;
  /** Exact values of one column across the migrated rows, in primary-key order. */
  expectValues?: { column: string; values: readonly string[] };
}

export interface Fixtures {
  conforming?: ImplementationSet;
  /** The deliberately violating counterpart a check must reject; absent for an adopting system's own run. */
  violating?: ImplementationSet;
  /** Accepted baseline model of the candidate, for document-level compatibility. */
  baseline?: Model;
  /** An explicit baseline and candidate pair for document-level compatibility. */
  compatibility?: { baseline: Model; candidate: Model };
  migrations?: readonly MigrationFixture[];
}

export interface RunnerContext {
  check: CheckDefinition;
  runId: string;
  /** This check's own directory inside the run directory. */
  dir: string;
  /** Root that fixture and migration paths resolve against. */
  root: string;
  model: Model;
  artifacts: ArtifactSet;
  fixtures: Fixtures;
  /** The verified inputs the artifacts were rendered with; a runner that renders again renders with the same. */
  inputs: EvaluationInputs;
  /** The check's primary tool, already resolved within its version policy. */
  tool: ToolInfo;
  tools: ToolLocator;
  timeoutMs: number;
  signal?: AbortSignal;
  budgets?: RunBudgets;
  lifecycle?: Lifecycle;
  provider?: ProviderEntry;
  /** Shared per-run resources, such as the run's own LocalDB instance. */
  resources: RunResources;
}

export interface RunnerOutcome {
  result: CheckResult;
  reason: string;
  cause?: NonNullable<RunRecord['checks'][number]['cause']>;
  dependency?: string;
  /** Tool identity to record when it differs from the primary tool, for example the Pester module chosen. */
  tool?: { name: string; version: string };
  boundaries?: EvidenceRecord['boundaries'];
  /** Artifact instances the check read; defaults to the instances of the check's input targets. */
  instances?: readonly string[];
  claims?: readonly EvidenceClaim[];
  /** Model records the result depends on, as '<kind>:<id>'. */
  records?: readonly string[];
}

export type Runner = (ctx: RunnerContext) => Promise<RunnerOutcome>;

/** Resources a run creates once and releases when it ends; each is owned by exactly one run. */
export interface RunResources {
  acquire<T>(key: string, create: () => Promise<T>, release: (value: T) => Promise<void>, partial?: () => T | undefined): Promise<T>;
}

export function unavailableCause(reason: string): NonNullable<RunnerOutcome['cause']> {
  if (/cancel/i.test(reason)) return 'cancelled';
  if (/timeout|deadline|did not finish/i.test(reason)) return 'timeout';
  if (/not found|missing|not installed|no .* supplied|no .* available/i.test(reason)) return 'tool-absent';
  if (/version|policy/i.test(reason)) return 'version-policy';
  if (/connection|connect|server/i.test(reason)) return 'connection';
  if (/budget|memory|disk|resource/i.test(reason)) return 'insufficient-resources';
  return 'unreadable';
}
export const outcome = (result: CheckResult, reason: string, extra: Partial<RunnerOutcome> = {}): RunnerOutcome => ({ result, reason, ...(result === 'UNKNOWN' ? { cause: unavailableCause(reason), dependency: 'declared qualification inputs and native runtime' } : {}), ...extra });
