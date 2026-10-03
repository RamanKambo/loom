import { Component, computed, inject, signal } from '@angular/core';
import type { DiffData } from '@loom/core';
import { ChangesTable } from './changes-table';
import { FindingsTable } from './findings-table';
import { LoomStore, TRUST_LIMIT, type RecordLoad } from './loom-store';

/**
 * Selects the accepted baseline and the records evaluated with it. Selecting a baseline is separate
 * from editing the candidate: it never changes the model, and the undo history and the
 * opened-model comparison point are never offered as a baseline.
 */
@Component({
  selector: 'app-baseline-panel',
  imports: [ChangesTable, FindingsTable],
  template: `
    @if (store.model()) {
      <p class="banner warn">{{ trustLimit }}</p>
      <fieldset>
        <legend>Accepted baseline: its record and the snapshot it names</legend>
        <div class="row">
          <label class="file">Baseline record <input #rec type="file" accept=".json" (change)="pickRecord(rec)" /></label>
          <label class="file">Snapshot model <input #snap type="file" accept=".json" (change)="pickSnapshot(snap)" /></label>
          <button type="button" [disabled]="!recordText() || !snapshotText()" (click)="select()">Select baseline</button>
          <button type="button" [disabled]="!store.acceptedBaseline()" (click)="store.clearBaseline()">Clear baseline</button>
        </div>
        <div class="row">
          <label class="file">Acceptance record <input #acc type="file" accept=".json" (change)="loadInto(acc, 'acceptance')" /></label>
          <label class="file">Policy <input #pol type="file" accept=".json" (change)="loadInto(pol, 'policy')" /></label>
          <label class="file">Evidence records <input #ev type="file" accept=".json" multiple (change)="loadInto(ev, 'evidence')" /></label>
          <button type="button" [disabled]="store.evidence().length === 0" (click)="store.clearEvidence()">Clear evidence</button>
        </div>
        @if (problem(); as p) {
          <div class="error" data-testid="baseline-error">
            <p>{{ p.error }}</p>
            @if (p.errors.length) {
              <ul>
                @for (e of p.errors; track $index) { <li><code>{{ e.pointer || '(record)' }}</code> {{ e.message }}</li> }
              </ul>
            }
          </div>
        }
      </fieldset>

      @if (store.acceptedBaseline(); as b) {
        <p data-testid="baseline-selected">
          Baseline <code>{{ b.record.id }}</code> from {{ b.source }}, snapshot <code>{{ b.record.model.hash }}</code>;
          {{ store.acceptances().length }} acceptance record(s), {{ store.evidence().length }} evidence record(s).
        </p>
      } @else {
        <p class="muted" data-testid="baseline-none">No accepted baseline is selected, so acceptance is not evaluated.</p>
      }

      @if (store.baselineComparison(); as r) {
        <h3>Acceptance: <span class="badge" data-testid="acceptance-state">{{ r.states.acceptance.state }}</span></h3>
        @if (changes(); as d) {
          <p>
            {{ d.changes.length }} change(s) against the baseline{{ d.provisional ? '; the comparison is provisional because a side is not valid' : '' }}.
          </p>
          <app-changes-table [changes]="d.changes" />
        }
        <h4>Findings</h4>
        <app-findings-table [findings]="comparisonFindings()" />
      }
    } @else {
      <p class="empty">Load a model first.</p>
    }
  `,
})
export class BaselinePanel {
  protected readonly store = inject(LoomStore);
  protected readonly trustLimit = TRUST_LIMIT;
  protected readonly recordText = signal<string | null>(null);
  protected readonly snapshotText = signal<string | null>(null);
  private readonly recordName = signal('baseline');
  protected readonly problem = signal<Extract<RecordLoad, { ok: false }> | null>(null);

  protected readonly changes = computed(() => (this.store.baselineComparison()?.data as DiffData | undefined) ?? null);
  /** The comparison's own findings; model findings stay on the Validate tab. */
  protected readonly comparisonFindings = computed(() => this.store.baselineFindings());

  protected async pickRecord(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    this.recordName.set(file.name);
    this.recordText.set(await file.text());
    input.value = '';
  }

  protected async pickSnapshot(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    this.snapshotText.set(await file.text());
    input.value = '';
  }

  protected select(): void {
    const r = this.store.selectBaseline(this.recordText() ?? '', this.snapshotText() ?? '', this.recordName());
    this.problem.set(r.ok ? null : r);
  }

  protected async loadInto(input: HTMLInputElement, kind: 'acceptance' | 'policy' | 'evidence'): Promise<void> {
    const files = [...(input.files ?? [])];
    input.value = '';
    for (const file of files) {
      const text = await file.text();
      const r = kind === 'acceptance' ? this.store.addAcceptance(text) : kind === 'policy' ? this.store.setPolicy(text) : this.store.addEvidence(text);
      this.problem.set(r.ok ? null : { ...r, error: `${file.name}: ${r.error}` });
      if (!r.ok) return;
    }
  }
}
