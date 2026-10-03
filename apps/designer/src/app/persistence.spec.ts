import { FINDING, exportModel, modelRevision, sampleModel, type Patch } from '@loom/core';
import { LoomStore } from './loom-store';
import type { ModelFile } from './model-file';

/** An in-memory model file that two editors can share, standing in for a file on disk. */
class MemoryFile implements ModelFile {
  writes = 0;
  constructor(
    readonly name: string,
    public text: string,
  ) {}
  async read(): Promise<string> {
    return this.text;
  }
  async write(text: string): Promise<void> {
    this.text = text;
    this.writes++;
  }
}

const kindEdit = (id: string, kind: 'worker' | 'job'): Patch => ({ op: 'update', collection: 'components', id, set: { kind } });

describe('persistent save', () => {
  it('refuses the second of two saves made from the same base and leaves the file as the first save wrote it', async () => {
    const file = new MemoryFile('model.json', exportModel(sampleModel()));
    const first = new LoomStore();
    const second = new LoomStore();
    expect(await first.openFile(file)).toBe(true);
    expect(await second.openFile(file)).toBe(true);
    expect(first.baseRevision()).toBe(second.baseRevision());

    expect(first.apply(kindEdit('billing', 'worker')).accepted).toBe(true);
    const saved = await first.save();
    expect(saved.kind).toBe('saved');
    const afterFirst = file.text;
    expect(afterFirst).toBe(exportModel(first.model()!));

    expect(second.apply(kindEdit('billing', 'job')).accepted).toBe(true);
    const refused = await second.save();
    expect(refused.kind).toBe('refused');
    if (refused.kind !== 'refused') return;
    expect(refused.findings.map((f) => f.code)).toContain(FINDING.STALE_BASE_REVISION);
    expect(refused.diskRevision).toBe(modelRevision(first.model()!));
    expect(refused.expectedRevision).toBe(modelRevision(sampleModel()));
    expect(second.saveConflict()).toEqual(refused);
    expect(file.text).toBe(afterFirst);
    expect(file.writes).toBe(1);
  });

  it('advances the base revision after a save, so the same editor can save again', async () => {
    const file = new MemoryFile('model.json', exportModel(sampleModel()));
    const store = new LoomStore();
    await store.openFile(file);
    store.apply(kindEdit('billing', 'worker'));
    expect((await store.save()).kind).toBe('saved');
    expect(store.baseRevision()).toBe(modelRevision(store.model()!));
    store.apply(kindEdit('billing', 'job'));
    expect((await store.save()).kind).toBe('saved');
    expect(file.writes).toBe(2);
  });

  it('downloads the model with the revision it was edited from when no file can be written back', async () => {
    const store = new LoomStore();
    store.loadSample();
    const base = store.baseRevision();
    store.apply(kindEdit('billing', 'worker'));
    const outcome = await store.save();
    expect(outcome.kind).toBe('download');
    if (outcome.kind !== 'download') return;
    expect(outcome.expectedRevision).toBe(base);
    expect(outcome.files.map((f) => f.fileName)).toEqual(['sample.json', 'sample.revision.json']);
    expect(JSON.parse(outcome.files[1]!.text)).toEqual({ baseRevision: base, revision: modelRevision(store.model()!) });
  });

  it('refuses to save a model with error findings', async () => {
    const file = new MemoryFile('model.json', exportModel(sampleModel()));
    const store = new LoomStore();
    const invalid = sampleModel();
    invalid.workflows.find((w) => w.imports.length > 0)!.imports[0]!.version += 1;
    file.text = JSON.stringify(invalid);
    await store.openFile(file);
    const outcome = await store.save();
    expect(outcome.kind).toBe('refused');
    expect(file.writes).toBe(0);
  });
});
