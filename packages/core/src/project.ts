import type { Finding, Model, ProjectedFile, ProjectionTarget } from './generated/types.js';
import { FINDING, FINDING_RULES } from './codes.js';
import { validate } from './validate.js';
import { LoomInvalidModelError } from './errors.js';
import { canonicalStringify } from './canonical.js';
import { textHash } from './hash.js';
import { projectJsonSchema } from './projections/json.js';
import { projectOpenApi } from './projections/openapi.js';
import { projectSql, projectSqlContractTests } from './projections/sql.js';
import { projectPesterContractTests } from './projections/pester.js';
import { projectYaml } from './projections/yaml.js';
import { projectWorkflow } from './projections/mermaid.js';
import { projectReference } from './projections/reference.js';
import type { RenderContext, Unsupported } from './projections/context.js';

export { JSON_SCHEMA_ID } from './projections/json.js';
export { SOURCE_NOTICE } from './projections/notice.js';

type Renderer = (model: Model, ctx: RenderContext) => unknown;

/** json-schema and openapi return objects; every other target returns text ending in one newline. */
const RENDERERS: Partial<Record<ProjectionTarget, Renderer>> = {
  'json-schema': projectJsonSchema,
  openapi: projectOpenApi,
  sql: projectSql,
  'sql-contract-tests': projectSqlContractTests,
  'pester-contract-tests': projectPesterContractTests,
  yaml: projectYaml,
  workflow: projectWorkflow,
  reference: projectReference,
};

/** Every projection target this engine renders, in the order the CLI and MCP server list them. */
export const PROJECTION_TARGETS: readonly ProjectionTarget[] = Object.keys(RENDERERS) as ProjectionTarget[];

/** The file each target is written to by projectToFiles. */
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

export interface ProjectOptions {
  /** Render an explicitly incomplete draft instead of refusing an unsupported construct. A draft can neither qualify nor publish. */
  draft?: boolean;
}

const DRAFT_LINE = 'DRAFT: this artifact omits constructs its profile cannot express; it can neither qualify nor publish a contract.';

/** Insert the draft marker after the source notice, in the artifact's own comment syntax. */
function markDraft(target: ProjectionTarget, value: unknown): unknown {
  if (typeof value !== 'string') {
    const obj = { ...(value as Record<string, unknown>) };
    if (target === 'openapi') {
      const info = { ...(obj['info'] as Record<string, unknown>) };
      info['description'] = `${String(info['description'] ?? '')} ${DRAFT_LINE}`.trim();
      obj['info'] = info;
    } else obj['$comment'] = `${String(obj['$comment'] ?? '')} ${DRAFT_LINE}`.trim();
    return obj;
  }
  const [first, ...rest] = value.split('\n');
  const marker = first?.startsWith('--') ? `-- ${DRAFT_LINE}` : first?.startsWith('#') ? `# ${DRAFT_LINE}` : `<!-- ${DRAFT_LINE} -->`;
  return [first, marker, ...rest].join('\n');
}

function unsupportedFinding(target: ProjectionTarget, u: Unsupported): Finding {
  return {
    code: FINDING.PROFILE_UNSUPPORTED_CONSTRUCT,
    severity: FINDING_RULES.PROFILE_UNSUPPORTED_CONSTRUCT.severity,
    path: `${u.ref.kind}/${u.ref.id}`,
    message: `${target}: ${u.construct} is not expressible: ${u.reason}`,
    refs: [u.ref],
    fix: `change the model so ${target} can express it, or render an explicit draft`,
  };
}

function assertValid(model: Model, what: string): void {
  const findings = validate(model);
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  if (errorCount > 0) throw new LoomInvalidModelError(`refusing to project ${what}: model has ${errorCount} error finding(s)`, findings);
}

function renderValue(model: Model, target: ProjectionTarget, options: ProjectOptions): { value: unknown; findings: Finding[] } {
  const renderer = RENDERERS[target];
  if (!renderer) throw new Error(`unknown projection target: ${String(target)}; expected one of ${PROJECTION_TARGETS.join(', ')}`);
  const issues: Unsupported[] = [];
  const value = renderer(model, { unsupported: (construct, ref, reason) => issues.push({ construct, ref, reason }) });
  if (issues.length === 0) return { value, findings: [] };
  const findings = issues.map((u) => unsupportedFinding(target, u));
  if (!options.draft) throw new LoomInvalidModelError(`refusing to project '${target}': ${issues.length} construct(s) the profile cannot express`, findings);
  return {
    value: markDraft(target, value),
    findings: [
      ...findings.map((f) => ({ ...f, severity: FINDING_RULES.PROJECTION_DRAFT.severity })),
      { code: FINDING.PROJECTION_DRAFT, severity: FINDING_RULES.PROJECTION_DRAFT.severity, path: target, message: `${target} is an incomplete draft`, fix: 'resolve the unsupported constructs before publishing' },
    ],
  };
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : `${canonicalStringify(value)}\n`);

/**
 * Project the model to one target. Fail-closed: any error finding, or any
 * construct the target cannot express outside draft mode, throws
 * LoomInvalidModelError rather than emitting an artifact. Output is
 * deterministic; object results serialize with canonicalStringify.
 */
export function project(model: Model, target: ProjectionTarget, options: ProjectOptions = {}): unknown {
  assertValid(model, `'${target}'`);
  return renderValue(model, target, options).value;
}

export interface RenderedTarget {
  files: ProjectedFile[];
  draft: boolean;
  findings: Finding[];
}

function fileOf(target: ProjectionTarget): string {
  return Object.keys(PROJECTION_FILES).find((f) => PROJECTION_FILES[f] === target) as string;
}

/** One target as the files it writes, each with its exact text and hash. */
export function renderTarget(model: Model, target: ProjectionTarget, options: ProjectOptions = {}): RenderedTarget {
  assertValid(model, `'${target}'`);
  const { value, findings } = renderValue(model, target, options);
  const file = fileOf(target);
  const content = asText(value);
  return { files: [{ instance: file, file, content, hash: textHash(content) }], draft: findings.length > 0, findings };
}

/** Every target as files, sorted by file name. */
export function renderAll(model: Model, options: ProjectOptions = {}): RenderedTarget {
  assertValid(model, 'the files');
  const files: ProjectedFile[] = [];
  const findings: Finding[] = [];
  for (const file of Object.keys(PROJECTION_FILES).sort()) {
    const r = renderValue(model, PROJECTION_FILES[file] as ProjectionTarget, options);
    const content = asText(r.value);
    files.push({ instance: file, file, content, hash: textHash(content) });
    findings.push(...r.findings);
  }
  return { files, draft: findings.length > 0, findings };
}

/** Every projection keyed by file name, each as the exact text to write. Fail-closed like project(). */
export function projectToFiles(model: Model, options: ProjectOptions = {}): Record<string, string> {
  return Object.fromEntries(renderAll(model, options).files.map((f) => [f.file, f.content]));
}
