import type { ContractPin, LoomConfig, RevisionVector } from './generated/types.js';
import { LoomStructuralError } from './errors.js';
import { schemaErrors } from './schema-runtime.js';

/** One model's entry of a RevisionVector. */
export type RevisionVectorEntry = RevisionVector['models'][number];

/** Deterministic ordering of a contract pin: publisher, then contract, then version. */
function comparePins(a: ContractPin, b: ContractPin): number {
  return a.publisher.localeCompare(b.publisher) || a.contract.localeCompare(b.contract) || a.version - b.version;
}

/**
 * A workspace's import pins, in canonical order: the export pins of every
 * direct composition member, members ordered by memberId and each member's
 * own pins ordered deterministically, so the same declaration always yields
 * the same list regardless of authoring order. A workspace without a
 * composition has none. Until published-contract references become
 * ContractPins, these are the only imports a workspace carries.
 */
export function importPinsOf(config: LoomConfig): ContractPin[] {
  const members = config.composition?.members ?? [];
  const ordered = [...members].sort((a, b) => a.memberId.localeCompare(b.memberId));
  return ordered.flatMap((m) => [...m.exports].sort(comparePins));
}

/**
 * Build and validate a RevisionVector from one or more model entries, ordered
 * by modelId so the digest of the result is the same regardless of the order
 * entries were supplied in. Throws when the result does not satisfy the
 * RevisionVector contract.
 */
export function revisionVectorOf(entries: readonly RevisionVectorEntry[]): RevisionVector {
  const vector: RevisionVector = { vectorVersion: 1, models: [...entries].sort((a, b) => a.modelId.localeCompare(b.modelId)) };
  const errors = schemaErrors('RevisionVector', vector);
  if (errors.length) throw new LoomStructuralError('the revision vector does not satisfy its contract', errors);
  return vector;
}
