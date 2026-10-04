import type { Baseline, ContextData, DescribeData, Model, NextAction, ResultEnvelope, ResumeData, RevisionVector } from '../generated/types.js';
import { CONTRACT_DIGEST } from '../generated/digest.js';
import { PATCH_VARIANTS } from '../generated/registry.js';
import { PROFILES } from '../generated/contracts.js';
import { AGENT_TOOLS, MCP_INSTRUCTIONS_BUDGET, MCP_TOOLS, OPERATION_CATALOGUE } from '../generated/operations.js';
import { FINDING_RULES } from '../codes.js';
import { canonicalHash, modelRevision, recordHash, textHash } from '../hash.js';
import { schemaErrors } from '../schema-runtime.js';
import { unmetPresenceRules } from '../operations.js';
import { DISCOVERY_LIMITS, dataBytes, toolEffects, utf8Bytes } from '../discovery.js';
import { GUIDANCE_REVISION, ORIENTATION_TEXT, guide, guides } from '../guidance.js';
import { DESCRIBE_SECTIONS, descriptionProblems, proofLimits, toolDescriptions } from '../describe.js';
import { RESUME_TARGET, type ResumeInputs } from '../resume.js';
import { contextTool, describeTool } from '../tools.js';
import { sampleModel } from '../sample.js';
import { assert, assertThrows, codesOf, fresh, observe, pick, type Tally } from './harness.js';

const HASH = (c: string): string => `sha256:${c.repeat(64)}`;

interface Section {
  name: string;
  run(t: Tally): void;
}

/** The input definition and the presence rules of the tool a next action names, read from the operation catalogue. */
function contractOf(action: NextAction): { input: string; presence: (typeof MCP_TOOLS)[number]['presence'] } {
  const advertised = MCP_TOOLS.find((x) => x.name === action.tool);
  if (advertised) return { input: advertised.input, presence: advertised.presence };
  const agent = AGENT_TOOLS.find((x) => x.name === action.tool);
  const step = agent?.actions.find((a) => a.action === (action.arguments as Record<string, unknown>)['action']);
  if (!agent || !step) throw new Error(`no catalogued tool runs the next action ${action.tool}`);
  return { input: agent.input, presence: step.presence };
}

/** Every reason a next action is not concrete: its arguments break its tool's input contract or one of its presence rules. */
function actionProblems(action: NextAction): string[] {
  const { input, presence } = contractOf(action);
  const args = action.arguments as Record<string, unknown>;
  return [...schemaErrors(input, args).map((e) => `${action.tool} ${e.pointer} ${e.message}`), ...unmetPresenceRules(presence, args).map((r) => `${action.tool} breaks ${r.id}`)];
}

/** Every page of a request, following its continuation; the request must not carry one itself. */
function pagesOf(run: (cursor: string | undefined) => ResultEnvelope, limit = 500): ResultEnvelope[] {
  const pages: ResultEnvelope[] = [];
  let cursor: string | undefined;
  do {
    const page = run(cursor);
    pages.push(page);
    cursor = page.completeness.continuation;
  } while (cursor !== undefined && pages.length < limit);
  return pages;
}

const describePages = (input: Parameters<typeof describeTool>[0]): ResultEnvelope[] => pagesOf((cursor) => describeTool({ ...input, ...(cursor ? { cursor } : {}) }));

/** The engineering order is a table of ten stages, each with its required input and its exit evidence. */
function stageRows(text: string): number {
  const at = text.indexOf('## Engineering order');
  const rest = text.slice(at).split('\n').slice(1);
  const end = rest.findIndex((l, i) => i > 0 && l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => /^\|/.test(l)).length - 2;
}

function baselineOf(model: Model, frozen: readonly string[]): Baseline {
  return {
    baselineVersion: 1,
    id: 'bl-1',
    model: { hash: modelRevision(model), formatVersion: 1, snapshot: 'baselines/bl-1.model.json' },
    config: { hash: HASH('1'), configVersion: 1 },
    policy: { ref: 'engineering', revision: 1, hash: HASH('2') },
    generator: { version: '1.0.0', contractDigest: CONTRACT_DIGEST },
    contracts: [],
    components: model.components.map((c) => ({ id: c.id, hash: HASH('3'), frozen: frozen.includes(c.id) })),
    artifacts: [],
    sources: [],
    commitments: [],
    acceptance: 'acc-1',
  };
}

