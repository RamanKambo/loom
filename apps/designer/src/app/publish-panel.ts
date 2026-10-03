import { Component, computed, inject, signal } from '@angular/core';
import type { RecordRef } from '@loom/core';
import { downloadText } from './download';
import { LoomStore, type PublishOutcome } from './loom-store';

type Publishable = 'type' | 'operation' | 'routine' | 'securityScheme';

/**
 * Publishing is separate from editing and from baseline selection: it exports the chosen records as
 * a pinned contract bundle whose digest the engine computes. It never changes the model.
 */
@Component({
  selector: 'app-publish-panel',
  template: `
    @if (store.model(); as m) {
      <div class="row">
        <label>Publisher <input type="text" name="publisher" #pub [value]="publisher()" (input)="publisher.set(pub.value)" /></label>
        <label>Contract <input type="text" name="contract" #con [value]="contract()" (input)="contract.set(con.value)" /></label>
        <label>Version <input type="number" name="version" min="1" #ver [value]="version()" (input)="version.set(+ver.value)" /></label>
      </div>
      <div class="columns">
        @for (g of groups(); track g.kind) {
          <fieldset>
            <legend>{{ g.label }}</legend>
            @for (id of g.ids; track id) {
              <label class="block">
                <input type="checkbox" [attr.data-publish]="g.kind + ':' + id" [checked]="isPicked(g.kind, id)" (change)="toggle(g.kind, id)" />
                {{ id }}
              </label>
            } @empty {
              <p class="empty">None.</p>
            }
          </fieldset>
        }
      </div>
      <button type="button" data-testid="publish" [disabled]="selection().length === 0" (click)="publish()">Build bundle</button>
      @if (result(); as r) {
        @if (r.ok) {
          <p data-testid="publish-digest">Digest <code>{{ r.bundle.digest }}</code> over {{ selection().length }} record(s).</p>
          <button type="button" (click)="download(r)">Download {{ r.fileName }}</button>
          <pre class="code output">{{ r.text }}</pre>
        } @else {
          <div class="error" data-testid="publish-error">
            <p>{{ r.error }}</p>
            <ul>
              @for (e of r.errors; track $index) { <li><code>{{ e.pointer }}</code> {{ e.message }}</li> }
            </ul>
          </div>
        }
      }
    } @else {
      <p class="empty">Load a model first.</p>
    }
  `,
})
export class PublishPanel {
  protected readonly store = inject(LoomStore);
  protected readonly publisher = signal('team-contracts');
  protected readonly contract = signal('contract');
  protected readonly version = signal(1);
  protected readonly selection = signal<readonly RecordRef[]>([]);
  protected readonly result = signal<PublishOutcome | null>(null);

  protected readonly groups = computed(() => {
    const m = this.store.model();
    if (!m) return [];
    const group = (kind: Publishable, label: string, ids: string[]) => ({ kind, label, ids });
    return [
      group('type', 'Types', m.types.map((t) => t.id)),
      group('operation', 'Operations', m.operations.map((o) => o.id)),
      group('routine', 'Routines', m.routines.map((r) => r.id)),
      group('securityScheme', 'Security schemes', m.securitySchemes.map((s) => s.id)),
    ];
  });

  protected isPicked(kind: Publishable, id: string): boolean {
    return this.selection().some((s) => s.kind === kind && s.id === id);
  }

  protected toggle(kind: Publishable, id: string): void {
    this.selection.update((list) => (list.some((s) => s.kind === kind && s.id === id) ? list.filter((s) => !(s.kind === kind && s.id === id)) : [...list, { kind, id }]));
    this.result.set(null);
  }

  protected publish(): void {
    this.result.set(this.store.publish(this.selection(), { publisher: this.publisher(), contract: this.contract(), version: this.version() }));
  }

  protected download(r: Extract<PublishOutcome, { ok: true }>): void {
    downloadText(r.fileName, r.text, 'application/json');
  }
}
