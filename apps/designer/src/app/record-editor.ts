import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { canonicalStringify, recordKey, schemaErrors, type CollectionName, type Patch, type SchemaError } from '@loom/core';
import { FindingsTable } from './findings-table';
import { LoomStore } from './loom-store';
import { COLLECTION_SPECS, fieldsOf, startingValue, type CollectionSpec, type FieldSpec } from './schema-fields';

type Draft = Record<string, unknown>;

const NEW = '$new';

const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);

/**
 * Inspects and edits any record of any collection. The controls come from the record's contract
 * definition; every change is sent as a patch through LoomStore.apply(), so the engine decides.
 */
@Component({
  selector: 'app-record-editor',
  imports: [FindingsTable],
  template: `
    @if (store.model(); as m) {
      <div class="row">
        <label>
          Collection
          <select name="collection" #col (change)="pickCollection(col.value)">
            @for (c of collections; track c.collection) {
              <option [value]="c.collection" [selected]="c.collection === spec().collection">{{ c.collection }} ({{ count(c) }})</option>
            }
          </select>
        </label>
        <label>
          Record
          <select name="record" #rec (change)="pickRecord(rec.value)">
            @for (k of keys(); track k) {
              <option [value]="k" [selected]="k === selectedKey()">{{ k }}</option>
            }
            <option [value]="NEW" [selected]="selectedKey() === NEW">(new record)</option>
          </select>
        </label>
      </div>

      <fieldset class="form" data-testid="record-form">
        <legend>
          {{ spec().definition }} {{ isNew() ? '(new)' : selectedKey() }} — fields from the contract definition
        </legend>
        @for (f of fields(); track f.name) {
          <div class="field" [attr.data-field]="f.name">
            <span class="label">{{ f.name }}{{ f.required ? ' *' : '' }}</span>
            @switch (f.control.kind) {
              @case ('text') {
                <input type="text" [attr.name]="f.name" [disabled]="f.key && !isNew()" [value]="textOf(f)" (input)="setText(f, $any($event.target).value)" />
              }
              @case ('number') {
                <input type="number" [attr.name]="f.name" [value]="textOf(f)" (input)="setNumber(f, $any($event.target).value)" />
              }
              @case ('boolean') {
                <input type="checkbox" [attr.name]="f.name" [checked]="draft()[f.name] === true" (change)="setValue(f, $any($event.target).checked)" />
              }
              @case ('enum') {
                <select [attr.name]="f.name" (change)="setEnum(f, $any($event.target).value)">
                  @if (!f.required) {
                    <option value="" [selected]="draft()[f.name] === undefined">(unset)</option>
                  }
                  @for (v of enumValues(f); track v) {
                    <option [value]="v" [selected]="draft()[f.name] === v">{{ v }}</option>
                  }
                </select>
              }
              @case ('const') {
                <code>{{ json(constValue(f)) }}</code>
              }
              @default {
                <textarea class="editor small" [attr.name]="f.name" rows="3" spellcheck="false" [value]="jsonOf(f)" (input)="setJson(f, $any($event.target).value)"></textarea>
              }
            }
            @if (fieldErrors()[f.name]; as e) {
              <span class="error">{{ e }}</span>
            }
            @if (f.description) {
              <span class="muted hint">{{ f.description }}</span>
            }
          </div>
        }
        @if (schemaProblems().length) {
          <ul class="error" data-testid="record-schema-errors">
            @for (e of schemaProblems(); track $index) {
              <li><code>{{ e.pointer || '(record)' }}</code> {{ e.message }}</li>
            }
          </ul>
        }
        <div class="actions">
          <button type="button" data-testid="record-apply" [disabled]="!patch()" (click)="applyForm()">Apply through mutate()</button>
          @if (!isNew()) {
            <button type="button" data-testid="record-remove" (click)="remove()">Remove record</button>
          }
          <button type="button" (click)="reset()">Reset form</button>
        </div>
        @if (!isNew() && renamable()) {
          <div class="row">
            <label>
              Rename to
              <input type="text" name="renameTo" #ren [value]="renameTo()" (input)="renameTo.set(ren.value)" />
            </label>
            <button type="button" data-testid="record-rename" [disabled]="!renameTo().trim()" (click)="rename()">Rename (references follow)</button>
          </div>
        }
      </fieldset>

      <fieldset>
        <legend>Structured editor: the whole record as JSON, checked against {{ spec().definition }}</legend>
        <textarea class="editor" name="recordJson" rows="12" spellcheck="false" data-testid="record-json" [value]="jsonText()" (input)="jsonText.set($any($event.target).value)"></textarea>
        @if (jsonProblems(); as p) {
          @if (p.parse) {
            <p class="error">{{ p.parse }}</p>
          }
          @if (p.schema.length) {
            <ul class="error" data-testid="record-json-errors">
              @for (e of p.schema; track $index) {
                <li><code>{{ e.pointer || '(record)' }}</code> {{ e.message }}</li>
              }
            </ul>
          }
        }
        <button type="button" data-testid="record-json-apply" (click)="applyJson()">Apply JSON through mutate()</button>
      </fieldset>

      <fieldset>
        <legend>System profile</legend>
        <textarea class="editor small" name="systemProfile" rows="3" spellcheck="false" [value]="profileText()" (input)="profileText.set($any($event.target).value)"></textarea>
        <div class="actions">
          <button type="button" (click)="setProfile()">Set system profile</button>
          <button type="button" [disabled]="!m.systemProfile" (click)="clearProfile()">Clear system profile</button>
        </div>
      </fieldset>

      @if (store.lastMutation(); as r) {
        <section class="outcome" data-testid="record-outcome" [class.ok]="r.accepted" [class.refused]="!r.accepted">
          <h3>{{ r.accepted ? 'ACCEPTED' : 'REFUSED' }}</h3>
          <app-findings-table [findings]="r.findings" />
        </section>
      }
    } @else {
      <p class="empty">Load a model first.</p>
    }
  `,
})
export class RecordEditor {
  protected readonly store = inject(LoomStore);
  protected readonly collections = COLLECTION_SPECS;
  protected readonly NEW = NEW;

