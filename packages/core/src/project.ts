import type { Model, ProjectionTarget } from './types.js';
import { validate } from './validate.js';
import { LoomInvalidModelError } from './errors.js';
import { canonicalStringify } from './canonical.js';
import { projectJsonSchema, projectOpenApi } from './projections/json.js';
import { projectSql, projectSqlContractTests } from './projections/sql.js';
import { projectPesterContractTests } from './projections/pester.js';
import { projectYaml } from './projections/yaml.js';
import { projectWorkflow } from './projections/mermaid.js';
import { projectReference } from './projections/reference.js';

export { JSON_SCHEMA_ID } from './projections/json.js';
export { SOURCE_NOTICE } from './projections/notice.js';

/** Every projection target, in the order the CLI and MCP server list them. */
export const PROJECTION_TARGETS: readonly ProjectionTarget[] = [
  'json-schema',
  'openapi',
  'sql',
  'sql-contract-tests',
  'pester-contract-tests',
  'yaml',
  'workflow',
  'reference',
];

/** json-schema and openapi return objects; every other target returns text ending in one newline. */
const RENDERERS: Readonly<Record<ProjectionTarget, (model: Model) => unknown>> = {
  'json-schema': projectJsonSchema,
  openapi: projectOpenApi,
  sql: projectSql,
  'sql-contract-tests': projectSqlContractTests,
  'pester-contract-tests': projectPesterContractTests,
  yaml: projectYaml,
  workflow: projectWorkflow,
  reference: projectReference,
};

/** The file each target is written to by projectToFiles (and `loom --write`). */
export const PROJECTION_FILES: Readonly<Record<string, ProjectionTarget>> = {
  'schema.json': 'json-schema',
  'openapi.json': 'openapi',
  'schema.sql': 'sql',
  'contract-tests.sql': 'sql-contract-tests',
  'Routines.Contract.Tests.ps1': 'pester-contract-tests',
  'model.yaml': 'yaml',
  'workflows.md': 'workflow',
  'reference.md': 'reference',
};

function assertValid(model: Model, what: string): void {
  const findings = validate(model);
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  if (errorCount > 0) {
    throw new LoomInvalidModelError(
      `refusing to project ${what}: model has ${errorCount} error finding(s)`,
      findings,
    );
  }
}

/**
 * Project the model to a target artifact. Fail-closed: if validate() reports any
 * error finding, this throws LoomInvalidModelError rather than emitting an
 * artifact built from an invalid model. Output is deterministic; object results
 * should be serialized with canonicalStringify.
 */
export function project(model: Model, target: ProjectionTarget): unknown {
  if (!Object.prototype.hasOwnProperty.call(RENDERERS, target)) {
    throw new Error(`unknown projection target: ${String(target)}; expected one of ${PROJECTION_TARGETS.join(', ')}`);
  }
  assertValid(model, `'${target}'`);
  return RENDERERS[target](model);
}

/**
 * Every projection keyed by file name, each as the exact text to write: JSON
 * outputs are canonical with a trailing newline. Fail-closed like project().
 */
export function projectToFiles(model: Model): Record<string, string> {
  assertValid(model, 'the files');
  const out: Record<string, string> = {};
  for (const file of Object.keys(PROJECTION_FILES).sort()) {
    const value = RENDERERS[PROJECTION_FILES[file] as ProjectionTarget](model);
    out[file] = typeof value === 'string' ? value : `${canonicalStringify(value)}\n`;
  }
  return out;
}
