import type { Model, Property, Authority } from '../types.js';
import { makeConsumerResolver, allElementIds } from '../reachability.js';
import { MARKDOWN_NOTICE, toText } from './notice.js';
import { workflowSections } from './mermaid.js';
import { FINDING, FINDING_RULES } from '../codes.js';
import { DIFF_RULES } from '../diff.js';

const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;
const codes = (values: readonly string[]): string => (values.length ? values.map(code).join(', ') : '(none)');
const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const yesNo = (b: boolean): string => (b ? 'yes' : 'no');

function kindText(p: Property): string {
  const notes: string[] = [];
  if (p.enumValues) notes.push(p.enumValues.join(', '));
  const b = p.bounds;
  if (b) {
    for (const key of ['min', 'max', 'minLength', 'maxLength'] as const) {
      if (b[key] !== undefined) notes.push(`${key} ${b[key]}`);
    }
  }
  return notes.length ? `${p.kind} (${notes.join('; ')})` : p.kind;
}

function authorityText(a: Authority): string {
  return a.scope === undefined ? code(a.permission) : `${code(a.permission)} (scope ${code(a.scope)})`;
}

/**
 * Markdown reference of the model, organised by component: each component's
 * types, operations, routines and mutations; then the workflows (which have no
 * owning component), a consumers index by reverse reachability, the workflow
 * diagrams, and the rules the model is checked against.
 */
