import type { Model, Finding } from './generated/types.js';
import { LoomStructuralError } from './errors.js';
import { FINDING, FINDING_RULES } from './codes.js';
import { schemaErrors } from './schema-runtime.js';

/** The model format version this engine reads and writes. */
export const MODEL_FORMAT = 1;

function formatFinding(version: unknown): Finding | null {
  if (version === MODEL_FORMAT || typeof version !== 'number') return null;
  return {
    code: FINDING.MODEL_FORMAT_UNSUPPORTED,
    severity: FINDING_RULES.MODEL_FORMAT_UNSUPPORTED.severity,
    path: '/version',
    message: `model format version ${version} is not supported; this engine reads format ${MODEL_FORMAT}`,
    fix: `migrate the document with migrateModel() (loom migrate) from format ${version} to format ${MODEL_FORMAT}, review the result, then replace the file`,
  };
}

/**
 * Structural findings of a value against the model contract; never throws. A
 * document of another format version gets only MODEL_FORMAT_UNSUPPORTED,
 * because its members mean what that format defines and are not reinterpreted.
 */
export function structuralFindings(value: unknown): Finding[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const format = formatFinding((value as { version?: unknown }).version);
    if (format) return [format];
  }
  return schemaErrors('Model', value).map((e) => {
    const path = e.pointer || '(root)';
    return {
      code: FINDING.STRUCTURAL_INVALID,
      severity: FINDING_RULES.STRUCTURAL_INVALID.severity,
      path,
      message: `${path}: ${e.message}`,
      fix: `correct the value at ${path} to satisfy the model contract (${e.keyword})`,
    };
  });
}

/**
 * Parse-and-structurally-validate an untrusted value into a Model. It checks
 * structure only: a structurally valid model may still carry semantic errors,
 * which validate() reports.
 */
export function loadModel(json: unknown): Model {
  const findings = structuralFindings(json);
  if (findings.length) {
    throw new LoomStructuralError(
      `model failed structural validation: ${findings.map((f) => f.message).join('; ')}`,
      findings,
    );
  }
  return json as Model;
}
