import { Component, input } from '@angular/core';
import type { AffectedElement, Change } from '@loom/core';

@Component({
  selector: 'app-changes-table',
  template: `
    @if (changes().length === 0) {
      <p class="empty">No changes.</p>
    } @else {
      <table class="grid">
        <thead>
          <tr><th>Kind</th><th>Dimension</th><th>Element</th><th>Path</th><th>Reason</th><th>Consumers and dependency paths</th></tr>
        </thead>
        <tbody>
          @for (c of changes(); track $index) {
            <tr [class]="'chg-' + c.kind">
              <td data-col="kind">{{ c.kind }}</td>
              <td data-col="dimension">{{ c.dimension }}</td>
              <td data-col="element"><code>{{ c.element }}</code> <span class="muted">{{ c.elementKind }}</span></td>
              <td data-col="path"><code>{{ c.path }}</code></td>
              <td data-col="reason">{{ c.reason }}</td>
              <td data-col="consumers">{{ consumers(c.consumers) }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
})
export class ChangesTable {
  readonly changes = input.required<readonly Change[]>();

  protected consumers(list: readonly AffectedElement[]): string {
    return list.map((a) => `${a.ref.id} (${a.reason}: ${a.path.join(' → ')})`).join('; ');
  }
}
