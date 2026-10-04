import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONTRACT_DIGEST, DISCOVERY_LIMITS, FINDING_RULES, SCHEMA_BUNDLE, contextTool, declaredContradictions, sampleModel, seededRegressions } from '@loom/core';
import type { FindingCode, MetricsReport, Model, RunRecord } from '@loom/core';
import { ENGINE_VERSION } from '@loom/workspace';
import { evaluateFixtures, readFixtureSets, type CaseOutcome, type Expectation } from './fixtures.js';

type Count = MetricsReport['seededErrors'];
const count = (entries: ReadonlyArray<{ id: string; ok: boolean }>): Count => ({ cases: entries.length, intended: entries.filter((e) => e.ok).length, missed: entries.filter((e) => !e.ok).map((e) => e.id) });

const isError = (code: string): boolean => FINDING_RULES[code as FindingCode]?.severity === 'error';

/** A fixture case that seeds a defect: it expects an invalid model or names an error finding that must be raised. */
const seedsDefect = (x: Expectation): boolean => x.validation === 'invalid' || (x.mustInclude ?? []).some(isError) || (x.mustIncludeFindings ?? []).some((f) => isError(f.code));

/** Expectations about evidence currency: evidence a change must invalidate, and EVIDENCE_STALE that must or must not be reported. */
function staleEvidence(outcomes: readonly CaseOutcome[]): Count {
  const entries: Array<{ id: string; ok: boolean }> = [];
  for (const o of outcomes) {
    const x = o.prepared.case.expect;
    const raised = new Set([...o.observation.findings.map((f) => f.code as string), ...o.observation.reasonCodes]);
    for (const id of x.invalidatedEvidence ?? []) entries.push({ id: `${o.id} invalidates ${id}`, ok: (o.observation.invalidatedEvidence ?? []).includes(id) });
    if ((x.mustInclude ?? []).includes('EVIDENCE_STALE')) entries.push({ id: `${o.id} reports stale evidence`, ok: raised.has('EVIDENCE_STALE') });
    if ((x.mustExclude ?? []).includes('EVIDENCE_STALE')) entries.push({ id: `${o.id} keeps current evidence current`, ok: !raised.has('EVIDENCE_STALE') });
  }
  return count(entries);
}

/** Every readiness expectation of a ready task; one that came out blocked or unresolved blocked unnecessarily. */
function unnecessaryBlocking(outcomes: readonly CaseOutcome[]): Count {
  return count(
    outcomes.flatMap((o) =>
      (o.prepared.case.expect.readiness ?? []).flatMap((r, i) => (r.state === 'ready' ? [{ id: `${o.id} ${r.task.class} ${(r.task.components ?? r.task.requirements ?? []).join(',')}`, ok: o.observation.readiness[i]?.state === 'ready' }] : [])),
    ),
  );
}

/** Hand-written declarations that restate a contract definition by name, outside the generated files. */
function manualDuplication(root: string): MetricsReport['manualDuplication'] {
  const defs = new Set(Object.keys(SCHEMA_BUNDLE.$defs));
  const files: string[] = [];
  let found = 0;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!['generated', 'node_modules', 'dist', 'test'].includes(e.name)) walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        const text = readFileSync(p, 'utf8');
        const hits = [...text.matchAll(/^export\s+(?:interface|type)\s+([A-Z][A-Za-z0-9]*)\b/gm)].filter((m) => defs.has(m[1] as string));
        if (hits.length) {
          found += hits.length;
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
  return { handMaintainedStructuralDeclarations: found, files: files.sort() };
}

/** The context tool's first page for every component of the sample and of the model of each fixture set's first case, within the largest budget a page allows. */
function contextSize(root: string): MetricsReport['contextSize'] {
  const models: Array<[string, Model]> = [['sample', sampleModel()]];
  for (const set of readFixtureSets(root)) {
    const first = set.cases[0];
    if (first) models.push([set.id, JSON.parse(readFileSync(join(root, ...`${set.dir}/${first.model}`.split('/')), 'utf8')) as Model]);
  }
  const budget = { maxBytes: DISCOVERY_LIMITS.maxBytes, maxRecords: DISCOVERY_LIMITS.maxRecords };
  return models.flatMap(([name, model]) =>
    model.components.map((c) => {
      const env = contextTool({ model, target: { kind: 'component', ref: { kind: 'component', id: c.id } }, budget });
      const items = (env.data as { items?: unknown[] } | undefined)?.items ?? [];
      return { target: `${name}/component:${c.id}`, records: items.length, bytes: Buffer.byteLength(JSON.stringify(items)), truncated: env.completeness.truncated };
    }),
  );
}

