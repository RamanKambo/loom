import type { CoverageItem, CoverageManifest, Finding, Model, ProjectedFile, ProjectionTarget, RecordKind, RecordRef, TypeDef } from './generated/types.js';
import { COLLECTIONS } from './generated/registry.js';
import { PROFILES, PROJECTION_PROFILES } from './generated/contracts.js';
import { FINDING, FINDING_RULES } from './codes.js';
import { validate } from './validate.js';
import { LoomInvalidModelError } from './errors.js';
import { canonicalStringify } from './canonical.js';
import { textHash } from './hash.js';
import { indexModel, recordKey, type CollectionName } from './records.js';
import { ownersOf, refKey } from './scope.js';
import { artifactInputs, type EvaluationInputs } from './inputs.js';
import { structuralFindings } from './load.js';
import { JSON_SCHEMA_FILE, projectJsonSchema } from './projections/json.js';
import { OPENAPI_FILE, projectOpenApi } from './projections/openapi.js';
import { SQL_SCHEMA_FILE, SQL_TESTS_FILE, projectSql, projectSqlContractTests, sqlDeploymentOrder } from './projections/sql.js';
import { PESTER_TESTS_FILE, projectPesterContractTests } from './projections/pester.js';
import { CSHARP_PROJECT_FILE, CSHARP_TESTS_FILE, projectCsharpContractTests } from './projections/csharp.js';
import { TYPESCRIPT_TESTS_FILE, projectTypescriptContractTests } from './projections/typescript.js';
import { YAML_FILE, projectYaml } from './projections/yaml.js';
import { WORKFLOW_FILE, projectWorkflow } from './projections/mermaid.js';
import { REFERENCE_FILE, projectReference } from './projections/reference.js';
import { ICD_FILE, projectIcd } from './projections/icd.js';
import { ARCHITECTURE_FILE, projectArchitecture } from './projections/architecture.js';
import { REGISTERS_FILE, projectRegisters } from './projections/registers.js';
import { COVERAGE_FILE, EVIDENCE_FILE, READINESS_FILE, evidenceIndexScope, projectCoverageMatrix, projectEvidenceIndex, projectReadinessReport } from './projections/reports.js';
import type { RenderContext, Unsupported } from './projections/context.js';

export { JSON_SCHEMA_ID } from './projections/json.js';
export { SOURCE_NOTICE } from './projections/notice.js';

/** A renderer's output: each file it writes, as an object (JSON artifacts) or text ending in one newline. */
export type RenderOutput = Readonly<Record<string, unknown>>;

export interface TargetSpec {
  files: readonly string[];
  render(model: Model, ctx: RenderContext): RenderOutput;
  /** Records one instance must project; `component` is absent for a singleton and means every component otherwise. */
  scope(model: Model, component: string | undefined): RecordRef[];
  /** Records the target never projects, with the reason. */
  excluded?(model: Model): Array<{ ref: RecordRef; reason: string }>;
}

const ref = (kind: RecordKind, id: string): RecordRef => ({ kind, id });
const owned = (component: string | undefined) => (r: { owner: string }): boolean => component === undefined || r.owner === component;
const typesAndProperties = (types: readonly TypeDef[]): RecordRef[] =>
  types.flatMap((t) => [ref('type', t.id), ...t.properties.map((p) => ref('property', `${t.id}.${p.name}`))]);
const isScript = (host: string): boolean => host === 'runbook' || host === 'function';

/** Every record of every top-level collection. */
function allRecords(model: Model): RecordRef[] {
  return COLLECTIONS.flatMap((c) =>
    ((model as unknown as Record<string, unknown[]>)[c.collection] ?? []).map((r) => ref(c.kind as RecordKind, recordKey(c.collection as CollectionName, r))),
  );
}

