import { Component, computed, inject, signal } from '@angular/core';
import type { Patch } from '@loom/core';
import { AffectedTable } from './affected-table';
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
  imports: [AffectedTable, ChangesTable, FindingsTable, GuidedEdit],
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
          <button type="button" data-testid="editor-preview" [disabled]="!editorText().trim()" (click)="previewEditor()">
            Preview with planChange
          </button>
          <button type="button" data-testid="editor-apply" [disabled]="!editorText().trim()" (click)="applyEditor()">
            Apply through mutate()
          </button>
          <button type="button" (click)="editorText.set('')">Clear</button>
        </div>
      </fieldset>

      @if (store.lastPlan(); as p) {
        <section data-testid="plan-outcome" class="outcome" [class.ok]="p.outcome === 'ok'" [class.refused]="p.outcome === 'refused'">
          <h3>PREVIEW {{ p.outcome === 'ok' ? '' : 'REFUSED' }}</h3>
          <p class="muted">Nothing was applied. This is the change planner's result, as the MCP planChange tool returns it.</p>
          @if (p.refusal; as r) {
            <p class="error">{{ r.cause }}: {{ r.message }}</p>
          }
          @if (store.planData(); as d) {
            <p data-testid="plan-acceptance">Acceptance {{ d.acceptanceRequired ? 'required by policy' : 'not required by policy' }}{{ d.changeClasses?.length ? ' (classes ' + d.changeClasses!.join(', ') + ')' : '' }}.</p>
            <h4>Compatibility by dimension</h4>
            <table class="grid" data-testid="plan-compatibility">
              <thead><tr><th>Dimension</th><th>Kind</th><th>Changes</th></tr></thead>
              <tbody>
                @for (c of d.compatibility; track $index) {
                  <tr><td>{{ c.dimension }}</td><td>{{ c.kind }}</td><td>{{ c.changes }}</td></tr>
                }
              </tbody>
            </table>
            <h4>Changes</h4>
            <app-changes-table [changes]="d.changes" />
            <h4>Affected elements</h4>
            <app-affected-table data-testid="plan-affected" [affected]="d.affected" />
            <h4>Invalidated evidence</h4>
            @if (d.invalidatedEvidence.length === 0) {
              <p class="empty">No evidence is invalidated.</p>
            } @else {
              <ul>
                @for (x of d.invalidatedEvidence; track x.evidence) { <li><code>{{ x.evidence }}</code>: {{ x.reason }}</li> }
              </ul>
            }
            <h4>Repair alternatives</h4>
            @if (d.repairs.length === 0) {
              <p class="empty">No repair is proposed.</p>
            } @else {
              <ul>
                @for (r of d.repairs; track r.id) {
                  <li>{{ r.description }} <span class="tag">{{ r.kind }}</span>@if (r.requiresAcceptance) { <span class="tag">needs acceptance</span> }</li>
                }
              </ul>
            }
            <p class="muted">{{ d.obligations.length }} evidence obligation(s) of the affected components.</p>
          }
          <app-findings-table [findings]="p.findings" />
        </section>
      }

      @if (store.lastMutation(); as r) {
        <section data-testid="mutation-outcome" class="outcome" [class.ok]="r.accepted" [class.refused]="!r.accepted">
          <h3>{{ r.accepted ? 'ACCEPTED' : 'REFUSED' }}</h3>
          <p>
            {{ r.accepted ? 'The model was replaced; Undo restores the previous one.' : 'The model is unchanged.' }}
          </p>
          @if (r.impact.length) {
            <h4>Impact</h4>
            <app-affected-table data-testid="mutation-impact" [affected]="r.impact" />
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

  /** Decode the editor JSON and hand it to the engine unchanged; the engine judges the patch shape. */
  private parsed(): Patch | Patch[] | null {
    try {
      const value = JSON.parse(this.editorText()) as Patch | Patch[];
      this.parseError.set(null);
      return value;
    } catch (e) {
      this.parseError.set(`The editor does not hold valid JSON: ${(e as Error).message}`);
      return null;
    }
  }

  protected applyEditor(): void {
    const p = this.parsed();
    if (p !== null) this.store.apply(p, this.ackList());
  }

  protected previewEditor(): void {
    const p = this.parsed();
    if (p !== null) this.store.preview(p, this.ackList());
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
