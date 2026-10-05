import type { AffectedElement, Change, Finding, Model, Patch, RecordRef, Repair } from './generated/types.js';
import { PATCH_VARIANTS } from './generated/registry.js';
import { FINDING, FINDING_RULES, type FindingCode } from './codes.js';
import { deepClone } from './canonical.js';
import { schemaErrors } from './schema-runtime.js';
import { structuralFindings } from './load.js';
import { validate } from './validate.js';
import { diff, needsAcknowledgement } from './diff.js';
import { changeImpact } from './graph.js';
import { renameReferences } from './refs.js';
import { KIND_OF_COLLECTION, VERSIONED_KINDS, keyFieldsAt, keyOf, recordKey, recordsOf, type CollectionName } from './records.js';

export type { Patch } from './generated/types.js';

export interface MutateOptions {
  /** Elements whose breaking or unclassified change is intended. Acknowledgement is never acceptance. */
  acknowledgeBreaking?: readonly string[];
}

export interface MutateResult {
  /** The new model, or null when the batch is refused; a refusal never changes the input. */
  model: Model | null;
  findings: Finding[];
  changes: Change[];
  impact: AffectedElement[];
  repairs: Repair[];
}

const finding = (code: FindingCode, path: string, message: string, fix: string): Finding => ({
  code,
  severity: FINDING_RULES[code].severity,
  path,
  message,
  fix,
});

const OPS = [...new Set(PATCH_VARIANTS.map((v) => v.op))];

/**
 * Select the patch variant by op, collection and field, then check the patch
 * against that variant's own schema, so a misspelled member is reported at its
 * exact pointer rather than as a failure of the whole union.
 */
export function checkPatch(patch: unknown, base: string): Finding[] {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return [finding(FINDING.PATCH_INVALID, base, `${base} is not a patch object`, 'send a patch object with an op')];
  }
  const p = patch as Record<string, unknown>;
  const byOp = PATCH_VARIANTS.filter((v) => v.op === p['op']);
  if (byOp.length === 0) {
    return [finding(FINDING.PATCH_INVALID, `${base}/op`, `unknown patch op ${JSON.stringify(p['op'])}`, `use one of ${OPS.join(', ')}`)];
  }
  const byCollection = byOp.filter((v) => v.collection === null || v.collection === p['collection']);
  if (byCollection.length === 0) {
    const allowed = [...new Set(byOp.map((v) => v.collection))].join(', ');
    return [finding(FINDING.PATCH_INVALID, `${base}/collection`, `op '${String(p['op'])}' does not apply to collection ${JSON.stringify(p['collection'])}`, `use one of ${allowed}`)];
  }
  const variant = byCollection.find((v) => v.field === null || v.field === p['field']);
  if (!variant) {
    const allowed = byCollection.map((v) => v.field).join(', ');
    return [finding(FINDING.PATCH_INVALID, `${base}/field`, `op '${String(p['op'])}' on '${String(p['collection'])}' has no keyed field ${JSON.stringify(p['field'])}`, `use one of ${allowed}`)];
  }
  return schemaErrors(variant.definition, patch).map((e) =>
    finding(FINDING.PATCH_INVALID, `${base}${e.pointer}`, `${base}${e.pointer || ''} ${e.message} (${variant.definition})`, `correct the patch to match ${variant.definition}`),
  );
}

type Rec = Record<string, unknown>;

function locate(model: Model, collection: CollectionName, id: string): { list: Rec[]; index: number } {
  const list = recordsOf(model, collection) as Rec[];
  return { list, index: list.findIndex((r) => recordKey(collection, r) === id) };
}

