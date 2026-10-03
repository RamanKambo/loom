import type { Acceptance, Baseline, EvidenceRecord, Model, Patch, Policy, PublishedContract, ReadinessState, TaskSpec } from '../generated/types.js';
import { CONTRACT_DIGEST } from '../generated/digest.js';
import { canonicalHash, modelRevision, recordHash } from '../hash.js';
import { deepClone } from '../canonical.js';
import { validate } from '../validate.js';
import { schemaErrors } from '../schema-runtime.js';
import { changeImpact } from '../graph.js';
import type { EvaluationInputs } from '../inputs.js';
import { compareBaseline, derivedSeal, gateFindings, retirementFindings } from '../baseline.js';
import { deriveObligations, evaluateEvidence } from '../evidence.js';
import { checkReadiness, designOrder, recomputeReadiness } from '../readiness.js';
import { checkReadinessTool, compareBaselineTool, contextTool, describeTool, evaluateEvidenceTool, planChangeTool } from '../tools.js';
import { mutateTool } from '../envelope.js';
import { continuationToken } from '../retrieval.js';
import { baselineAccepted, resolveScope } from '../scope.js';
import { mutate } from '../mutate.js';
import { exportYaml, importModel } from '../exportModel.js';
import { renderTarget, withArtifactHashes } from '../project.js';
import { indexModel } from '../records.js';
import { sampleModel } from '../sample.js';
import { assert, codesOf, fresh, observe, pick, type Tally } from './harness.js';

const AT = '2026-10-03T00:00:00Z';
const HASH = (c: string): string => `sha256:${c.repeat(64)}`;

const reasons = (t: Tally, s: ReadinessState): string[] => {
  for (const r of s.reasons) t.raised.add(r.code);
  return s.reasons.map((r) => r.code);
};

function baselineOf(model: Model, extra: Partial<Baseline> = {}): Baseline {
  return {
    baselineVersion: 1,
    id: 'bl-1',
    model: { hash: modelRevision(model), formatVersion: 1, snapshot: 'baselines/bl-1.model.json' },
    config: { hash: HASH('1'), configVersion: 1 },
    policy: { ref: 'engineering', revision: 1, hash: HASH('2') },
    generator: { version: '1.0.0', contractDigest: CONTRACT_DIGEST },
    contracts: [],
    components: model.components.map((c) => ({ id: c.id, hash: HASH('3'), frozen: c.id === 'ordering' })),
    artifacts: [],
    sources: [],
    commitments: [],
    acceptance: 'acc-1',
    ...extra,
  };
}

function acceptance(id: string, candidate: string, scope: Acceptance['scope'] = [], kind: Acceptance['subject']['kind'] = 'change'): Acceptance {
  return { acceptanceVersion: 1, id, subject: kind === 'baseline' ? { kind, baseline: 'bl-1', candidate } : { kind, candidate }, decision: 'accepted', authority: 'team-architecture', policy: { ref: 'engineering', revision: 1 }, scope, changeClasses: [], at: AT };
}

const POLICY: Policy = {
  policyVersion: 1,
  id: 'engineering',
  revision: 1,
  trust: { ref: 'refs/heads/main', acceptanceVia: 'trusted-ref', acceptanceKeys: [], evidenceKeys: [] },
  changeClasses: [
    { id: 'non-semantic', description: 'Edits with no semantic effect.', match: { kinds: ['nonSemantic'] }, approval: 'pre-authorized' },
    { id: 'compatible-shape', description: 'Compatible shape changes.', match: { kinds: ['compatible'], dimensions: ['shape-provider', 'shape-consumer'] }, approval: 'pre-authorized' },
    { id: 'security', description: 'Any security consequence.', match: { dimensions: ['security'] }, approval: 'acceptance-required' },
    { id: 'no-removal', description: 'Properties are never removed.', match: { rules: ['PROPERTY_REMOVED'] }, approval: 'prohibited' },
  ],
  readiness: { implementation: { requires: 'accepted-contract' }, integration: { evidence: ['integration'] }, release: { evidence: ['integration'] } },
  substitutes: [{ kind: 'test-double', permits: ['implementation'], limits: 'Never satisfies a real integration obligation.' }],
  qualification: { required: [], optional: [] },
  environments: [{ id: 'localdb-fixture', kind: 'disposable-fixture', designated: true, description: 'A per-run fixture database.' }],
  freeze: { onAcceptance: false, defectFixRequalify: ['conformance'] },
};

/** Inputs under which the sample itself is the trusted, accepted baseline. */
function acceptedInputs(model: Model = sampleModel(), extra: EvaluationInputs = {}): EvaluationInputs {
  return {
    baseline: { record: baselineOf(model), model, verified: true },
    acceptances: [{ record: acceptance('acc-1', modelRevision(model), [], 'baseline'), trusted: true }],
    policy: POLICY,
    ...extra,
  };
}

function evidence(id: string, kind: EvidenceRecord['kind'], claims: EvidenceRecord['claims'], model: Model, inputs: string[], extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceVersion: 1,
    id,
    claims,
    kind,
    check: { id: `check.${kind}`, revision: 1, definitionHash: HASH('4') },
    artifacts: [],
    sources: [{ repository: '.', revision: 'a9ce204' }],
    environment: { id: 'ci', kind: 'ci' },
    tool: { name: 'node', version: '24.0.0' },
    result: 'PASS',
    run: { id: `run.${id}`, runner: 'ci', startedAt: AT, finishedAt: AT },
    boundaries: [{ boundary: 'SQL Server engine', actual: 'real' }],
    limits: 'Fixture data only.',
    inputs: inputs.map((ref) => {
      const [kind, ...rest] = ref.split(':');
      const r = { kind: kind as never, id: rest.join(':') };
      return { ref, hash: recordHash(model, r) ?? HASH('0') };
    }),
    ...extra,
  };
}

