import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FINDING, sampleModel } from '@loom/core';
import { LoomStore } from './loom-store';
import { ModelBrowser } from './model-browser';
import { MutatePanel } from './mutate-panel';

/** The browser shows the model; the mutate panel hosts the guided form and the outcome. */
@Component({
  imports: [ModelBrowser, MutatePanel],
  template: `<app-model-browser /><app-mutate-panel />`,
})
class Host {}

function choose(root: Element, name: string, value: string): void {
  const select = root.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
  expect(select, `select[name="${name}"]`).not.toBeNull();
  select!.value = value;
  expect(select!.value, `option '${value}' in select[name="${name}"]`).toBe(value);
  select!.dispatchEvent(new Event('change'));
}

describe('GuidedEdit', () => {
  it('sends a breaking edit through mutate(), shows it REFUSED and leaves the displayed model unchanged', async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const store = TestBed.inject(LoomStore);
    store.loadSample();
    const before = store.model();
    const apply = vi.spyOn(store, 'apply');

    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const shownKind = () =>
      el.querySelector('app-model-browser [data-prop="order.id"] [data-col="kind"]')?.textContent?.trim();
    expect(shownKind()).toBe('string');

    const form = el.querySelector('app-guided-edit')!;
    choose(form, 'type', 'order');
    await fixture.whenStable();
    choose(form, 'property', 'id');
    await fixture.whenStable();
    choose(form, 'kind', 'integer');
    await fixture.whenStable();

    const built = { op: 'updateItem', collection: 'types', id: 'order', field: 'properties', key: 'id', set: { kind: 'integer' } };
    expect(JSON.parse(form.querySelector('[data-testid="guided-patch"]')!.textContent!)).toEqual(built);

    form.querySelector<HTMLButtonElement>('[data-testid="guided-apply"]')!.click();
    await fixture.whenStable();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(built, []);
    expect(store.lastMutation()?.accepted).toBe(false);
    expect(store.model()).toBe(before);
    expect(store.model()).toEqual(sampleModel());

    const outcome = el.querySelector('[data-testid="mutation-outcome"]');
    expect(outcome?.querySelector('h3')?.textContent?.trim()).toBe('REFUSED');
    const codes = [...el.querySelectorAll('[data-testid="mutation-findings"] [data-col="code"]')].map((td) =>
      td.textContent?.trim(),
    );
    expect(codes).toContain(FINDING.BREAKING_CHANGE_WITHOUT_VERSION_BUMP);
    expect(codes).toContain(FINDING.BINDING_KIND_MISMATCH);

    expect(shownKind()).toBe('string');
  });
});