/** Apply one structurally checked patch to `model` in place; returns findings when its target is missing. */
function applyOne(model: Model, patch: Patch, base: string): Finding[] {
  const p = patch as unknown as Rec;
  const op = p['op'] as string;
  if (op === 'setSystemProfile') {
    model.systemProfile = deepClone(p['profile'] as Model['systemProfile']);
    return [];
  }
  if (op === 'clearSystemProfile') {
    delete model.systemProfile;
    return [];
  }
  const collection = p['collection'] as CollectionName;
  if (op === 'add') {
    (recordsOf(model, collection) as Rec[]).push(deepClone(p['record'] as Rec));
    return [];
  }
  const id = String(p['id']);
  const { list, index } = locate(model, collection, id);
  if (index < 0) {
    return [finding(FINDING.PATCH_TARGET_NOT_FOUND, `${base}/id`, `${collection} has no record '${id}'`, `name an existing ${KIND_OF_COLLECTION[collection]} id`)];
  }
  const record = list[index] as Rec;
  const assign = (target: Rec, set: unknown, unset: unknown): void => {
    for (const [k, v] of Object.entries((set as Rec | undefined) ?? {})) target[k] = deepClone(v);
    for (const k of (unset as string[] | undefined) ?? []) delete target[k];
  };
  switch (op) {
    case 'replace': {
      const next = deepClone(p['record'] as Rec);
      if (recordKey(collection, next) !== id) {
        return [finding(FINDING.PATCH_INVALID, `${base}/record`, `replace of '${id}' carries a record keyed '${recordKey(collection, next)}'`, `keep the key, or use op 'rename'`)];
      }
      list[index] = next;
      return [];
    }
    case 'remove':
      list.splice(index, 1);
      return [];
    case 'update':
      assign(record, p['set'], p['unset']);
      return [];
    case 'rename': {
      const to = String(p['to']);
      record['id'] = to;
      renameReferences(model, KIND_OF_COLLECTION[collection], id, to);
      return [];
    }
    default:
      break;
  }
  const field = String(p['field']);
  const keyFields = keyFieldsAt(`${collection}[].${field}[]`) ?? ['id'];
  const items = (record[field] as Rec[] | undefined) ?? [];
  if (op === 'addItem') {
    const item = deepClone(p['item'] as Rec);
    const at = typeof p['index'] === 'number' ? Math.min(p['index'] as number, items.length) : items.length;
    items.splice(at, 0, item);
    record[field] = items;
    return [];
  }
  const key = String(p['key']);
  const at = items.findIndex((x) => keyOf(x, keyFields) === key);
  if (at < 0) {
    return [finding(FINDING.PATCH_TARGET_NOT_FOUND, `${base}/key`, `${collection} '${id}' has no ${field} item '${key}'`, `name an existing ${field} item of '${id}'`)];
  }
  switch (op) {
    case 'replaceItem': {
      const next = deepClone(p['item'] as Rec);
      if (keyOf(next, keyFields) !== key) {
        return [finding(FINDING.PATCH_INVALID, `${base}/item`, `replaceItem of '${key}' carries an item keyed '${keyOf(next, keyFields)}'`, 'keep the item key')];
      }
      items[at] = next;
      return [];
    }
    case 'updateItem':
      assign(items[at] as Rec, p['set'], p['unset']);
      return [];
    case 'removeItem':
      items.splice(at, 1);
      return [];
    case 'moveItem': {
      const [moved] = items.splice(at, 1);
      items.splice(Math.min(p['index'] as number, items.length), 0, moved as Rec);
      return [];
    }
    default:
      return [finding(FINDING.PATCH_INVALID, `${base}/op`, `unknown patch op '${op}'`, `use one of ${OPS.join(', ')}`)];
  }
}

/** Version of a versioned record, or undefined. */
function versionOf(model: Model, ref: RecordRef): number | undefined {
  if (!VERSIONED_KINDS.has(ref.kind)) return undefined;
  const collection = ref.kind === 'type' ? 'types' : ref.kind === 'operation' ? 'operations' : 'routines';
  const r = (recordsOf(model, collection) as Array<{ id: string; version: number }>).find((x) => x.id === ref.id);
  return r?.version;
}

interface BreakingElement {
  ref: RecordRef;
  collection: string;
  reasons: string[];
}

/** The elements with a breaking or unclassified change, each with the reasons of its changes. */
function breakingElements(changes: readonly Change[]): BreakingElement[] {
  const byElement = new Map<string, BreakingElement>();
  for (const c of changes) {
    if (!needsAcknowledgement(c)) continue;
    const key = `${c.elementKind}:${c.element}`;
    const kind = c.elementKind;
    const g = byElement.get(key) ?? { ref: { kind, id: c.element }, collection: kind === 'type' ? 'types' : kind === 'operation' ? 'operations' : kind === 'routine' ? 'routines' : kind, reasons: [] };
    g.reasons.push(c.reason);
    byElement.set(key, g);
  }
  return [...byElement.values()];
}

/**
 * Versioned contracts with a breaking or unclassified change whose version did
 * not rise from `before` to `after`. `mutate` asks this of a patch against the
 * model it patches and `compareBaseline` of a candidate against the accepted
 * baseline, so an edit that never passed through `mutate` meets the same rule.
 */
