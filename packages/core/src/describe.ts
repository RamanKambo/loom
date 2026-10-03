import type { DescribeData, DescribeInput, ProjectionTarget } from './generated/types.js';
import { CONTRACT_DIGEST } from './generated/digest.js';
import { SCHEMA_BUNDLE } from './generated/schemas.js';
import { COLLECTIONS, PATCH_VARIANTS } from './generated/registry.js';
import { PROFILES } from './generated/contracts.js';
import { MCP_TOOLS, TOOL_EXAMPLES } from './generated/operations.js';
import { FINDING_RULES } from './codes.js';
import { DIFF_RULES } from './field-policy.js';
import { PROJECTION_FILES, PROJECTION_TARGETS } from './project.js';

/** Every tool the shared services expose, in the order the MCP server lists them, with its effect on persisted state. */
export const TOOL_EFFECTS: DescribeData['tools'] = MCP_TOOLS.map((t) => ({ name: t.name, effects: t.effects }));

const LIMITS: readonly string[] = [
  'Model validation establishes conformance to the declared rule set; it does not establish that the requirements are correct or complete.',
  'Generated-file equality establishes that artifacts match their inputs, not that an implementation conforms.',
  'Readiness, acceptance and qualification are evaluated only over the baseline, acceptance, evidence and policy records supplied; their provenance is verified by the adapter.',
  'A prose predicate is never evaluated; an expression predicate is type-checked, never run against live data.',
];

/**
 * The capabilities this build supports, read from the generated contract, the
 * operation catalogue, the rule tables and the renderer registry, so the
 * description cannot disagree with what runs.
 */
export function describe(input: DescribeInput = {}): DescribeData {
  const want = (section: NonNullable<DescribeInput['sections']>[number]): boolean => !input.sections || input.sections.includes(section);
  const targets = SCHEMA_BUNDLE.$defs.ProjectionTarget.enum as readonly ProjectionTarget[];
  const profiles = input.profile ? PROFILES.filter((p) => p.id === input.profile) : PROFILES;
  const instancing = (t: ProjectionTarget): 'singleton' | 'per-component' => (PROFILES.flatMap((p) => p.artifacts).find((a) => a.target === t)?.instancing ?? 'singleton');
  return {
    contractDigest: CONTRACT_DIGEST,
    resultVersion: 1,
    modelFormat: 1,
    records: want('records') ? COLLECTIONS.map((c) => ({ collection: c.collection, kind: c.kind, definition: c.definition, key: [...c.key] })) : [],
    patchOperations: want('patches')
      ? PATCH_VARIANTS.map((v) => {
          const op: DescribeData['patchOperations'][number] = { op: v.op, collection: v.collection ?? '(model)', definition: `patch.schema.json#/$defs/${v.definition}` };
          if (v.field) op.items = v.field;
          return op;
        })
      : [],
    findingCodes: want('findings') ? Object.entries(FINDING_RULES).map(([code, r]) => ({ code: code as keyof typeof FINDING_RULES, severity: r.severity, rule: r.rule })) : [],
    comparisonRules: want('comparison') ? Object.entries(DIFF_RULES).map(([rule, r]) => ({ rule, kind: r.kind, dimension: r.dimension, description: r.change })) : [],
    projectionTargets: want('projections')
      ? targets.filter((t) => PROJECTION_TARGETS.includes(t)).map((t) => ({ target: t, files: Object.keys(PROJECTION_FILES).filter((f) => PROJECTION_FILES[f] === t), instancing: instancing(t) }))
      : [],
    profiles: want('profiles') ? [...profiles] : [],
    tools: want('tools') ? TOOL_EFFECTS : [],
    examples: want('examples') ? TOOL_EXAMPLES : [],
    unavailable: targets.filter((t) => !PROJECTION_TARGETS.includes(t)).map((t) => ({ feature: `projection target '${t}'`, reason: 'No renderer for this target is registered in this build.' })),
    proofLimits: want('limits') ? [...LIMITS, ...PROFILES.flatMap((p) => p.proofLimits)] : [],
  };
}