  private readonly collection = signal<CollectionName>(COLLECTION_SPECS[0]!.collection);
  private readonly picked = signal<string | null>(null);

  protected readonly spec = computed<CollectionSpec>(() => COLLECTION_SPECS.find((c) => c.collection === this.collection()) ?? COLLECTION_SPECS[0]!);
  protected readonly fields = computed<FieldSpec[]>(() => fieldsOf(this.spec().definition, this.spec().key));

  private readonly records = computed<Draft[]>(() => {
    const m = this.store.model();
    return m ? ((m as unknown as Record<string, Draft[]>)[this.spec().collection] ?? []) : [];
  });
  protected readonly keys = computed(() => this.records().map((r) => recordKey(this.spec().collection, r)));
  protected readonly selectedKey = computed(() => {
    const p = this.picked();
    if (p === NEW) return NEW;
    const keys = this.keys();
    return p !== null && keys.includes(p) ? p : (keys[0] ?? NEW);
  });
  protected readonly isNew = computed(() => this.selectedKey() === NEW);
  private readonly original = computed<Draft | null>(() => {
    const k = this.selectedKey();
    return k === NEW ? null : (this.records().find((r) => recordKey(this.spec().collection, r) === k) ?? null);
  });
  protected readonly renamable = computed(() => this.spec().key.length === 1 && this.spec().key[0] === 'id');

  protected readonly draft = linkedSignal<Draft>(() => {
    const o = this.original();
    if (o) return structuredClone(o);
    const fresh: Draft = {};
    for (const f of this.fields()) if (f.required) fresh[f.name] = startingValue(f);
    return fresh;
  });
  protected readonly fieldErrors = linkedSignal<Record<string, string>>(() => {
    this.draft();
    return {};
  });
  protected readonly jsonText = linkedSignal(() => JSON.stringify(this.original() ?? this.draft(), null, 2));
  protected readonly renameTo = linkedSignal(() => '');
  protected readonly profileText = linkedSignal(() => {
    const p = this.store.model()?.systemProfile;
    return p ? JSON.stringify(p, null, 2) : '{ "kind": "service", "traits": [] }';
  });

  protected readonly schemaProblems = computed<SchemaError[]>(() => schemaErrors(this.spec().definition, this.draft()));

  protected readonly jsonProblems = computed(() => {
    try {
      return { parse: null as string | null, schema: schemaErrors(this.spec().definition, JSON.parse(this.jsonText())) };
    } catch (e) {
      return { parse: `not valid JSON: ${(e as Error).message}`, schema: [] as SchemaError[] };
    }
  });

