import { Component, input } from '@angular/core';
import type { AffectedElement } from '@loom/core';

/** Affected elements as the engine reports them: the reason and the dependency path that explains each one. */
@Component({
  selector: 'app-affected-table',
  template: `
    @if (affected().length === 0) {
      <p class="empty">No affected element.</p>
    } @else {
      <table class="grid">
        <thead><tr><th>Element</th><th>Reason</th><th>Dependency path</th><th>Via</th></tr></thead>
        <tbody>
          @for (a of affected(); track $index) {
            <tr [attr.data-affected]="a.ref.kind + ':' + a.ref.id">
              <td><code>{{ a.ref.kind }} {{ a.ref.id }}</code></td>
              <td data-col="reason">{{ a.reason }}</td>
              <td data-col="path">{{ a.path.join(' → ') }}</td>
              <td>{{ (a.edgeKinds ?? []).join(', ') }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
})
export class AffectedTable {
  readonly affected = input.required<readonly AffectedElement[]>();
}
