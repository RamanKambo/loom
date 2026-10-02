import type { Change, Finding, Model } from './generated/types.js';
import { FINDING, FINDING_RULES } from './codes.js';
import { deepClone } from './canonical.js';
import { MODEL_FORMAT, structuralFindings } from './load.js';
import { validate } from './validate.js';

/**
 * One deterministic step from a model format to the next. `apply` is pure and
 * returns the migrated document together with every semantic difference the
 * step introduces, so a migration that changes meaning says so explicitly.
 */
export interface MigrationStep {
  from: number;
  to: number;
  description: string;
  apply(document: unknown): { document: unknown; changes: Change[] };
}

/** Registered format migrations. Format 1 is the only format, so the registry is empty. */
export const MODEL_MIGRATIONS: readonly MigrationStep[] = [];

export interface MigrationResult {
  /** The input, unchanged. */
  before: unknown;
  /** The migrated model, or null when no path exists or the result is invalid. */
  after: Model | null;
  steps: string[];
  findings: Finding[];
  /** Semantic differences declared by the applied steps, for review before replacement. */
  changes: Change[];
}

/**
 * Migrate a document to the current model format by registered steps. The input
 * is never modified, and the result is a candidate for review: the caller
 * compares, tests and only then replaces the stored document.
 */
export function migrateModel(document: unknown, registry: readonly MigrationStep[] = MODEL_MIGRATIONS): MigrationResult {
  const before = deepClone(document);
  const versionOf = (d: unknown): unknown => (d && typeof d === 'object' ? (d as { version?: unknown }).version : undefined);
  let current: unknown = deepClone(document);
  const steps: string[] = [];
  const changes: Change[] = [];
  const guard = new Set<number>();
  for (;;) {
    const v = versionOf(current);
    if (v === MODEL_FORMAT) break;
    const step = typeof v === 'number' && !guard.has(v) ? registry.find((s) => s.from === v) : undefined;
    if (!step) {
      return {
        before,
        after: null,
        steps,
        findings: [
          {
            code: FINDING.MODEL_FORMAT_UNSUPPORTED,
            severity: FINDING_RULES.MODEL_FORMAT_UNSUPPORTED.severity,
            path: '/version',
            message: `no registered migration leads from format ${JSON.stringify(v)} to format ${MODEL_FORMAT}`,
            fix: `register a migration step from format ${JSON.stringify(v)}, or supply a format ${MODEL_FORMAT} document`,
          },
        ],
        changes,
      };
    }
    guard.add(step.from);
    const out = step.apply(deepClone(current));
    current = out.document;
    changes.push(...out.changes);
    steps.push(`${step.from} -> ${step.to}: ${step.description}`);
  }
  const structural = structuralFindings(current);
  if (structural.length) return { before, after: null, steps, findings: structural, changes };
  const model = current as Model;
  const findings = validate(model);
  return { before, after: findings.some((f) => f.severity === 'error') ? null : model, steps, findings, changes };
}