interface Section {
  name: string;
  run(t: Tally): void;
}

export const EVALUATION_SECTIONS: readonly Section[] = [
  {
    name: 'knowledge with inputs',
    run: (t) => {
      const plain = observe(t, validate(sampleModel(), { acceptances: [] }));
      assert(t, codesOf(plain).includes('CLAIM_ACCEPTANCE_UNVERIFIED'), 'a decision marked accepted without a trusted acceptance is reported once acceptance is evaluated');
      const covered = validate(sampleModel(), { acceptances: [{ record: acceptance('acc-all', modelRevision(sampleModel())), trusted: true }] });
      assert(t, !codesOf(covered).includes('CLAIM_ACCEPTANCE_UNVERIFIED'), 'a trusted acceptance of the revision backs the accepted decision');
      assert(t, !codesOf(validate(sampleModel())).includes('CLAIM_ACCEPTANCE_UNVERIFIED'), 'plain validation does not judge acceptance');
      const m = fresh();
      pick(m.assumptions, 'asm.peak-factor').expires = '2026-01-01';
      assert(t, codesOf(observe(t, validate(m, { asOf: AT }))).includes('ASSUMPTION_EXPIRED') && !codesOf(validate(m, { asOf: '2025-12-31' })).includes('ASSUMPTION_EXPIRED'), 'an open assumption past its expiry needs validation');
      const changed = fresh();
      pick(changed.workloads, 'wl.checkout').failureExpectations = 'Order intake tolerates the loss of one region.';
      const base = { record: baselineOf(sampleModel()), model: sampleModel(), verified: true };
      assert(t, codesOf(observe(t, validate(changed, { baseline: base }))).includes('DECISION_INPUT_CHANGED'), 'a decision whose input changed since the baseline is flagged');
      pick(changed.decisions, 'dec.order-store').revision = 2;
      assert(t, !validate(changed, { baseline: base }).some((f) => f.code === 'DECISION_INPUT_CHANGED' && f.path.includes('dec.order-store')), 'a revised decision is reviewed against its new inputs');
      const widened = fresh();
      pick(pick(widened.storage, 'ordering.orders').columns, 'note').sqlType = { name: 'nvarchar', length: 400 };
      assert(t, codesOf(observe(t, validate(widened, { baseline: base }))).includes('MIGRATION_MISSING'), 'a storage change without a migration is reported against the baseline');
      widened.migrations.push({ id: 'mig.note', contract: { kind: 'storage', id: 'ordering.orders' }, fromVersion: 1, toVersion: 2, dependsOn: [], readers: { old: true, new: true }, writers: { old: false, new: true }, transaction: 'online', locking: 'An online column change.', recovery: 'roll-forward', evidence: ['migration'] });
      assert(t, !codesOf(validate(widened, { baseline: base })).includes('MIGRATION_MISSING'), 'a declared migration covers the storage change');
      const att = fresh();
      att.attachments.push({ id: 'att.store', title: 'Order store rationale', source: { kind: 'document', ref: 'order-store-rationale', revision: '1' }, digest: HASH('a'), explains: [{ kind: 'decision', id: 'dec.order-store' }], reviewedAgainst: [{ record: { kind: 'decision', id: 'dec.order-store' }, hash: recordHash(att, { kind: 'decision', id: 'dec.order-store' })! }] });
      assert(t, !codesOf(validate(att)).includes('RATIONALE_REVIEW_REQUIRED'), 'rationale reviewed against the current record needs no review');
      const updated = deepClone(att);
      pick(updated.attachments, 'att.store').digest = HASH('b');
      assert(t, codesOf(validate(updated, { baseline: { record: baselineOf(att), model: att, verified: true } })).includes('RATIONALE_REVIEW_REQUIRED'), 'an updated source marks the rationale for review instead of changing intent');
    },
  },
  {
    name: 'published contracts',
    run: (t) => {
      const m = fresh();
      const content: PublishedContract['content'] = { types: [{ id: 'payment', version: 2, owner: 'payments', representation: 'response', properties: [{ name: 'id', kind: 'uuid', required: true, nullable: false, immutable: true, origin: 'system' }] }], operations: [], routines: [], securitySchemes: [] };
      const digest = canonicalHash(content);
      m.publishedContracts.push({ id: 'payments', publisher: 'team-payments', contract: 'payments-api', version: 2, digest, schemaVersion: 1, consumers: ['billing'] });
      pick(m.types, 'invoice').properties.push({ name: 'payment', kind: 'ref', ref: 'payments:payment', required: false, nullable: true, immutable: false, origin: 'external' });
      pick(pick(m.storage, 'billing.invoices').columns, 'id');
      const bundle: PublishedContract = { bundleVersion: 1, publisher: 'team-payments', contract: 'payments-api', version: 2, schemaVersion: 1, profiles: ['openapi'], digest, content };
      const ok = validate(m, { publishedContracts: [bundle] });
      assert(t, !codesOf(ok).some((c) => c.startsWith('PUBLISHED_CONTRACT')), `a pinned, matching bundle resolves: ${codesOf(ok).join(', ')}`);
      const tampered = { ...bundle, content: { ...content, types: [{ ...content.types[0]!, version: 3 }] } };
      assert(t, codesOf(observe(t, validate(m, { publishedContracts: [tampered] }))).includes('PUBLISHED_CONTRACT_DIGEST_MISMATCH'), 'a bundle whose content differs from its pinned digest is rejected');
      assert(t, codesOf(observe(t, validate(m, { publishedContracts: [{ ...bundle, version: 3 }] }))).includes('PUBLISHED_CONTRACT_INCOMPATIBLE'), 'a bundle of another version is incompatible with the pin');
      const unknownRef = deepClone(m);
      pick(pick(unknownRef.types, 'invoice').properties, 'payment').ref = 'payments:refund';
      assert(t, codesOf(observe(t, validate(unknownRef, { publishedContracts: [bundle] }))).includes('PUBLISHED_CONTRACT_REFERENCE_UNKNOWN'), 'a reference to a record the bundle lacks is rejected');
      assert(t, codesOf(observe(t, validate(m, { publishedContracts: [] }))).includes('PUBLISHED_CONTRACT_UNRESOLVED'), 'a pin without a resolved bundle stays unresolved');
      const ready = checkReadiness(m, { class: 'release', mode: 'component', components: ['billing'] }, { ...acceptedInputs(m), evidence: [] });
      assert(t, ready.state.state !== 'ready' && reasons(t, ready.state).includes('PUBLISHED_CONTRACT_UNRESOLVED'), 'an unresolved bundle keeps dependent release work from being ready');
    },
  },
  {
    name: 'baselines and acceptance',
    run: (t) => {
      const none = compareBaseline(sampleModel(), {});
      assert(t, none.acceptance.state === 'notEvaluated' && codesOf(observe(t, none.findings)).includes('BASELINE_MISSING'), 'without a baseline acceptance is not evaluated');
      const same = compareBaseline(sampleModel(), acceptedInputs());
      assert(t, same.acceptance.state === 'accepted' && same.changes.length === 0, `the accepted baseline itself is accepted: ${codesOf(same.findings).join(', ')}`);
      const security = fresh();
      pick(security.operations, 'order.get').authority.permission = 'order.admin';
      const refused = compareBaseline(security, acceptedInputs());
      assert(t, refused.acceptance.state === 'unaccepted' && codesOf(observe(t, refused.findings)).includes('CHANGE_UNACCEPTED') && refused.acceptanceRequired, 'a security change against the baseline needs acceptance, whatever route produced it');
      const acked = compareBaseline(security, { ...acceptedInputs() });
      assert(t, codesOf(acked.findings).includes('CHANGE_UNACCEPTED'), 'acknowledgement plays no part in acceptance');
      const accepted = compareBaseline(security, { ...acceptedInputs(), acceptances: [...acceptedInputs().acceptances!, { record: acceptance('acc-2', modelRevision(security), [{ kind: 'operation', id: 'order.get' }]), trusted: true }] });
      assert(t, !codesOf(accepted.findings).includes('CHANGE_UNACCEPTED') && accepted.acceptance.state === 'accepted', `a trusted acceptance of the change admits it: ${codesOf(accepted.findings).join(', ')}`);
      const untrusted = compareBaseline(security, { ...acceptedInputs(), acceptances: [...acceptedInputs().acceptances!, { record: acceptance('acc-2', modelRevision(security), [{ kind: 'operation', id: 'order.get' }]), trusted: false }] });
      assert(t, codesOf(untrusted.findings).includes('CHANGE_UNACCEPTED'), 'an untrusted acceptance admits nothing');
      const removal = fresh();
      pick(removal.types, 'order-request').properties = pick(removal.types, 'order-request').properties.filter((p) => p.name !== 'note');
      assert(t, codesOf(observe(t, compareBaseline(removal, acceptedInputs()).findings)).includes('CHANGE_PROHIBITED'), 'a change the policy prohibits is refused');
      const additive = fresh();
      pick(additive.types, 'order-request').properties.push({ name: 'channel', kind: 'string', required: false, nullable: true, immutable: false, origin: 'client', bounds: { maxLength: 20 } });
      const frozen = compareBaseline(additive, acceptedInputs());
      assert(t, codesOf(observe(t, frozen.findings)).includes('FROZEN_COMPONENT_CHANGED') && !codesOf(frozen.findings).includes('CHANGE_UNACCEPTED'), 'a pre-authorized change still cannot redesign a frozen component');
      const thawed = compareBaseline(additive, { ...acceptedInputs(), baseline: { record: baselineOf(sampleModel(), { components: [] }), model: sampleModel(), verified: true } });
      assert(t, !codesOf(thawed.findings).includes('FROZEN_COMPONENT_CHANGED') && thawed.acceptance.state === 'accepted', 'a pre-authorized change to an unfrozen component proceeds without acceptance');
      assert(t, codesOf(observe(t, compareBaseline(sampleModel(), { ...acceptedInputs(), baseline: { record: baselineOf(sampleModel()), model: sampleModel(), verified: false } }).findings)).includes('BASELINE_UNTRUSTED'), 'a baseline not read from the trusted ref is untrusted');
      assert(t, codesOf(observe(t, compareBaseline(sampleModel(), { ...acceptedInputs(), baseline: { record: baselineOf(sampleModel(), { model: { hash: HASH('9'), formatVersion: 1, snapshot: 'x.json' } }), model: sampleModel(), verified: true } }).findings)).includes('BASELINE_HASH_MISMATCH'), 'a baseline whose snapshot does not match its hash is rejected');
      assert(t, codesOf(observe(t, compareBaseline(sampleModel(), { ...acceptedInputs(), acceptances: [{ record: acceptance('acc-1', modelRevision(sampleModel()), [], 'baseline'), trusted: false }] }).findings)).includes('ACCEPTANCE_UNTRUSTED'), 'an acceptance outside the trusted ref is untrusted');
      const elsewhere: EvaluationInputs = { ...acceptedInputs(), acceptances: [{ record: acceptance('acc-1', modelRevision(security), [], 'baseline'), trusted: true }] };
      const otherRevision = compareBaseline(sampleModel(), elsewhere);
      assert(t, !baselineAccepted(elsewhere) && otherRevision.acceptance.state === 'unaccepted' && otherRevision.findings.some((f) => f.code === 'ACCEPTANCE_MISSING' && f.message.includes(modelRevision(security))), 'an acceptance of another revision does not accept the baseline that names it');
      assert(t, checkReadiness(sampleModel(), { class: 'implementation', mode: 'component', components: ['billing'] }, elsewhere).state.state === 'blocked', 'the contracts of a baseline whose acceptance names another revision are not accepted for implementation');
      assert(t, baselineAccepted(acceptedInputs()) && !compareBaseline(sampleModel(), acceptedInputs()).findings.some((f) => f.code === 'ACCEPTANCE_MISSING'), 'an acceptance of the revision the baseline pins accepts it');

      const unbumped = (m: Model): string[] => compareBaseline(m, acceptedInputs()).findings.filter((f) => f.code === 'BREAKING_CHANGE_WITHOUT_VERSION_BUMP').map((f) => f.path);
      assert(t, unbumped(security).includes('operations/order.get/version'), 'a breaking change against the baseline at an unchanged contract version is reported by the comparison itself');
      const raised = mutate(sampleModel(), { op: 'update', collection: 'operations', id: 'order.get', set: { version: 2, authority: { permission: 'order.admin', scheme: 'bearer' } } }, { acknowledgeBreaking: ['order.get'] }).model;
      const lowered = raised ? mutate(raised, { op: 'update', collection: 'operations', id: 'order.get', set: { version: 1 } }).model : null;
      assert(t, raised !== null && lowered !== null && unbumped(lowered).includes('operations/order.get/version'), 'two accepted patches that together break a contract at its accepted version get the same finding');
      assert(t, unbumped(importModel(exportYaml(security))).includes('operations/order.get/version'), 'an imported document gets the same finding as the edit it carries');
      assert(t, raised !== null && unbumped(raised).length === 0, 'a breaking change that raises the version is not reported as unbumped');
      const reworded = fresh();
      pick(reworded.operations, 'order.get').description = 'Reads one order by its id.';
      assert(t, unbumped(reworded).length === 0, 'a compatible edit at an unchanged version is not reported as unbumped');

      const supported = fresh();
      Object.assign(pick(supported.types, 'order'), { version: 2, supported: [{ version: 1, baseline: 'bl-0', status: 'supported', retirement: { condition: 'decision', decision: 'dec.order-retire' } }] });
      supported.decisions.push({ id: 'dec.order-retire', revision: 1, question: 'When is order version 1 retired?', alternatives: [{ id: 'now', description: 'Retire it now.', consequences: 'Version 1 consumers break.' }, { id: 'later', description: 'Keep it.', consequences: 'Two shapes are served.', rejectedBecause: 'Its consumers migrated.' }], criteria: ['Consumer impact.'], basedOn: [{ kind: 'workload', id: 'wl.checkout' }], chosen: 'now', affects: [{ kind: 'type', id: 'order' }], authority: 'team-architecture', status: 'accepted' });
      const retired = deepClone(supported);
      delete pick(retired.types, 'order').supported;
      const blocked = observe(t, retirementFindings(supported, retired, {}));
      assert(t, codesOf(blocked).includes('VERSION_RETIREMENT_BLOCKED'), 'retiring a version an active required consumer binds is blocked');
      const permitted = retirementFindings(supported, retired, { acceptances: [{ record: acceptance('acc-retire', modelRevision(retired), [{ kind: 'decision', id: 'dec.order-retire' }]), trusted: true }] });
      assert(t, permitted.length === 0, 'an accepted retirement decision permits the retirement');
      const migrated = deepClone(retired);
      for (const b of migrated.consumerBindings) b.version = 2;
      assert(t, retirementFindings(supported, migrated, {}).length === 0, 'retirement proceeds once the consumers moved on');

      const weak = observe(t, gateFindings(sampleModel(), { policy: POLICY, gates: { implementationRequires: 'none' } }));
      assert(t, codesOf(weak).includes('POLICY_WEAKENED'), 'configuration weaker than the trusted policy is ignored and reported');
      const sealed = observe(t, gateFindings(sampleModel(), { state: { stateVersion: 1, phase: 'implementation', sealed: true } }));
      assert(t, codesOf(sealed).includes('SEALED_FLAG_UNBACKED'), 'a sealed flag without acceptance has no authority');
      assert(t, derivedSeal(sampleModel(), acceptedInputs()) === true && derivedSeal(sampleModel(), {}) === false, 'the seal is derived from trusted acceptance of the current revision');
      const env = compareBaselineTool({ model: security }, acceptedInputs());
      assert(t, schemaErrors('ResultEnvelope', env).length === 0 && env.states.acceptance.state === 'unaccepted', `the comparison result satisfies the result contract: ${JSON.stringify(schemaErrors('ResultEnvelope', env))}`);
    },
  },
  {
    name: 'evidence',
    run: (t) => {
      const m = sampleModel();
      const scope = resolveScope(indexModel(m), { mode: 'component', components: ['ordering'] });
      const obligations = deriveObligations(m, scope, { policy: POLICY });
      assert(t, obligations.some((o) => o.id === 'criterion:req.pay-order.paid') && obligations.some((o) => o.id === 'release:ordering:integration'), 'obligations cover required criteria and the release evidence of the gates');
      const pay = obligations.filter((o) => o.id === 'criterion:req.pay-order.paid');
      const run = (records: Array<{ record: EvidenceRecord; trusted: boolean }>) => evaluateEvidence(m, pay, { evidence: records });
      const ok = run([{ record: evidence('ev.pay', 'behavior', [{ kind: 'criterion', ref: 'req.pay-order.paid' }], m, ['mutation:order.pay']), trusted: true }]);
      assert(t, ok.obligations[0]!.status === 'passing' && ok.qualification.state === 'qualified', 'trusted current passing evidence qualifies its obligation');
      const statuses: Array<[string, EvidenceRecord, boolean, string, string]> = [
        ['absent', evidence('ev.other', 'behavior', [{ kind: 'criterion', ref: 'req.cancel-order.cancelled' }], m, []), true, 'absent', 'EVIDENCE_MISSING'],
        ['failing', evidence('ev.fail', 'behavior', [{ kind: 'criterion', ref: 'req.pay-order.paid' }], m, [], { result: 'FAIL' }), true, 'failing', 'EVIDENCE_FAILED'],
        ['unknown', evidence('ev.unknown', 'behavior', [{ kind: 'criterion', ref: 'req.pay-order.paid' }], m, [], { result: 'UNKNOWN', reason: 'The tool was absent.' }), true, 'unknown', 'EVIDENCE_UNKNOWN'],
        ['untrusted', evidence('ev.claim', 'behavior', [{ kind: 'criterion', ref: 'req.pay-order.paid' }], m, []), false, 'untrusted', 'EVIDENCE_UNTRUSTED'],
        ['stale', { ...evidence('ev.stale', 'behavior', [{ kind: 'criterion', ref: 'req.pay-order.paid' }], m, ['mutation:order.pay']), inputs: [{ ref: 'mutation:order.pay', hash: HASH('5') }] }, true, 'stale', 'EVIDENCE_STALE'],
        ['unjustified n/a', evidence('ev.na', 'behavior', [{ kind: 'criterion', ref: 'req.pay-order.paid' }], m, [], { result: 'NOT_APPLICABLE' }), true, 'unknown', 'EVIDENCE_NOT_APPLICABLE_UNJUSTIFIED'],
      ];
      for (const [label, record, trusted, status, code] of statuses) {
        const r = run([{ record, trusted }]);
        observe(t, r.findings);
        assert(t, r.obligations[0]!.status === status && codesOf(r.findings).includes(code as never) && r.qualification.state !== 'qualified', `${label} evidence is ${status} with ${code}, never qualified: ${r.obligations[0]!.status} ${codesOf(r.findings).join(', ')}`);
      }
      const ddl = renderTarget(m, 'sql').files.find((f) => f.instance === 'schema.sql#ordering')!;
      const aboutDdl = evidence('ev.ddl', 'behavior', [{ kind: 'criterion', ref: 'req.pay-order.paid' }], m, [], { inputs: [{ ref: `artifact:${ddl.instance}`, hash: ddl.hash }] });
      const unhashed = run([{ record: aboutDdl, trusted: true }]);
      observe(t, unhashed.findings);
      assert(t, unhashed.obligations[0]!.status === 'unknown' && /was not supplied/.test(unhashed.obligations[0]!.reason ?? '') && unhashed.findings.some((f) => f.code === 'EVIDENCE_UNKNOWN' && f.message.includes(ddl.instance)) && unhashed.qualification.state === 'unknown' && !unhashed.retained.some((r) => r.evidence === 'ev.ddl'), 'evidence about an artifact whose current hash was not supplied is unknown with that reason, never current');
      const hashed = evaluateEvidence(m, pay, withArtifactHashes(m, { evidence: [{ record: aboutDdl, trusted: true }] }));
      assert(t, hashed.obligations[0]!.status === 'passing' && hashed.obligations[0]!.reason === undefined && hashed.retained.some((r) => r.evidence === 'ev.ddl'), 'the same evidence with the current hash supplied is passing and retained');
      const moved = evaluateEvidence(m, pay, { evidence: [{ record: aboutDdl, trusted: true }], artifacts: { [ddl.instance]: HASH('d') } });
      assert(t, moved.obligations[0]!.status === 'stale', 'a supplied hash that differs from the recorded one makes it stale');
      const unknownOnly = run([{ record: evidence('ev.unknown', 'behavior', [{ kind: 'criterion', ref: 'req.pay-order.paid' }], m, [], { result: 'UNKNOWN' }), trusted: true }]);
      assert(t, unknownOnly.qualification.state === 'unknown', 'a required unknown leaves qualification unknown');
      const na = run([{ record: evidence('ev.na', 'behavior', [{ kind: 'criterion', ref: 'req.pay-order.paid' }], m, [], { result: 'NOT_APPLICABLE', reason: 'The criterion is verified by review in this release.' }), trusted: true }]);
      assert(t, na.obligations[0]!.status === 'not-applicable' && na.qualification.state === 'qualified', 'a justified NOT_APPLICABLE satisfies its obligation');
      const mixed = evaluateEvidence(m, pay, {
        evidence: [
          { record: { ...evidence('ev.stale', 'behavior', [{ kind: 'criterion', ref: 'req.pay-order.paid' }], m, []), inputs: [{ ref: 'mutation:order.pay', hash: HASH('5') }] }, trusted: true },
          { record: evidence('ev.cancel', 'behavior', [{ kind: 'criterion', ref: 'req.cancel-order.cancelled' }], m, ['mutation:order.cancel']), trusted: true },
        ],
      });
      assert(t, mixed.invalidated.some((i) => i.evidence === 'ev.stale') && mixed.retained.some((r) => r.evidence === 'ev.cancel'), 'changed inputs invalidate their evidence while unrelated evidence is retained with its reason');
      const integration = [{ id: 'release:ordering:integration', claim: { kind: 'release' as const, ref: 'ordering' }, kinds: ['integration' as const], required: true, status: 'absent' as const }];
      const doubled = evaluateEvidence(m, integration, { evidence: [{ record: evidence('ev.double', 'integration', [{ kind: 'criterion', ref: 'req.place-order.accepted' }], m, [], { boundaries: [{ boundary: 'Order store', actual: 'substitute', substitute: 'test-double' }] }), trusted: true }] });
      assert(t, codesOf(observe(t, doubled.findings)).includes('EVIDENCE_SUBSTITUTE_NOT_PERMITTED') && doubled.qualification.state === 'unqualified', 'integration evidence against a substitute cannot qualify the real boundary');
      const engine = evaluateEvidence(m, integration, { evidence: [{ record: evidence('ev.selftest', 'integration', [{ kind: 'release', ref: 'ordering' }], m, [], { check: { id: 'loom.self-test', revision: 1, definitionHash: HASH('6') }, environment: { id: 'process', kind: 'process' } }), trusted: true }] });
      assert(t, engine.obligations[0]!.status === 'absent', "the engine's own self-test never satisfies an adopting system's integration obligation");
      const split = evaluateEvidence(m, [...pay, ...obligations.filter((o) => o.id === 'criterion:req.cancel-order.cancelled')], {
        evidence: [
          { record: evidence('ev.pay', 'behavior', [{ kind: 'criterion', ref: 'req.pay-order.paid' }], m, []), trusted: true },
          { record: evidence('ev.cancel', 'behavior', [{ kind: 'criterion', ref: 'req.cancel-order.cancelled' }], m, [], { sources: [{ repository: '.', revision: 'b1c2d3e' }] }), trusted: true },
        ],
      });
      assert(t, codesOf(observe(t, split.findings)).includes('EVIDENCE_REVISION_SET_INCONSISTENT') && split.qualification.state === 'unqualified', 'separately passing evidence at different revisions cannot qualify one assembled system');
      const env = evaluateEvidenceTool({ model: m }, { evidence: [] });
      assert(t, schemaErrors('ResultEnvelope', env).length === 0, 'the evidence result satisfies the result contract');
    },
  },
  {
    name: 'readiness',
    run: (t) => {
      const m = sampleModel();
      const task = (cls: TaskSpec['class'], components: string[], extra: Partial<TaskSpec> = {}): TaskSpec => ({ class: cls, mode: 'component', components, ...extra });
      const discovery = checkReadiness(m, task('discovery', ['ordering']));
      assert(t, discovery.state.state === 'ready' && discovery.data.allowedNext.includes('discovery'), 'discovery is ready without inputs');
      const spec = checkReadiness(m, task('specification', ['billing']));
      assert(t, spec.state.state === 'blocked' && reasons(t, spec.state).includes('READINESS_BLOCKED_BY_UNKNOWN'), 'an unknown blocking specification blocks it for the components it affects');
      assert(t, checkReadiness(m, task('specification', ['ordering'])).state.state === 'ready', 'specification is ready where no unknown blocks it');
      const noProfile = fresh();
      delete noProfile.systemProfile;
      const unresolvedSpec = checkReadiness(noProfile, task('specification', ['ordering']));
      assert(t, unresolvedSpec.state.state === 'unresolved' && reasons(t, unresolvedSpec.state).includes('READINESS_INPUT_MISSING'), 'without a system profile applicable concerns are not evaluated, so specification is unresolved');
      const unresolved = checkReadiness(m, task('implementation', ['billing']));
      assert(t, unresolved.state.state === 'unresolved', 'implementation without baseline or acceptance inputs is unresolved, never ready');
      const blocked = checkReadiness(m, task('implementation', ['billing']), { policy: POLICY, acceptances: [] });
      assert(t, blocked.state.state === 'blocked' && reasons(t, blocked.state).includes('READINESS_MATURITY_INSUFFICIENT'), 'implementation against unaccepted contracts is blocked');
      const ready = checkReadiness(m, task('implementation', ['billing']), acceptedInputs());
      assert(t, ready.state.state === 'ready', `implementation against accepted contracts is ready: ${ready.state.reasons.map((r) => r.message).join('; ')}`);
      const substituted = checkReadiness(m, task('implementation', ['billing'], { substitutes: [{ dependency: { kind: 'component', id: 'ordering' }, kind: 'test-double' }] }), acceptedInputs());
      assert(t, substituted.state.state === 'ready' && reasons(t, substituted.state).includes('READINESS_SUBSTITUTE_APPLIED') && substituted.data.substitutes.length === 1, 'a permitted test double stands in for the order store during implementation');
      const mocked = checkReadiness(m, task('implementation', ['billing'], { substitutes: [{ dependency: { kind: 'component', id: 'ordering' }, kind: 'mock' }] }), acceptedInputs());
      assert(t, mocked.state.state === 'blocked' && reasons(t, mocked.state).includes('READINESS_PREREQUISITE_UNMET'), 'a substitute no dependency and policy permit is refused');
      const integration = checkReadiness(m, task('integration', ['billing'], { substitutes: [{ dependency: { kind: 'component', id: 'ordering' }, kind: 'test-double' }] }), { ...acceptedInputs(), evidence: [] });
      assert(t, integration.state.state === 'blocked' && integration.data.substitutes.length === 0, 'a substitute never makes integration ready');
      const unplanned = checkReadiness(m, task('implementation', ['billing']), { ...acceptedInputs(), state: { stateVersion: 1, phase: 'unplanned', sealed: false } });
      assert(t, unplanned.state.state === 'blocked' && reasons(t, unplanned.state).includes('WORKSPACE_UNPLANNED'), 'an unplanned workspace is not ready for implementation');
      const doubted = fresh();
      pick(doubted.assumptions, 'asm.peak-factor').status = 'invalidated';
      const assumption = checkReadiness(doubted, task('implementation', ['ordering']), acceptedInputs(doubted));
      assert(t, reasons(t, assumption.state).includes('READINESS_BLOCKED_BY_ASSUMPTION'), 'an invalidated assumption blocks the work resting on it');
      const release = checkReadiness(m, task('release', ['ordering']), { ...acceptedInputs(), evidence: [] });
      assert(t, release.state.state === 'blocked' && release.data.workPackage.exitEvidence.length > 0, 'release without evidence is blocked and its exit evidence is listed');
      const operations = checkReadiness(m, task('operations', ['ordering'], { records: [{ kind: 'workload', id: 'wl.checkout' }] }));
      assert(t, operations.state.state === 'ready', `operational investigation is ready where observations exist: ${operations.state.reasons.map((r) => r.message).join('; ')}`);
      const discoveryBlocked = fresh();
      pick(discoveryBlocked.unknowns, 'unk.report-period').blocks = ['discovery'];
      assert(t, checkReadiness(discoveryBlocked, task('discovery', ['billing'])).state.state === 'blocked', 'an unknown that blocks discovery blocks it');
      assert(t, checkReadiness(m, task('integration', ['billing']), acceptedInputs()).state.state === 'unresolved', 'integration without evidence inputs is unresolved');
      assert(t, checkReadiness(m, task('release', ['billing']), acceptedInputs()).state.state === 'unresolved', 'release without evidence inputs is unresolved');
      assert(t, checkReadiness(m, task('operations', ['billing'])).state.state === 'blocked', 'operational investigation without observations is blocked');
      assert(t, checkReadiness(noProfile, task('operations', ['ordering'], { records: [{ kind: 'workload', id: 'wl.checkout' }] })).state.state === 'unresolved', 'operational investigation without a system profile is unresolved');
      const realIntegration = evidence('ev.integration', 'integration', [{ kind: 'release', ref: 'billing' }, { kind: 'release', ref: 'ordering' }], m, ['type:invoice', 'type:order']);
      const built = evidence('ev.build', 'build', [{ kind: 'contract', ref: 'type:invoice' }, { kind: 'contract', ref: 'storage:billing.invoices' }], m, ['type:invoice', 'storage:billing.invoices']);
      const integrated = checkReadiness(m, task('integration', ['billing']), { ...acceptedInputs(), evidence: [{ record: built, trusted: true }, { record: realIntegration, trusted: true }] });
      assert(t, integrated.state.state === 'ready', `integration with implemented contracts and real-boundary evidence is ready: ${integrated.state.reasons.map((r) => r.message).join('; ')}`);
      const released = checkReadiness(m, task('release', ['billing']), { ...acceptedInputs(), evidence: [{ record: built, trusted: true }, { record: realIntegration, trusted: true }] });
      assert(t, released.state.state === 'ready', `release with every obligation passing and the revision accepted is ready: ${released.state.reasons.map((r) => r.message).join('; ')}`);
      const wp = ready.data.workPackage;
      assert(t, wp.scope.includes('billing') && wp.inputs.length > 0 && wp.allowedEdits.length > 0 && wp.tests.length > 0, 'a work package states its scope, input revisions, allowed edits and tests');
      const slice = checkReadiness(m, { class: 'implementation', mode: 'slice', requirements: ['req.dispatch'] }, acceptedInputs());
      assert(t, slice.data.workPackage.mode === 'slice' && slice.data.workPackage.scope.includes('fulfillment') && slice.data.workPackage.inputs.some((i) => i.ref.kind === 'storage'), 'a slice spans the requirement closure across components');
      const after = fresh();
      pick(pick(after.types, 'invoice').properties, 'amount').description = 'The invoiced total.';
      const re = recomputeReadiness(m, after, [task('implementation', ['ordering']), task('implementation', ['billing'])], acceptedInputs());
      assert(t, re.affected.some((a) => a.workPackage.scope.includes('billing') && a.changed.some((c) => c.id === 'invoice')) && re.unaffected.some((w) => w.scope.includes('ordering')), 'a changed type affects the work that consumes it and preserves unrelated accepted work');
      const env = checkReadinessTool({ model: m, task: task('implementation', ['billing']) }, acceptedInputs());
      assert(t, schemaErrors('ResultEnvelope', env).length === 0 && env.states.readiness.state === 'ready', `the readiness result satisfies the result contract: ${JSON.stringify(schemaErrors('ResultEnvelope', env))}`);
      assert(t, schemaErrors('ReadinessData', env.data).length === 0, 'the readiness payload satisfies its contract');
    },
  },
  {
    name: 'design order and impact',
    run: (t) => {
      const order = designOrder(sampleModel());
      const rank = (kind: string, id: string): number => order.design.find((d) => d.ref.kind === kind && d.ref.id === id)!.rank;
      assert(t, rank('type', 'order') < rank('type', 'order-response') && rank('type', 'order') < rank('storage', 'fulfillment.shipments'), 'the shared identity ranks before the detail that depends on it');
      assert(t, order.design.every((d) => d.reasons.length === 4), 'every design rank exposes its propagation, centrality, uncertainty and reversal-cost factors');
      const impl = order.implementation.map((i) => i.ref.id);
      assert(t, impl.indexOf('ordering') < impl.indexOf('billing'), 'implementation order puts a provider before its consumers');
      assert(t, order.runtime.length > 0 && order.deployment.length > 0, 'runtime and deployment orders are reported separately');
      assert(t, schemaErrors('DesignOrder', order).length === 0, 'the design order satisfies its contract');
      const moved = fresh();
      pick(moved.deploymentUnits, 'du.ordering-api').timeout = 'PT60S';
      const impact = changeImpact(sampleModel(), moved, [{ kind: 'deploymentUnit', id: 'du.ordering-api' }]);
      assert(t, impact.some((a) => a.reason === 'co-hosted' && a.ref.id === 'billing') && impact.some((a) => a.reason === 'co-hosted' && a.ref.id === 'ordering'), 'a hosting change reaches every co-hosted component');
    },
  },
  {
    name: 'context and previews',
    run: (t) => {
      const m = sampleModel();
      const target = { kind: 'component' as const, ref: { kind: 'component' as const, id: 'ordering' } };
      const first = contextTool({ model: m, target, budget: { maxRecords: 3 } });
      const page = first.data as { items: unknown[]; required: unknown[] };
      assert(t, first.outcome === 'ok' && page.items.length === 3 && first.completeness.truncated && first.completeness.continuation !== undefined && first.completeness.omitted.length === page.required.length - 3, 'a budgeted context marks what it omitted and how to retrieve it');
      const second = contextTool({ model: m, target, budget: { maxRecords: 1000 }, continuation: first.completeness.continuation! });
      assert(t, second.outcome === 'ok' && (second.data as { items: unknown[] }).items.length === page.required.length - 3 && !second.completeness.truncated, 'the continuation retrieves the rest');
      const stale = contextTool({ model: m, target, budget: { maxRecords: 3 }, continuation: continuationToken(HASH('7'), 3) });
      assert(t, stale.refusal?.cause === 'stale-base' && codesOf(observe(t, stale.findings)).includes('STALE_BASE_REVISION'), 'a continuation for another revision is refused');
      for (const env of [first, second, stale]) assert(t, schemaErrors('ResultEnvelope', env).length === 0, `the context result satisfies the result contract: ${JSON.stringify(schemaErrors('ResultEnvelope', env))}`);
      assert(t, schemaErrors('ContextData', first.data).length === 0, 'the context payload satisfies its contract');
      const wrongBase = planChangeTool({ model: m, baseRevision: HASH('8'), patch: { op: 'clearSystemProfile' } });
      assert(t, wrongBase.refusal?.cause === 'stale-base', 'a change planned against another revision is refused');
      const preview = planChangeTool({ model: m, baseRevision: modelRevision(m), patch: { op: 'update', collection: 'operations', id: 'order.get', set: { version: 2, authority: { permission: 'order.admin', scheme: 'bearer' } } }, acknowledgeBreaking: ['order.get'] }, { ...acceptedInputs(), evidence: [{ record: evidence('ev.get', 'conformance', [{ kind: 'contract', ref: 'operation:order.get' }], m, ['operation:order.get']), trusted: true }] });
      const data = preview.data as { acceptanceRequired: boolean; changes: unknown[]; invalidatedEvidence: Array<{ evidence: string }>; compatibility: Array<{ dimension: string }> };
      assert(t, data.acceptanceRequired && data.changes.length > 0 && data.compatibility.some((c) => c.dimension === 'security') && data.invalidatedEvidence.some((e) => e.evidence === 'ev.get'), `a preview names the security consequence, the acceptance it needs and the evidence it invalidates: ${JSON.stringify(data.compatibility)}`);
      assert(t, modelRevision(m) === modelRevision(sampleModel()), 'a preview never persists');
      const ddl = renderTarget(m, 'sql').files.find((f) => f.instance === 'schema.sql#ordering')!;
      const aboutDdl = evidence('ev.ddl', 'conformance', [{ kind: 'contract', ref: 'storage:ordering.orders' }], m, [], { inputs: [{ ref: `artifact:${ddl.instance}`, hash: ddl.hash }] });
      const withDdl = withArtifactHashes(m, { ...acceptedInputs(), evidence: [{ record: aboutDdl, trusted: true }] });
      const widened = planChangeTool({ model: m, baseRevision: modelRevision(m), patch: { op: 'updateItem', collection: 'storage', id: 'ordering.orders', field: 'columns', key: 'note', set: { sqlType: { name: 'nvarchar', length: 400 } } }, acknowledgeBreaking: ['ordering.orders'] }, withDdl);
      const reworded = planChangeTool({ model: m, baseRevision: modelRevision(m), patch: { op: 'update', collection: 'operations', id: 'order.get', set: { description: 'Reads one order by its id.' } } }, withDdl);
      const invalidated = (env: typeof widened): string[] => ((env.data as { invalidatedEvidence?: Array<{ evidence: string }> }).invalidatedEvidence ?? []).map((e) => e.evidence);
      assert(t, invalidated(widened).includes('ev.ddl') && !invalidated(reworded).includes('ev.ddl'), `a preview judges evidence about an artifact by the candidate's own rendering of it: ${JSON.stringify(widened.findings.map((f) => f.code))}`);
      const mutated = (patch: Patch, acknowledgeBreaking: string[] = []): string[] => invalidated(mutateTool({ model: m, patch, acknowledgeBreaking, dryRun: true }, withDdl));
      assert(t, mutated({ op: 'updateItem', collection: 'storage', id: 'ordering.orders', field: 'columns', key: 'note', set: { sqlType: { name: 'nvarchar', length: 400 } } }, ['ordering.orders']).includes('ev.ddl') && mutated({ op: 'update', collection: 'operations', id: 'order.get', set: { description: 'Reads one order by its id.' } }).length === 0, 'a mutation names the evidence it invalidates as the preview of the same change does');
      for (const env of [wrongBase, preview]) assert(t, schemaErrors('ResultEnvelope', env).length === 0, `the plan result satisfies the result contract: ${JSON.stringify(schemaErrors('ResultEnvelope', env))}`);
      assert(t, schemaErrors('PlanChangeData', preview.data).length === 0, `the plan payload satisfies its contract: ${JSON.stringify(schemaErrors('PlanChangeData', preview.data))}`);
      const described = describeTool();
      assert(t, schemaErrors('ResultEnvelope', described).length === 0 && schemaErrors('DescribeData', described.data).length === 0, `the describe result satisfies its contract: ${JSON.stringify(schemaErrors('DescribeData', described.data))}`);
    },
  },
];