const vectorOf = (model: Model, models = 1): RevisionVector => ({
  vectorVersion: 1,
  models: Array.from({ length: models }, (_, i) => ({ modelId: i === 0 ? 'shop' : `member-${String(i).padStart(3, '0')}`, model: modelRevision(model), config: HASH('4'), policy: null, contract: CONTRACT_DIGEST, generator: HASH('5'), imports: [] })),
});

/** The recorded progress of a workspace holding the sample: what an adapter reads and supplies. */
function recorded(model: Model, extra: Partial<ResumeInputs> = {}): ResumeInputs {
  return {
    address: { workspace: true },
    workspaceId: 'ws_3f9a1c7d',
    outcome: { statement: 'Orders can be paid in one step.', exclusions: ['Refunds.'], constraints: ['Amounts are exact decimals.'] },
    phase: 'specification',
    owningScopes: model.components.map((c) => ({ modelId: 'shop', component: c.id, roots: [c.id] })),
    revisionVector: vectorOf(model),
    baseline: { record: baselineOf(model, ['ordering']), model },
    openUnknowns: model.unknowns,
    evidence: [{ id: 'criterion:req.pay-order.paid', claim: { kind: 'criterion', ref: 'req.pay-order.paid' }, kinds: ['behavior'], required: true, status: 'absent' }],
    pendingWork: [
      { workPackage: 'wp.billing.specification', status: 'in-progress', task: { class: 'specification', mode: 'component', components: ['billing'] } },
      { workPackage: 'wp.ordering.implementation', status: 'blocked', task: { class: 'implementation', mode: 'component', components: ['ordering'] } },
      { workPackage: 'wp.reporting', status: 'planned' },
    ],
    pendingRuns: [{ runId: 'run-1', phase: 'running' }],
    ...extra,
  };
}

const resumeOf = (env: ResultEnvelope): ResumeData => (env.data as ContextData).resume as ResumeData;