export function projectReference(model: Model): string {
  const L: string[] = [MARKDOWN_NOTICE, '# Loom model reference', ''];
  L.push(
    `Model version ${model.version}: ${model.components.length} components, ${model.types.length} types, ` +
      `${model.operations.length} operations, ${model.routines.length} routines, ${model.mutations.length} mutations, ` +
      `${model.workflows.length} workflows.`,
    '',
  );

  for (const c of model.components) {
    L.push(`## Component ${code(c.id)}`, '', cell(c.purpose), '');

    const types = model.types.filter((t) => t.owner === c.id);
    if (types.length) L.push('### Types', '');
    for (const t of types) {
      L.push(`#### Type ${code(t.id)} (version ${t.version})`, '');
      L.push(`- Table: ${t.table === undefined ? '(none)' : code(t.table)}`);
      L.push(`- Key: ${codes(t.key ?? [])}`);
      if (t.stateProperty !== undefined) L.push(`- State property: ${code(t.stateProperty)}`);
      L.push(
        '',
        '| Property | Kind | Required | Nullable | Immutable | Origin | Binds |',
        '| --- | --- | --- | --- | --- | --- | --- |',
      );
      for (const p of t.properties) {
        L.push(
          `| ${code(p.name)} | ${cell(kindText(p))} | ${yesNo(p.required)} | ${yesNo(p.nullable)} | ${yesNo(p.immutable)} | ${cell(p.origin)} | ${p.binds ? code(p.binds) : ''} |`,
        );
      }
      L.push('');
    }

    const operations = model.operations.filter((o) => o.owner === c.id);
    if (operations.length) L.push('### Operations', '');
    for (const o of operations) {
      L.push(`#### Operation ${code(o.id)} (${o.kind}, version ${o.version})`, '');
      L.push(`- Authority: ${authorityText(o.authority)}`);
      if (o.request !== undefined) L.push(`- Request: ${code(o.request)}`);
      if (o.response !== undefined) L.push(`- Response: ${code(o.response)}`);
      if (o.result !== undefined) L.push(`- Result: ${code(o.result)}`);
      const bindings = (o.bindings ?? []).map((b) => [b.transport, b.method, b.path].filter((x) => x).join(' '));
      L.push(`- Bindings: ${bindings.length ? bindings.map(code).join(', ') : '(none)'}`, '');
    }

    const routines = model.routines.filter((r) => r.owner === c.id);
    if (routines.length) L.push('### Routines', '');
    for (const r of routines) {
      L.push(`#### Routine ${code(r.id)} (${r.host}, version ${r.version})`, '');
      L.push(`- Source: ${r.source === undefined ? '(none)' : code(r.source)}`);
      L.push(`- Authority: ${authorityText(r.authority)}`);
      L.push(`- Performs mutations: ${codes(r.performsMutations)}`);
      L.push(`- Writes tables: ${codes(r.writesTables ?? [])}`);
      L.push(`- Writes columns: ${codes(r.writesColumns ?? [])}`);
      if (r.transactionScope) L.push(`- Transaction scope: ${codes(r.transactionScope)}`);
      L.push('');
      if (r.params.length) {
        L.push('| Param | Kind | Required | Nullable | Binds |', '| --- | --- | --- | --- | --- |');
        for (const p of r.params) {
          L.push(`| ${code(p.name)} | ${p.kind} | ${yesNo(p.required)} | ${yesNo(p.nullable)} | ${p.binds ? code(p.binds) : ''} |`);
        }
        L.push('');
      }
      L.push('| Result column | Kind | Nullable | Binds |', '| --- | --- | --- | --- |');
      for (const col of r.resultSet) {
        L.push(`| ${code(col.name)} | ${col.kind} | ${yesNo(col.nullable)} | ${col.binds ? code(col.binds) : ''} |`);
      }
      L.push('');
    }

    const mutations = model.mutations.filter((m) => m.owner === c.id);
    if (mutations.length) L.push('### Mutations', '');
    for (const m of mutations) {
      L.push(`#### Mutation ${code(m.id)} (${code(m.type)}: ${m.from.join(', ')} -> ${m.to})`, '');
      L.push(`- Writes: ${codes(m.writes)}`);
      L.push(`- Guard: ${cell(m.guard)}`);
      L.push(`- Effect: ${cell(m.effect)}`);
      L.push(`- Requirements: ${codes(m.requirements)}`);
      L.push(`- Scenarios: ${codes(m.scenarios)}`, '');
    }
  }

  L.push('## Workflows', '');
  if (model.workflows.length === 0) L.push('No workflows.', '');
  for (const w of model.workflows) {
    L.push(`### Workflow ${code(w.id)} (${w.status})`, '');
    L.push(`- Depends on: ${codes(w.dependsOn)}`);
    L.push(`- Imports: ${w.imports.length ? w.imports.map((i) => `${code(i.typeId)} version ${i.version}`).join(', ') : '(none)'}`);
    L.push(`- Operations: ${codes(w.operations ?? [])}`);
    L.push(`- Mutations: ${codes(w.mutations ?? [])}`);
    L.push(`- Requirements: ${codes(w.requirements)}`, '');
  }

  L.push('## Consumers index', '', 'Each element and every element that consumes it, by reverse reachability.', '');
  L.push('| Element | Consumers |', '| --- | --- |');
  const consumersOf = makeConsumerResolver(model);
  for (const id of allElementIds(model)) {
    L.push(`| ${code(id)} | ${codes(consumersOf([id]))} |`);
  }
  L.push('', ...workflowSections(model, 2), ...rulesSection());
  return toText(L);
}

/** Rule prose in a table cell; `<` and `>` are escaped so '<component>.<table>' is not read as HTML. */
const prose = (s: string): string => cell(s).replace(/[<>]/g, '\\$&');

/**
 * The rules every model is checked against, rendered from the engine's own
 * tables (FINDING_RULES in codes.ts, DIFF_RULES in diff.ts), so the list
 * cannot drift from the code that enforces it.
 */
function rulesSection(): string[] {
  const L: string[] = [
    '## Rules',
    '',
    'Every finding code `validate()` and `mutate()` report, then every rule `diff()` classifies a change by.',
    '',
    '### Finding codes',
    '',
    '| Code | Severity | Rule |',
    '| --- | --- | --- |',
  ];
  for (const findingCode of Object.values(FINDING)) {
    const r = FINDING_RULES[findingCode];
    L.push(`| ${code(findingCode)} | ${r.severity} | ${prose(r.rule)} |`);
  }
  L.push('', '### Change rules', '', '| Rule | Applies to | Kind | Change |', '| --- | --- | --- | --- |');
  for (const [id, r] of Object.entries(DIFF_RULES)) {
    L.push(`| ${code(id)} | ${r.subject} | ${r.kind} | ${prose(r.change)} |`);
  }
  L.push('');
  return L;
}
