import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { diff, renderTarget, type Change, type Model } from '@loom/core';
import { filesOfTarget } from '../artifacts.js';
import { exec, firstErrorLine } from '../exec.js';
import { outcome, type Runner } from '../types.js';

interface OpenApiDoc {
  paths?: Record<string, Record<string, { operationId?: string; parameters?: Array<{ name: string; in: string }> }>>;
}

const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

/** Templated paths whose operations do not declare every path parameter, and repeated operation ids. */
function structuralProblems(doc: OpenApiDoc): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const vars = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      const declared = new Set((op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name));
      const missing = vars.filter((v) => !declared.has(v));
      if (missing.length) problems.push(`${method.toUpperCase()} ${path} does not declare path parameter(s) ${missing.join(', ')}`);
      if (op.operationId) {
        const prior = seen.get(op.operationId);
        if (prior) problems.push(`operationId ${op.operationId} is used by both ${prior} and ${method.toUpperCase()} ${path}`);
        else seen.set(op.operationId, `${method.toUpperCase()} ${path}`);
      }
    }
  }
  return problems;
}

const openapiValidate: Runner = async (ctx) => {
  const files = filesOfTarget(ctx.artifacts, 'openapi');
  if (!files.length) return outcome('NOT_APPLICABLE', 'no operation has an HTTP binding');
  const doc = JSON.parse(files[0]!.content) as OpenApiDoc;
  const own = structuralProblems(doc);
  try {
    // swagger-parser dereferences in place; it validates a copy so the reported document stays as rendered.
    const api = (await SwaggerParser.validate(JSON.parse(files[0]!.content))) as OpenApiDoc;
    if (own.length) return outcome('FAIL', own.join('; '));
    return outcome('PASS', `the document validates against OpenAPI 3.1 (swagger-parser ${ctx.tool.version}); ${Object.keys(api.paths ?? {}).length} path(s), every templated path declares its parameters and every operationId is unique`);
  } catch (e) {
    return outcome('FAIL', `swagger-parser ${ctx.tool.version} rejects the document: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}${own.length ? `; ${own.join('; ')}` : ''}`);
  }
};

/** One oasdiff finding in its JSON output. Level 3 is an error, a breaking change; level 2 a warning. */
export interface OasdiffItem {
  id: string;
  text?: string;
  level: number;
  operation?: string;
  operationId?: string;
  path?: string;
}

/** Operation ids the model comparison reports a breaking change for, directly or as an affected consumer. */
function breakingOperations(changes: readonly Change[]): Set<string> {
  const ops = new Set<string>();
  for (const c of changes.filter((x) => x.kind === 'breaking')) {
    if (c.elementKind === 'operation') ops.add(c.element);
    for (const a of c.consumers) if (a.ref.kind === 'operation') ops.add(a.ref.id);
  }
  return ops;
}

/**
 * Every breaking item oasdiff reports that the model comparison does not also
 * report for the same operation. An unmatched item means the model comparison
 * missed a document-level break, so it fails the check.
 */
export function unmatchedBreaks(items: readonly OasdiffItem[], changes: readonly Change[], candidate: Model, baseline: Model): OasdiffItem[] {
  const ops = breakingOperations(changes);
  const byRoute = new Map<string, string>();
  for (const m of [baseline, candidate]) {
    for (const op of m.operations) for (const b of op.bindings ?? []) if (b.transport === 'http' && b.method && b.path) byRoute.set(`${b.method.toLowerCase()} ${b.path}`, op.id);
  }
  return items
    .filter((i) => i.level >= 3)
    .filter((i) => {
      const id = i.operationId ?? (i.operation && i.path ? byRoute.get(`${i.operation.toLowerCase()} ${i.path}`) : undefined);
      return !(id && ops.has(id));
    });
}

const openapiCompatibility: Runner = async (ctx) => {
  const pair = ctx.fixtures.compatibility ?? (ctx.fixtures.baseline ? { baseline: ctx.fixtures.baseline, candidate: ctx.model } : null);
  if (!pair) return outcome('NOT_APPLICABLE', 'no accepted baseline document exists to compare the candidate document against');
  const base = renderTarget(pair.baseline, 'openapi', { inputs: ctx.inputs }).files[0];
  const rev = renderTarget(pair.candidate, 'openapi', { inputs: ctx.inputs }).files[0];
  if (!base || !rev) return outcome('NOT_APPLICABLE', 'one side of the comparison has no HTTP binding');
  const basePath = join(ctx.dir, 'baseline.openapi.json');
  const revPath = join(ctx.dir, 'candidate.openapi.json');
  writeFileSync(basePath, base.content, 'utf8');
  writeFileSync(revPath, rev.content, 'utf8');
  const r = await exec(ctx.tool.path, ['breaking', basePath, revPath, '--format', 'json', '--allow-external-refs=false'], { cwd: ctx.dir, timeoutMs: ctx.timeoutMs, signal: ctx.signal });
  if (!r.ok) return outcome('UNKNOWN', r.reason);
  if (r.status !== 0) return outcome('UNKNOWN', `oasdiff exited ${r.status}: ${firstErrorLine(`${r.stdout}\n${r.stderr}`)}`);
  let items: OasdiffItem[];
  try {
    const parsed = JSON.parse(r.stdout.trim() || '[]') as unknown;
    if (!Array.isArray(parsed)) return outcome('UNKNOWN', 'oasdiff did not return a JSON list');
    items = parsed as OasdiffItem[];
  } catch {
    return outcome('UNKNOWN', 'oasdiff returned unreadable JSON');
  }
  const changes = diff(pair.baseline, pair.candidate);
  const unmatched = unmatchedBreaks(items, changes, pair.candidate, pair.baseline);
  const errors = items.filter((i) => i.level >= 3).length;
  const warnings = items.filter((i) => i.level === 2).length;
  const tool = { name: 'oasdiff', version: ctx.tool.version };
  if (unmatched.length) {
    return outcome('FAIL', `oasdiff reports ${unmatched.length} breaking change(s) the model comparison does not: ${unmatched.slice(0, 5).map((i) => `${i.id} ${i.operation ?? ''} ${i.path ?? ''}`.trim()).join('; ')}`, { tool });
  }
  return outcome('PASS', `oasdiff ${ctx.tool.version} reports ${errors} breaking change(s) and ${warnings} warning(s), every breaking one also reported by the model comparison (${changes.filter((c) => c.kind === 'breaking').length} breaking model change(s))`, {
    tool,
    // An explicit pair compares its own models; the run model's records and artifacts were not inputs.
    ...(pair.candidate === ctx.model ? { records: pair.candidate.operations.map((o) => `operation:${o.id}`) } : { records: [], instances: [] }),
  });
};

export const OPENAPI_RUNNERS: Readonly<Record<string, Runner>> = {
  'openapi-validate': openapiValidate,
  'openapi-compatibility': openapiCompatibility,
};
