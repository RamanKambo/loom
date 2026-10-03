import type { Model, PublishedContract, PublishedContractRef, RecordRef } from '../generated/types.js';
import { FINDING } from '../codes.js';
import { MODEL_FORMAT } from '../load.js';
import { canonicalHash } from '../hash.js';
import { collectReferences, resolveReference } from '../refs.js';
import { diff } from '../diff.js';
import { ref, type Rule, type RuleContext } from './context.js';

interface Versioned {
  id: string;
  version: number;
  supported?: Array<{ version: number }>;
}

const versionedOf = (model: Model, r: RecordRef): Versioned | undefined => {
  const list = r.kind === 'type' ? model.types : r.kind === 'operation' ? model.operations : r.kind === 'routine' ? model.routines : undefined;
  return list?.find((x) => x.id === r.id) as Versioned | undefined;
};

/** Whether a supported baseline proves a consumer of `version` unaffected by the current shape. */
function compatibilityProven(ctx: RuleContext, contract: RecordRef, version: number): boolean | null {
  const holder = (ctx.inputs.supportedBaselines ?? []).find((b) => versionedOf(b.model, contract)?.version === version);
  if (!holder) return null;
  return !diff(holder.model, ctx.model).some((c) => c.element === contract.id && c.elementKind === contract.kind && c.kind === 'breaking' && (c.dimension === 'shape-consumer' || c.dimension === 'shape-provider'));
}

/**
 * Supported versions and consumer bindings. A consumer binds the current
 * version, an explicitly supported earlier one, or under 'compatible' a version
 * a supplied supported baseline proves compatible.
 */
export const versionRules: Rule = (ctx) => {
  for (const kind of ['type', 'operation', 'routine'] as const) {
    const list = (kind === 'type' ? ctx.model.types : kind === 'operation' ? ctx.model.operations : ctx.model.routines) as Versioned[];
    for (const r of list) {
      for (const s of r.supported ?? []) {
        if (s.version < r.version) continue;
        ctx.report(FINDING.VERSION_SUPPORT_INVALID, `${kind === 'type' ? 'types' : `${kind}s`}/${r.id}/supported/${s.version}`, `${kind} '${r.id}' declares version ${s.version} supported, but its current version is ${r.version}`, [ref(kind, r.id)], `list only versions below ${r.version} as supported`);
      }
    }
  }
  for (const b of ctx.model.consumerBindings) {
    if (b.status === 'retired' || b.version === undefined) continue;
    const target = versionedOf(ctx.model, b.contract);
    let problem: string | null = null;
    if (target) {
      if (b.version === target.version) continue;
      if ((target.supported ?? []).some((s) => s.version === b.version)) continue;
      if (b.compatibility === 'compatible') {
        const proven = compatibilityProven(ctx, b.contract, b.version);
        if (proven === true) continue;
        problem = proven === false ? `the current shape breaks consumers of version ${b.version}` : `no supported baseline holds version ${b.version}`;
      } else problem = `version ${b.version} is neither current (${target.version}) nor supported`;
    } else if (b.contract.kind === 'publishedContract') {
      const pin = ctx.model.publishedContracts.find((p) => p.id === b.contract.id);
      if (!pin || pin.version === b.version) continue;
      problem = `the pinned version is ${pin.version}`;
    } else continue;
    ctx.report(FINDING.VERSION_BINDING_UNSUPPORTED, `consumerBindings/${b.id}/version`, `consumer binding '${b.id}' binds ${b.contract.kind} '${b.contract.id}' at version ${b.version}: ${problem}`, [ref('consumerBinding', b.id), b.contract], `bind '${b.id}' to the current version, declare version ${b.version} supported, or migrate the consumer`);
  }
};

/** The bundle resolved for a pin, matched by publisher and contract id. */
export const bundleFor = (pin: PublishedContractRef, bundles: readonly PublishedContract[]): PublishedContract | undefined =>
  bundles.find((b) => b.publisher === pin.publisher && b.contract === pin.contract && b.version === pin.version) ?? bundles.find((b) => b.publisher === pin.publisher && b.contract === pin.contract);

/** The resolved bundle only when it is exactly what the pin names: version, supported schema version and digest of its content. */
export function pinnedBundle(pin: PublishedContractRef, bundles: readonly PublishedContract[]): PublishedContract | undefined {
  const b = bundleFor(pin, bundles);
  if (!b || b.version !== pin.version || b.schemaVersion !== MODEL_FORMAT || pin.schemaVersion !== MODEL_FORMAT) return undefined;
  return b.digest === pin.digest && canonicalHash(b.content) === pin.digest ? b : undefined;
}

/** Resolved published contracts: identity, digest, schema version and the records referenced inside them. */
export const publishedRules: Rule = (ctx) => {
  const bundles = ctx.inputs.publishedContracts;
  if (bundles === undefined) return;
  for (const pin of ctx.model.publishedContracts) {
    const bundle = bundleFor(pin, bundles);
    const about = [ref('publishedContract', pin.id)];
    if (!bundle) {
      ctx.report(FINDING.PUBLISHED_CONTRACT_UNRESOLVED, `publishedContracts/${pin.id}`, `no bundle was resolved for published contract '${pin.id}' (${pin.publisher}/${pin.contract} version ${pin.version})`, about, `vendor the pinned bundle of '${pin.id}' so the workspace adapter can resolve it`);
      continue;
    }
    const digest = canonicalHash(bundle.content);
    if (digest !== pin.digest || digest !== bundle.digest) {
      ctx.report(FINDING.PUBLISHED_CONTRACT_DIGEST_MISMATCH, `publishedContracts/${pin.id}/digest`, `published contract '${pin.id}' content hashes to ${digest}, the pin names ${pin.digest} and the bundle names ${bundle.digest}`, about, `re-pin '${pin.id}' to the verified digest of the bundle, or restore the published bundle`);
    }
    const problems: string[] = [];
    if (bundle.schemaVersion !== MODEL_FORMAT || pin.schemaVersion !== MODEL_FORMAT) problems.push(`schema version ${bundle.schemaVersion} is not the supported format ${MODEL_FORMAT}`);
    if (bundle.version !== pin.version) problems.push(`the bundle is version ${bundle.version}, the pin version ${pin.version}`);
    if (problems.length) {
      ctx.report(FINDING.PUBLISHED_CONTRACT_INCOMPATIBLE, `publishedContracts/${pin.id}`, `published contract '${pin.id}' is incompatible: ${problems.join('; ')}`, about, `pin a bundle of '${pin.contract}' at a supported schema version and the intended version`);
    }
  }
  const inBundle = (pinId: string, recordId: string): boolean | null => {
    const pin = ctx.model.publishedContracts.find((p) => p.id === pinId);
    const bundle = pin && bundleFor(pin, bundles);
    if (!bundle) return null;
    const c = bundle.content;
    return [...c.types, ...c.operations, ...c.routines, ...c.securitySchemes].some((r) => r.id === recordId);
  };
  for (const r of collectReferences(ctx.model)) {
    const res = resolveReference(ctx.index, r);
    if (res.status !== 'external') continue;
    if (inBundle(res.publishedContract, res.recordId) !== false) continue;
    ctx.report(FINDING.PUBLISHED_CONTRACT_REFERENCE_UNKNOWN, r.path, `${r.path} references '${res.recordId}', which published contract '${res.publishedContract}' does not contain`, [r.holder, ref('publishedContract', res.publishedContract)], `reference a record the pinned bundle of '${res.publishedContract}' contains`);
  }
};
