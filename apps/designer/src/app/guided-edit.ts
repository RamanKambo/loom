import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { SCHEMA_BUNDLE, type Kind, type Patch } from '@loom/core';
import { LoomStore } from './loom-store';

/** Property kinds as the model contract defines them at runtime. */
const KINDS: readonly Kind[] = SCHEMA_BUNDLE.$defs.Kind.enum;

/**
 * Builds an updateItem patch for the common property edit and sends it through
 * the same LoomStore.apply() path as the batch editor; the engine decides.
 */
@Component({
  selector: 'app-guided-edit',
  template: `
    <fieldset class="guided">
      <legend>Guided edit: change one property</legend>
      @if (type(); as t) {
        <div class="row">
          <label>
            Type
            <select name="type" #typeSel (change)="pickType(typeSel.value)">
              @for (x of types(); track x.id) {
                <option [value]="x.id" [selected]="x.id === t.id">{{ x.id }} (v{{ x.version }}, {{ x.owner }})</option>
              }
            </select>
          </label>
          @if (property(); as p) {
            <label>
              Property
              <select name="property" #propSel (change)="pickProperty(propSel.value)">
                @for (x of t.properties; track x.name) {
                  <option [value]="x.name" [selected]="x.name === p.name">{{ x.name }}</option>
                }
              </select>
            </label>
            <label>
              Kind
              <select name="kind" #kindSel (change)="pickKind(kindSel.value)">
                @for (k of kinds; track k) {
                  <option [value]="k" [selected]="k === kind()">{{ k }}</option>
                }
              </select>
            </label>
            <label>
              <input type="checkbox" name="nullable" #nullBox [checked]="nullable()" (change)="nullable.set(nullBox.checked)" />
              nullable
            </label>
            <label>
              <input type="checkbox" name="required" #reqBox [checked]="required()" (change)="required.set(reqBox.checked)" />
              required
            </label>
          }
        </div>
        @if (property(); as p) {
          <p class="muted">
            Current <code>{{ t.id }}.{{ p.name }}</code>: {{ p.kind }}, {{ p.required ? 'required' : 'optional' }},
            {{ p.nullable ? 'nullable' : 'not nullable' }}
          </p>
        }
        @if (patch(); as pt) {
          <pre class="code" data-testid="guided-patch">{{ json(pt) }}</pre>
          <div class="actions">
            <button type="button" data-testid="guided-apply" (click)="apply()">Apply through mutate()</button>
            <button type="button" (click)="addToEditor.emit(pt)">Add to batch editor</button>
          </div>
        } @else {
          <p class="empty">Pick a different kind, nullability or required flag to build a patch.</p>
        }
      } @else {
        <p class="empty">The model has no types.</p>
      }
    </fieldset>
  `,
})
export class GuidedEdit {
  private readonly store = inject(LoomStore);

  /** Element ids sent as acknowledgeBreaking with the patch. */
  readonly acknowledge = input<string[]>([]);
  /** Hands the built patch to the batch editor so it can be combined with others. */
  readonly addToEditor = output<Patch>();

  protected readonly kinds = KINDS;
  private readonly typeId = signal<string | null>(null);
  private readonly propertyName = signal<string | null>(null);

  protected readonly types = computed(() => this.store.model()?.types ?? []);
  protected readonly type = computed(() => {
    const ts = this.types();
    return ts.find((t) => t.id === this.typeId()) ?? ts[0] ?? null;
  });
  protected readonly property = computed(() => {
    const t = this.type();
    return t?.properties.find((p) => p.name === this.propertyName()) ?? t?.properties[0] ?? null;
  });

  // Drafts reset to the selected property's current values whenever it changes.
  protected readonly kind = linkedSignal<Kind>(() => this.property()?.kind ?? KINDS[0]);
  protected readonly nullable = linkedSignal(() => this.property()?.nullable ?? false);
  protected readonly required = linkedSignal(() => this.property()?.required ?? false);

  /** The patch the form describes, carrying only the fields that differ from the current property. */
  protected readonly patch = computed<Patch | null>(() => {
    const t = this.type();
    const p = this.property();
    if (!t || !p) return null;
    const set: { kind?: Kind; nullable?: boolean; required?: boolean } = {};
    if (this.kind() !== p.kind) set.kind = this.kind();
    if (this.nullable() !== p.nullable) set.nullable = this.nullable();
    if (this.required() !== p.required) set.required = this.required();
    if (Object.keys(set).length === 0) return null;
    return { op: 'updateItem', collection: 'types', id: t.id, field: 'properties', key: p.name, set };
  });

  protected pickType(id: string): void {
    this.typeId.set(id);
    this.propertyName.set(null);
  }

  protected pickProperty(name: string): void {
    this.propertyName.set(name);
  }

  protected pickKind(value: string): void {
    const k = KINDS.find((x) => x === value);
    if (k) this.kind.set(k);
  }

  protected apply(): void {
    const p = this.patch();
    if (p) this.store.apply(p, this.acknowledge());
  }

  protected json(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }
}
