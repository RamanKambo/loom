import type { Completeness, DescribeData, DescribeInput, DescribeSection, Finding, NextAction, ProjectionTarget } from './generated/types.js';
import { CONTRACT_DIGEST } from './generated/digest.js';
import { SCHEMA_BUNDLE } from './generated/schemas.js';
import { COLLECTIONS, PATCH_VARIANTS } from './generated/registry.js';
import { PROFILES } from './generated/contracts.js';
import { AGENT_TOOLS, MCP_TOOLS, OPERATION_CATALOGUE, TOOL_EXAMPLES, WORKFLOW } from './generated/operations.js';
import { GUIDES } from './generated/guides.js';
import { FINDING_RULES } from './codes.js';
import { DIFF_RULES } from './field-policy.js';
import { PROJECTION_FILES, PROJECTION_TARGETS } from './project.js';
import { GUIDANCE_REVISION, ORIENTATION_TEXT } from './guidance.js';
import { checkContinuation, continuationToken, fillPage, nextAction, pageCompleteness, resolveBudget, type PageEntry } from './discovery.js';

/** Every tool the MCP server lists, in its order, with its effect on persisted state and the purpose of its operation. */
export const TOOL_SUMMARIES: NonNullable<DescribeData['tools']> = MCP_TOOLS.map((t) => ({
  name: t.name,
  effects: t.effects,
  purpose: (OPERATION_CATALOGUE.operations.find((o) => o.id === t.operation) as { purpose: string }).purpose,
}));

/** The sections of a full description in page order, the order of DescribeSection. */
export const DESCRIBE_SECTIONS = SCHEMA_BUNDLE.$defs.DescribeSection.enum as readonly DescribeSection[];

const TARGETS = SCHEMA_BUNDLE.$defs.ProjectionTarget.enum as readonly ProjectionTarget[];
const instancing = (t: ProjectionTarget): 'singleton' | 'per-component' => PROFILES.flatMap((p) => p.artifacts).find((a) => a.target === t)?.instancing ?? 'singleton';

/** The data member that carries each section. */
const SECTION_MEMBER: Record<DescribeSection, keyof DescribeData> = {
  records: 'records',
  patches: 'patchOperations',
  findings: 'findingCodes',
  comparison: 'comparisonRules',
  projections: 'projectionTargets',
  profiles: 'profiles',
  tools: 'tools',
  examples: 'examples',
  unavailable: 'unavailable',
  limits: 'proofLimits',
};

/**
 * The proof limits that apply to one operation, or with none every proof limit of this build, each
 * text once: the catalogue's limits, then each profile's, which apply to the operations the catalogue
 * marks as depending on profiles.
 */
export function proofLimits(operation?: string): string[] {
  const op = operation === undefined ? undefined : OPERATION_CATALOGUE.operations.find((o) => o.id === operation);
  const texts = [
    ...OPERATION_CATALOGUE.proofLimits.filter((p) => operation === undefined || p.operations.includes(operation)).map((p) => p.text),
    ...(operation === undefined || op?.dependsOnProfiles === true ? PROFILES.flatMap((p) => p.proofLimits) : []),
  ];
  return [...new Set(texts)];
}

/** The records of one section, each with the key an omission names it by. */
function sectionRecords(section: DescribeSection, profile?: string): Array<{ key: string; value: unknown }> {
  switch (section) {
    case 'records':
      return COLLECTIONS.map((c) => ({ key: c.collection, value: { collection: c.collection, kind: c.kind, definition: c.definition, key: [...c.key] } }));
    case 'patches':
      return PATCH_VARIANTS.map((v) => {
        const op: NonNullable<DescribeData['patchOperations']>[number] = { op: v.op, collection: v.collection ?? '(model)', definition: `patch.schema.json#/$defs/${v.definition}` };
        if (v.field) op.items = v.field;
        return { key: v.definition, value: op };
      });
    case 'findings':
      return Object.entries(FINDING_RULES).map(([code, r]) => ({ key: code, value: { code: code as keyof typeof FINDING_RULES, severity: r.severity, rule: r.rule } }));
    case 'comparison':
      return Object.entries(DIFF_RULES).map(([rule, r]) => ({ key: rule, value: { rule, kind: r.kind, dimension: r.dimension, description: r.change } }));
    case 'projections':
      return TARGETS.filter((t) => PROJECTION_TARGETS.includes(t)).map((t) => ({ key: t, value: { target: t, files: Object.keys(PROJECTION_FILES).filter((f) => PROJECTION_FILES[f] === t), instancing: instancing(t) } }));
    case 'profiles':
      return PROFILES.filter((p) => profile === undefined || p.id === profile).map((p) => ({ key: p.id, value: p }));
    case 'tools':
      return TOOL_SUMMARIES.map((t) => ({ key: t.name, value: t }));
    case 'examples':
      return TOOL_EXAMPLES.map((e, i) => ({ key: `${e.tool}#${i + 1}`, value: e }));
    case 'unavailable':
      return TARGETS.filter((t) => !PROJECTION_TARGETS.includes(t)).map((t) => ({ key: t, value: { feature: `projection target '${t}'`, reason: 'No renderer for this target is registered in this build.' } }));
    case 'limits':
      return proofLimits().map((text, i) => ({ key: String(i + 1), value: text }));
  }
}

