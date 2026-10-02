import { Component, input } from '@angular/core';
import type { AffectedElement, Finding } from '@loom/core';

@Component({
  selector: 'app-findings-table',
  template: `
    @if (findings().length === 0) {
      <p class="empty">No findings.</p>
    } @else {
      <table class="grid">
        <thead>
          <tr><th>Severity</th><th>Code</th><th>Path</th><th>Message</th><th>Fix</th><th>Impact</th></tr>
        </thead>
        <tbody>
          @for (f of findings(); track $index) {
            <tr [class]="'sev-' + f.severity">
              <td data-col="severity">{{ f.severity }}</td>
              <td data-col="code"><code>{{ f.code }}</code></td>
              <td data-col="path"><code>{{ f.path }}</code></td>
              <td data-col="message">{{ f.message }}</td>
              <td data-col="fix">{{ f.fix ?? '' }}</td>
              <td data-col="impact">{{ ids(f.impact ?? []) }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
})
export class FindingsTable {
  readonly findings = input.required<readonly Finding[]>();

  protected ids(list: readonly AffectedElement[]): string {
    return list.map((a) => a.ref.id).join(', ');
  }
}
