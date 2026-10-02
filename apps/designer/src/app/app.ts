import { Component, computed, inject, signal } from '@angular/core';
import type { Model } from '@loom/core';
import { ChangesTable } from './changes-table';
import { downloadText } from './download';
import { FindingsTable } from './findings-table';
import { GeneratePanel } from './generate-panel';
import { LoomStore, type ExportOutcome } from './loom-store';
import { ModelBrowser } from './model-browser';
import { MutatePanel } from './mutate-panel';

type Tab = 'browse' | 'mutate' | 'validate' | 'diff' | 'generate';

@Component({
  selector: 'app-root',
  imports: [ChangesTable, FindingsTable, GeneratePanel, ModelBrowser, MutatePanel],
  templateUrl: './app.html',
})
export class App {
  protected readonly store = inject(LoomStore);
  protected readonly tab = signal<Tab>('browse');

  private readonly exportAttempt = signal<{ model: Model; outcome: ExportOutcome } | null>(null);

  /** The last refused export, shown only while the model it was refused for is still current. */
  protected readonly exportBlocked = computed(() => {
    const a = this.exportAttempt();
    if (!a || a.model !== this.store.model() || a.outcome.ok) return null;
    return a.outcome;
  });

  protected readonly diffSummary = computed(() => {
    const d = this.store.changesSinceBaseline();
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
}