/** One entry per target; the Record type makes the registry exhaustive over the contract's targets. */
const TARGETS: Readonly<Record<ProjectionTarget, TargetSpec>> = {
  'json-schema': { files: [JSON_SCHEMA_FILE], render: projectJsonSchema, scope: (m) => typesAndProperties(m.types) },
  openapi: {
    files: [OPENAPI_FILE],
    render: projectOpenApi,
    scope: (m) => [
      ...typesAndProperties(m.types),
      ...m.operations.filter((o) => (o.bindings ?? []).some((b) => b.transport === 'http' && b.method && b.path)).map((o) => ref('operation', o.id)),
      ...m.securitySchemes.map((s) => ref('securityScheme', s.id)),
    ],
  },
  sql: { files: [SQL_SCHEMA_FILE], render: projectSql, scope: (m, c) => m.storage.filter(owned(c)).map((s) => ref('storage', s.id)) },
  'sql-contract-tests': {
    files: [SQL_TESTS_FILE],
    render: projectSqlContractTests,
    scope: (m, c) => [...m.routines.filter((r) => r.host === 'sql-procedure' && owned(c)(r)).map((r) => ref('routine', r.id)), ...m.storage.filter(owned(c)).map((s) => ref('storage', s.id))],
  },
  'pester-contract-tests': {
    files: [PESTER_TESTS_FILE],
    render: projectPesterContractTests,
    scope: (m, c) => m.routines.filter((r) => isScript(r.host) && r.source !== undefined && owned(c)(r)).map((r) => ref('routine', r.id)),
    excluded: (m) => m.routines.filter((r) => isScript(r.host) && r.source === undefined).map((r) => ({ ref: ref('routine', r.id), reason: 'declares no source file, so there is no script to check' })),
  },
  'csharp-contract-tests': { files: [CSHARP_TESTS_FILE, CSHARP_PROJECT_FILE], render: projectCsharpContractTests, scope: (m, c) => typesAndProperties(m.types.filter(owned(c))) },
  'typescript-contract-tests': { files: [TYPESCRIPT_TESTS_FILE], render: projectTypescriptContractTests, scope: (m, c) => typesAndProperties(m.types.filter(owned(c))) },
  yaml: { files: [YAML_FILE], render: projectYaml, scope: allRecords },
  workflow: {
    files: [WORKFLOW_FILE],
    render: projectWorkflow,
    scope: (m) => [...m.types.filter((t) => t.stateProperty !== undefined).map((t) => ref('type', t.id)), ...m.workflows.map((w) => ref('workflow', w.id))],
  },
  reference: {
    files: [REFERENCE_FILE],
    render: projectReference,
    scope: (m) => [
      ...m.components.map((c) => ref('component', c.id)),
      ...m.types.map((t) => ref('type', t.id)),
      ...m.storage.map((s) => ref('storage', s.id)),
      ...m.operations.map((o) => ref('operation', o.id)),
      ...m.routines.map((r) => ref('routine', r.id)),
      ...m.mutations.map((x) => ref('mutation', x.id)),
      ...m.workflows.map((w) => ref('workflow', w.id)),
      ...m.requirements.map((r) => ref('requirement', r.id)),
    ],
  },
  icd: {
    files: [ICD_FILE],
    render: projectIcd,
    scope: (m, c) => [
      ...m.components.filter((x) => c === undefined || x.id === c).map((x) => ref('component', x.id)),
      ...m.operations.filter(owned(c)).map((o) => ref('operation', o.id)),
      ...m.routines.filter(owned(c)).map((r) => ref('routine', r.id)),
      ...m.types.filter(owned(c)).map((t) => ref('type', t.id)),
      ...m.storage.filter(owned(c)).map((s) => ref('storage', s.id)),
      ...m.mutations.filter(owned(c)).map((x) => ref('mutation', x.id)),
    ],
  },
  architecture: {
    files: [ARCHITECTURE_FILE],
    render: projectArchitecture,
    scope: (m) => [
      ...m.components.map((c) => ref('component', c.id)),
      ...m.edges.map((e) => ref('edge', `${e.from}|${e.to}|${e.kind}`)),
      ...m.deploymentUnits.map((u) => ref('deploymentUnit', u.id)),
      ...m.hosts.map((h) => ref('host', h.id)),
      ...m.trustBoundaries.map((b) => ref('trustBoundary', b.id)),
    ],
  },
  registers: {
    files: [REGISTERS_FILE],
    render: projectRegisters,
    scope: (m) => [
      ...m.decisions.map((d) => ref('decision', d.id)),
      ...m.unknowns.map((u) => ref('unknown', u.id)),
      ...m.assumptions.map((a) => ref('assumption', a.id)),
      ...m.constraints.map((c) => ref('constraint', c.id)),
      ...m.migrations.map((x) => ref('migration', x.id)),
    ],
  },
  'readiness-report': {
    files: [READINESS_FILE],
    render: projectReadinessReport,
    scope: (m) => [...m.components.map((c) => ref('component', c.id)), ...m.migrations.map((x) => ref('migration', x.id))],
  },
  'coverage-matrix': {
    files: [COVERAGE_FILE],
    render: projectCoverageMatrix,
    scope: (m) => [
      ...m.requirements.map((r) => ref('requirement', r.id)),
      ...m.requirements.flatMap((r) => r.criteria.map((c) => ref('criterion', c.id))),
      ...m.scenarios.map((s) => ref('scenario', s.id)),
    ],
  },
  'evidence-index': { files: [EVIDENCE_FILE], render: projectEvidenceIndex, scope: evidenceIndexScope },
};