/** The parts of the summary in page order; each part is one entry, its section's whole value. */
function summaryEntries(): PageEntry[] {
  const part = (member: keyof DescribeData, value: unknown): PageEntry => ({ member, section: member, key: '', value, single: true });
  return [
    part('orientation', ORIENTATION_TEXT),
    part('entryPoints', WORKFLOW),
    part('tools', TOOL_SUMMARIES),
    part('capabilities', { sections: DESCRIBE_SECTIONS.map((s) => ({ section: s, records: sectionRecords(s).length })), profiles: PROFILES.map((p) => p.id) }),
    part('guides', GUIDES.map((g) => ({ uri: g.uri, title: g.title, contentDigest: g.contentDigest }))),
    part('resources', OPERATION_CATALOGUE.resources.map((r) => ({ uri: r.uri, contents: r.contents, scope: r.scope, listed: r.exposure === 'listed' }))),
  ];
}

export type DescribeResult =
  | { ok: true; data: DescribeData; completeness: Completeness }
  | { ok: false; cause: 'invalid-input' | 'stale-base'; message: string; findings: Finding[]; nextActions: NextAction[] };

const finding = (path: string, message: string, fix: string): Finding => ({ code: 'STRUCTURAL_INVALID', severity: FINDING_RULES.STRUCTURAL_INVALID.severity, path, message, fix });

/**
 * One page of the description of this build, read from the generated contract, the operation
 * catalogue, the embedded guidance, the rule tables and the renderer registry, so it cannot disagree
 * with what runs. The summary is the default; 'full' pages through the requested sections and
 * 'operation' through the proof limits of one operation. A page stays within the budget, counted over
 * its data alone, and its completeness lists every part, section or record it leaves out. A cursor
 * binds the request and the revision of the build that issued it.
 */
export function describe(input: DescribeInput = {}): DescribeResult {
  const budget = resolveBudget(input.budget);
  const operation = input.operation;
  if (operation !== undefined && !OPERATION_CATALOGUE.operations.some((o) => o.id === operation)) {
    return { ok: false, cause: 'invalid-input', message: `the operation catalogue holds no operation '${operation}'`, findings: [finding('operation', `'${operation}' names no catalogue operation`, 'name an operation of the operation catalogue, such as project or validate')], nextActions: [] };
  }
  const detail = input.detail ?? 'summary';
  const sections: DescribeSection[] = operation !== undefined ? ['limits'] : detail === 'full' ? DESCRIBE_SECTIONS.filter((s) => input.sections === undefined || input.sections.includes(s)) : [];
  const entries: PageEntry[] =
    operation !== undefined
      ? proofLimits(operation).map((text, i) => ({ member: 'proofLimits', section: 'limits', key: String(i + 1), value: text }))
      : detail === 'summary'
        ? summaryEntries()
        : sections.flatMap((s) => sectionRecords(s, input.profile).map((r) => ({ member: SECTION_MEMBER[s], section: s, key: r.key, value: r.value })));
  const filters = { detail: operation === undefined ? detail : null, sections, profile: input.profile ?? null, operation: operation ?? null, budget };
  let offset = 0;
  if (input.cursor !== undefined) {
    const check = checkContinuation(input.cursor, 'describe', GUIDANCE_REVISION, filters, entries.length);
    if (!check.ok) {
      const { cursor: _cursor, ...again } = input;
      return {
        ok: false,
        cause: check.cause,
        message: check.message,
        findings: [check.cause === 'stale-base' ? { code: 'STALE_BASE_REVISION', severity: FINDING_RULES.STALE_BASE_REVISION.severity, path: 'cursor', message: check.message, fix: 'describe this build again from the first page' } : finding('cursor', check.message, 'send the cursor of the page before with the same request, or start again without one')],
        nextActions: [nextAction('Describe this build again from the first page of the same request.', 'loom.describe', again)],
      };
    }
    offset = check.offset;
  }
  const page = fillPage({ contractDigest: CONTRACT_DIGEST, resultVersion: 1, modelFormat: 1 }, entries, offset, budget);
  const continuation = page.next < entries.length ? continuationToken('describe', GUIDANCE_REVISION, filters, page.next) : undefined;
  const unrequested = operation === undefined && detail === 'summary' ? [...DESCRIBE_SECTIONS] : ['summary', ...DESCRIBE_SECTIONS.filter((s) => !sections.includes(s))];
  return { ok: true, data: page.data as unknown as DescribeData, completeness: pageCompleteness(entries, offset, page, continuation, unrequested) };
}

/** Every generated tool description: each MCP tool's, each agent tool's and each action's. */
export function toolDescriptions(): Array<{ name: string; description: string }> {
  return [
    ...MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    ...AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    ...AGENT_TOOLS.flatMap((t) => t.actions.map((a) => ({ name: `${t.name} ${a.action ?? a.operation}`, description: a.description }))),
  ];
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where generated tool descriptions break their rule: a description states its operation's purpose,
 * prerequisites, effects, important refusals and next action, and neither lists every profile nor
 * repeats a proof limit, which loom.describe returns per operation instead. Keeping both out keeps
 * every advertised tool small enough for the tool budget as profiles and limits grow.
 */
export function descriptionProblems(descriptions: ReadonlyArray<{ name: string; description: string }>): string[] {
  const limits = proofLimits();
  const ids = PROFILES.map((p) => new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(p.id)}([^A-Za-z0-9-]|$)`));
  const problems: string[] = [];
  for (const d of descriptions) {
    for (const limit of limits) if (d.description.includes(limit)) problems.push(`${d.name} repeats the proof limit '${limit}'`);
    if (ids.length > 0 && ids.every((re) => re.test(d.description))) problems.push(`${d.name} lists every profile`);
  }
  return problems;
}
