import { parse as parseYaml } from 'yaml';
import type { Model } from './types.js';
import { validate } from './validate.js';
import { canonicalStringify } from './canonical.js';
import { loadModel } from './load.js';
import { LoomInvalidModelError, LoomStructuralError } from './errors.js';

/**
 * Serialize the model to a canonical, deterministic JSON string. Fail-closed:
 * an invalid model (any error finding) throws rather than serializing. The
 * output is stable (sorted keys, preserved array order), so the same model
 * always produces the identical string.
 */
export function exportModel(model: Model): string {
  const findings = validate(model);
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  if (errorCount > 0) {
    throw new LoomInvalidModelError(
      `refusing to export: model has ${errorCount} error finding(s)`,
      findings,
    );
  }
  return canonicalStringify(model);
}

/**
 * Parse a model from JSON or YAML text and structurally validate it. Text whose
 * first non-blank character is '{' or '[' is JSON (so a malformed JSON file
 * reports the JSON error); anything else is YAML 1.2. Either round-trips
 * losslessly: exportModel(importModel(x)) equals the canonical JSON of x.
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