/** Every projection target this engine renders, in the order the CLI and MCP server list them. */
export const PROJECTION_TARGETS: readonly ProjectionTarget[] = Object.keys(TARGETS) as ProjectionTarget[];

/** The target each generated file name belongs to; a multi-file target lists every file it writes. */
export const PROJECTION_FILES: Readonly<Record<string, ProjectionTarget>> = Object.fromEntries(
  (Object.entries(TARGETS) as Array<[ProjectionTarget, TargetSpec]>).flatMap(([target, spec]) => spec.files.map((f) => [f, target])),
);

/** The file names a target writes. */
export const filesOf = (target: ProjectionTarget): readonly string[] => TARGETS[target].files;

const IMPLEMENTATION_LANGUAGES = new Set(['sql', 'powershell', 'csharp', 'typescript']);

export interface ArtifactProfile {
  instancing: 'singleton' | 'per-component';
  /** Implementation language a component must declare to receive an instance. */
  language?: string;
}

/** Instancing and language of a target, read from the profile definitions that declare it. */
export function artifactProfile(target: ProjectionTarget): ArtifactProfile {
  for (const p of PROFILES) {
    const a = p.artifacts.find((x) => x.target === target);
    if (!a) continue;
    const out: ArtifactProfile = { instancing: a.instancing };
    if (a.instancing === 'per-component' && p.language && IMPLEMENTATION_LANGUAGES.has(p.language)) out.language = p.language;
    return out;
  }
  return { instancing: 'singleton' };
}

/** How the profiles that declare a target treat an unsupported construct: refuse, or permit an explicit draft. */
function constructPolicy(target: ProjectionTarget, construct: string): 'fail' | 'draft' | undefined {
  for (const p of PROFILES) {
    if (!p.artifacts.some((a) => a.target === target)) continue;
    const u = p.unsupported.find((x) => x.construct === construct);
    if (u) return u.onUse;
  }
  return undefined;
}

/** Constructs any profile declaring the target lists as unsupported. */
export function unsupportedConstructs(target: ProjectionTarget): string[] {
  return [...new Set(PROFILES.filter((p) => p.artifacts.some((a) => a.target === target)).flatMap((p) => p.unsupported.map((u) => u.construct)))].sort();
}

/**
 * The instances of a target: one singleton, or one per component with
 * records in scope that, for a language artifact, declares that language.
 * SQL instances come in foreign-key deployment order.
 */
export function instancesOf(model: Model, target: ProjectionTarget): Array<string | undefined> {
  const profile = artifactProfile(target);
  if (profile.instancing === 'singleton') return [undefined];
  const spec = TARGETS[target];
  let ids = model.components
    .filter((c) => profile.language === undefined || (c.implementations ?? []).some((i) => i.language === profile.language))
    .map((c) => c.id)
    .filter((id) => spec.scope(model, id).length > 0);
  if (profile.language === 'sql') {
    const order = sqlDeploymentOrder(model);
    ids = [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))];
  }
  return ids;
}

/** Enabled targets of a projection profile; an unknown profile enables nothing. */
export function enabledTargets(projectionProfileId: string): ProjectionTarget[] {
  return [...(PROJECTION_PROFILES.find((p) => p.id === projectionProfileId)?.enables ?? [])];
}

/** Workspace-relative path of a projected file: '<component>/<file>' for a per-component instance. */
export const projectedPath = (f: Pick<ProjectedFile, 'file' | 'component'>): string => (f.component ? `${f.component}/${f.file}` : f.file);

