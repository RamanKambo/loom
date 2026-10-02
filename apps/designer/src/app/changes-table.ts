import { Component, input } from '@angular/core';
import type { Change } from '@loom/core';

@Component({
  selector: 'app-changes-table',
  template: `
    @if (changes().length === 0) {
      <p class="empty">No changes.</p>
    } @else {
      <table class="grid">
        <thead>
          <tr><th>Kind</th><th>Element</th><th>Path</th><th>Reason</th><th>Consumers</th></tr>
        </thead>
        <tbody>
          @for (c of changes(); track $index) {
            <tr [class]="'chg-' + c.kind">
              <td data-col="kind">{{ c.kind }}</td>
              <td data-col="element"><code>{{ c.element }}</code> <span class="muted">{{ c.elementKind }}</span></td>
              <td data-col="path"><code>{{ c.path }}</code></td>
              <td data-col="reason">{{ c.reason }}</td>
              <td data-col="consumers">{{ c.consumers.join(', ') }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
})
export class ChangesTable {
  readonly changes = input.required<readonly Change[]>();
}
