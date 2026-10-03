import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { exportModel, sampleModel, type Patch } from '@loom/core';
import { App } from './app';
import { LoomStore } from './loom-store';
import type { ModelFile } from './model-file';

class MemoryFile implements ModelFile {
  constructor(
    readonly name: string,
    public text: string,
  ) {}
  async read(): Promise<string> {
    return this.text;
  }
  async write(text: string): Promise<void> {
    this.text = text;
  }
}

function tab(el: HTMLElement, label: string): void {
  const button = [...el.querySelectorAll<HTMLButtonElement>('nav.tabs button')].find((b) => b.textContent!.trim().startsWith(label));
  expect(button, `tab ${label}`).toBeDefined();
  button!.click();
}

/** The breaking batch from the store tests: drop an enum value, bump the version, re-pin every importing workflow. */
function versionedEnumRemoval(): { batch: Patch[]; ack: string } {
  const m = sampleModel();
  const invoice = m.types.find((t) => t.id === 'invoice')!;
  const version = invoice.version + 1;
  const values = invoice.properties.find((p) => p.name === 'state')!.enumValues!.filter((v) => v !== 'settled');
  return {
    ack: 'invoice',
    batch: [
      { op: 'updateItem', collection: 'types', id: 'invoice', field: 'properties', key: 'state', set: { enumValues: values } },
      { op: 'update', collection: 'types', id: 'invoice', set: { version } },
      ...m.workflows
        .filter((w) => w.imports.some((i) => i.typeId === 'invoice'))
        .map((w): Patch => ({ op: 'updateItem', collection: 'workflows', id: w.id, field: 'imports', key: 'invoice', set: { version } })),
    ],
  };
}

describe('designer workflow', () => {
  let fixture: ComponentFixture<App>;
  let el: HTMLElement;
  let store: LoomStore;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
    store = TestBed.inject(LoomStore);
    fixture = TestBed.createComponent(App);
    el = fixture.nativeElement as HTMLElement;
  });

  it('imports, edits a record, previews and applies a batch, explains its impact and saves with a revision check', async () => {
    const file = new MemoryFile('model.json', exportModel(sampleModel()));
    expect(await store.openFile(file)).toBe(true);
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="status-acceptance"]')!.textContent!.trim()).toBe('notEvaluated');

    // Edit a record through the schema-driven form.
    tab(el, 'Records');
    await fixture.whenStable();
    const records = el.querySelector('app-record-editor')!;
    const collection = records.querySelector<HTMLSelectElement>('select[name="collection"]')!;
    collection.value = 'components';
    collection.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    const record = records.querySelector<HTMLSelectElement>('select[name="record"]')!;
    record.value = 'billing';
    record.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    const kind = records.querySelector<HTMLSelectElement>('[data-field="kind"] select')!;
    kind.value = 'worker';
    kind.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    records.querySelector<HTMLButtonElement>('[data-testid="record-apply"]')!.click();
    await fixture.whenStable();
    expect(store.model()!.components.find((c) => c.id === 'billing')!.kind).toBe('worker');

    // Preview the batch: the planner explains it and nothing is applied.
    tab(el, 'Mutate');
    await fixture.whenStable();
    const { batch, ack } = versionedEnumRemoval();
    const editor = el.querySelector<HTMLTextAreaElement>('textarea[name="patches"]')!;
    editor.value = JSON.stringify(batch);
    editor.dispatchEvent(new Event('input'));
    const ackInput = el.querySelector<HTMLInputElement>('input[name="acknowledgeBreaking"]')!;
    ackInput.value = ack;
    ackInput.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const beforePreview = store.model();
    el.querySelector<HTMLButtonElement>('[data-testid="editor-preview"]')!.click();
    await fixture.whenStable();
    expect(store.model()).toBe(beforePreview);
    const plan = el.querySelector('[data-testid="plan-outcome"]')!;
    expect(plan).not.toBeNull();
    expect(plan.querySelector('[data-testid="plan-compatibility"]')!.textContent).toContain('breaking');
    const planned = store.planData()!;
    expect(planned.affected.some((a) => a.ref.id === 'invoice' && a.reason === 'direct-change')).toBe(true);

    // Apply it and see the impact with its dependency paths.
    el.querySelector<HTMLButtonElement>('[data-testid="editor-apply"]')!.click();
    await fixture.whenStable();
    expect(store.lastMutation()!.accepted).toBe(true);
    const impact = el.querySelector('[data-testid="mutation-impact"]')!;
    for (const a of store.lastMutation()!.impact) {
      const row = impact.querySelector(`[data-affected="${a.ref.kind}:${a.ref.id}"]`);
      expect(row, `${a.ref.kind}:${a.ref.id}`).not.toBeNull();
      expect(row!.querySelector('[data-col="path"]')!.textContent!.trim()).toBe(a.path.join(' → '));
    }

    // Save: the file is still at the base revision, so the write goes through.
    el.querySelector<HTMLButtonElement>('[data-testid="save"]')!.click();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="save-ok"]')).not.toBeNull();
    expect(file.text).toBe(exportModel(store.model()!));
  });

  it('shows a save conflict and writes nothing when the file changed underneath the editor', async () => {
    const file = new MemoryFile('model.json', exportModel(sampleModel()));
    await store.openFile(file);
    const other = new LoomStore();
    await other.openFile(file);
    other.apply({ op: 'update', collection: 'components', id: 'billing', set: { kind: 'job' } });
    expect((await other.save()).kind).toBe('saved');
    const onDisk = file.text;

    store.apply({ op: 'update', collection: 'components', id: 'billing', set: { kind: 'worker' } });
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('[data-testid="save"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="save-conflict"]')).not.toBeNull();
    expect(file.text).toBe(onDisk);
  });
});