function coverageOf(run: RunRecord | undefined): MetricsReport['qualificationCoverage'] {
  const required = (run?.checks ?? []).filter((c) => c.required);
  const n = (r: string): number => required.filter((c) => c.result === r).length;
  return { required: required.length, passed: n('PASS'), failed: n('FAIL'), unknown: n('UNKNOWN'), notApplicable: n('NOT_APPLICABLE') };
}

/**
 * Outcome and maintenance measurements of this engine, each computed by
 * running the engine over its own corpora: the self-test regressions and
 * contradictions, the independent fixture cases evaluated as the fixture suite
 * evaluates them, the context tool, and the given qualification run. Each count
 * names the corpus it was measured on; no figure is a general accuracy rate.
 */
export function computeMetrics(root: string, run?: RunRecord): MetricsReport {
  const outcomes = evaluateFixtures(root);
  const fixture = (o: CaseOutcome): { id: string; ok: boolean } => ({ id: o.id, ok: o.mismatches.length === 0 });
  return {
    metricsVersion: 1,
    engine: { version: ENGINE_VERSION, contractDigest: CONTRACT_DIGEST },
    seededErrors: count([...seededRegressions().map((r) => ({ id: `regression: ${r.id}`, ok: r.caught })), ...outcomes.filter((o) => seedsDefect(o.prepared.case.expect)).map(fixture)]),
    legitimateChanges: count(outcomes.filter((o) => !seedsDefect(o.prepared.case.expect)).map(fixture)),
    escapedContradictions: count(declaredContradictions().map((c) => ({ id: c.id, ok: c.caught }))),
    staleEvidence: staleEvidence(outcomes),
    unnecessaryBlocking: unnecessaryBlocking(outcomes),
    qualificationCoverage: coverageOf(run),
    contextSize: contextSize(root),
    manualDuplication: manualDuplication(root),
  };
}

/** Every numeric measurement of a report, by metric name. */
function measurements(r: MetricsReport): Array<[string, number]> {
  const counts = (name: string, c: Count | undefined): Array<[string, number]> => (c ? [[`${name}.cases`, c.cases], [`${name}.intended`, c.intended], [`${name}.missed`, c.missed.length]] : []);
  const q = r.qualificationCoverage;
  return [
    ...counts('seededErrors', r.seededErrors),
    ...counts('legitimateChanges', r.legitimateChanges),
    ...counts('escapedContradictions', r.escapedContradictions),
    ...counts('staleEvidence', r.staleEvidence),
    ...counts('unnecessaryBlocking', r.unnecessaryBlocking),
    ['qualificationCoverage.required', q.required],
    ['qualificationCoverage.passed', q.passed],
    ['qualificationCoverage.failed', q.failed],
    ['qualificationCoverage.unknown', q.unknown],
    ['qualificationCoverage.notApplicable', q.notApplicable],
    ['contextSize.targets', r.contextSize.length],
    ['contextSize.records', r.contextSize.reduce((n, c) => n + c.records, 0)],
    ['contextSize.bytes', r.contextSize.reduce((n, c) => n + c.bytes, 0)],
    ['contextSize.truncated', r.contextSize.filter((c) => c.truncated).length],
    ['manualDuplication.handMaintainedStructuralDeclarations', r.manualDuplication.handMaintainedStructuralDeclarations],
  ];
}

/** The report with each measurement beside its value in the recorded baseline; a metric the baseline lacks is left out. */
export function compareMetrics(current: MetricsReport, baseline: MetricsReport): MetricsReport {
  const before = new Map(measurements(baseline));
  const comparison = measurements(current).flatMap(([metric, value]) => (before.has(metric) ? [{ metric, baseline: before.get(metric) as number, current: value }] : []));
  return { ...current, comparison };
}
