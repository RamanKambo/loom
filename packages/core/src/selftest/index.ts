import type { Change, FindingCode, Model, Patch, SelftestData } from '../generated/types.js';
import { CONTRACT_DIGEST } from '../generated/digest.js';
import { FIELD_PATHS, PATCH_VARIANTS } from '../generated/registry.js';
import { SCHEMA_BUNDLE } from '../generated/schemas.js';
import { FINDING, FINDING_RULES } from '../codes.js';
import { canonicalStringify, deepClone, deepEqual } from '../canonical.js';
import { sha256Hex } from '../sha256.js';
import { modelRevision, recordHash } from '../hash.js';
import { loadModel, structuralFindings } from '../load.js';
import { migrateModel, type MigrationStep } from '../migrate.js';
import { validate } from '../validate.js';
import { diff, reachablePolicyKeys } from '../diff.js';
import { DIFF_RULES, FIELD_POLICY, type DiffRule } from '../field-policy.js';
import { mutate, guardFindings } from '../mutate.js';
import { changeImpact } from '../graph.js';
import { renameReferences } from '../refs.js';
import { exportModel, exportYaml, importModel } from '../exportModel.js';
import { LoomInvalidModelError, LoomStructuralError } from '../errors.js';
import { schemaErrors } from '../schema-runtime.js';
import { checkRevision, mutateTool, projectTool, validateTool, diffTool, importTool, exportTool, projectAllTool } from '../envelope.js';
import { sampleModel } from '../sample.js';
import { CONTRADICTIONS } from './contradictions.js';
import { DIFF_CASES } from './diffs.js';
import { REGRESSIONS } from './regressions.js';
import { EVALUATION_SECTIONS } from './evaluation.js';
import { PROJECTION_SECTIONS } from './projections.js';
import { assert, assertThrows, codesOf, errorsOf, fresh, observe, pick, SelfTestFailure, type Tally } from './harness.js';

/**
 * Codes another part of the toolset raises, with the area that owns them. The
 * self-test fails on a code that is neither raised by a section here nor
 * listed with its owner, and on a listed code it raises itself.
 */
const RAISED_ELSEWHERE: Partial<Record<FindingCode, string>> = {
  POLICY_UNRESOLVED: 'workspace adapter',
  POLICY_UNTRUSTED: 'workspace adapter',
  EVIDENCE_STORE_UNAVAILABLE: 'workspace adapter',
  PROJECTION_INVALID: 'qualification adapter',
  SCOPE_OVERLAP: 'workspace adapter',
  SCOPE_COMPONENT_UNKNOWN: 'workspace adapter',
  SCOPE_ROOT_INVALID: 'workspace adapter',
  SCOPE_ROOT_MISSING: 'workspace adapter',
  SCOPE_COMPONENT_ROOT_OVERLAP: 'workspace adapter',
  SCOPE_UNRESOLVED: 'workspace adapter',
  SCOPE_NO_OWNER: 'workspace adapter',
  INIT_NOT_REPOSITORY_ROOT: 'workspace adapter',
  INIT_ALREADY_INITIALIZED: 'workspace adapter',
  INIT_REPAIR_REQUIRED: 'workspace adapter',
  CONFIG_INVALID: 'workspace adapter',
  CONFIG_MODEL_MISSING: 'workspace adapter',
  CONFIG_PROFILE_UNKNOWN: 'workspace adapter',
  CONFIG_PROFILE_NOT_PERMITTED: 'workspace adapter',
  OUTPUT_COLLISION: 'workspace adapter',
  OUTPUT_OUTSIDE_WORKSPACE: 'workspace adapter',
  OUTPUT_PROTECTED_TARGET: 'workspace adapter',
  OUTPUT_DRIFT: 'workspace adapter',
  OUTPUT_MISSING: 'workspace adapter',
  MANIFEST_MISSING: 'workspace adapter',
  MANIFEST_STALE: 'workspace adapter',
  INSTALL_INCOMPLETE: 'workspace adapter',
  VALIDATION_ONLY_MODE: 'workspace adapter',
  CLIENT_CAPABILITY_UNSUPPORTED: 'MCP server',
  DOCUMENT_LINK_BROKEN: 'CLI documentation check',
  DOCUMENT_RECORD_UNKNOWN: 'CLI documentation check',
  DOCUMENT_HISTORY_MARKER: 'CLI documentation check',
  DOCUMENT_DUPLICATES_GENERATED: 'CLI documentation check',
  DOCUMENT_INTERFACE_DROPPED: 'CLI documentation check',
  DOCUMENT_PROHIBITED_MARKER: 'CLI documentation check',
  CAPABILITY_CODE_UNRESOLVED: 'CLI capability check',
  CAPABILITY_CONTRACT_UNRESOLVED: 'CLI capability check',
  CAPABILITY_CASE_UNKNOWN: 'CLI capability check',
  CAPABILITY_CASE_FAILED: 'CLI capability check',
};

