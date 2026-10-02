import { TestBed } from '@angular/core/testing';
import { FINDING, PROJECTION_FILES, PROJECTION_TARGETS, exportModel, sampleModel, type Finding, type Model, type Patch } from '@loom/core';
import { LoomStore } from './loom-store';

const errorsOf = (findings: readonly Finding[]): Finding[] => findings.filter((f) => f.severity === 'error');

/** The enum property every test edit narrows. */
const TYPE = 'invoice';
const PROPERTY = 'state';
const REMOVED = 'settled';

/** Removing an enum value is a breaking change of the type. */
const dropState = (m: Model): Patch => ({
  op: 'updateItem',
  collection: 'types',
  id: TYPE,
  field: 'properties',
  key: PROPERTY,
  set: { enumValues: m.types.find((t) => t.id === TYPE)!.properties.find((p) => p.name === PROPERTY)!.enumValues!.filter((v) => v !== REMOVED) },
});

describe('LoomStore', () => {
  let store: LoomStore;

  beforeEach(() => {
    store = TestBed.inject(LoomStore);
    store.loadSample();
  });

  it('(a) loads the sample with zero error findings', () => {
    expect(store.model()).not.toBeNull();
    expect(store.loadError()).toBeNull();
    expect(store.sourceName()).toBe('sample');
    expect(errorsOf(store.findings())).toEqual([]);
    expect(store.errorCount()).toBe(0);
  });

  it('(b) refuses a lone breaking change and leaves the model unchanged', () => {
    const before = store.model()!;
    const outcome = store.apply(dropState(before));

    expect(outcome.accepted).toBe(false);
    expect(store.model()).toBe(before);
    expect(store.model()).toEqual(sampleModel());
    expect(store.history()).toEqual([]);
    expect(store.lastMutation()).toBe(outcome);

    const codes = new Set(outcome.findings.map((f) => f.code));
    expect(codes.has(FINDING.BREAKING_CHANGE_WITHOUT_VERSION_BUMP)).toBe(true);
    expect(codes.has(FINDING.BREAKING_CHANGE_UNACKNOWLEDGED)).toBe(true);

    const bump = outcome.findings.find((f) => f.code === FINDING.BREAKING_CHANGE_WITHOUT_VERSION_BUMP)!;
    expect(bump.path).toBe(`types/${TYPE}/version`);
    expect(bump.fix).toContain(`'${TYPE}'`);
    expect(outcome.changes.some((c) => c.rule === 'ENUM_VALUE_REMOVED' && c.element === TYPE)).toBe(true);
  });

  it('(c) accepts the corrected batch whose consumers are derived from the model', () => {
    const before = store.model()!;
    const type = before.types.find((t) => t.id === TYPE)!;
    const version = type.version + 1;
    // Every workflow pinning the type is a consumer that must adopt the new version in the same batch.
    const workflows = before.workflows.filter((w) => w.imports.some((i) => i.typeId === TYPE));
    expect(workflows.length).toBeGreaterThan(0);

    const batch: Patch[] = [
      dropState(before),
      { op: 'update', collection: 'types', id: TYPE, set: { version } },
      ...workflows.map((w): Patch => ({ op: 'updateItem', collection: 'workflows', id: w.id, field: 'imports', key: TYPE, set: { version } })),
    ];
    const outcome = store.apply(batch, [TYPE]);

    expect(errorsOf(outcome.findings)).toEqual([]);
    expect(outcome.accepted).toBe(true);
    expect(store.history()).toEqual([before]);
    expect(store.history()[0]).toBe(before);

    const after = store.model()!;
    expect(after).not.toBe(before);
    const afterType = after.types.find((t) => t.id === TYPE)!;
    expect(afterType.version).toBe(version);
    expect(afterType.properties.find((p) => p.name === PROPERTY)!.enumValues).not.toContain(REMOVED);
    for (const w of workflows) {
      const aw = after.workflows.find((x) => x.id === w.id)!;
      expect(aw.imports.find((i) => i.typeId === TYPE)!.version).toBe(version);
    }

    const brokenElements = new Set(outcome.changes.filter((c) => c.kind === 'breaking').map((c) => c.element));
    expect([...brokenElements]).toEqual([TYPE]);
    expect(outcome.impact.some((a) => a.reason === 'direct-change' && a.ref.id === TYPE)).toBe(true);
    expect(errorsOf(store.findings())).toEqual([]);
    // The baseline is the loaded model, so the diff tab shows exactly this batch's changes.
    expect(store.changesSinceBaseline()).toEqual({ ok: true, changes: outcome.changes });
  });

  it('(d) blocks exporting an imported model that has error findings', () => {
    expect(store.exportCanonical()).toEqual({ ok: true, text: exportModel(sampleModel()) });

    const invalid = sampleModel();
    const workflow = invalid.workflows.find((w) => w.imports.length > 0)!;
    workflow.imports[0].version += 1;
    expect(store.loadText(JSON.stringify(invalid), 'invalid.json')).toBe(true);
    expect(store.loadError()).toBeNull();
    expect(store.errorCount()).toBeGreaterThan(0);

    const outcome = store.exportCanonical();
    expect(outcome.ok).toBe(false);
    expect('text' in outcome).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('refusing to export');
    expect(outcome.findings.map((f) => f.code)).toContain(FINDING.WORKFLOW_IMPORT_VERSION_MISMATCH);
  });

  it('(e) produces non-empty output for every PROJECTION_TARGETS entry on the sample', () => {
    expect(store.targets).toBe(PROJECTION_TARGETS);
    expect(PROJECTION_TARGETS.length).toBeGreaterThan(0);
    for (const target of PROJECTION_TARGETS) {
      const out = store.project(target);
      expect(out.ok, `${target}: ${out.ok ? '' : out.error}`).toBe(true);
      if (!out.ok) continue;
      expect(out.target).toBe(target);
      expect(['', '{}', '[]', '""', 'null'], target).not.toContain(out.text.trim());

      const file = store.projectionFile(target);
      expect(file.ok, `${target}: ${file.ok ? '' : file.error}`).toBe(true);
      if (!file.ok) continue;
      expect(PROJECTION_FILES[file.fileName]).toBe(target);
      expect(file.text.trim().length, file.fileName).toBeGreaterThan(0);
    }
  });

  it('loads YAML text through the engine and keeps the current model when a file fails import', () => {
    const yaml = store.project('yaml');
    expect(yaml.ok).toBe(true);
    if (!yaml.ok) return;
    expect(store.loadText(yaml.text, 'model.yaml')).toBe(true);
    expect(store.model()).toEqual(sampleModel());
    expect(store.sourceName()).toBe('model.yaml');

    const before = store.model();
    expect(store.loadText('{ "version": 1 }', 'broken.json')).toBe(false);
    expect(store.loadError()).toContain('structural');
    expect(store.model()).toBe(before);
    expect(store.sourceName()).toBe('model.yaml');
  });
});
