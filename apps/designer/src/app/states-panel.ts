import { Component, computed, inject } from '@angular/core';
import type { EvidenceObligation, Reason, TaskSpec } from '@loom/core';
import { LoomStore, TRUST_LIMIT } from './loom-store';
import { enumOf } from './schema-fields';

/** The four independent result states, each with its reasons, and the exact revisions they were evaluated for. */
@Component({
  selector: 'app-states-panel',
  template: `
    @if (store.states(); as s) {
      @let e = store.evaluated();
      <section class="card" data-testid="evaluated-revisions">
        <h3>Evaluated revisions</h3>
        <ul class="plain">
          <li>Model <code>{{ e.model }}</code></li>
          <li>
            Accepted baseline:
            @if (e.baseline; as b) { <code>{{ b.id }}</code> (<code>{{ b.hash }}</code>), untrusted } @else { none selected }
          </li>
          <li>Policy: @if (e.policy; as p) { <code>{{ p.id }}</code> revision {{ p.revision }}, unverified } @else { none; the strictest gates apply }</li>
          <li>Acceptance records: {{ e.acceptances }} · evidence records: {{ e.evidence }} · as of {{ e.asOf }}</li>
        </ul>
        <p class="muted">{{ trustLimit }}</p>
      </section>

      <div class="states">
        <section class="card state" data-testid="state-validation" [attr.data-state]="s.validation.state">
          <h3>Validation: <span class="badge">{{ s.validation.state }}</span></h3>
          <p class="muted">{{ store.errorCount() }} error(s), {{ store.warningCount() }} warning(s); see Validate.</p>
        </section>

        <section class="card state" data-testid="state-readiness" [attr.data-state]="s.readiness.state">
          <h3>Readiness: <span class="badge">{{ s.readiness.state }}</span></h3>
          <div class="row">
            <label>
              Task class
              <select name="taskClass" #cls (change)="setTask({ class: $any(cls.value) })">
                @for (c of taskClasses; track c) {
                  <option [value]="c" [selected]="c === store.task().class">{{ c }}</option>
                }
              </select>
            </label>
            <label>
              Mode
              <select name="taskMode" #mode (change)="setTask({ mode: $any(mode.value) })">
                <option value="component" [selected]="store.task().mode === 'component'">component</option>
                <option value="slice" [selected]="store.task().mode === 'slice'">slice</option>
              </select>
            </label>
            <label>
              Component
              <select name="taskComponent" #comp (change)="setComponent(comp.value)">
                <option value="" [selected]="!store.task().components?.length">(all)</option>
                @for (c of components(); track c) {
                  <option [value]="c" [selected]="store.task().components?.[0] === c">{{ c }}</option>
                }
              </select>
            </label>
          </div>
          <ul class="reasons">
            @for (r of s.readiness.reasons; track $index) {
              <li><code>{{ r.code }}</code> {{ r.message }} {{ refs(r) }}</li>
            }
          </ul>
          @if (store.readinessData(); as d) {
            @if (d.missing.length) {
              <h4>Unmet prerequisites</h4>
              <table class="grid" data-testid="prerequisites">
                <thead><tr><th>Record</th><th>Needs</th><th>Required</th><th>Actual</th><th>Code</th><th>Why</th></tr></thead>
                <tbody>
                  @for (p of d.missing; track $index) {
                    <tr>
                      <td><code>{{ p.ref.kind }} {{ p.ref.id }}</code></td>
                      <td>{{ p.requirement }}</td>
                      <td>{{ p.maturityRequired ?? '' }}</td>
                      <td>{{ p.maturityActual ?? '' }}</td>
                      <td><code>{{ p.code }}</code></td>
                      <td>{{ p.message }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
            @if (d.substitutes.length) {
              <h4>Permitted substitutes</h4>
              <ul>
                @for (x of d.substitutes; track $index) {
                  <li>{{ x.kind }} for <code>{{ x.dependency.kind }} {{ x.dependency.id }}</code>: permits {{ x.permits.join(', ') }}; {{ x.limits }}</li>
                }
              </ul>
            }
            <p>Ready task classes: {{ d.allowedNext.join(', ') || 'none' }}</p>
            <p class="muted">Work package <code>{{ d.workPackage.id }}</code>: {{ d.workPackage.inputs.length }} input record(s), {{ d.workPackage.exitEvidence.length }} exit obligation(s).</p>
          }
        </section>

        <section class="card state" data-testid="state-acceptance" [attr.data-state]="s.acceptance.state">
          <h3>Acceptance: <span class="badge">{{ s.acceptance.state }}</span></h3>
          <ul class="reasons">
            @for (r of s.acceptance.reasons; track $index) {
              <li><code>{{ r.code }}</code> {{ r.message }}</li>
            }
          </ul>
        </section>

        <section class="card state" data-testid="state-qualification" [attr.data-state]="s.qualification.state">
          <h3>Qualification: <span class="badge">{{ s.qualification.state }}</span></h3>
          <ul class="reasons">
            @for (r of s.qualification.reasons; track $index) {
              <li><code>{{ r.code }}</code> {{ r.message }}</li>
            }
          </ul>
          @if (obligations().length) {
            <h4>Evidence obligations</h4>
            <table class="grid" data-testid="obligations">
              <thead><tr><th>Claim</th><th>Kinds</th><th>Required</th><th>Status</th></tr></thead>
              <tbody>
                @for (o of obligations(); track o.id) {
                  <tr [attr.data-status]="o.status">
                    <td><code>{{ o.claim.kind }} {{ o.claim.ref }}</code></td>
                    <td>{{ o.kinds.join(', ') }}</td>
                    <td>{{ o.required ? 'yes' : 'no' }}</td>
                    <td>{{ o.status }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>
      </div>
    } @else {
      <p class="empty">Load a model first.</p>
    }
  `,
})
export class StatesPanel {
  protected readonly store = inject(LoomStore);
  protected readonly taskClasses = enumOf('TaskClass');
  protected readonly trustLimit = TRUST_LIMIT;

  protected readonly components = computed(() => this.store.model()?.components.map((c) => c.id) ?? []);
  protected readonly obligations = computed<EvidenceObligation[]>(() => {
    const data = this.store.evidenceEvaluation()?.data as { obligations?: EvidenceObligation[] } | undefined;
    return data?.obligations ?? [];
  });

  protected setTask(change: Partial<TaskSpec>): void {
    this.store.task.update((t) => ({ ...t, ...change }));
  }

  protected setComponent(id: string): void {
    this.store.task.update((t) => {
      const next: TaskSpec = { class: t.class, mode: t.mode };
      if (id) next.components = [id];
      return next;
    });
  }

  protected refs(r: Reason): string {
    return r.refs.length ? `(${r.refs.map((x) => `${x.kind} ${x.id}`).join(', ')})` : '';
  }
}
