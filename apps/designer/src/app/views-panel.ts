import { Component, computed, inject, signal } from '@angular/core';
import { PROFILES, type CoverageItem, type ProjectionTarget } from '@loom/core';
import { FindingsTable } from './findings-table';
import { LoomStore } from './loom-store';

/** Targets the documentation profiles declare: the generated views, read from the profile definitions. */
const VIEW_TARGETS: readonly ProjectionTarget[] = [
  ...new Set(PROFILES.filter((p) => p.kind === 'documentation').flatMap((p) => p.artifacts.map((a) => a.target))),
];

/**
 * Generated views with their sources and completeness, plus the mapping and hosting records they
 * are rendered from. A view never grants readiness or qualification; it renders the engine's results.
 */
@Component({
  selector: 'app-views-panel',
  imports: [FindingsTable],
  template: `
    @if (store.model(); as m) {
      <div class="row">
        <label>
          View
          <select name="view" #sel (change)="pick(sel.value)">
            @for (t of targets; track t) {
              <option [value]="t" [selected]="t === target()">{{ t }}</option>
            }
          </select>
        </label>
        <label><input type="checkbox" name="draft" #dr [checked]="draft()" (change)="draft.set(dr.checked)" /> draft</label>
      </div>
      @let o = outcome();
      @if (o.ok) {
        @let r = o.rendered;
        <p class="muted" data-testid="view-source">
          Rendered from model <code>{{ store.revision() }}</code>
          @if (store.evaluated().baseline; as b) { with baseline <code>{{ b.id }}</code> }
          and {{ store.evaluated().evidence }} evidence record(s). No external validator ran on this view.
          @if (r.draft) { <strong>Draft: it can neither qualify nor publish.</strong> }
        </p>
        <p data-testid="view-coverage" [attr.data-complete]="r.coverage.complete">
          Coverage {{ r.coverage.complete ? 'complete' : 'incomplete' }}: {{ counts(r.coverage.items) }}
        </p>
        @if (unsupported(r.coverage.items).length) {
          <ul class="error">
            @for (u of unsupported(r.coverage.items); track $index) {
              <li><code>{{ u.ref.kind }} {{ u.ref.id }}</code> unsupported: {{ u.reason ?? '' }}</li>
            }
          </ul>
        }
        @for (f of r.files; track f.instance) {
          <h4><code>{{ f.instance }}</code></h4>
          <pre class="code output" data-testid="view-output">{{ f.content }}</pre>
        }
      } @else {
        <p class="error" data-testid="view-error">{{ o.error }}</p>
        <app-findings-table [findings]="o.findings" />
      }

      <h3>Mappings</h3>
      @if (m.mappings.length === 0) {
        <p class="empty">No mapping.</p>
      } @else {
        <table class="grid" data-testid="mappings">
          <thead><tr><th>Id</th><th>From → to</th><th>Owner</th><th>Fields</th><th>Unmapped</th></tr></thead>
          <tbody>
            @for (x of m.mappings; track x.id) {
              <tr>
                <td><code>{{ x.id }}</code></td>
                <td>{{ x.from }} → {{ x.to }}</td>
                <td>{{ x.owner }}</td>
                <td>{{ fields(x.fields) }}</td>
                <td>{{ unmapped(x.unmapped ?? []) }}</td>
              </tr>
            }
          </tbody>
        </table>
      }

      <h3>Hosting</h3>
      @if (m.deploymentUnits.length === 0) {
        <p class="empty">No deployment unit.</p>
      } @else {
        <table class="grid" data-testid="hosting">
          <thead><tr><th>Unit</th><th>Components</th><th>Host</th><th>Trust boundary</th><th>Trigger</th><th>Co-hosting</th></tr></thead>
          <tbody>
            @for (u of m.deploymentUnits; track u.id) {
              <tr [attr.data-unit]="u.id">
                <td><code>{{ u.id }}</code></td>
                <td>{{ u.components.join(', ') }}</td>
                <td>{{ u.host }}</td>
                <td>{{ u.trustBoundary }}</td>
                <td>{{ u.invocation.trigger }}</td>
                <td>{{ u.components.length > 1 ? 'co-hosted' + (u.decision ? ', decision ' + u.decision : ', no decision') : 'single component' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    } @else {
      <p class="empty">Load a model first.</p>
    }
  `,
})
export class ViewsPanel {
  protected readonly store = inject(LoomStore);
  protected readonly targets = VIEW_TARGETS;
  private readonly picked = signal<ProjectionTarget | null>(null);
  protected readonly draft = signal(false);

  protected readonly target = computed<ProjectionTarget>(() => {
    const p = this.picked();
    return p !== null && VIEW_TARGETS.includes(p) ? p : VIEW_TARGETS[0]!;
  });
  protected readonly outcome = computed(() => this.store.view(this.target(), this.draft()));

  protected pick(value: string): void {
    const t = VIEW_TARGETS.find((x) => x === value);
    if (t) this.picked.set(t);
  }

  protected counts(items: readonly CoverageItem[]): string {
    const by = new Map<string, number>();
    for (const i of items) by.set(i.status, (by.get(i.status) ?? 0) + 1);
    return [...by].map(([k, v]) => `${v} ${k}`).join(', ') || 'no record in scope';
  }

  protected unsupported(items: readonly CoverageItem[]): CoverageItem[] {
    return items.filter((i) => i.status === 'unsupported');
  }

  protected fields(list: readonly { from?: string; to: string; transform: string }[]): string {
    return list.map((f) => `${f.from ?? '∅'} → ${f.to} (${f.transform})`).join('; ');
  }

  protected unmapped(list: readonly { side: string; property: string }[]): string {
    return list.map((u) => `${u.side} ${u.property}`).join(', ');
  }
}