export interface ProjectOptions {
  /** Render an explicitly incomplete draft where the profile permits it. A draft can neither qualify nor publish. */
  draft?: boolean;
  /** Baselines, acceptance, evidence and policy for the views that report readiness and evidence. */
  inputs?: EvaluationInputs;
}

const DRAFT_LINE = 'DRAFT: this artifact omits constructs its profile cannot express; it can neither qualify nor publish a contract.';

/** Insert the draft marker after the source notice, in the artifact's own comment syntax. */
function markDraft(file: string, value: unknown): unknown {
  if (typeof value !== 'string') {
    const obj = { ...(value as Record<string, unknown>) };
    if ('openapi' in obj) {
      const info = { ...(obj['info'] as Record<string, unknown>) };
      info['description'] = `${String(info['description'] ?? '')} ${DRAFT_LINE}`.trim();
      obj['info'] = info;
    } else obj['$comment'] = `${String(obj['$comment'] ?? '')} ${DRAFT_LINE}`.trim();
    return obj;
  }
  const [first, ...rest] = value.split('\n');
  const marker = /\.sql$/.test(file) ? `-- ${DRAFT_LINE}` : /\.(ps1|ya?ml)$/.test(file) ? `# ${DRAFT_LINE}` : /\.(cs|ts)$/.test(file) ? `// ${DRAFT_LINE}` : `<!-- ${DRAFT_LINE} -->`;
  return [first, marker, ...rest].join('\n');
}

function finding(code: Finding['code'], path: string, message: string, fix: string, refs: RecordRef[] = []): Finding {
  const f: Finding = { code, severity: FINDING_RULES[code].severity, path, message, fix };
  if (refs.length) f.refs = refs;
  return f;
}

const unsupportedFinding = (target: ProjectionTarget, u: Unsupported): Finding =>
  finding(FINDING.PROFILE_UNSUPPORTED_CONSTRUCT, `${u.ref.kind}/${u.ref.id}`, `${target}: ${u.construct} is not expressible: ${u.reason}`, `change the model so ${target} can express it, or render an explicit draft where the profile permits one`, [u.ref]);

function assertValid(model: Model, what: string): void {
  const findings = validate(model);
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  if (errorCount > 0) throw new LoomInvalidModelError(`refusing to project ${what}: model has ${errorCount} error finding(s)`, findings);
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : `${canonicalStringify(value)}\n`);

/** The value at a JSON Pointer, or undefined when the pointer does not resolve. */
function atPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let node: unknown = value;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

interface RenderedFile extends ProjectedFile {
  /** The renderer's value before serialization: an object for JSON artifacts, otherwise the text. */
  value: unknown;
}

export interface RenderedTarget {
  files: ProjectedFile[];
  draft: boolean;
  findings: Finding[];
  coverage: CoverageManifest;
}

interface RenderedSpec extends RenderedTarget {
  rendered: RenderedFile[];
}

/**
 * Render one target with a given spec. Fail-closed: a construct the profile
 * refuses throws; a record in scope that the output does not hold, or a
 * coverage location the output does not contain, throws with
 * PROJECTION_COVERAGE_LOSS, so no in-scope record can silently disappear.
 */
