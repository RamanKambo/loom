import type { Finding } from './types.js';

/**
 * Thrown by loadModel/importModel when a value fails the structural meta-schema,
 * before any semantic rule runs. `errors` carries the raw Ajv error objects.
 */
export class LoomStructuralError extends Error {
  readonly errors: unknown[];
  constructor(message: string, errors: unknown[]) {
    super(message);
    this.name = 'LoomStructuralError';
    this.errors = errors;
  }
}

/**
 * Thrown by project() and exportModel() when the model carries error-severity
 * findings. These operations are fail-closed: an invalid model never serializes
 * or projects, so a bad mutation cannot leak into a downstream artifact.
 */
export class LoomInvalidModelError extends Error {
  readonly findings: Finding[];
  constructor(message: string, findings: Finding[]) {
    super(message);
    this.name = 'LoomInvalidModelError';
    this.findings = findings;
  }
}
