import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES, sampleModel, schemaErrors, type Model, type Policy } from '@loom/core';
import { runChecks, type RunOutput, type Signer } from './run.js';
import type { Fixtures, MigrationFixture } from './types.js';

/** Loom's own qualification policy: every profile check is required, in a per-run LocalDB fixture. */
export const SELF_POLICY_FILE = 'qualification/policy.json';

const readJson = <T>(root: string, rel: string): T => JSON.parse(readFileSync(join(root, ...rel.split('/')), 'utf8')) as T;

export function readSelfPolicy(root: string): Policy {
  const policy = readJson<Policy>(root, SELF_POLICY_FILE);
  const errors = schemaErrors('Policy', policy);
  if (errors.length) throw new Error(`${SELF_POLICY_FILE} is not a valid policy: ${errors.map((e) => `${e.pointer || '(root)'} ${e.message}`).join('; ')}`);
  return policy;
}

/** Every profile check that the self-qualification policy neither requires nor marks optional. */
export function unlistedChecks(policy: Policy): string[] {
  const listed = new Set([...policy.qualification.required, ...policy.qualification.optional]);
  return PROFILES.flatMap((p) => p.checks.map((c) => c.id)).filter((id) => !listed.has(id));
}

const API_DATABASE = 'qualification/fixtures/api-database';
const CURRENCY_CHANGE = 'qualification/fixtures/currency-change';

interface MigrationCase {
  id: string;
  expect: { checks?: Array<{ id: string; inputs?: { migration?: string; rows?: string }; afterwards?: { rows?: number; currency?: string; amounts?: string[] } }> };
}

/**
 * The migration fixture with the outcome its authored expectations state:
 * every row kept, the backfilled currency, and the exact amounts.
 */
function migrationFixture(root: string): MigrationFixture {
  const expected = readJson<{ cases: MigrationCase[] }>(root, `${API_DATABASE}/expected.json`);
  const check = expected.cases.flatMap((c) => c.expect.checks ?? []).find((c) => c.id === 'sql.migration');
  if (!check?.inputs?.migration || !check.inputs.rows) throw new Error(`${API_DATABASE}/expected.json names no sql.migration case`);
  const fx: MigrationFixture = {
    migration: check.inputs.migration,
    previous: readJson<Model>(root, `${API_DATABASE}/baseline/model.json`),
    candidate: readJson<Model>(root, `${API_DATABASE}/model.json`),
    rows: `${API_DATABASE}/${check.inputs.rows}`,
  };
  if (check.afterwards?.currency) fx.expectColumns = { currency: check.afterwards.currency };
  if (check.afterwards?.amounts) fx.expectValues = { column: 'amount', values: check.afterwards.amounts };
  return fx;
}

/** Loom's own conforming and violating implementations, and the fixture pairs the comparison and migration checks use. */
export function selfFixtures(root: string): Fixtures {
  return {
    conforming: {
      sql: ['examples/conforming/ordering/sp_place_order.sql'],
      powershellRoot: 'examples/conforming',
      csharp: { 'Ordering.Contracts': 'examples/conforming/csharp/Ordering.Contracts/Ordering.Contracts.csproj' },
      typescript: { '@loom-fixtures/fulfillment': 'examples/conforming/typescript/index.ts' },
    },
    violating: {
      sql: ['examples/violating/ordering/sp_place_order.sql'],
      powershellRoot: 'examples/violating',
      csharp: { 'Ordering.Contracts': 'examples/violating/csharp/Ordering.Contracts/Ordering.Contracts.csproj' },
      typescript: { '@loom-fixtures/fulfillment': 'examples/violating/typescript/index.ts' },
    },
    // The accepted order API and its state after the currency change: an HTTP-bound pair whose documents both render.
    compatibility: { baseline: readJson<Model>(root, `${CURRENCY_CHANGE}/baseline/model.json`), candidate: readJson<Model>(root, `${CURRENCY_CHANGE}/states/after-07.json`) },
    migrations: [migrationFixture(root)],
  };
}

/**
 * Qualify the projections themselves: every check of every profile, on the
 * sample model, against Loom's own fixtures, under Loom's own policy. This
 * qualifies the projection library, not any adopting system.
 */
export async function selfQualify(root: string, options: { signer?: Signer; log?: (line: string) => void; timeoutMs?: number } = {}): Promise<RunOutput & { unlisted: string[] }> {
  const policy = readSelfPolicy(root);
  const unlisted = unlistedChecks(policy);
  const out = await runChecks({
    root,
    model: sampleModel(),
    checks: PROFILES.flatMap((p) => p.checks.map((c) => c.id)),
    fixtures: selfFixtures(root),
    policy,
    runner: 'loom-self-qualification',
    ...(options.signer ? { signer: options.signer } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { ...out, unlisted };
}