export const DISCOVERY_SECTIONS: readonly Section[] = [
  {
    name: 'orientation and guidance',
    run: (t) => {
      assert(t, utf8Bytes(ORIENTATION_TEXT) <= MCP_INSTRUCTIONS_BUDGET, `the orientation takes ${utf8Bytes(ORIENTATION_TEXT)} UTF-8 bytes, within the instructions budget of ${MCP_INSTRUCTIONS_BUDGET}`);
      const catalogued = OPERATION_CATALOGUE.resources.filter((r) => r.contents === 'GuideResource').map((r) => r.uri);
      assert(t, catalogued.length > 0 && guides().map((g) => g.uri).join(' ') === catalogued.join(' '), 'every guide resource of the catalogue has its guide, in catalogue order');
      for (const g of guides()) {
        assert(t, schemaErrors('GuideResource', g).length === 0, `${g.uri} satisfies GuideResource: ${JSON.stringify(schemaErrors('GuideResource', g))}`);
        assert(t, g.contentDigest === textHash(g.text) && g.contractDigest === CONTRACT_DIGEST, `${g.uri} names the digest of its exact text and the contract digest`);
      }
      assert(t, guide('loom://guide/start') === null, 'a URI the catalogue defines no guide at returns none');
      assert(t, stageRows(guide('loom://guide/engineering')?.text ?? '') === 10, 'the engineering guide states ten stages, each with its required input and exit evidence');
      const described = toolDescriptions();
      assert(t, described.length === MCP_TOOLS.length + AGENT_TOOLS.length + AGENT_TOOLS.reduce((n, a) => n + a.actions.length, 0), 'every generated description is checked');
      const problems = descriptionProblems(described);
      assert(t, problems.length === 0, `no generated tool description lists every profile or repeats a proof limit: ${problems.join('; ')}`);
      const limit = proofLimits()[0] as string;
      assert(t, descriptionProblems([{ name: 'loom.example', description: `Project a model. ${limit}` }]).length === 1, 'a description that repeats a proof limit is reported');
      assert(t, descriptionProblems([{ name: 'loom.example', description: `Profiles: ${PROFILES.map((p) => p.id).join(', ')}.` }]).some((p) => p.includes('lists every profile')), 'a description that lists every profile is reported');
    },
  },
  {
    name: 'describe pages',
    run: (t) => {
      const summary = describeTool();
      const data = summary.data as DescribeData;
      assert(t, summary.outcome === 'ok' && schemaErrors('ResultEnvelope', summary).length === 0 && schemaErrors('DescribeData', data).length === 0, `the summary satisfies its contract: ${JSON.stringify(schemaErrors('DescribeData', data))}`);
      assert(t, dataBytes(data) <= DISCOVERY_LIMITS.defaultBytes, `the default summary takes ${dataBytes(data)} bytes of data, within the default budget of ${DISCOVERY_LIMITS.defaultBytes}`);
      assert(t, data.orientation === ORIENTATION_TEXT && (data.entryPoints ?? []).length === OPERATION_CATALOGUE.workflow.length && (data.tools ?? []).length === MCP_TOOLS.length && data.capabilities !== undefined && (data.guides ?? []).length === guides().length && data.resources !== undefined, 'the summary carries the orientation, the entry points, the tool summaries, the capability facts and the guide and resource links');
      assert(t, data.proofLimits === undefined && data.findingCodes === undefined, 'the summary carries no proof limit and no full section');
      assert(t, !summary.completeness.truncated && DESCRIBE_SECTIONS.every((s) => summary.completeness.omitted.some((o) => o.section === s && o.reason === 'not-requested')), 'the summary lists every full section it leaves out');

      const full = describePages({ detail: 'full' });
      const sum = (member: keyof DescribeData): number => full.reduce((n, p) => n + (((p.data as DescribeData)[member] as unknown[] | undefined) ?? []).length, 0);
      assert(t, full.length > 1 && full.every((p) => p.outcome === 'ok' && dataBytes(p.data) <= DISCOVERY_LIMITS.defaultBytes && schemaErrors('DescribeData', p.data).length === 0), `every full page stays within the default budget and its contract: ${full.length} pages`);
      const records = (p: ResultEnvelope): number => Object.values(p.data as Record<string, unknown>).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
      assert(t, full.every((p) => records(p) <= DISCOVERY_LIMITS.defaultRecords), 'every full page holds at most the default number of records');
      assert(t, sum('findingCodes') === Object.keys(FINDING_RULES).length && sum('patchOperations') === PATCH_VARIANTS.length && sum('profiles') === PROFILES.length && sum('proofLimits') === proofLimits().length && new Set(proofLimits()).size === proofLimits().length, 'following the cursor returns every record of every section once, and every proof limit once');
      assert(t, full.slice(0, -1).every((p) => p.completeness.truncated && p.completeness.omitted.some((o) => o.reason === 'budget' && o.continuation === p.completeness.continuation)) && full.at(-1)?.completeness.continuation === undefined, 'every page but the last names the sections it leaves for later pages with its continuation');
      assert(t, full.every((p) => p.completeness.omitted.some((o) => o.section === 'summary' && o.reason === 'not-requested')), 'a full page lists the summary it leaves out');

      const small = describePages({ detail: 'full', sections: ['profiles'], budget: { maxBytes: DISCOVERY_LIMITS.minBytes } });
      const delivered = small.flatMap((p) => ((p.data as DescribeData).profiles ?? []).map((x) => x.id));
      const listed = small.flatMap((p) => p.completeness.omitted.map((o) => (o.reason === 'budget' && o.section?.startsWith('profiles/') ? o.section.slice('profiles/'.length) : null)).filter((id): id is string => id !== null));
      assert(t, small.every((p) => dataBytes(p.data) <= DISCOVERY_LIMITS.minBytes) && listed.length > 0 && [...delivered, ...listed].sort().join(' ') === PROFILES.map((p) => p.id).sort().join(' '), `a profile too large for the page is listed as omitted, never dropped: ${listed.join(', ')}`);

      const limitsOf = (operation: string): string[] => ((describeTool({ operation }).data as DescribeData).proofLimits ?? []);
      const validate = limitsOf('validate');
      assert(t, validate.join('|') === OPERATION_CATALOGUE.proofLimits.filter((p) => p.operations.includes('validate')).map((p) => p.text).join('|'), 'an operation that depends on no profile gets only its catalogue limits');
      const project = limitsOf('project');
      const raw = PROFILES.flatMap((p) => p.proofLimits);
      assert(t, raw.every((l) => project.includes(l)) && new Set(project).size === project.length && project.length < raw.length + OPERATION_CATALOGUE.proofLimits.length, "an operation that depends on profiles gets every profile's limits, each text once");
      const unknownOperation = describeTool({ operation: 'nothing' });
      assert(t, unknownOperation.refusal?.cause === 'invalid-input' && codesOf(observe(t, unknownOperation.findings)).includes('STRUCTURAL_INVALID'), 'an operation the catalogue does not hold is refused');
      for (const bad of [{ operation: 'project', detail: 'full' as const }, { sections: ['findings' as const] }, { detail: 'summary' as const, profile: 'sql' }, { detail: 'full' as const, budget: { maxBytes: 100 } }]) {
        const r = describeTool(bad);
        assert(t, r.refusal?.cause === 'invalid-input' && r.findings.length > 0 && schemaErrors('ResultEnvelope', r).length === 0, `a request that breaks a presence rule or the input contract is refused: ${JSON.stringify(bad)}`);
      }

      const cursor = full[0]?.completeness.continuation as string;
      const stale = describeTool({ detail: 'full', cursor: cursor.replace(GUIDANCE_REVISION, HASH('7')) });
      const again = stale.refusal?.nextActions?.[0];
      assert(t, stale.refusal?.cause === 'stale-base' && codesOf(observe(t, stale.findings)).includes('STALE_BASE_REVISION') && again !== undefined && actionProblems(again).length === 0 && (again.arguments as Record<string, unknown>)['cursor'] === undefined, 'a cursor of another build is refused with the request that starts again');
      const foreign = describeTool({ detail: 'full', sections: ['patches'], cursor });
      assert(t, foreign.refusal?.cause === 'invalid-input' && (foreign.refusal.nextActions ?? []).length === 1, 'a cursor of another request is refused');
      assert(t, describeTool({ detail: 'full', cursor: 'describe.x' }).refusal?.cause === 'invalid-input', 'a token Loom did not issue is refused');
      assert(t, describeTool({ detail: 'full', cursor: cursor.replace(/\.\d+$/, '.999999') }).refusal?.cause === 'invalid-input', 'a cursor past the end of the sequence is refused');
      assertThrows(t, () => toolEffects('loom.nothing'), 'a next action can name only a catalogued tool');
    },
  },
  {
    name: 'context pages',
    run: (t) => {
      const m = sampleModel();
      const resource = (ref: { kind: string; id: string }): string => `loom://workspaces/ws_3f9a1c7d/records/${ref.kind}/${encodeURIComponent(ref.id)}`;
      for (const c of m.components) {
        const target = { kind: 'component' as const, ref: { kind: 'component' as const, id: c.id } };
        for (const budget of [{}, { maxBytes: DISCOVERY_LIMITS.minBytes }]) {
          for (const withResource of [false, true]) {
            const pages = pagesOf((continuation) => contextTool({ model: m, target, budget, ...(continuation ? { continuation } : {}) }, {}, withResource ? { recordResource: resource } : {}));
            const limit = budget.maxBytes ?? DISCOVERY_LIMITS.defaultBytes;
            const total = (pages[0]?.data as ContextData).total as number;
            const items = pages.reduce((n, p) => n + ((p.data as ContextData).items ?? []).length, 0);
            const stoodIn = pages.flatMap((p) => (p.data as ContextData).oversized ?? []);
            const omitted = pages.flatMap((p) => p.completeness.omitted.filter((o) => o.ref !== undefined && o.reason === 'budget'));
            assert(t, pages.every((p) => p.outcome === 'ok' && dataBytes(p.data) <= limit && schemaErrors('ContextData', p.data).length === 0), `every context page of ${c.id} stays within ${limit} bytes and its contract`);
            assert(t, items + omitted.length === total, `every record of the closure of ${c.id} is on a page or listed as too large for one: ${items} and ${omitted.length} of ${total}`);
            assert(t, withResource ? stoodIn.length === omitted.length && stoodIn.every((o) => o.resource === resource(o.ref) && o.revision === modelRevision(m)) : stoodIn.length === 0, `a record too large for any page ${withResource ? 'is summarized with its record resource' : 'is listed in completeness when no resource serves it'}`);
            if (budget.maxBytes !== undefined) assert(t, omitted.length > 0, `a page of ${limit} bytes cannot hold every record of ${c.id}`);
          }
        }
      }
      const target = { kind: 'component' as const, ref: { kind: 'component' as const, id: 'ordering' } };
      const first = contextTool({ model: m, target, budget: { maxRecords: 5 } }, {}, { address: { workspace: true } });
      const token = first.completeness.continuation as string;
      const edited = fresh();
      pick(edited.operations, 'order.get').description = 'Reads one order by its id.';
      const stale = contextTool({ model: edited, target, budget: { maxRecords: 5 }, continuation: token }, {}, { address: { workspace: true } });
      const again = stale.refusal?.nextActions?.[0];
      assert(t, stale.refusal?.cause === 'stale-base' && stale.revisions.model === modelRevision(edited) && codesOf(observe(t, stale.findings)).includes('STALE_BASE_REVISION'), 'a continuation from before the model changed is refused, naming the current revision');
      assert(t, again !== undefined && actionProblems(again).length === 0 && (again.arguments as Record<string, unknown>)['workspace'] === true && (again.arguments as Record<string, unknown>)['continuation'] === undefined, `the refusal names the request that starts again, valid against the context input: ${again ? actionProblems(again).join('; ') : 'none'}`);
      const otherBudget = contextTool({ model: m, target, budget: { maxRecords: 6 }, continuation: token });
      const otherTarget = contextTool({ model: m, target: { kind: 'component', ref: { kind: 'component', id: 'billing' } }, budget: { maxRecords: 5 }, continuation: token });
      assert(t, otherBudget.refusal?.cause === 'invalid-input' && otherTarget.refusal?.cause === 'invalid-input' && (otherBudget.refusal.nextActions ?? []).length === 1, 'a continuation used with another budget or target is refused');
      const otherVector = contextTool({ model: m, target, budget: { maxRecords: 5 }, continuation: token }, {}, { revision: canonicalHash(vectorOf(m, 2)) });
      assert(t, otherVector.refusal?.cause === 'stale-base', 'a continuation binds the revision the adapter supplies, such as the digest of a revision vector');
      assert(t, contextTool({ model: m, target, continuation: 'context.x' }).refusal?.cause === 'invalid-input', 'a token Loom did not issue is refused');
      const shaped = contextTool({ model: m, target, continuation: 'page 2; rm -rf' });
      assert(t, shaped.refusal?.cause === 'invalid-input' && shaped.findings.some((f) => f.code === 'STRUCTURAL_INVALID' && f.path.startsWith('/continuation')), 'a continuation outside the cursor contract is refused before anything runs');
      const revisionAsked = contextTool({ model: m, target, modelRevision: HASH('8') }, {}, { address: { workspace: true } });
      assert(t, revisionAsked.refusal?.cause === 'stale-base' && (revisionAsked.refusal.nextActions ?? []).every((a) => actionProblems(a).length === 0 && (a.arguments as Record<string, unknown>)['modelRevision'] === undefined), 'a request for another model revision is refused with the request at the current revision');
      assert(t, contextTool({ model: m, target, budget: { maxRecords: 1000 } }).refusal?.cause === 'invalid-input', 'a budget above its maximum is refused');
      const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'type' as const, id: `record-${i}-of-a-task-with-a-long-name` }));
      const crowded = contextTool({ model: m, target: { kind: 'task', task: { class: 'implementation', mode: 'component', components: ['ordering'], records: many } }, budget: { maxBytes: DISCOVERY_LIMITS.minBytes } });
      assert(t, crowded.refusal?.cause === 'invalid-input', 'a budget smaller than the members every page repeats is refused');

      const evaluated = { evidence: [] };
      const truncated = contextTool({ model: m, target, budget: { maxRecords: 5 } }, evaluated);
      const whole = contextTool({ model: m, target, budget: { maxBytes: DISCOVERY_LIMITS.maxBytes, maxRecords: DISCOVERY_LIMITS.maxRecords } }, evaluated);
      assert(t, whole.completeness.complete && whole.states.qualification.state !== 'notEvaluated', `a complete context reports the qualification the supplied evidence gives: ${whole.states.qualification.state}`);
      assert(t, truncated.completeness.truncated && truncated.states.qualification.state === 'notEvaluated' && truncated.states.readiness.state === 'notEvaluated', 'a truncated context establishes neither coverage nor readiness');
      for (const s of [truncated.states.qualification, truncated.states.readiness]) for (const r of s.reasons) t.raised.add(r.code);
    },
  },
  {
    name: 'resume',
    run: (t) => {
      const m = sampleModel();
      const inputs = recorded(m);
      const env = contextTool({ model: m, target: RESUME_TARGET }, {}, { resume: inputs });
      const r = resumeOf(env);
      assert(t, env.outcome === 'ok' && schemaErrors('ResultEnvelope', env).length === 0 && schemaErrors('ContextData', env.data).length === 0 && schemaErrors('ResumeData', r).length === 0, `the resume satisfies its contract: ${JSON.stringify(schemaErrors('ContextData', env.data))}`);
      assert(t, env.completeness.complete && dataBytes(env.data) <= DISCOVERY_LIMITS.defaultBytes, 'the resume of the sample fits one default page');
      assert(t, r.phase === 'specification' && r.outcome?.statement === inputs.outcome?.statement && r.revisionVector.models[0]?.model === modelRevision(m), 'the resume restates the recorded outcome, phase and revision vector');
      assert(t, r.pendingWork.map((w) => `${w.workPackage}:${w.status}`).join(' ') === 'wp.billing.specification:in-progress wp.ordering.implementation:blocked wp.reporting:planned', 'pending work keeps its recorded status; no progress is inferred');
      assert(t, r.blockingUnknowns.map((u) => u.id).join(' ') === m.unknowns.filter((u) => u.status === 'open' && u.blocks.length).map((u) => u.id).join(' ') && r.blockingUnknowns.length > 0, 'the open unknowns that block work are listed');
      assert(t, r.frozenContracts.length > 0 && r.frozenContracts.every((f) => f.baseline === 'bl-1' && f.hash === recordHash(m, f.ref)), 'the contracts of the frozen components are listed with the hash the baseline froze');
      const problems = r.nextActions.flatMap(actionProblems);
      assert(t, r.nextActions.length === r.blockingUnknowns.length + 3 && problems.length === 0, `every next action is concrete, its arguments valid against its tool's input: ${problems.join('; ')}`);
      assert(t, r.nextActions.some((a) => a.tool === 'loom.qualify') && r.nextActions.some((a) => a.tool === 'loom.checkReadiness') && !r.nextActions.some((a) => JSON.stringify(a.arguments).includes('wp.reporting')), 'recorded runs and tasks get their actions; work recorded without a task gets none');

      const noHandle = { ...recorded(m) };
      delete noHandle.workspaceId;
      const withoutHandle = contextTool({ model: m, target: RESUME_TARGET }, {}, { resume: noHandle });
      assert(t, withoutHandle.outcome === 'ok' && !resumeOf(withoutHandle).nextActions.some((a) => a.tool === 'loom.qualify') && withoutHandle.completeness.omitted.some((o) => o.section === 'pendingRuns/run-1' && o.reason === 'unavailable') && !withoutHandle.completeness.complete, 'a pending run the session holds no handle for is listed as unavailable, never dropped');
      const empty = resumeOf(contextTool({ model: m, target: RESUME_TARGET }, {}, { resume: recorded(m, { outcome: null, phase: 'unplanned', baseline: null, openUnknowns: [], evidence: [], pendingWork: [], pendingRuns: [] }) }));
      assert(t, empty.outcome === null && empty.nextActions.length === 0 && empty.frozenContracts.length === 0, 'a workspace that records nothing resumes with nothing invented');

      const small = { maxBytes: DISCOVERY_LIMITS.minBytes };
      const pages = pagesOf((continuation) => contextTool({ model: m, target: RESUME_TARGET, budget: small, ...(continuation ? { continuation } : {}) }, {}, { resume: inputs }));
      const actions = pages.reduce((n, p) => n + resumeOf(p).nextActions.length, 0);
      const pageOmissions = pages.flatMap((p) => p.completeness.omitted.filter((o) => o.reason === 'budget' && o.continuation === undefined));
      assert(t, pages.length > 1 && pages.every((p) => dataBytes(p.data) <= DISCOVERY_LIMITS.minBytes) && actions + pageOmissions.filter((o) => o.section?.startsWith('nextActions') === true).length === r.nextActions.length, `a resume pages within the budget and following its continuation returns every next action: ${pages.length} pages`);
      assert(t, pages[0]?.completeness.truncated === true && pages[0].states.readiness.state === 'notEvaluated' && pages[0].states.qualification.state === 'notEvaluated', 'a truncated resume establishes neither coverage nor readiness');
      const moved = recorded(m, { revisionVector: vectorOf(m, 2) });
      const staleResume = contextTool({ model: m, target: RESUME_TARGET, budget: small, continuation: pages[0]?.completeness.continuation as string }, {}, { resume: moved });
      assert(t, staleResume.refusal?.cause === 'stale-base' && (staleResume.refusal.nextActions ?? []).every((a) => actionProblems(a).length === 0), 'a resume continuation binds the revision vector it was issued for');
      assert(t, contextTool({ model: m, target: RESUME_TARGET }).refusal?.cause === 'unresolved-context', 'a resume without the recorded progress is refused, never answered from the model alone');
      const wide = contextTool({ model: m, target: RESUME_TARGET, budget: small }, {}, { resume: recorded(m, { revisionVector: vectorOf(m, 12) }) });
      assert(t, wide.refusal?.cause === 'invalid-input', 'a budget smaller than the members every resume page repeats is refused');
    },
  },
];
