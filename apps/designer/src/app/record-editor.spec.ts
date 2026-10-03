import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FINDING, sampleModel } from '@loom/core';
import { LoomStore } from './loom-store';
import { RecordEditor } from './record-editor';
import { COLLECTION_SPECS, fieldsOf } from './schema-fields';

function select(root: Element, name: string, value: string): void {
  const el = root.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
  expect(el, `select[name="${name}"]`).not.toBeNull();
  el!.value = value;
  expect(el!.value, `option '${value}' in select[name="${name}"]`).toBe(value);
  el!.dispatchEvent(new Event('change'));
}

function type(root: Element, name: string, value: string): void {
  const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
  expect(el, `[name="${name}"]`).not.toBeNull();
  el!.value = value;
  el!.dispatchEvent(new Event('input'));
}

function click(root: Element, testId: string): void {
  const el = root.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(el, testId).not.toBeNull();
  expect(el!.disabled, `${testId} is enabled`).toBe(false);
  el!.click();
}

describe('RecordEditor', () => {
  let store: LoomStore;
  let fixture: ComponentFixture<RecordEditor>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [RecordEditor] }).compileComponents();
    store = TestBed.inject(LoomStore);
    store.loadSample();
    fixture = TestBed.createComponent(RecordEditor);
    await fixture.whenStable();
    el = fixture.nativeElement as HTMLElement;
  });

  const open = async (collection: string, record: string): Promise<void> => {
    select(el, 'collection', collection);
    await fixture.whenStable();
    select(el, 'record', record);
    await fixture.whenStable();
  };

  it('offers every collection the contract defines, with fields read from its definition', () => {
    const offered = [...el.querySelectorAll<HTMLOptionElement>('select[name="collection"] option')].map((o) => o.value);
    expect(offered).toEqual(COLLECTION_SPECS.map((c) => c.collection));
    const shown = [...el.querySelectorAll('[data-testid="record-form"] [data-field]')].map((f) => f.getAttribute('data-field'));
    expect(shown).toEqual(fieldsOf(COLLECTION_SPECS[0]!.definition).map((f) => f.name));
  });

  it('edits an enum field of a component through an update patch the engine accepts', async () => {
    await open('components', 'billing');
    select(el.querySelector('[data-field="kind"]')!, 'kind', 'worker');
    await fixture.whenStable();
    const apply = vi.spyOn(store, 'apply');
    click(el, 'record-apply');
    await fixture.whenStable();

    expect(apply).toHaveBeenCalledWith({ op: 'update', collection: 'components', id: 'billing', set: { kind: 'worker' } });
    expect(store.lastMutation()?.accepted).toBe(true);
    expect(store.model()!.components.find((c) => c.id === 'billing')!.kind).toBe('worker');
  });

  it('edits a requirement priority through the same form', async () => {
    const requirement = sampleModel().requirements.find((r) => r.priority === 'must')!;
    await open('requirements', requirement.id);
    select(el.querySelector('[data-field="priority"]')!, 'priority', 'should');
    await fixture.whenStable();
    click(el, 'record-apply');
    await fixture.whenStable();

    expect(store.lastMutation()?.accepted).toBe(true);
    expect(store.model()!.requirements.find((r) => r.id === requirement.id)!.priority).toBe('should');
  });

  it('adds a new record of another kind from the contract fields', async () => {
    await open('trustBoundaries', '$new');
    type(el, 'id', 'tb.partner');
    select(el.querySelector('[data-field="kind"]')!, 'kind', 'network');
    type(el, 'description', 'Partner network.');
    await fixture.whenStable();
    click(el, 'record-apply');
    await fixture.whenStable();

    expect(store.lastMutation()?.accepted).toBe(true);
    expect(store.model()!.trustBoundaries.find((t) => t.id === 'tb.partner')).toEqual({ id: 'tb.partner', kind: 'network', description: 'Partner network.' });
  });

  it('leaves the decision to the engine: an unacknowledged breaking criterion edit is refused and the model is unchanged', async () => {
    const before = store.model();
    const requirement = sampleModel().requirements[0]!;
    await open('requirements', requirement.id);
    const criteria = requirement.criteria.map((c, i) => (i === 0 ? { ...c, statement: `${c.statement} Exactly once.` } : c));
    type(el, 'criteria', JSON.stringify(criteria));
    await fixture.whenStable();
    click(el, 'record-apply');
    await fixture.whenStable();

    expect(store.lastMutation()?.accepted).toBe(false);
    expect(store.lastMutation()!.findings.map((f) => f.code)).toContain(FINDING.BREAKING_CHANGE_UNACKNOWLEDGED);
    expect(store.model()).toBe(before);
  });

  it('shows contract errors in the structured editor and the engine refuses the misspelled record', async () => {
    const before = store.model();
    await open('components', 'ordering');
    const record = { ...sampleModel().components.find((c) => c.id === 'ordering')!, purpse: 'misspelled' };
    type(el, 'recordJson', JSON.stringify(record));
    await fixture.whenStable();

    const errors = el.querySelector('[data-testid="record-json-errors"]')?.textContent ?? '';
    expect(errors).toContain('purpse');
    click(el, 'record-json-apply');
    await fixture.whenStable();

    expect(store.lastMutation()?.accepted).toBe(false);
    expect(store.lastMutation()!.findings.map((f) => f.code)).toContain(FINDING.PATCH_INVALID);
    expect(store.model()).toBe(before);
  });
});
