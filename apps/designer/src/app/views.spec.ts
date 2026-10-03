import { TestBed } from '@angular/core/testing';
import { canonicalHash, modelRevision, sampleModel, schemaErrors } from '@loom/core';
import { LoomStore } from './loom-store';
import { ViewsPanel } from './views-panel';

describe('generated views and publishing', () => {
  it('renders each documentation view with its source revision and coverage, plus the mapping and hosting records', async () => {
    await TestBed.configureTestingModule({ imports: [ViewsPanel] }).compileComponents();
    const store = TestBed.inject(LoomStore);
    store.loadSample();
    const fixture = TestBed.createComponent(ViewsPanel);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const views = [...el.querySelectorAll<HTMLOptionElement>('select[name="view"] option')].map((o) => o.value);
    expect(views).toContain('icd');
    expect(views).toContain('registers');
    for (const view of views) {
      const select = el.querySelector<HTMLSelectElement>('select[name="view"]')!;
      select.value = view;
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(el.querySelector('[data-testid="view-error"]'), `${view} renders`).toBeNull();
      expect(el.querySelector('[data-testid="view-source"]')!.textContent).toContain(modelRevision(sampleModel()));
      const coverage = el.querySelector('[data-testid="view-coverage"]')!;
      expect(coverage.getAttribute('data-complete'), `${view} coverage`).toBe('true');
      expect(el.querySelectorAll('[data-testid="view-output"]').length, `${view} output`).toBeGreaterThan(0);
    }

    const sample = sampleModel();
    expect(el.querySelectorAll('[data-testid="mappings"] tbody tr').length).toBe(sample.mappings.length);
    const cohosted = sample.deploymentUnits.find((u) => u.components.length > 1)!;
    expect(el.querySelector(`[data-testid="hosting"] [data-unit="${cohosted.id}"]`)!.textContent).toContain('co-hosted');
  });

  it('publishes selected records as a bundle whose digest is the canonical hash of its content', () => {
    const store = new LoomStore();
    store.loadSample();
    const r = store.publish(
      [
        { kind: 'type', id: 'order-response' },
        { kind: 'operation', id: 'order.get' },
        { kind: 'securityScheme', id: 'bearer' },
      ],
      { publisher: 'team-ordering', contract: 'ordering-api', version: 1 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.digest).toBe(canonicalHash(r.bundle.content));
    expect(r.bundle.content.types.map((t) => t.id)).toEqual(['order-response']);
    expect(r.bundle.content.operations.map((o) => o.id)).toEqual(['order.get']);
    expect(schemaErrors('PublishedContract', r.bundle)).toEqual([]);
    expect(r.fileName).toBe('ordering-api@1.json');
    expect(store.model()).toEqual(sampleModel());
  });

  it('refuses to publish from a model with error findings', () => {
    const store = new LoomStore();
    const invalid = sampleModel();
    invalid.workflows.find((w) => w.imports.length > 0)!.imports[0]!.version += 1;
    store.loadText(JSON.stringify(invalid), 'invalid.json');
    const r = store.publish([{ kind: 'type', id: 'order' }], { publisher: 'team-ordering', contract: 'ordering-api', version: 1 });
    expect(r.ok).toBe(false);
  });
});
