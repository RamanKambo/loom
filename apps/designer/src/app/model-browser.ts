import { Component, computed, inject, signal } from '@angular/core';
import type { Authority, Binding, Property, TypeImport } from '@loom/core';
import { LoomStore } from './loom-store';

/** Navigator key for the model-wide workflow list; workflows have no owning component. */
const WORKFLOWS = '$workflows';

@Component({
  selector: 'app-model-browser',
  template: `
    @if (store.model(); as m) {
      <div class="browser">
        <nav class="nav">
          <h3>Components</h3>
          <ul>
            @for (c of m.components; track c.id) {
              <li>
                <button type="button" [class.active]="selected() === c.id" (click)="pick(c.id)">{{ c.id }}</button>
              </li>
            }
            <li>
              <button type="button" [class.active]="selected() === WORKFLOWS" (click)="pick(WORKFLOWS)">
                Workflows ({{ m.workflows.length }})
              </button>
            </li>
          </ul>
        </nav>

        <div class="detail">
          @if (view(); as v) {
            <h2>{{ v.component.id }}</h2>
            <p class="muted">{{ v.component.purpose }}</p>

            <h3>Types</h3>
            @for (t of v.types; track t.id) {
              <section class="card" [attr.data-type]="t.id">
                <h4>
                  <code>{{ t.id }}</code> v{{ t.version }}
                  @if (t.table) { <span class="tag">table {{ t.table }}</span> }
                  @if (t.key?.length) { <span class="tag">key {{ t.key!.join(', ') }}</span> }
                  @if (t.stateProperty) { <span class="tag">state {{ t.stateProperty }}</span> }
                </h4>
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Name</th><th>Kind</th><th>Required</th><th>Nullable</th><th>Immutable</th><th>Origin</th>
                      <th>Constraints</th><th>Binds</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of t.properties; track p.name) {
                      <tr [attr.data-prop]="t.id + '.' + p.name">
                        <td data-col="name"><code>{{ p.name }}</code></td>
                        <td data-col="kind">{{ p.kind }}</td>
                        <td data-col="required">{{ yesNo(p.required) }}</td>
                        <td data-col="nullable">{{ yesNo(p.nullable) }}</td>
                        <td data-col="immutable">{{ yesNo(p.immutable) }}</td>
                        <td data-col="origin">{{ p.origin }}</td>
                        <td data-col="constraints">{{ constraints(p) }}</td>
                        <td data-col="binds"><code>{{ p.binds ?? '' }}</code></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            } @empty {
              <p class="empty">No types.</p>
            }

            <h3>Operations</h3>
            @if (v.operations.length === 0) {
              <p class="empty">No operations.</p>
            } @else {
              <table class="grid">
                <thead>
                  <tr><th>Id</th><th>Kind</th><th>Version</th><th>Request</th><th>Response / result</th><th>Authority</th><th>Bindings</th></tr>
                </thead>
                <tbody>
                  @for (o of v.operations; track o.id) {
                    <tr [attr.data-operation]="o.id">
                      <td><code>{{ o.id }}</code></td>
                      <td>{{ o.kind }}</td>
                      <td>{{ o.version }}</td>
                      <td>{{ o.request ?? '' }}</td>
                      <td>{{ o.response ?? o.result ?? '' }}</td>
                      <td>{{ authority(o.authority) }}</td>
                      <td>{{ bindings(o.bindings) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }

            <h3>Routines</h3>
            @for (r of v.routines; track r.id) {
              <section class="card" [attr.data-routine]="r.id">
                <h4>
                  <code>{{ r.id }}</code> v{{ r.version }}
                  <span class="tag">{{ r.host }}</span>
                  @if (r.source) { <span class="tag">source {{ r.source }}</span> }
                  <span class="tag">authority {{ authority(r.authority) }}</span>
                </h4>
                <p class="muted">
                  performs {{ r.performsMutations.join(', ') || 'nothing' }}
                  @if (r.writesTables?.length) { · writes {{ r.writesTables!.join(', ') }} }
                </p>
                <table class="grid">
                  <caption>Params</caption>
                  <thead><tr><th>Name</th><th>Kind</th><th>Required</th><th>Nullable</th><th>Binds</th></tr></thead>
                  <tbody>
                    @for (p of r.params; track p.name) {
                      <tr>
                        <td><code>{{ p.name }}</code></td>
                        <td>{{ p.kind }}</td>
                        <td>{{ yesNo(p.required) }}</td>
                        <td>{{ yesNo(p.nullable) }}</td>
                        <td><code>{{ p.binds ?? '' }}</code></td>
                      </tr>
                    } @empty {
                      <tr><td colspan="5" class="empty">No params.</td></tr>
                    }
                  </tbody>
                </table>
                <table class="grid">
                  <caption>Result set</caption>
                  <thead><tr><th>Name</th><th>Kind</th><th>Nullable</th><th>Binds</th></tr></thead>
                  <tbody>
                    @for (c of r.resultSet; track $index) {
                      <tr>
                        <td><code>{{ c.name }}</code></td>
                        <td>{{ c.kind }}</td>
                        <td>{{ yesNo(c.nullable) }}</td>
                        <td><code>{{ c.binds ?? '' }}</code></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            } @empty {
              <p class="empty">No routines.</p>
            }

            <h3>Mutations</h3>
            @if (v.mutations.length === 0) {
              <p class="empty">No mutations.</p>
            } @else {
              <table class="grid">
                <thead><tr><th>Id</th><th>Type</th><th>From → to</th><th>Writes</th><th>Guard</th><th>Effect</th></tr></thead>
                <tbody>
                  @for (x of v.mutations; track x.id) {
                    <tr>
                      <td><code>{{ x.id }}</code></td>
                      <td>{{ x.type }}</td>
                      <td>{{ x.from.join(' | ') }} → {{ x.to }}</td>
                      <td>{{ x.writes.join(', ') }}</td>
                      <td>{{ x.guard }}</td>
                      <td>{{ x.effect }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          } @else {
            <h2>Workflows</h2>
            @if (m.workflows.length === 0) {
              <p class="empty">No workflows.</p>
            } @else {
              <table class="grid">
                <thead>
                  <tr><th>Id</th><th>Status</th><th>Depends on</th><th>Imports</th><th>Operations</th><th>Mutations</th><th>Requirements</th></tr>
                </thead>
                <tbody>
                  @for (w of m.workflows; track w.id) {
                    <tr [attr.data-workflow]="w.id">
                      <td><code>{{ w.id }}</code></td>
                      <td>{{ w.status }}</td>
                      <td>{{ w.dependsOn.join(', ') }}</td>
                      <td>{{ imports(w.imports) }}</td>
                      <td>{{ (w.operations ?? []).join(', ') }}</td>
                      <td>{{ (w.mutations ?? []).join(', ') }}</td>
                      <td>{{ w.requirements.join(', ') }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          }
        </div>
      </div>
    } @else {
      <p class="empty">Load a model file or the sample to browse it.</p>
    }
  `,
})
export class ModelBrowser {
  protected readonly store = inject(LoomStore);
  protected readonly WORKFLOWS = WORKFLOWS;
  private readonly picked = signal<string | null>(null);

