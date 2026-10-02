import { Component, computed, inject, signal } from '@angular/core';
import type { AffectedElement, Patch } from '@loom/core';
import { ChangesTable } from './changes-table';
import { FindingsTable } from './findings-table';
import { GuidedEdit } from './guided-edit';
import { LoomStore } from './loom-store';

const PLACEHOLDER = `[
  { "op": "update", "collection": "types", "id": "invoice", "set": { "version": 2 } },
  { "op": "updateItem", "collection": "types", "id": "invoice", "field": "properties", "key": "state", "set": { "enumValues": ["draft", "issued"] } }
]`;

@Component({
  selector: 'app-mutate-panel',
  imports: [ChangesTable, FindingsTable, GuidedEdit],
  template: `
    @if (store.model()) {
      <app-guided-edit [acknowledge]="ackList()" (addToEditor)="addToEditor($event)" />

      <fieldset>
        <legend>Patch editor: one Patch or a Patch[] batch, applied atomically</legend>
        <textarea
          #editor
          class="editor"
          name="patches"
          rows="14"
          spellcheck="false"
          [placeholder]="placeholder"
          [value]="editorText()"
          (input)="editorText.set(editor.value)"
        ></textarea>
        <label class="block">
          acknowledgeBreaking: element ids, separated by commas or spaces
          <input #ack type="text" name="acknowledgeBreaking" [value]="ackText()" (input)="ackText.set(ack.value)" />
        </label>
        @if (parseError(); as e) {
          <p class="error">{{ e }}</p>
        }
        <div class="actions">
          <button type="button" data-testid="editor-apply" [disabled]="!editorText().trim()" (click)="applyEditor()">
            Apply through mutate()
          </button>
          <button type="button" (click)="editorText.set('')">Clear</button>
        </div>
      </fieldset>

      @if (store.lastMutation(); as r) {
        <section data-testid="mutation-outcome" class="outcome" [class.ok]="r.accepted" [class.refused]="!r.accepted">
          <h3>{{ r.accepted ? 'ACCEPTED' : 'REFUSED' }}</h3>
          <p>
            {{ r.accepted ? 'The model was replaced; Undo restores the previous one.' : 'The model is unchanged.' }}
          </p>
          @if (r.impact.length) {
            <p>Impact: {{ impactText(r.impact) }}</p>
          }
          @if (!r.accepted || r.findings.length) {
            <h4>Findings</h4>
            <app-findings-table data-testid="mutation-findings" [findings]="r.findings" />
          }
          @if (r.accepted) {
            <h4>Changes</h4>
            <app-changes-table data-testid="mutation-changes" [changes]="r.changes" />
          } @else {
            <h4>Breaking changes</h4>
            <app-changes-table data-testid="mutation-changes" [changes]="breaking()" />
          }
        </section>
      }
    } @else {
      <p class="empty">Load a model first.</p>
    }
  `,
})
export class MutatePanel {
  protected readonly store = inject(LoomStore);
  protected readonly placeholder = PLACEHOLDER;

  protected readonly editorText = signal('');
  protected readonly ackText = signal('');
  protected readonly parseError = signal<string | null>(null);

  protected readonly ackList = computed(() => this.ackText().split(/[\s,]+/).filter((s) => s.length > 0));
  protected readonly breaking = computed(
    () => this.store.lastMutation()?.changes.filter((c) => c.kind === 'breaking') ?? [],
  );

  /** Decode the editor JSON and hand it to the engine unchanged; mutate() judges the patch shape. */
  protected applyEditor(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.editorText());
    } catch (e) {
      this.parseError.set(`The editor does not hold valid JSON: ${(e as Error).message}`);
      return;
    }
    this.parseError.set(null);
    this.store.apply(parsed as Patch | Patch[], this.ackList());
  }

  protected impactText(impact: readonly AffectedElement[]): string {
    return impact.map((a) => `${a.ref.kind} ${a.ref.id} (${a.reason})`).join(', ');
  }

  protected addToEditor(patch: Patch): void {
    const text = this.editorText().trim();
    if (!text) {
      this.editorText.set(JSON.stringify(patch, null, 2));
      return;
    }
    let existing: unknown;
    try {
      existing = JSON.parse(text);
    } catch {
      this.parseError.set('The editor holds invalid JSON; fix or clear it before adding a patch.');
      return;
    }
    const batch = Array.isArray(existing) ? [...existing, patch] : [existing, patch];
    this.editorText.set(JSON.stringify(batch, null, 2));
    this.parseError.set(null);
  }
}
