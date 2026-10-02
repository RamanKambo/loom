import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { META_SCHEMA } from './meta-schema.js';
import { LoomStructuralError } from './errors.js';
import { FINDING } from './codes.js';
import type { Model, Finding } from './types.js';

// ajv-formats ships only a CommonJS default export. Under NodeNext the default
// import is the plugin function at runtime, but the type view can surface a
// namespace with the function on `.default`; normalize so both forms call.
type FormatsPlugin = (ajv: unknown, opts?: unknown) => unknown;
const raw = addFormatsModule as unknown as FormatsPlugin | { default: FormatsPlugin };
const addFormats: FormatsPlugin = typeof raw === 'function' ? raw : raw.default;

let cachedValidator: ValidateFunction | null = null;

function metaValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const compiled = ajv.compile(META_SCHEMA as object);
  cachedValidator = compiled;
  return compiled;
}

interface AjvErrorLike {
  instancePath?: string;
  message?: string;
  params?: Record<string, unknown>;
}

function describe(e: AjvErrorLike): { path: string; message: string } {
  const path = e.instancePath && e.instancePath.length ? e.instancePath : '(root)';
  const extra = e.params?.['additionalProperty'];
  const detail = typeof extra === 'string' ? ` '${extra}'` : '';
  return { path, message: `${e.message ?? 'invalid'}${detail}` };
}

/**
 * Structural meta-schema check as findings (never throws). validate() runs this
 * first, which keeps project() and exportModel() fail-closed even for a model
 * produced in memory (e.g. by a patch that set a field to an illegal value).
 */
export function structuralFindings(value: unknown): Finding[] {
  const validate = metaValidator();
  if (validate(value)) return [];
  return ((validate.errors ?? []) as AjvErrorLike[]).map((e) => {
    const d = describe(e);
    return {
      code: FINDING.STRUCTURAL_INVALID,
      severity: 'error' as const,
      path: d.path,
      message: `${d.path}: ${d.message}`,
      fix: `correct the value at ${d.path} to satisfy the model meta-schema`,
    };
  });
}

/**
 * Parse-and-structurally-validate an untrusted value into a Model. This is the
 * first gate: it runs the meta-schema so a malformed file is rejected with a
 * precise pointer before any semantic rule (validate()) sees it. It does NOT
 * check semantics — a structurally valid model may still have error findings.
 */
export function loadModel(json: unknown): Model {
  const validate = metaValidator();
  if (!validate(json)) {
    const errs = (validate.errors ?? []) as AjvErrorLike[];
    const summary = errs
      .map((e) => {
        const d = describe(e);
        return `${d.path}: ${d.message}`;
      })
      .join('; ');
    throw new LoomStructuralError(`model failed structural validation: ${summary}`, errs);
  }
  return json as Model;
}
