import { Component, computed, inject, signal } from '@angular/core';
import type { ProjectionTarget } from '@loom/core';
import { downloadText } from './download';
import { FindingsTable } from './findings-table';
import { LoomStore } from './loom-store';

@Component({
  selector: 'app-generate-panel',
  imports: [FindingsTable],
  template: `
    @if (store.model()) {
      @let o = output();
      <div class="row">
        <label>
          Target
          <select name="target" #sel (change)="pick(sel.value)">
            @for (t of store.targets; track t) {
              <option [value]="t" [selected]="t === target()">{{ t }}</option>
            }
          </select>
        </label>
        <button type="button" [disabled]="!o.ok" (click)="download()">Download</button>
      </div>
      @if (downloadError(); as e) {
        <p class="error">{{ e }}</p>
      }
      @if (o.ok) {
        <pre class="code output" data-testid="projection-output">{{ o.text }}</pre>
      } @else {
        <p class="error" data-testid="projection-error">{{ o.error }}</p>
        <app-findings-table [findings]="o.findings" />
      }
    } @else {
      <p class="empty">Load a model first.</p>
    }
  `,
})
export class GeneratePanel {
  protected readonly store = inject(LoomStore);
  private readonly picked = signal<ProjectionTarget | null>(null);
  protected readonly downloadError = signal<string | null>(null);

  protected readonly target = computed<ProjectionTarget>(() => {
    const p = this.picked();
    return p !== null && this.store.targets.includes(p) ? p : this.store.targets[0];
  });
  protected readonly output = computed(() => this.store.project(this.target()));

  protected pick(value: string): void {
    const t = this.store.targets.find((x) => x === value);
    if (t) this.picked.set(t);
  }

  /** Downloads the file exactly as the engine writes it, under the engine's file name. */
  protected download(): void {
    const file = this.store.projectionFile(this.target());
    this.downloadError.set(file.ok ? null : file.error);
    if (!file.ok) return;
    downloadText(file.fileName, file.text, file.fileName.endsWith('.json') ? 'application/json' : 'text/plain');
  }
}