export function renderWithSpec(model: Model, target: ProjectionTarget, spec: TargetSpec, options: ProjectOptions = {}): RenderedSpec {
  const index = indexModel(model);
  const rendered: RenderedFile[] = [];
  const findings: Finding[] = [];
  const items: CoverageItem[] = [];
  const losses: Finding[] = [];
  const refused: Finding[] = [];
  const inScope = new Set<string>();
  let draft = false;

  for (const component of instancesOf(model, target)) {
    const covered = new Map<string, Array<{ file: string; location: string }>>();
    const unsupported: Unsupported[] = [];
    const ctx: RenderContext = {
      unsupported: (construct, r, reason) => unsupported.push({ construct, ref: r, reason }),
      covered: (r, file, ...locations) => {
        const list = covered.get(refKey(r)) ?? [];
        list.push(...locations.map((location) => ({ file, location })));
        covered.set(refKey(r), list);
      },
    };
    if (component !== undefined) ctx.component = component;
    if (options.inputs !== undefined) ctx.inputs = options.inputs;
    const output = spec.render(model, ctx);
    const instanceDraft = unsupported.length > 0;
    for (const u of unsupported) {
      const policy = constructPolicy(target, u.construct);
      if (policy !== 'draft' || !options.draft) refused.push(unsupportedFinding(target, u));
    }
    const instanceOf = (file: string): string => (component ? `${file}#${component}` : file);
    for (const file of spec.files) {
      if (!(file in output)) throw new Error(`renderer for '${target}' wrote no '${file}'`);
      const value = instanceDraft ? markDraft(file, output[file]) : output[file];
      const content = asText(value);
      const f: RenderedFile = { instance: instanceOf(file), file, content, hash: textHash(content), value };
      if (component) f.component = component;
      rendered.push(f);
    }
    if (instanceDraft) draft = true;

    const unsupportedReasons = new Map<string, string[]>();
    for (const u of unsupported) unsupportedReasons.set(refKey(u.ref), [...(unsupportedReasons.get(refKey(u.ref)) ?? []), `${u.construct}: ${u.reason}`]);
    for (const r of spec.scope(model, component)) {
      const key = refKey(r);
      inScope.add(key);
      const reasons = unsupportedReasons.get(key);
      if (reasons) {
        items.push({ ref: r, status: 'unsupported', reason: reasons.join('; ') });
        continue;
      }
      const at = covered.get(key);
      if (!at?.length) {
        losses.push(finding(FINDING.PROJECTION_COVERAGE_LOSS, `${r.kind}/${r.id}`, `${target}${component ? ` for component ${component}` : ''} does not project ${r.kind} '${r.id}', which is in scope`, 'report the projection as an engine defect; the record must be projected or reported unsupported', [r]));
        continue;
      }
      const missing = at.filter(({ file, location }) => {
        const value = output[file];
        if (value === undefined) return true;
        return typeof value === 'string' ? !value.includes(location) : atPointer(value, location) === undefined;
      });
      if (missing.length) {
        losses.push(finding(FINDING.PROJECTION_COVERAGE_LOSS, `${r.kind}/${r.id}`, `${target} claims ${r.kind} '${r.id}' at ${missing.map((m) => `${m.file} ${JSON.stringify(m.location)}`).join(', ')}, which the output does not hold`, 'report the projection as an engine defect; every coverage location must be present in the output', [r]));
        continue;
      }
      items.push({ ref: r, status: 'projected', locations: at.map(({ file, location }) => `${instanceOf(file)} ${location}`) });
    }
  }

  if (refused.length) throw new LoomInvalidModelError(`refusing to project '${target}': ${refused.length} construct(s) the profile cannot express${options.draft ? ' even as a draft' : ''}`, refused);
  if (losses.length) throw new LoomInvalidModelError(`refusing to project '${target}': ${losses.length} in-scope record(s) are missing from the output`, losses);

  const profile = artifactProfile(target);
  const outOfScope: Array<{ ref: RecordRef; reason: string }> = [...(spec.excluded?.(model) ?? [])];
  if (profile.instancing === 'per-component' && profile.language) {
    for (const r of spec.scope(model, undefined)) {
      if (inScope.has(refKey(r))) continue;
      const owner = ownersOf(index, r)[0];
      outOfScope.push({ ref: r, reason: owner ? `component '${owner}' declares no ${profile.language} implementation` : `no component declaring a ${profile.language} implementation owns it` });
    }
  }
  for (const o of outOfScope) if (!inScope.has(refKey(o.ref))) items.push({ ref: o.ref, status: 'out-of-scope', reason: o.reason });

  if (draft) {
    findings.push(finding(FINDING.PROJECTION_DRAFT, target, `${target} is an incomplete draft`, 'resolve the unsupported constructs before publishing'));
    for (const i of items) if (i.status === 'unsupported') findings.push({ ...finding(FINDING.PROFILE_UNSUPPORTED_CONSTRUCT, `${i.ref.kind}/${i.ref.id}`, `${target}: ${i.reason ?? ''}`, 'resolve the construct before publishing', [i.ref]), severity: FINDING_RULES.PROJECTION_DRAFT.severity });
  }
  const coverage: CoverageManifest = { target, complete: !items.some((i) => i.status === 'unsupported'), items };
  return { files: rendered.map(({ value: _value, ...f }) => f), rendered, draft, findings, coverage };
}

