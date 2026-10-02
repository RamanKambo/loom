import {
  loadModel,
  validate,
  mutate,
  diff,
  project,
  projectToFiles,
  PROJECTION_TARGETS,
  exportModel,
  importModel,
  selfTest,
  canonicalStringify,
  type Patch,
  type ProjectionTarget,
} from '@loom/core';

/** Raw JSON-Schema input shape for a tool (the low-level SDK takes JSON Schema, not Zod). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

const modelProp = { type: 'object', description: 'A Loom model document.' };

export const TOOLS: ToolDefinition[] = [
  {
    name: 'loom.validate',
    description:
      'Validate a Loom model: structural meta-schema then every semantic rule (ownership, state legality, immutability, creation completeness, table ownership, routine write-set completeness, consumer bindings, workflow version pins and cycles, traceability). The model is valid iff there is no error finding; each finding carries a one-line fix.',
    inputSchema: { type: 'object', properties: { model: modelProp }, required: ['model'] },
  },
  {
    name: 'loom.mutate',
    description:
      'Apply one patch or an atomic batch of patches to a model and recompute the cascade. The batch is REFUSED (model: null) if any patch misses its target, if the result has any error finding, or if a breaking change to a type, operation or routine lacks a version bump or is not listed in acknowledgeBreaking. A correct breaking change must be one batch: bump the version, change the contract, update every bound consumer and pinned workflow import, and acknowledge each broken element. Returns findings (with fixes), the impact set, and every change classified breaking or compatible.',
    inputSchema: {
      type: 'object',
      properties: {
        model: modelProp,
        patch: { type: 'object', description: "A single Loom patch: { op, ... }. Provide 'patch' or 'patches', not both." },
        patches: {
          type: 'array',
          items: { type: 'object' },
          description: 'An atomic batch of Loom patches, applied to one copy in order.',
        },
        acknowledgeBreaking: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids of the elements whose breaking change is intended.',
        },
      },
      required: ['model'],
    },
  },
  {
    name: 'loom.diff',
    description:
      'Diff two models and classify each change as breaking or compatible, listing the affected consumers (reverse-reachability) for each breaking change.',
    inputSchema: {
      type: 'object',
      properties: { before: modelProp, after: modelProp },
      required: ['before', 'after'],
    },
  },
  {
    name: 'loom.project',
    description:
      'Project a model to one artifact. JSON targets (json-schema, openapi) return canonical JSON; the others return text: T-SQL DDL (sql), T-SQL conformance checks (sql-contract-tests), a Pester 5 conformance test file (pester-contract-tests), the model as YAML (yaml), Mermaid workflow diagrams (workflow) and a Markdown reference (reference). Fail-closed: refuses a model with any error finding.',
    inputSchema: {
      type: 'object',
      properties: {
        model: modelProp,
        target: { type: 'string', enum: [...PROJECTION_TARGETS] },
      },
      required: ['model', 'target'],
    },
  },
  {
    name: 'loom.projectAll',
    description:
      'Project a model to every artifact at once. Returns a map from file name (schema.json, openapi.json, schema.sql, contract-tests.sql, Routines.Contract.Tests.ps1, model.yaml, workflows.md, reference.md) to the exact file text. Fail-closed like loom.project.',
    inputSchema: { type: 'object', properties: { model: modelProp }, required: ['model'] },
  },
  {
    name: 'loom.export',
    description: 'Serialize a model to canonical, deterministic JSON. Fail-closed on an invalid model.',
    inputSchema: { type: 'object', properties: { model: modelProp }, required: ['model'] },
  },
  {
    name: 'loom.import',
    description: 'Parse and structurally validate a model from JSON or YAML text, returning the loaded model.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'loom.selftest',
    description:
      'Run the engine self-test (contradictions, determinism, round-trip, fail-closed projection). Returns the summary line, or the failure message.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export interface ToolResult {
  text: string;
  isError: boolean;
}

function ok(value: unknown): ToolResult {
  return { text: canonicalStringify(value), isError: false };
}

function fail(error: string): ToolResult {
  return { text: canonicalStringify({ error }), isError: true };
}

/**
 * selfTest() writes its summary with console.log. On a stdio MCP server stdout
 * is the JSON-RPC channel, so capture the output instead of letting it leak.
 */
function captureSelfTest(): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]): void => {
    lines.push(a.map((x) => String(x)).join(' '));
  };
  try {
    selfTest();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

/** Execute a tool by name against the pure core. Never throws; errors are returned as isError results. */
export function executeTool(name: string, args: Record<string, unknown>): ToolResult {
  try {
    switch (name) {
      case 'loom.validate': {
        const model = loadModel(args['model']);
        const findings = validate(model);
        const errorCount = findings.filter((f) => f.severity === 'error').length;
        return ok({ valid: errorCount === 0, errorCount, findings });
      }
      case 'loom.mutate': {
        const model = loadModel(args['model']);
        const hasPatch = args['patch'] !== undefined;
        const hasPatches = args['patches'] !== undefined;
        if (hasPatch === hasPatches) {
          return fail("provide exactly one of 'patch' (object) or 'patches' (array)");
        }
        if (hasPatches && !Array.isArray(args['patches'])) return fail("'patches' must be an array");
        const ack = args['acknowledgeBreaking'];
        if (ack !== undefined && !(Array.isArray(ack) && ack.every((x) => typeof x === 'string'))) {
          return fail("'acknowledgeBreaking' must be an array of element ids");
        }
        const patches = (hasPatches ? args['patches'] : args['patch']) as Patch | Patch[];
        const result = mutate(model, patches, { acknowledgeBreaking: ack as string[] | undefined });
        return ok({
          refused: result.model === null,
          impact: result.impact,
          findings: result.findings,
          changes: result.changes,
          model: result.model,
        });
      }
      case 'loom.diff': {
        const before = loadModel(args['before']);
        const after = loadModel(args['after']);
        const changes = diff(before, after);
        const breakingCount = changes.filter((c) => c.kind === 'breaking').length;
        return ok({ breakingCount, changes });
      }
      case 'loom.project': {
        const target = args['target'];
        if (typeof target !== 'string' || !(PROJECTION_TARGETS as readonly string[]).includes(target)) {
          return fail(`'target' must be one of ${PROJECTION_TARGETS.join(', ')}`);
        }
        const model = loadModel(args['model']);
        const artifact = project(model, target as ProjectionTarget);
        return typeof artifact === 'string' ? { text: artifact, isError: false } : ok(artifact);
      }
      case 'loom.projectAll': {
        const model = loadModel(args['model']);
        return ok(projectToFiles(model));
      }
      case 'loom.export': {
        const model = loadModel(args['model']);
        return { text: exportModel(model), isError: false };
      }
      case 'loom.import': {
        const model = importModel(String(args['text'] ?? ''));
        return ok(model);
      }
      case 'loom.selftest': {
        return { text: captureSelfTest(), isError: false };
      }
      default:
        return { text: canonicalStringify({ error: `unknown tool '${name}'` }), isError: true };
    }
  } catch (e) {
    const err = e as { message?: string; findings?: unknown };
    return {
      text: canonicalStringify({ error: err.message ?? String(e), findings: err.findings }),
      isError: true,
    };
  }
}
