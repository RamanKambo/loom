import { Ajv2020, type ValidateFunction, type ErrorObject } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { SCHEMA_BUNDLE, SCHEMA_BUNDLE_ID } from './generated/schemas.js';

// ajv-formats ships only a CommonJS default export. Under NodeNext the default
// import is the plugin function at runtime, but the type view can surface a
// namespace with the function on `.default`; normalize so both forms call.
type FormatsPlugin = (ajv: unknown, opts?: unknown) => unknown;
const raw = addFormatsModule as unknown as FormatsPlugin | { default: FormatsPlugin };
const addFormats: FormatsPlugin = typeof raw === 'function' ? raw : raw.default;

/** The annotation keywords the contract uses; generate.mjs registers the same set. */
const ANNOTATION_KEYWORDS = ['x-loom-kind', 'x-loom-key', 'x-loom-ordered', 'x-loom-ref', 'x-loom-atomic'];

let ajv: Ajv2020 | null = null;
const validators = new Map<string, ValidateFunction>();

function instance(): Ajv2020 {
  if (ajv) return ajv;
  const created = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
  addFormats(created);
  for (const keyword of ANNOTATION_KEYWORDS) created.addKeyword({ keyword });
  created.addSchema(SCHEMA_BUNDLE as unknown as object);
  ajv = created;
  return created;
}

/** The compiled validator of one contract definition, compiled once and cached. */
export function validatorFor(definition: string): ValidateFunction {
  const cached = validators.get(definition);
  if (cached) return cached;
  const fn = instance().getSchema(`${SCHEMA_BUNDLE_ID}#/$defs/${definition}`);
  if (!fn) throw new Error(`the contract defines no '${definition}'`);
  validators.set(definition, fn);
  return fn;
}

export interface SchemaError {
  /** JSON Pointer of the offending value; '' is the document root. */
  pointer: string;
  keyword: string;
  message: string;
}

function describe(e: ErrorObject): SchemaError {
  const params = e.params as Record<string, unknown>;
  const extra = params['additionalProperty'];
  const allowed = params['allowedValues'];
  let detail = '';
  if (typeof extra === 'string') detail = ` '${extra}'`;
  else if (Array.isArray(allowed)) detail = ` (${allowed.map((v) => JSON.stringify(v)).join(', ')})`;
  return { pointer: e.instancePath, keyword: e.keyword, message: `${e.message ?? 'is invalid'}${detail}` };
}

/** Structural errors of `value` against a contract definition; empty when it conforms. */
export function schemaErrors(definition: string, value: unknown): SchemaError[] {
  const validate = validatorFor(definition);
  if (validate(value)) return [];
  return (validate.errors ?? []).map(describe);
}