  /** The navigator selection, falling back to the first component when the pick no longer exists. */
  protected readonly selected = computed(() => {
    const m = this.store.model();
    if (!m) return null;
    const p = this.picked();
    if (p === WORKFLOWS || (p !== null && m.components.some((c) => c.id === p))) return p;
    return m.components[0]?.id ?? WORKFLOWS;
  });

  protected readonly view = computed(() => {
    const m = this.store.model();
    const id = this.selected();
    const component = m?.components.find((c) => c.id === id);
    if (!m || !component) return null;
    return {
      component,
      types: m.types.filter((t) => t.owner === component.id),
      operations: m.operations.filter((o) => o.owner === component.id),
      routines: m.routines.filter((r) => r.owner === component.id),
      mutations: m.mutations.filter((x) => x.owner === component.id),
    };
  });

  protected pick(id: string): void {
    this.picked.set(id);
  }

  protected yesNo(v: boolean): string {
    return v ? 'yes' : 'no';
  }

  protected constraints(p: Property): string {
    const parts: string[] = [];
    if (p.enumValues?.length) parts.push(p.enumValues.join(' | '));
    if (p.bounds) parts.push(JSON.stringify(p.bounds));
    return parts.join(' ');
  }

  protected authority(a: Authority): string {
    return a.scope ? `${a.permission} @ ${a.scope}` : a.permission;
  }

  protected bindings(bs: readonly Binding[] | undefined): string {
    return (bs ?? []).map((b) => [b.transport, b.method, b.path].filter(Boolean).join(' ')).join('; ');
  }

  protected imports(list: readonly TypeImport[]): string {
    return list.map((i) => `${i.typeId}@v${i.version}`).join(', ');
  }
}