function renderOne(model: Model, target: ProjectionTarget, options: ProjectOptions): RenderedSpec {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`unknown projection target: ${String(target)}; expected one of ${PROJECTION_TARGETS.join(', ')}`);
  return renderWithSpec(model, target, spec, options);
}

/**
 * Project the model to one target. Fail-closed: any error finding, any
 * construct the target's profile refuses, or any in-scope record missing from
 * the output throws LoomInvalidModelError rather than emitting an artifact.
 * A singleton one-file target returns its value (an object for JSON targets,
 * text otherwise); any other target returns its values keyed by instance id.
 */
export function project(model: Model, target: ProjectionTarget, options: ProjectOptions = {}): unknown {
  assertValid(model, `'${target}'`);
  const r = renderOne(model, target, options);
  if (artifactProfile(target).instancing === 'singleton' && TARGETS[target].files.length === 1) return r.rendered[0]!.value;
  return Object.fromEntries(r.rendered.map((f) => [f.instance, f.value]));
}

/** One target as the files it writes, each with its exact text and hash, and its coverage manifest. */
export function renderTarget(model: Model, target: ProjectionTarget, options: ProjectOptions = {}): RenderedTarget {
  assertValid(model, `'${target}'`);
  const { rendered: _rendered, ...r } = renderOne(model, target, options);
  return r;
}

export interface RenderedBundle {
  files: ProjectedFile[];
  draft: boolean;
  findings: Finding[];
  coverage: CoverageManifest[];
}

/** Every target (or the given targets) as files, sorted by path, with one coverage manifest per target. */
export function renderAll(model: Model, options: ProjectOptions & { targets?: readonly ProjectionTarget[] } = {}): RenderedBundle {
  assertValid(model, 'the files');
  const files: ProjectedFile[] = [];
  const findings: Finding[] = [];
  const coverage: CoverageManifest[] = [];
  let draft = false;
  for (const target of options.targets ?? PROJECTION_TARGETS) {
    const r = renderOne(model, target, options);
    files.push(...r.files);
    findings.push(...r.findings);
    coverage.push(r.coverage);
    draft ||= r.draft;
  }
  files.sort((a, b) => (projectedPath(a) < projectedPath(b) ? -1 : projectedPath(a) > projectedPath(b) ? 1 : 0));
  return { files, draft, findings, coverage };
}

/** Every projection keyed by its relative path ('<component>/<file>' for a per-component instance), each as the exact text to write. Fail-closed like project(). */
export function projectToFiles(model: Model, options: ProjectOptions & { targets?: readonly ProjectionTarget[] } = {}): Record<string, string> {
  return Object.fromEntries(renderAll(model, options).files.map((f) => [projectedPath(f), f.content]));
}

/**
 * The inputs with the current hash of every artifact instance their evidence
 * names, rendered from `model` as a qualification run renders it
 * (`artifactInputs`), so evidence about an artifact goes stale when the model
 * changes what that artifact holds. An instance the model cannot render gets
 * no hash, which leaves the evidence about it unknown rather than current.
 */
export function withArtifactHashes(model: Model, inputs: EvaluationInputs): EvaluationInputs {
  const { artifacts: _replaced, ...rest } = inputs;
  const named = new Set((inputs.evidence ?? []).flatMap((e) => e.record.inputs.filter((i) => i.ref.startsWith('artifact:')).map((i) => i.ref.slice('artifact:'.length))));
  if (!named.size || structuralFindings(model).length) return rest;
  const rendering = artifactInputs(inputs);
  const artifacts: Record<string, string> = {};
  const targets = new Set([...named].map((instance) => PROJECTION_FILES[instance.split('#')[0] as string]).filter((t): t is ProjectionTarget => t !== undefined));
  for (const target of targets) {
    try {
      for (const f of renderTarget(model, target, rendering ? { inputs: rendering } : {}).files) if (named.has(f.instance)) artifacts[f.instance] = f.hash;
    } catch (e) {
      if (!(e instanceof LoomInvalidModelError)) throw e;
    }
  }
  return { ...rest, artifacts };
}
