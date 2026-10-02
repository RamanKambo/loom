import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Model } from './generated/types.js';
import { validate } from './validate.js';
import { canonicalStringify } from './canonical.js';
import { loadModel } from './load.js';
import { LoomInvalidModelError, LoomStructuralError } from './errors.js';

function assertExportable(model: Model, what: string): void {
  const findings = validate(model);
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  if (errorCount > 0) throw new LoomInvalidModelError(`refusing to ${what}: model has ${errorCount} error finding(s)`, findings);
}

/**
 * Serialize the model to canonical JSON. Fail-closed: an invalid model throws
 * rather than serializing. Sorted keys and preserved array order make the
 * output identical for the same model.
 */
export function exportModel(model: Model): string {
  assertExportable(model, 'export');
  return canonicalStringify(model);
}

/** The canonical model as YAML 1.2 with sorted keys; fail-closed like exportModel(). */
export function exportYaml(model: Model): string {
  assertExportable(model, 'export');
  return stringifyYaml(model, { sortMapEntries: true, lineWidth: 0 });
}

/**
 * Parse a model from JSON or YAML text and check its structure. Text whose
 * first non-blank character is '{' or '[' is JSON, so a malformed JSON file
 * reports the JSON error; anything else is YAML 1.2.
 */
export function importModel(text: string): Model {
  const body = text.replace(/^﻿/, '');
  const head = body.trimStart().charAt(0);
  let parsed: unknown;
  if (head === '{' || head === '[') {
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new LoomStructuralError(`invalid JSON: ${(e as Error).message}`, []);
    }
  } else {
    try {
      parsed = parseYaml(body);
    } catch (e) {
      throw new LoomStructuralError(`invalid YAML: ${(e as Error).message}`, []);
    }
  }
  return loadModel(parsed);
}