  /** The patch the form describes: an add for a new record, otherwise an update of the changed fields. */
  protected readonly patch = computed<Patch | null>(() => {
    const collection = this.spec().collection;
    const draft = this.draft();
    const original = this.original();
    if (!original) return { op: 'add', collection, record: draft } as unknown as Patch;
    const set: Draft = {};
    const unset: string[] = [];
    for (const f of this.fields()) {
      if (f.key) continue;
      const before = original[f.name];
      const after = draft[f.name];
      if (after === undefined && before !== undefined) unset.push(f.name);
      else if (after !== undefined && !same(before, after)) set[f.name] = after;
    }
    if (!Object.keys(set).length && !unset.length) return null;
    const p: Draft = { op: 'update', collection, id: this.selectedKey(), set };
    if (unset.length) p['unset'] = unset;
    return p as unknown as Patch;
  });

  protected count(c: CollectionSpec): number {
    const m = this.store.model() as unknown as Record<string, unknown[]> | null;
    return m?.[c.collection]?.length ?? 0;
  }

  protected pickCollection(value: string): void {
    const c = COLLECTION_SPECS.find((x) => x.collection === value);
    if (!c) return;
    this.collection.set(c.collection);
    this.picked.set(null);
  }

  protected pickRecord(value: string): void {
    this.picked.set(value);
  }

  protected textOf(f: FieldSpec): string {
    const v = this.draft()[f.name];
    return v === undefined || v === null ? '' : String(v);
  }

  protected jsonOf(f: FieldSpec): string {
    const v = this.draft()[f.name];
    return v === undefined ? '' : JSON.stringify(v, null, 2);
  }

  protected enumValues(f: FieldSpec): readonly string[] {
    return f.control.kind === 'enum' ? f.control.values : [];
  }

  protected constValue(f: FieldSpec): unknown {
    return f.control.kind === 'const' ? f.control.value : undefined;
  }

  protected setValue(f: FieldSpec, value: unknown): void {
    this.draft.update((d) => {
      const next = { ...d };
      if (value === undefined) delete next[f.name];
      else next[f.name] = value;
      return next;
    });
  }

  protected setText(f: FieldSpec, value: string): void {
    this.setValue(f, value === '' && !f.required ? undefined : value);
  }

  protected setNumber(f: FieldSpec, value: string): void {
    this.setValue(f, value === '' ? (f.required ? null : undefined) : Number(value));
  }

  protected setEnum(f: FieldSpec, value: string): void {
    this.setValue(f, value === '' ? undefined : value);
  }

  protected setJson(f: FieldSpec, text: string): void {
    if (text.trim() === '') {
      this.fieldErrors.update((e) => ({ ...e, [f.name]: '' }));
      this.setValue(f, undefined);
      return;
    }
    try {
      const value: unknown = JSON.parse(text);
      this.setValue(f, value);
      this.fieldErrors.update((e) => ({ ...e, [f.name]: '' }));
    } catch (e) {
      this.fieldErrors.update((errs) => ({ ...errs, [f.name]: `not valid JSON: ${(e as Error).message}` }));
    }
  }

  protected applyForm(): void {
    const p = this.patch();
    if (!p) return;
    const outcome = this.store.apply(p);
    if (outcome.accepted && this.isNew()) this.picked.set(recordKey(this.spec().collection, this.draft()));
  }

  protected remove(): void {
    this.store.apply({ op: 'remove', collection: this.spec().collection, id: this.selectedKey() } as unknown as Patch);
  }

  protected rename(): void {
    const to = this.renameTo().trim();
    const outcome = this.store.apply({ op: 'rename', collection: this.spec().collection, id: this.selectedKey(), to } as unknown as Patch);
    if (outcome.accepted) this.picked.set(to);
  }

  protected reset(): void {
    const o = this.original();
    this.draft.set(o ? structuredClone(o) : {});
  }

  protected applyJson(): void {
    let record: unknown;
    try {
      record = JSON.parse(this.jsonText());
    } catch {
      return;
    }
    const collection = this.spec().collection;
    const patch = this.isNew()
      ? { op: 'add', collection, record }
      : { op: 'replace', collection, id: this.selectedKey(), record };
    const outcome = this.store.apply(patch as unknown as Patch);
    if (outcome.accepted) this.picked.set(recordKey(collection, record));
  }

  protected setProfile(): void {
    let profile: unknown;
    try {
      profile = JSON.parse(this.profileText());
    } catch {
      return;
    }
    this.store.apply({ op: 'setSystemProfile', profile } as unknown as Patch);
  }

  protected clearProfile(): void {
    this.store.apply({ op: 'clearSystemProfile' });
  }

  protected json(v: unknown): string {
    return JSON.stringify(v);
  }
}
