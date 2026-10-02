import type { Authority, Binding, ItemShape, Model, Operation, Property, RecordKind, SqlType } from '../generated/types.js';
import { COLLECTIONS } from '../generated/registry.js';
import { FINDING_RULES } from '../codes.js';
import { DIFF_RULES, type DiffRule } from '../field-policy.js';
import { dependencyGraph } from '../graph.js';
import { recordKey, recordsOf, type CollectionName } from '../records.js';
import { sqlTypeText } from '../sql-types.js';
import { MARKDOWN_NOTICE, toText } from './notice.js';
import { workflowSections } from './mermaid.js';
import { predicateText } from './context.js';

const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;
const codes = (values: readonly string[]): string => (values.length ? values.map(code).join(', ') : '(none)');
const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const yesNo = (b: boolean): string => (b ? 'yes' : 'no');
/** Rule prose in a table cell; `<` and `>` are escaped so '<typeId>.<name>' is not read as HTML. */
const prose = (s: string): string => cell(s).replace(/[<>]/g, '\\$&');

function shapeText(p: ItemShape | Property): string {
  const notes: string[] = [];
  if (p.kind === 'decimal' && p.decimal) notes.push(`precision ${p.decimal.precision}, scale ${p.decimal.scale}`);
  if (p.enumValues) notes.push(p.enumValues.join(', '));
  if (p.ref) notes.push(`ref ${p.ref}`);
  if (p.variants) notes.push(`one of ${p.variants.join(', ')} by ${p.discriminator ?? '?'}`);
  if (p.items) notes.push(`items ${shapeText(p.items)}`);
  const b = p.bounds;
  if (b) for (const key of ['min', 'max', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'] as const) if (b[key] !== undefined) notes.push(`${key} ${String(b[key])}`);
  return notes.length ? `${p.kind} (${notes.join('; ')})` : p.kind;
}

const authorityText = (a: Authority): string =>
  `${code(a.permission)}${a.scope !== undefined ? ` (scope ${code(a.scope)})` : ''}${a.scheme !== undefined ? ` via ${code(a.scheme)}` : ''}`;

function bindingText(b: Binding): string {
  if (b.transport !== 'http') return code(`${b.transport}${b.channel ? ` ${b.channel}` : ''}`);
  const params = (b.parameters ?? []).map((p) => `${p.in} ${p.name}${p.required ? '' : '?'}`);
  const responses = (b.responses ?? []).map((r) => `${r.status} ${r.kind}`);
  return `${code(`${b.method ?? '?'} ${b.path ?? '?'}`)}${params.length ? ` params ${params.join(', ')}` : ''}${responses.length ? `; responses ${responses.join(', ')}` : ''}`;
}

function operationLines(o: Operation): string[] {
  const L = [`#### Operation ${code(o.id)} (${o.kind}, version ${o.version})`, ''];
  if (o.description) L.push(cell(o.description), '');
  L.push(`- Authority: ${authorityText(o.authority)}`);
  if (o.request !== undefined) L.push(`- Request: ${code(o.request)}`);
  if (o.response !== undefined) L.push(`- Response: ${code(o.response)}`);
  if (o.result !== undefined) L.push(`- Result: ${code(o.result)}`);
  L.push(`- Bindings: ${(o.bindings ?? []).length ? (o.bindings ?? []).map(bindingText).join('; ') : '(none)'}`);
  if (o.errors?.length) L.push(`- Errors: ${o.errors.map((e) => `${code(e.code)}${e.status ? ` ${e.status}` : ''}${e.retryable ? ' retryable' : ''}`).join(', ')}`);
  if (o.invokes?.length) L.push(`- Invokes: ${o.invokes.map((i) => `${i.kind} ${code(i.id)}`).join(', ')}`);
  if (o.enforcement) L.push(`- Enforcement: authorization ${code(o.enforcement.authorization)}, validation ${code(o.enforcement.validation)}${o.enforcement.persistence ? `, persistence ${code(o.enforcement.persistence)}` : ''}`);
  if (o.idempotency) L.push(`- Idempotency: ${o.idempotency.kind}${o.idempotency.key ? ` (${o.idempotency.key.in} ${code(o.idempotency.key.name)})` : ''}; repeated request: ${cell(o.idempotency.repeatedRequest)}`);
  if (o.concurrency) L.push(`- Concurrency: ${o.concurrency.control}; on conflict: ${cell(o.concurrency.onConflict)}`);
  if (o.transaction) L.push(`- Transaction: ${o.transaction.boundary}${o.transaction.routine ? ` (${code(o.transaction.routine)})` : ''}`);
  if (o.async) {
    const a = o.async;
    const parts = [
      a.accepted ? `accepted ${a.accepted.status}` : null,
      a.completion ? `completion ${code(a.completion.result)} by ${a.completion.via}${a.completion.statusOperation ? ` via ${code(a.completion.statusOperation)}` : ''}` : null,
      a.jobIdentity ? `job ${code(a.jobIdentity)}` : null,
      a.timeout ? `timeout ${a.timeout.after}` : null,
      a.deduplication ? `deduplication ${a.deduplication.window} by ${code(a.deduplication.key)}` : null,
      a.retry ? `retries by ${a.retry.owner}` : null,
    ].filter((x): x is string => x !== null);
    L.push(`- Asynchronous: ${parts.join('; ')}`);
  }
  for (const p of o.preconditions ?? []) L.push(`- Precondition: ${cell(predicateText(p))}`);
  for (const p of o.postconditions ?? []) L.push(`- Postcondition: ${cell(predicateText(p))}`);
  L.push('');
  return L;
}

const sqlText = (t: SqlType): string => sqlTypeText(t);

/**
 * Markdown reference of the model, organised by component: each component's
 * types, storage, operations, routines and mutations; then workflows,
 * requirements, a consumers index by reverse reachability, the workflow
 * diagrams, and the rules the model is checked against.
 */
export function projectReference(model: Model): string {
  const L: string[] = [MARKDOWN_NOTICE, '# Loom model reference', ''];
  L.push(`Model format version ${model.version}.`, '');
  if (model.systemProfile) L.push(`System: ${model.systemProfile.kind}; traits ${codes(model.systemProfile.traits)}.`, '');

  for (const c of model.components) {
    L.push(`## Component ${code(c.id)}`, '', cell(c.purpose), '');
    if (c.responsibilities.length) L.push(...c.responsibilities.map((r) => `- ${cell(r)}`), '');
    if (c.implementations?.length) L.push(`Implementations: ${c.implementations.map((i) => `${i.language} ${code(i.module)}`).join(', ')}`, '');

    const types = model.types.filter((t) => t.owner === c.id);
    if (types.length) L.push('### Types', '');
    for (const t of types) {
      L.push(`#### Type ${code(t.id)} (${t.representation}, version ${t.version})`, '');
      if (t.description) L.push(cell(t.description), '');
      L.push(`- Key: ${codes(t.key ?? [])}`);
      if (t.stateProperty !== undefined) L.push(`- State property: ${code(t.stateProperty)}`);
      for (const inv of t.invariants ?? []) L.push(`- Invariant: ${cell(predicateText(inv))}`);
      L.push('', '| Property | Kind | Required | Nullable | Immutable | Origin | Binds |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const p of t.properties) {
        L.push(`| ${code(p.name)} | ${cell(shapeText(p))} | ${yesNo(p.required)} | ${yesNo(p.nullable)} | ${yesNo(p.immutable)} | ${p.origin} | ${p.binds ? code(p.binds) : ''} |`);
      }
      L.push('');
    }

    const storage = model.storage.filter((s) => s.owner === c.id);
    if (storage.length) L.push('### Storage', '');
    for (const s of storage) {
      L.push(`#### Storage ${code(s.id)} (${code(`${s.schema}.${s.table}`)}, ${s.platform}, type ${code(s.type)})`, '');
      L.push(`- Primary key: ${codes(s.primaryKey)}`);
      for (const fk of s.foreignKeys ?? []) L.push(`- Foreign key ${code(fk.name)}: ${codes(fk.columns)} references ${code(fk.references)} ${codes(fk.referencedColumns)}`);
      for (const k of s.checks ?? []) L.push(`- Check ${code(k.name)}: ${cell(predicateText(k.predicate))}`);
      L.push('', '| Column | SQL type | Nullable | Property |', '| --- | --- | --- | --- |');
      for (const col of s.columns) L.push(`| ${code(col.name)} | ${sqlText(col.sqlType)} | ${yesNo(col.nullable)} | ${col.property ? code(col.property) : ''} |`);
      L.push('');
    }

    const operations = model.operations.filter((o) => o.owner === c.id);
    if (operations.length) L.push('### Operations', '');
    for (const o of operations) L.push(...operationLines(o));

    const routines = model.routines.filter((r) => r.owner === c.id);
    if (routines.length) L.push('### Routines', '');
    for (const r of routines) {
      L.push(`#### Routine ${code(r.id)} (${r.host}, version ${r.version}, ${r.parameterPassing} parameters)`, '');
      L.push(`- Source: ${r.source === undefined ? '(none)' : code(r.source)}`);
      L.push(`- Authority: ${authorityText(r.authority)}`);
      L.push(`- Performs mutations: ${codes(r.performsMutations)}`);
      L.push(`- Writes: ${(r.writes ?? []).length ? (r.writes ?? []).map((w) => `${code(w.storage)} (${w.columns.join(', ')})`).join(', ') : '(none)'}`);
      if (r.transactionScope) L.push(`- Transaction scope: ${codes(r.transactionScope)}`);
      L.push('');
      if (r.params.length) {
        L.push('| Param | Kind | Required | Nullable | Binds |', '| --- | --- | --- | --- | --- |');
        for (const p of r.params) L.push(`| ${code(p.name)} | ${cell(shapeText(p as unknown as Property))} | ${yesNo(p.required)} | ${yesNo(p.nullable)} | ${p.binds ? code(p.binds) : ''} |`);
        L.push('');
      }
      L.push('| Result column | Kind | Nullable | Binds |', '| --- | --- | --- | --- |');
      for (const col of r.resultSet) L.push(`| ${code(col.name)} | ${cell(shapeText(col as unknown as Property))} | ${yesNo(col.nullable)} | ${col.binds ? code(col.binds) : ''} |`);
      L.push('');
    }

    const mutations = model.mutations.filter((m) => m.owner === c.id);
    if (mutations.length) L.push('### Mutations', '');
    for (const m of mutations) {
      L.push(`#### Mutation ${code(m.id)} (${code(m.type)}: ${m.from.join(', ')} -> ${m.to})`, '');
      L.push(`- Writes: ${codes(m.writes)}`);
      L.push(`- Guard: ${cell(predicateText(m.guard))}${m.guard.form === 'prose' ? ' (prose claim)' : ''}`);
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

  L.push('## Requirements', '');
  if (model.requirements.length === 0) L.push('No requirements.', '');
  else {
    L.push('| Requirement | Status | Priority | Outcome | Criteria |', '| --- | --- | --- | --- | --- |');
    for (const r of model.requirements) L.push(`| ${code(r.id)} | ${r.status} | ${r.priority} | ${cell(r.outcome)} | ${codes(r.criteria.map((c) => c.id))} |`);
    L.push('');
  }

  L.push('## Consumers index', '', 'Each record and every record that depends on it, by reverse reachability.', '');
  L.push('| Record | Consumers |', '| --- | --- |');
  const graph = dependencyGraph(model);
  for (const c of COLLECTIONS) {
    if (c.kind === 'edge') continue;
    for (const r of recordsOf(model, c.collection as CollectionName)) {
      const id = recordKey(c.collection as CollectionName, r);
      const consumers = graph.affected([{ kind: c.kind as RecordKind, id }]).map((a) => a.ref.id);
      L.push(`| ${c.kind} ${code(id)} | ${codes([...new Set(consumers)].sort())} |`);
    }
  }
  L.push('', ...workflowSections(model, 2), ...rulesSection());
  return toText(L);
}

/**
 * The rules every model is checked against, rendered from the engine's own
 * tables, so the list cannot drift from the code that enforces it.
 */
function rulesSection(): string[] {
  const L: string[] = ['## Rules', '', 'Every finding code validation, mutation and the adapters report, then every rule a change is classified by.', '', '### Finding codes', '', '| Code | Severity | Rule |', '| --- | --- | --- |'];
  for (const [findingCode, r] of Object.entries(FINDING_RULES)) L.push(`| ${code(findingCode)} | ${r.severity} | ${prose(r.rule)} |`);
  L.push('', '### Change rules', '', '| Rule | Applies to | Kind | Dimension | Change |', '| --- | --- | --- | --- | --- |');
  for (const [id, r] of Object.entries(DIFF_RULES) as Array<[string, DiffRule]>) L.push(`| ${code(id)} | ${r.subject} | ${r.kind} | ${r.dimension} | ${prose(r.change)} |`);
  L.push('');
  return L;
}
