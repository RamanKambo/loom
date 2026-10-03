import { Component, inject } from '@angular/core';
import { LoomStore } from './loom-store';

/** Open unknowns, applicable concerns the model leaves unresolved, and assumptions not yet validated. */
@Component({
  selector: 'app-unknowns-panel',
  template: `
    @if (store.openQuestions(); as q) {
      <h3>Open unknowns ({{ q.unknowns.length }})</h3>
      @if (q.unknowns.length === 0) {
        <p class="empty">No open unknown.</p>
      } @else {
        <table class="grid" data-testid="open-unknowns">
          <thead><tr><th>Id</th><th>Question</th><th>Blocks</th><th>Affects</th><th>Owner</th><th>Resolution</th></tr></thead>
          <tbody>
            @for (u of q.unknowns; track u.id) {
              <tr>
                <td><code>{{ u.id }}</code></td>
                <td>{{ u.question }}</td>
                <td>{{ u.blocks.join(', ') }}</td>
                <td>{{ refs(u.affects) }}</td>
                <td>{{ u.owner }}</td>
                <td>{{ u.resolution }}</td>
              </tr>
            }
          </tbody>
        </table>
      }

      <h3>Unresolved concerns ({{ q.concerns.length }})</h3>
      @if (q.concerns.length === 0) {
        <p class="empty">Every applicable concern is declared, recorded as unknown or justified as not applicable.</p>
      } @else {
        <table class="grid" data-testid="unresolved-concerns">
          <thead><tr><th>Code</th><th>Path</th><th>Message</th><th>Fix</th></tr></thead>
          <tbody>
            @for (f of q.concerns; track $index) {
              <tr><td><code>{{ f.code }}</code></td><td><code>{{ f.path }}</code></td><td>{{ f.message }}</td><td>{{ f.fix ?? '' }}</td></tr>
            }
          </tbody>
        </table>
      }

      <h3>Assumptions not validated ({{ q.assumptions.length }})</h3>
      @if (q.assumptions.length === 0) {
        <p class="empty">No unvalidated assumption.</p>
      } @else {
        <table class="grid">
          <thead><tr><th>Id</th><th>Claim</th><th>Status</th><th>If false</th><th>Validation</th></tr></thead>
          <tbody>
            @for (a of q.assumptions; track a.id) {
              <tr><td><code>{{ a.id }}</code></td><td>{{ a.claim }}</td><td>{{ a.status }}</td><td>{{ a.consequenceIfFalse }}</td><td>{{ a.validation }}</td></tr>
            }
          </tbody>
        </table>
      }
    } @else {
      <p class="empty">Load a model first.</p>
    }
  `,
})
export class UnknownsPanel {
  protected readonly store = inject(LoomStore);

  protected refs(list: readonly { kind: string; id: string }[]): string {
    return list.map((r) => `${r.kind} ${r.id}`).join(', ');
  }
}
