import { Component, computed, inject, signal } from '@angular/core';
import type { Model } from '@loom/core';
import { BaselinePanel } from './baseline-panel';
import { ChangesTable } from './changes-table';
import { downloadText } from './download';
import { FindingsTable } from './findings-table';
import { GeneratePanel } from './generate-panel';
import { LoomStore, type ExportOutcome, type SaveOutcome } from './loom-store';
import { ModelBrowser } from './model-browser';
import { persistentFilesAvailable, pickModelFile } from './model-file';
import { MutatePanel } from './mutate-panel';
import { PublishPanel } from './publish-panel';
import { RecordEditor } from './record-editor';
import { StatesPanel } from './states-panel';
import { UnknownsPanel } from './unknowns-panel';
import { ViewsPanel } from './views-panel';

type Tab = 'browse' | 'records' | 'mutate' | 'validate' | 'states' | 'unknowns' | 'diff' | 'baseline' | 'views' | 'generate' | 'publish';

@Component({
  selector: 'app-root',
  imports: [
    BaselinePanel,
    ChangesTable,
    FindingsTable,
    GeneratePanel,
    ModelBrowser,
    MutatePanel,
    PublishPanel,
    RecordEditor,
    StatesPanel,
    UnknownsPanel,
    ViewsPanel,
  ],
  templateUrl: './app.html',
})
export class App {
  protected readonly store = inject(LoomStore);
  protected readonly tab = signal<Tab>('browse');
  protected readonly canReopen = persistentFilesAvailable();
  protected readonly lastSave = signal<SaveOutcome | null>(null);
  constructor() { void this.store.connectFromLocation(); }

  private readonly exportAttempt = signal<{ model: Model; outcome: ExportOutcome } | null>(null);

  /** The last refused export, shown only while the model it was refused for is still current. */
  protected readonly exportBlocked = computed(() => {
    const a = this.exportAttempt();
    if (!a || a.model !== this.store.model() || a.outcome.ok) return null;
    return a.outcome;
  });

  protected readonly diffSummary = computed(() => {
    const d = this.store.changesSinceOpened();
    if (!d.ok) return null;
    const breaking = d.changes.filter((c) => c.kind === 'breaking').length;
    return { total: d.changes.length, breaking, compatible: d.changes.length - breaking };
  });

  protected async openFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    input.value = '';
    this.store.loadText(text, file.name);
  }

  /** Opens through the File System Access API, so a later save can check the file on disk first. */
  protected async openPersistent(): Promise<void> {
    const file = await pickModelFile();
    if (file) await this.store.openFile(file);
  }

  protected async save(): Promise<void> {
    const outcome = await this.store.save();
    this.lastSave.set(outcome);
    if (outcome.kind === 'download') for (const f of outcome.files) downloadText(f.fileName, f.text, 'application/json');
  }

  protected exportModel(): void {
    const model = this.store.model();
    if (!model) return;
    const outcome = this.store.exportCanonical();
    this.exportAttempt.set({ model, outcome });
    if (outcome.ok) {
      const base = (this.store.sourceName() ?? 'model').replace(/\.(json|ya?ml)$/i, '');
      downloadText(`${base}.json`, outcome.text, 'application/json');
    }
  }

  protected short(hash: string | null): string {
    return hash ? hash.slice(7, 19) : '';
  }
}
