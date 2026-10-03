import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONTRACT_DIGEST, SCHEMA_BUNDLE, contextTool, sampleModel, schemaErrors, validate } from '@loom/core';
import type { Finding, MetricsReport, Model, RunRecord } from '@loom/core';
import { ENGINE_VERSION } from '@loom/workspace';

/** Recorded measurement a later run compares against, so a report never stands without its explicit baseline. */
export const METRICS_FILE = 'qualification/metrics.json';

interface FixtureCase {
  id: string;
  model?: string;
  baseline?: string;
  patches?: string;
  expect: { validation?: 'valid' | 'invalid' | null; mustInclude?: Array<string | { code: string }>; readiness?: unknown[]; qualification?: unknown };
}

const codeOf = (x: string | { code: string }): string => (typeof x === 'string' ? x : x.code);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

/**
 * Fixture cases that validation alone decides: a model with no baseline, patch,
 * readiness or qualification expectation. A negative case is detected when every
 * expected code is raised; a positive case is accepted when no error is raised.
 */
function validationCases(root: string): { seeded: MetricsReport['seededErrors']; legitimate: MetricsReport['legitimateChanges'] } {
  const seeded: MetricsReport['seededErrors'] = { cases: 0, intended: 0, missed: [] };
  const legitimate: MetricsReport['legitimateChanges'] = { cases: 0, intended: 0, missed: [] };
  const dir = join(root, 'qualification', 'fixtures');
  if (!existsSync(dir)) return { seeded, legitimate };
  for (const set of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const expected = join(dir, set, 'expected.json');
    if (!existsSync(expected)) continue;
    for (const c of readJson<{ cases: FixtureCase[] }>(expected).cases) {
      if (!c.model || c.baseline || c.patches || c.expect.readiness?.length || c.expect.qualification) continue;
      const model = readJson<Model>(join(dir, set, ...c.model.split('/')));
      if (schemaErrors('Model', model).length) continue;
      const findings: Finding[] = validate(model);
      const raised = new Set(findings.map((f) => f.code as string));
      const id = `${set}/${c.id}`;
      const must = (c.expect.mustInclude ?? []).map(codeOf);
      if (must.length) {
        seeded.cases++;
        if (must.every((m) => raised.has(m))) seeded.intended++;
        else seeded.missed.push(id);
      } else if (c.expect.validation === 'valid') {
        legitimate.cases++;
        if (!findings.some((f) => f.severity === 'error')) legitimate.intended++;
        else legitimate.missed.push(id);
      }
    }
  }
  return { seeded, legitimate };
}

/** Hand-written declarations that restate a contract definition by name, outside the generated files. */
function manualDuplication(root: string): MetricsReport['manualDuplication'] {
  const defs = new Set(Object.keys(SCHEMA_BUNDLE.$defs));
  const files: string[] = [];
  let count = 0;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!['generated', 'node_modules', 'dist', 'test'].includes(e.name)) walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        const text = readFileSync(p, 'utf8');
        const hits = [...text.matchAll(/^export\s+(?:interface|type)\s+([A-Z][A-Za-z0-9]*)\b/gm)].filter((m) => defs.has(m[1] as string));
        if (hits.length) {
          count += hits.length;
          files.push(relative(root, p).replace(/\\/g, '/'));
        }
      }
    }
  };
  for (const base of ['packages', 'apps']) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const pkg of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const src = join(dir, pkg.name, 'src');
      if (existsSync(src)) walk(src);
    }
  }
  return { handMaintainedStructuralDeclarations: count, files: files.sort() };
}

/** Required context of every component of the fixture model within a fixed budget. */
function contextSize(): MetricsReport['contextSize'] {
  const model = sampleModel();
  return model.components.map((c) => {
    const env = contextTool({ model, target: { kind: 'component', ref: { kind: 'component', id: c.id } }, budget: { maxRecords: 200 } });
    const items = (env.data as { items?: unknown[] } | undefined)?.items ?? [];
    return { target: `component:${c.id}`, records: items.length, bytes: Buffer.byteLength(JSON.stringify(items)), truncated: env.completeness.truncated };
  });
}

function coverageOf(run: RunRecord | undefined): MetricsReport['qualificationCoverage'] {
  const required = (run?.checks ?? []).filter((c) => c.required);
  const n = (r: string): number => required.filter((c) => c.result === r).length;
  return { required: required.length, passed: n('PASS'), failed: n('FAIL'), unknown: n('UNKNOWN'), notApplicable: n('NOT_APPLICABLE') };
}

/**
 * Outcome and maintenance measurements of this engine, compared with the
 * recorded measurement in qualification/metrics.json when it exists. Kinds no
 * runnable case measures report zero cases rather than an estimate.
 */
export function computeMetrics(root: string, run?: RunRecord): MetricsReport {
  const { seeded, legitimate } = validationCases(root);
  const report: MetricsReport = {
    metricsVersion: 1,
    engine: { version: ENGINE_VERSION, contractDigest: CONTRACT_DIGEST },
    seededErrors: seeded,
    legitimateChanges: legitimate,
    staleEvidence: { cases: 0, intended: 0, missed: [] },
    unnecessaryBlocking: { cases: 0, intended: 0, missed: [] },
    qualificationCoverage: coverageOf(run),
    contextSize: contextSize(),
    manualDuplication: manualDuplication(root),
  };
  const recorded = join(root, ...METRICS_FILE.split('/'));
  if (existsSync(recorded)) {
    const before = readJson<MetricsReport>(recorded);
    report.comparison = [
      { metric: 'seededErrors.intended', baseline: before.seededErrors.intended, current: report.seededErrors.intended },
      { metric: 'legitimateChanges.intended', baseline: before.legitimateChanges.intended, current: report.legitimateChanges.intended },
      { metric: 'qualificationCoverage.passed', baseline: before.qualificationCoverage.passed, current: report.qualificationCoverage.passed },
      { metric: 'manualDuplication.handMaintainedStructuralDeclarations', baseline: before.manualDuplication.handMaintainedStructuralDeclarations, current: report.manualDuplication.handMaintainedStructuralDeclarations },
    ];
  }
  return report;
}
