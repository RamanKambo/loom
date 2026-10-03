import { join } from 'node:path';
import { schemaErrors } from '@loom/core';
import type { Finding, Model, PublishedContract, PublishedContractRef } from '@loom/core';
import { LOOM_DIR, loomDirOf } from './config.js';
import { finding } from './findings.js';
import { readJson } from './fsx.js';
import { segmentsOf } from './paths.js';

export const CONTRACTS_DIR = 'contracts';

/** Repository-relative location of a pinned bundle: .loom/contracts/<publisher>/<contract>@<version>.json. */
export const bundleLocation = (pin: PublishedContractRef): string => `${LOOM_DIR}/${CONTRACTS_DIR}/${pin.publisher}/${pin.contract}@${pin.version}.json`;

/**
 * Resolve every pinned published contract from its vendored bundle file. A
 * missing bundle stays unresolved; nothing is ever fetched from the network,
 * so the bundle that is checked is exactly the one the repository pins. The
 * digest and compatibility of a resolved bundle are evaluated by the core.
 */
export function resolvePublishedContracts(root: string, model: Model): { bundles: PublishedContract[]; findings: Finding[] } {
  const bundles: PublishedContract[] = [];
  const findings: Finding[] = [];
  for (const pin of model.publishedContracts) {
    const ref = [{ kind: 'publishedContract' as const, id: pin.id }];
    if (segmentsOf(pin.publisher).includes('..')) {
      findings.push(finding('PUBLISHED_CONTRACT_UNRESOLVED', `publishedContracts/${pin.id}`, `publisher '${pin.publisher}' does not name a directory inside .loom/contracts`, 'name the publisher by its alias', ref));
      continue;
    }
    const rel = bundleLocation(pin);
    const r = readJson(join(loomDirOf(root), CONTRACTS_DIR, ...pin.publisher.split('/'), `${pin.contract}@${pin.version}.json`));
    if (!r.ok) {
      findings.push(finding('PUBLISHED_CONTRACT_UNRESOLVED', `publishedContracts/${pin.id}`, `pinned contract ${pin.publisher}/${pin.contract}@${pin.version} has no bundle at ${rel}`, `vendor the published bundle at ${rel}`, ref));
      continue;
    }
    const errs = schemaErrors('PublishedContract', r.value);
    if (errs.length) {
      findings.push(finding('PUBLISHED_CONTRACT_INCOMPATIBLE', `publishedContracts/${pin.id}`, `${rel} does not satisfy the published-contract format: ${errs.map((e) => `${e.pointer} ${e.message}`).join('; ')}`, 'replace the bundle with the publisher\'s exact published artifact', ref));
      continue;
    }
    bundles.push(r.value as PublishedContract);
  }
  return { bundles, findings };
}
