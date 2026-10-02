import { TestBed } from '@angular/core/testing';
import {
  FINDING,
  PROJECTION_FILES,
  PROJECTION_TARGETS,
  exportModel,
  sampleModel,
  type Finding,
  type Kind,
  type Patch,
  type Property,
  type ResultColumn,
  type RoutineParam,
} from '@loom/core';
import { LoomStore } from './loom-store';

const errorsOf = (findings: readonly Finding[]): Finding[] => findings.filter((f) => f.severity === 'error');

/** The producer property every test edit targets. */
const TYPE = 'order';
const PROPERTY = 'id';
const BINDING = `${TYPE}.${PROPERTY}`;
const NEW_KIND: Kind = 'integer';

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

  it('(b) refuses a lone breaking kind change and leaves the model unchanged', () => {
    const before = store.model()!;
    const outcome = store.apply({
      op: 'changeProperty',
      typeId: TYPE,
      propertyName: PROPERTY,
      set: { kind: NEW_KIND },
    });

    expect(outcome.accepted).toBe(false);
    expect(store.model()).toBe(before);
    expect(store.model()).toEqual(sampleModel());
    expect(store.history()).toEqual([]);
    expect(store.lastMutation()).toBe(outcome);

    const codes = new Set(outcome.findings.map((f) => f.code));
    expect(codes.has(FINDING.BREAKING_CHANGE_WITHOUT_VERSION_BUMP)).toBe(true);
    expect(codes.has(FINDING.BINDING_KIND_MISMATCH)).toBe(true);

    const bump = outcome.findings.find((f) => f.code === FINDING.BREAKING_CHANGE_WITHOUT_VERSION_BUMP)!;
    expect(bump.path).toBe(`types/${TYPE}/version`);
    expect(bump.fix).toContain(`'${TYPE}'`);

    // One mismatch per stale consumer binding and per referencing property, derived from the model.
    const expectedPaths = [
      ...before.routines.flatMap((r) => [
        ...r.params.filter((p) => p.binds === BINDING).map((p) => `routines/${r.id}/params/${p.name}/binds`),
        ...r.resultSet.filter((c) => c.binds === BINDING).map((c) => `routines/${r.id}/resultSet/${c.name}/binds`),
      ]),
      ...before.types.flatMap((t) =>
        t.properties.filter((p) => p.binds === BINDING).map((p) => `types/${t.id}/properties/${p.name}/binds`),
      ),
    ];
    expect(expectedPaths.length).toBeGreaterThan(0);
    const mismatchPaths = outcome.findings.filter((f) => f.code === FINDING.BINDING_KIND_MISMATCH).map((f) => f.path);
    expect(mismatchPaths.sort()).toEqual(expectedPaths.sort());
  });

  it('(c) accepts the corrected batch whose consumers are derived from the model', () => {
    const before = store.model()!;
    const type = before.types.find((t) => t.id === TYPE)!;
    const version = type.version + 1;
    const routines = before.routines.filter(
      (r) => r.params.some((p) => p.binds === BINDING) || r.resultSet.some((c) => c.binds === BINDING),
    );
    // Types whose properties reference the changed key are consumers too; each is retyped and bumped.
    const referencing = before.types.filter((t) => t.id !== TYPE && t.properties.some((p) => p.binds === BINDING));
    const bumped = new Map([[TYPE, version], ...referencing.map((t): [string, number] => [t.id, t.version + 1])]);
    const workflows = before.workflows.filter((w) => w.imports.some((i) => bumped.has(i.typeId)));
    expect(routines.length).toBeGreaterThan(0);
    expect(referencing.length).toBeGreaterThan(0);
    expect(workflows.length).toBeGreaterThan(0);

    // Length bounds apply only to strings; the engine refuses them on an integer (BOUNDS_KIND_MISMATCH).
    const integerBounds = (p: Property): Property['bounds'] | null => {
      const { minLength: _minLength, maxLength: _maxLength, ...numericBounds } = p.bounds ?? {};
      return Object.keys(numericBounds).length > 0 ? numericBounds : null;
    };
    const property = type.properties.find((p) => p.name === PROPERTY)!;

    const retypeParam = (p: RoutineParam): RoutineParam => (p.binds === BINDING ? { ...p, kind: NEW_KIND } : p);
    const retypeColumn = (c: ResultColumn): ResultColumn => (c.binds === BINDING ? { ...c, kind: NEW_KIND } : c);
    const batch: Patch[] = [
      { op: 'changeProperty', typeId: TYPE, propertyName: PROPERTY, set: { kind: NEW_KIND, bounds: integerBounds(property) } },
      { op: 'setVersion', target: 'type', id: TYPE, version },
      ...routines.map(
        (r): Patch => ({
          op: 'changeRoutine',
          routineId: r.id,
          set: { version: r.version + 1, params: r.params.map(retypeParam), resultSet: r.resultSet.map(retypeColumn) },
        }),
      ),
      ...referencing.flatMap((t): Patch[] => [
        ...t.properties
          .filter((p) => p.binds === BINDING)
          .map(
            (p): Patch => ({
              op: 'changeProperty',
              typeId: t.id,
              propertyName: p.name,
              set: { kind: NEW_KIND, bounds: integerBounds(p) },
            }),
          ),
        { op: 'setVersion', target: 'type', id: t.id, version: bumped.get(t.id)! },
      ]),
      ...workflows.flatMap((w) =>
        w.imports
          .filter((i) => bumped.has(i.typeId))
          .map((i): Patch => ({ op: 'changeWorkflowImport', workflowId: w.id, typeId: i.typeId, version: bumped.get(i.typeId)! })),
      ),
    ];
    const acknowledged = [TYPE, ...routines.map((r) => r.id), ...referencing.map((t) => t.id)];

    const outcome = store.apply(batch, acknowledged);

    expect(errorsOf(outcome.findings)).toEqual([]);
    expect(outcome.accepted).toBe(true);
    expect(store.history()).toEqual([before]);
    expect(store.history()[0]).toBe(before);

    const after = store.model()!;
    expect(after).not.toBe(before);
    const afterType = after.types.find((t) => t.id === TYPE)!;
    expect(afterType.version).toBe(version);
    expect(afterType.properties.find((p) => p.name === PROPERTY)!.kind).toBe(NEW_KIND);
    for (const r of routines) {
      const ar = after.routines.find((x) => x.id === r.id)!;
      expect(ar.version).toBe(r.version + 1);
      const bound = [...ar.params, ...ar.resultSet].filter((x) => x.binds === BINDING);
      expect(bound.length).toBeGreaterThan(0);
      expect(bound.every((x) => x.kind === NEW_KIND)).toBe(true);
    }
    for (const t of referencing) {
      const at = after.types.find((x) => x.id === t.id)!;
      expect(at.version).toBe(bumped.get(t.id));
      expect(at.properties.filter((p) => p.binds === BINDING).every((p) => p.kind === NEW_KIND)).toBe(true);
    }
    for (const w of workflows) {
      const aw = after.workflows.find((x) => x.id === w.id)!;
      for (const i of aw.imports.filter((x) => bumped.has(x.typeId))) expect(i.version).toBe(bumped.get(i.typeId));
    }

    const brokenElements = new Set(outcome.changes.filter((c) => c.kind === 'breaking').map((c) => c.element));
    expect([...brokenElements].sort()).toEqual([...acknowledged].sort());
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
