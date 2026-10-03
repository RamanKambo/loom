import { TestBed } from '@angular/core/testing';
import {
  CONTRACT_DIGEST,
  FINDING,
  canonicalHash,
  diffTool,
  exportModel,
  modelRevision,
  planChangeTool,
  sampleModel,
  type Acceptance,
  type Baseline,
  type Model,
  type Patch,
} from '@loom/core';
import { LoomStore } from './loom-store';
import { StatesPanel } from './states-panel';

const ZERO = `sha256:${'0'.repeat(64)}`;

function baselineFor(model: Model): { record: Baseline; acceptance: Acceptance } {
  const record: Baseline = {
    baselineVersion: 1,
    id: 'bl-1',
    model: { hash: modelRevision(model), formatVersion: 1, snapshot: 'baselines/bl-1.model.json' },
    config: { hash: ZERO, configVersion: 1 },
    policy: { ref: 'engineering', revision: 1, hash: ZERO },
    generator: { version: '1.0.0', contractDigest: CONTRACT_DIGEST },
    contracts: [],
    components: model.components.map((c) => ({ id: c.id, hash: canonicalHash(c), frozen: false })),
    artifacts: [],
    sources: [],
    commitments: [],
    acceptance: 'acc-1',
  };
  const acceptance: Acceptance = {
    acceptanceVersion: 1,
    id: 'acc-1',
    subject: { kind: 'baseline', baseline: 'bl-1', candidate: modelRevision(model) },
    decision: 'accepted',
    authority: 'team-architecture',
    policy: { ref: 'engineering', revision: 1 },
    scope: [],
    changeClasses: [],
    at: '2026-10-01T09:00:00Z',
  };
  return { record, acceptance };
}

describe('states', () => {
  it('importing a model never accepts it: acceptance is not evaluated without a selected baseline', () => {
    const store = new LoomStore();
    expect(store.loadText(exportModel(sampleModel()), 'imported.json')).toBe(true);
    const acceptance = store.states()!.acceptance;
    expect(acceptance.state).toBe('notEvaluated');
    expect(acceptance.reasons.map((r) => r.code)).toContain(FINDING.BASELINE_MISSING);
  });

  it('a selected baseline with its acceptance record is still not accepted, because the designer cannot establish trust', () => {
    const store = new LoomStore();
    store.loadSample();
    const { record, acceptance } = baselineFor(sampleModel());
    expect(store.selectBaseline(JSON.stringify(record), exportModel(sampleModel()), 'bl-1.json')).toEqual({ ok: true });
    expect(store.addAcceptance(JSON.stringify(acceptance))).toEqual({ ok: true });

    const state = store.states()!.acceptance;
    expect(state.state).not.toBe('accepted');
    const codes = store.baselineFindings().map((f) => f.code);
    expect(codes).toContain(FINDING.BASELINE_UNTRUSTED);
    expect(codes).toContain(FINDING.ACCEPTANCE_UNTRUSTED);
    expect(store.evaluated().baseline).toEqual({ id: 'bl-1', hash: modelRevision(sampleModel()) });
  });

  it('refuses a baseline record that does not match the contract', () => {
    const store = new LoomStore();
    store.loadSample();
    const r = store.selectBaseline('{ "baselineVersion": 1 }', exportModel(sampleModel()), 'bad.json');
    expect(r.ok).toBe(false);
    expect(store.acceptedBaseline()).toBeNull();
  });

  it('shows a valid model as blocked for release and unresolved for implementation without an accepted baseline', async () => {
    await TestBed.configureTestingModule({ imports: [StatesPanel] }).compileComponents();
    const store = TestBed.inject(LoomStore);
    store.loadSample();
    expect(store.errorCount()).toBe(0);
    const fixture = TestBed.createComponent(StatesPanel);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const readiness = () => el.querySelector('[data-testid="state-readiness"]')!;

    expect(el.querySelector('[data-testid="state-validation"]')!.getAttribute('data-state')).toBe('valid');
    expect(readiness().getAttribute('data-state')).toBe('unresolved');

    const select = el.querySelector<HTMLSelectElement>('select[name="taskClass"]')!;
    select.value = 'release';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(readiness().getAttribute('data-state')).toBe('blocked');
    expect(el.querySelector('[data-testid="prerequisites"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="state-acceptance"]')!.getAttribute('data-state')).toBe('notEvaluated');
    expect(el.querySelector('[data-testid="evaluated-revisions"]')!.textContent).toContain(modelRevision(sampleModel()));
  });

  it('explains a change with exactly the planner and diff results the MCP tools return', () => {
    const store = new LoomStore();
    store.loadSample();
    const patch: Patch = { op: 'update', collection: 'components', id: 'billing', set: { kind: 'worker' } };
    const model = store.model()!;
    const preview = store.preview(patch);
    expect(preview).toEqual(planChangeTool({ model, baseRevision: modelRevision(model), patch, acknowledgeBreaking: [] }, store.inputs()));
    expect(store.model()).toBe(model);

    store.apply(patch);
    expect(store.localDiff()).toEqual(diffTool({ before: model, after: store.model()! }));
  });
});