export function unbumpedContracts(before: Model, after: Model, changes: readonly Change[]): Array<BreakingElement & { from: number; to: number }> {
  const out: Array<BreakingElement & { from: number; to: number }> = [];
  for (const e of breakingElements(changes)) {
    const from = versionOf(before, e.ref);
    const to = versionOf(after, e.ref);
    if (from !== undefined && to !== undefined && !(to > from)) out.push({ ...e, from, to });
  }
  return out;
}

/**
 * Breaking and unclassified changes need a version bump on versioned contracts
 * and an acknowledgement on every element; an unclassified change is also
 * reported for review.
 */
export function guardFindings(before: Model, after: Model, changes: readonly Change[], acknowledged: readonly string[]): Finding[] {
  const acked = new Set(acknowledged);
  const out: Finding[] = [];
  for (const c of changes) {
    if (c.kind !== 'requiresReview') continue;
    out.push(finding(FINDING.CHANGE_REQUIRES_REVIEW, c.path, `${c.path}: ${c.reason}`, `review the change at ${c.path} and add a comparison rule for it`));
  }
  const unbumped = new Map(unbumpedContracts(before, after, changes).map((u) => [`${u.ref.kind}:${u.ref.id}`, u]));
  for (const { ref, collection, reasons } of breakingElements(changes)) {
    const u = unbumped.get(`${ref.kind}:${ref.id}`);
    if (u) {
      out.push(finding(FINDING.BREAKING_CHANGE_WITHOUT_VERSION_BUMP, `${collection}/${ref.id}/version`, `${ref.kind} '${ref.id}' has a breaking change without a version bump (${u.from} -> ${u.to}): ${reasons.join('; ')}`, `bump ${ref.kind} '${ref.id}' version above ${u.from} and list '${ref.id}' in acknowledgeBreaking`));
    }
    if (!acked.has(ref.id)) {
      out.push(finding(FINDING.BREAKING_CHANGE_UNACKNOWLEDGED, `${collection}/${ref.id}`, `${ref.kind} '${ref.id}' has an unacknowledged breaking or unclassified change: ${reasons.join('; ')}`, `list '${ref.id}' in acknowledgeBreaking to confirm the change is intended`));
    }
  }
  return out;
}

/**
 * Apply one patch or an atomic batch to a clone, then validate, compare and
 * guard. The input model is never modified. A refusal returns model null with
 * the findings that caused it; the changes are still reported when the
 * candidate is structurally valid, so a caller can see what was refused.
 */
export function mutate(model: Model, patches: Patch | readonly Patch[], options: MutateOptions = {}): MutateResult {
  const list = Array.isArray(patches) ? (patches as readonly Patch[]) : [patches as Patch];
  const empty = (findings: Finding[]): MutateResult => ({ model: null, findings, changes: [], impact: [], repairs: [] });
  for (let i=0;i<list.length;i++) {
    const patch=list[i] as Patch & {id?:string};
    if(typeof patch.id !== 'string'||!patch.id.includes(':'))continue;
    const prefix=patch.id.slice(0,patch.id.indexOf(':'));
    const imported=model.publishedContracts.find(pin=>pin.id===prefix);
    if(imported)return empty([finding('PATCH_INVALID',`patches/${i}`,`imported record '${patch.id}' is read-only; its owner is '${imported.publisher}'`,`propose the change to owner '${imported.publisher}', publish a new exact export and update the consumer pin`)]);
  }
  const inputFindings = structuralFindings(model);
  if (inputFindings.length) return empty(inputFindings);
  const patchFindings = list.flatMap((p, i) => checkPatch(p, `patches/${i}`));
  if (patchFindings.length) return empty(patchFindings);

  const after = deepClone(model);
  const applyFindings = list.flatMap((p, i) => applyOne(after, p, `patches/${i}`));
  if (applyFindings.length) return empty(applyFindings);

  const structural = structuralFindings(after);
  if (structural.length) return empty(structural);
  const changes = diff(model, after);
  const findings = [...validate(after), ...guardFindings(model, after, changes, options.acknowledgeBreaking ?? [])];
  const changed: RecordRef[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    const k = `${c.elementKind}:${c.element}`;
    if (!seen.has(k)) {
      seen.add(k);
      changed.push({ kind: c.elementKind, id: c.element });
    }
  }
  const impact = changeImpact(model, after, changed);
  const errors = findings.filter((f) => f.severity === 'error');
  const repairs = errors.flatMap((f) => f.repairs ?? []);
  return { model: errors.length ? null : after, findings, changes, impact, repairs };
}