interface Section {
  name: string;
  run(t: Tally): void;
}

const NIST: ReadonlyArray<[string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
];

/** Every FIELD_PATHS entry is reached by the comparison walk, directly or inside a set-compared array. */
function unreachedFieldPaths(reached: ReadonlyMap<string, string[]>): string[] {
  const paths = new Set([...reached.values()].flat());
  const prefixes = [...paths].filter((p) => p.endsWith('[]'));
  return FIELD_PATHS.filter((f) => !paths.has(f) && !prefixes.some((p) => f.startsWith(`${p}.`)));
}

const SECTIONS: readonly Section[] = [
  {
    name: 'contract',
    run: (t) => {
      assert(t, /^sha256:[0-9a-f]{64}$/.test(CONTRACT_DIGEST), 'the contract digest is a SHA-256 hash');
      for (const code of SCHEMA_BUNDLE.$defs.FindingCode.enum) assert(t, FINDING_RULES[code as FindingCode] !== undefined, `finding code ${code} has a rule`);
      const reached = reachablePolicyKeys();
      for (const key of reached.keys()) assert(t, FIELD_POLICY[key] !== undefined, `field ${key} (${reached.get(key)!.join(', ')}) has a comparison policy`);
      for (const key of Object.keys(FIELD_POLICY)) assert(t, reached.has(key), `comparison policy ${key} names a field the walk reaches`);
      const unreached = unreachedFieldPaths(reached);
      assert(t, unreached.length === 0, `every schema field is compared; unreached: ${unreached.join(', ')}`);
    },
  },
  {
    name: 'sha256',
    run: (t) => {
      for (const [input, digest] of NIST) assert(t, sha256Hex(input) === digest, `SHA-256 of a ${input.length}-character input matches the FIPS 180-4 vector`);
    },
  },
  {
    name: 'sample',
    run: (t) => {
      const findings = observe(t, validate(sampleModel()));
      assert(t, errorsOf(findings).length === 0, `the sample is valid: ${errorsOf(findings).map((f) => `${f.code} ${f.path}`).join('; ')}`);
      assert(t, structuralFindings(sampleModel()).length === 0, 'the sample satisfies the structural contract');
    },
  },
  {
    name: 'contradictions',
    run: (t) => {
      for (const c of CONTRADICTIONS) {
        const m = fresh();
        try {
          c.break(m);
        } catch (e) {
          throw new SelfTestFailure(`${c.label}: the contradiction could not be applied: ${e instanceof Error ? e.message : String(e)}`);
        }
        const findings = observe(t, validate(m));
        const hit = findings.find((f) => f.code === c.code && (c.pathIncludes === undefined || f.path.includes(c.pathIncludes)));
        assert(t, hit !== undefined, `${c.label}: expected ${c.code}${c.pathIncludes ? ` at a path containing '${c.pathIncludes}'` : ''}, got ${codesOf(findings).join(', ') || 'no finding'}`);
        assert(t, typeof hit!.fix === 'string' && hit!.fix.length > 0, `${c.label}: the finding carries a fix`);
      }
    },
  },
  {
    name: 'comparison',
    run: (t) => {
      for (const c of DIFF_CASES) {
        const before = fresh();
        c.prepare?.(before);
        const after = deepClone(before);
        c.edit(after);
        const changes = diff(before, after);
        for (const x of changes) t.emitted.add(x.rule);
        if (c.kind === 'none') {
          assert(t, changes.length === 0, `${c.rule}: the edit is non-semantic, but produced ${changes.map((x) => x.rule).join(', ')}`);
          continue;
        }
        const hit = changes.find((x) => x.rule === c.rule && x.kind === c.kind);
        assert(t, hit !== undefined, `${c.rule}: expected a ${c.kind} change, got ${changes.map((x) => `${x.rule}/${x.kind}`).join(', ') || 'none'}`);
        assert(t, hit!.dimension !== undefined && hit!.reason.length > 0, `${c.rule}: the change has a dimension and a reason`);
      }
      for (const [rule, r] of Object.entries(DIFF_RULES) as Array<[string, DiffRule]>) {
        if (r.kind === 'nonSemantic') continue;
        assert(t, t.emitted.has(rule), `comparison rule ${rule} is emitted by a case`);
      }
      const before = fresh();
      const after = fresh();
      pick(after.mutations, 'order.pay').effect = 'Paid.';
      const withoutEffect = Object.fromEntries(Object.entries(FIELD_POLICY).filter(([k]) => k !== 'Mutation.effect'));
      const review = diff(before, after, { policy: withoutEffect });
      assert(t, review.length === 1 && review[0]!.kind === 'requiresReview' && review[0]!.rule === 'CHANGE_REQUIRES_REVIEW', 'a delta without a policy requires review');
      const guards = observe(t, guardFindings(before, after, review, []));
      assert(t, codesOf(guards).includes('CHANGE_REQUIRES_REVIEW') && codesOf(guards).includes('BREAKING_CHANGE_UNACKNOWLEDGED'), 'an unclassified change is reported and needs acknowledgement');
      assert(t, diff(before, before).length === 0, 'a model compared with itself has no change');
    },
  },
  {
    name: 'regressions',
    run: (t) => {
      for (const r of REGRESSIONS) {
        try {
          r.run(t);
        } catch (e) {
          if (e instanceof SelfTestFailure) throw new SelfTestFailure(`${r.behavior}: ${e.message}`);
          throw e;
        }
      }
    },
  },
  {
    name: 'patches',
    run: (t) => {
      const base = sampleModel();
      const snapshot = canonicalStringify(base);
      const apply = (patches: Patch | Patch[], ack: string[] = []) => mutate(base, patches, { acknowledgeBreaking: ack });
      assert(t, PATCH_VARIANTS.length > 0, 'the patch contract defines variants');
      const added = apply({ op: 'add', collection: 'trustBoundaries', record: { id: 'tb.partner', kind: 'network', description: 'Partner network.' } });
      assert(t, added.model?.trustBoundaries.some((x) => x.id === 'tb.partner') === true, 'add inserts a record');
      const replaced = apply({ op: 'replace', collection: 'trustBoundaries', id: 'tb.public', record: { id: 'tb.public', kind: 'network', description: 'The public edge.' } });
      assert(t, pick(replaced.model?.trustBoundaries, 'tb.public').description === 'The public edge.', 'replace swaps a record');
      const removed = apply({ op: 'remove', collection: 'trustBoundaries', id: 'tb.public' }, ['tb.public']);
      assert(t, removed.model !== null && !removed.model.trustBoundaries.some((x) => x.id === 'tb.public'), `remove deletes a record: ${codesOf(removed.findings).join(', ')}`);
      const renamed = apply({ op: 'rename', collection: 'types', id: 'invoice', to: 'bill' }, ['invoice', 'bill', 'billing.invoices', 'wf.reporting', 'con.exact-money']);
      assert(t, renamed.model !== null, `rename keeps the model valid: ${codesOf(errorsOf(renamed.findings)).join(', ')}`);
      assert(t, pick(renamed.model!.storage, 'billing.invoices').type === 'bill' && renamed.model!.workflows.some((w) => w.imports.some((i) => i.typeId === 'bill')), 'rename rewrites every reference');
      const dotted = deepClone(base);
      const { stateProperty: _state, ...orderShape } = deepClone(pick(dotted.types, 'order'));
      dotted.types.push({ ...orderShape, id: 'order.part' });
      dotted.unknowns.push({ id: 'unk.part-note', question: 'What does the note of a part hold?', affects: [{ kind: 'property', id: 'order.note' }, { kind: 'property', id: 'order.part.note' }], blocks: ['release'], owner: 'team-ordering', resolution: 'A decision.', status: 'open' });
      pick(dotted.types, 'order').id = 'order-renamed';
      renameReferences(dotted, 'type', 'order', 'order-renamed');
      const affects = pick(dotted.unknowns, 'unk.part-note').affects.map((a) => a.id);
      assert(t, affects[0] === 'order-renamed.note' && affects[1] === 'order.part.note', `a rename follows the renamed type's property and leaves that of a type whose id extends it: ${affects.join(', ')}`);
      assert(t, !codesOf(validate(dotted)).includes('DANGLING_REF'), 'every reference still resolves after the rename');
      const item = apply({ op: 'addItem', collection: 'types', id: 'invoice', field: 'properties', item: { name: 'memo', kind: 'string', required: false, nullable: true, immutable: false, origin: 'client', bounds: { maxLength: 80 } } });
      assert(t, pick(item.model?.types, 'invoice').properties.some((p) => p.name === 'memo'), 'addItem inserts an item');
      const updated = apply({ op: 'updateItem', collection: 'types', id: 'order', field: 'properties', key: 'note', set: { description: 'Free text from the customer.' } });
      assert(t, updated.model !== null && pick(pick(updated.model.types, 'order').properties, 'note').description === 'Free text from the customer.' && updated.changes.length === 0, `updateItem changes an item: ${codesOf(errorsOf(updated.findings)).join(', ')}`);
      const moved = apply({ op: 'moveItem', collection: 'routines', id: 'fulfillment.rb_dispatch', field: 'params', key: 'Notify', index: 0 });
      assert(t, pick(moved.model?.routines, 'fulfillment.rb_dispatch').params[0]!.name === 'Notify', 'moveItem reorders an item');
      const profile = apply({ op: 'clearSystemProfile' }, ['system']);
      assert(t, profile.model !== null && profile.model.systemProfile === undefined, 'clearSystemProfile removes the profile');
      const typo = apply({ op: 'update', collection: 'mutations', id: 'order.pay', set: { gaurd: { form: 'prose', text: 'x' } } } as unknown as Patch);
      const typoFinding = observe(t, typo.findings).find((f) => f.code === 'PATCH_INVALID');
      assert(t, typo.model === null && typoFinding?.path === 'patches/0/set' && typoFinding.message.includes("'gaurd'"), `a misspelled field is reported at its pointer: ${typoFinding?.path} ${typoFinding?.message}`);
      const unknownOp = observe(t, apply({ op: 'changeMutation', mutationId: 'order.pay' } as unknown as Patch).findings);
      assert(t, unknownOp[0]?.path === 'patches/0/op', 'an unknown op is reported at /op');
      const missing = observe(t, apply({ op: 'remove', collection: 'mutations', id: 'order.refund' }).findings);
      assert(t, codesOf(missing).includes('PATCH_TARGET_NOT_FOUND'), 'a missing target is reported');
      const batch = apply([{ op: 'remove', collection: 'trustBoundaries', id: 'tb.public' }, { op: 'remove', collection: 'mutations', id: 'order.refund' }], ['tb.public']);
      assert(t, batch.model === null && canonicalStringify(base) === snapshot, 'a refused batch leaves the input untouched');
      const ambiguous = mutateTool({ model: base, patch: { op: 'clearSystemProfile' }, patches: [{ op: 'clearSystemProfile' }] });
      assert(t, ambiguous.outcome === 'refused' && ambiguous.refusal?.cause === 'invalid-input' && codesOf(observe(t, ambiguous.findings)).includes('PATCH_AMBIGUOUS'), 'patch and patches together are ambiguous');
      assert(t, canonicalStringify(base) === snapshot, 'mutate never modifies its input');
    },
  },
  {
    name: 'impact and repairs',
    run: (t) => {
      const before = sampleModel();
      const after = fresh();
      delete pick(pick(after.types, 'shipment').properties, 'orderId').binds;
      const impact = changeImpact(before, after, [{ kind: 'type', id: 'order' }]);
      const former = impact.find((a) => a.ref.kind === 'type' && a.ref.id === 'shipment');
      assert(t, former?.reason === 'former-consumer' && former.path[0] === 'order' && former.path.at(-1) === 'shipment', `a removed dependency names the former consumer with its path: ${JSON.stringify(former)}`);
      const added = changeImpact(after, before, [{ kind: 'type', id: 'order' }]).find((a) => a.ref.id === 'shipment');
      assert(t, added?.reason === 'new-consumer', 'an added dependency names the new consumer');
      const m = fresh();
      pick(m.mutations, 'order.pay').to = 'refunded';
      const illegal = validate(m).find((f) => f.code === 'MUTATION_ILLEGAL_STATE');
      assert(t, illegal?.repairs?.length && illegal.repairs.every((r) => r.kind === 'intent-change' && r.requiresAcceptance), 'adding a state is an intent change that needs acceptance');
      const n = fresh();
      pick(n.mutations, 'order.pay').writes = [];
      const hidden = validate(n).find((f) => f.code === 'MUTATION_STATE_WRITE_UNDECLARED');
      const fix = hidden?.repairs?.find((r) => r.kind === 'mechanical');
      assert(t, fix?.requiresAcceptance === false && fix.patches?.length === 1, 'declaring the state write is a mechanical repair with its patch');
      const repaired = mutate(n, fix!.patches!, { acknowledgeBreaking: ['order.pay'] });
      assert(t, repaired.model !== null && !repaired.findings.some((f) => f.code === 'MUTATION_STATE_WRITE_UNDECLARED'), 'the mechanical repair clears the finding');
    },
  },
  {
    name: 'result envelopes',
    run: (t) => {
      const ok = validateTool({ model: sampleModel() });
      assert(t, schemaErrors('ResultEnvelope', ok).length === 0, `a validate result satisfies the result contract: ${JSON.stringify(schemaErrors('ResultEnvelope', ok))}`);
      assert(t, ok.states.validation.state === 'valid' && ok.states.readiness.state === 'notEvaluated' && ok.states.qualification.state === 'notEvaluated' && ok.states.acceptance.state === 'notEvaluated', 'states are independent and unevaluated states say so');
      for (const s of [ok.states.readiness, ok.states.qualification, ok.states.acceptance]) for (const r of s.reasons) t.raised.add(r.code);
      assert(t, ok.revisions.model === modelRevision(sampleModel()) && ok.revisions.contractDigest === CONTRACT_DIGEST, 'the result names the evaluated revisions');
      const bad = fresh();
      pick(bad.mutations, 'order.pay').to = 'refunded';
      const invalid = validateTool({ model: bad });
      for (const r of invalid.states.validation.reasons) t.raised.add(r.code);
      assert(t, invalid.states.validation.state === 'invalid', 'an invalid model is invalid, never collapsed into one flag');
      const refused = validateTool({ model: { version: 1 } });
      assert(t, refused.outcome === 'refused' && refused.refusal?.cause === 'invalid-input', 'a structurally invalid input is refused as invalid input');
      const stale = checkRevision(sampleModel(), `sha256:${'0'.repeat(64)}`);
      assert(t, stale.refusal?.cause === 'stale-base' && codesOf(observe(t, stale.findings)).includes('STALE_BASE_REVISION'), 'a stale base revision is refused');
      assert(t, checkRevision(sampleModel(), modelRevision(sampleModel())).outcome === 'ok', 'the current revision is accepted');
      for (const env of [
        mutateTool({ model: sampleModel(), patch: { op: 'update', collection: 'mutations', id: 'order.pay', set: { effect: 'Paid.' } }, acknowledgeBreaking: ['order.pay'], dryRun: true }),
        diffTool({ before: sampleModel(), after: sampleModel() }),
        projectTool({ model: sampleModel(), target: 'sql' }),
        projectAllTool({ model: sampleModel() }),
        exportTool({ model: sampleModel(), format: 'yaml' }),
        importTool({ text: exportModel(sampleModel()) }),
        stale,
        refused,
      ]) {
        assert(t, schemaErrors('ResultEnvelope', env).length === 0, `${env.tool} result satisfies the result contract: ${JSON.stringify(schemaErrors('ResultEnvelope', env))}`);
      }
      const dry = mutateTool({ model: sampleModel(), patch: { op: 'update', collection: 'mutations', id: 'order.pay', set: { effect: 'Paid.' } }, acknowledgeBreaking: ['order.pay'], dryRun: true });
      const data = dry.data as { committed: boolean; model?: Model; revision?: string };
      assert(t, data.committed === false && data.model === undefined && typeof data.revision === 'string', 'a dry run previews the revision without returning or committing a model');
      assert(t, recordHash(sampleModel(), { kind: 'property', id: 'order.total' }) !== null && recordHash(sampleModel(), { kind: 'edge', id: 'billing|ordering|integration' }) !== null, 'any record, a property or an edge has a canonical hash');
    },
  },
  ...PROJECTION_SECTIONS,
  {
    name: 'round trip and formats',
    run: (t) => {
      const json = exportModel(sampleModel());
      assert(t, exportModel(importModel(json)) === json, 'JSON export round-trips');
      assert(t, exportModel(importModel(exportYaml(sampleModel()))) === json, 'YAML export round-trips');
      assert(t, deepEqual(loadModel(JSON.parse(json)), sampleModel()), 'a loaded model equals its source');
      const future = observe(t, structuralFindings({ ...sampleModel(), version: 2 }));
      assert(t, future.length === 1 && future[0]!.code === 'MODEL_FORMAT_UNSUPPORTED' && future[0]!.path === '/version', 'another format version is refused with one finding');
      assertThrows(t, () => loadModel({ ...sampleModel(), version: 2 }), 'loading another format version throws', (e) => e instanceof LoomStructuralError);
      const current = migrateModel(sampleModel());
      assert(t, current.after !== null && current.steps.length === 0 && deepEqual(current.after, sampleModel()), 'a current-format document needs no migration');
      const ancient: Record<string, unknown> = { ...deepClone(sampleModel()), version: 0 };
      const frozen = canonicalStringify(ancient);
      const step: MigrationStep = {
        from: 0,
        to: 1,
        description: 'sets the format version',
        apply: (d) => ({ document: { ...(d as object), version: 1 }, changes: [] as Change[] }),
      };
      const migrated = migrateModel(ancient, [step]);
      assert(t, migrated.after !== null && migrated.steps.length === 1 && canonicalStringify(ancient) === frozen, 'a registered step migrates deterministically without changing its input');
      assert(t, deepEqual(migrateModel(ancient, [step]).after, migrated.after), 'migration is deterministic');
      const none = migrateModel(ancient);
      assert(t, none.after === null && codesOf(observe(t, none.findings)).includes('MODEL_FORMAT_UNSUPPORTED'), 'a format without a registered path is refused');
    },
  },
  ...EVALUATION_SECTIONS,
  {
    name: 'code accounting',
    run: (t) => {
      for (const code of Object.keys(FINDING) as FindingCode[]) {
        const elsewhere = RAISED_ELSEWHERE[code];
        if (elsewhere) assert(t, !t.raised.has(code), `${code} is listed as raised by ${elsewhere} but the core raises it; remove it from the list`);
        else assert(t, t.raised.has(code), `${code} is never raised by any self-test section`);
      }
    },
  },
];

/**
 * Run the engine self-test. Throws on the first failed assertion, naming it;
 * on success prints one summary line and returns the per-section counts.
 */
export function selfTest(): SelftestData {
  const t: Tally = { assertions: 0, raised: new Set(), emitted: new Set() };
  const sections: SelftestData['sections'] = [];
  for (const s of SECTIONS) {
    const start = t.assertions;
    try {
      s.run(t);
    } catch (e) {
      throw new SelfTestFailure(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    sections.push({ name: s.name, passed: true, assertions: t.assertions - start });
  }
  console.log(
    `loom self-test PASS: ${sections.length} sections, ${t.assertions} assertions; ${CONTRADICTIONS.length} contradictions, ${DIFF_CASES.length} comparison cases, ${REGRESSIONS.length} regressions; contract ${CONTRACT_DIGEST}.`,
  );
  return { sections };
}

