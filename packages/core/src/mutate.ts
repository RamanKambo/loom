import type {
  Model,
  Finding,
  Change,
  ElementKind,
  Component,
  TypeDef,
  Property,
  Operation,
  Routine,
  Mutation,
  Workflow,
  Edge,
  Requirement,
  Scenario,
  Authority,
} from './types.js';
import { FINDING } from './codes.js';
import { deepClone } from './canonical.js';
import { validate } from './validate.js';
import { diff } from './diff.js';
import { makeConsumerResolver } from './reachability.js';
import { structuralFindings } from './load.js';

const COLLECTIONS = [
  'components',
  'types',
  'operations',
  'routines',
  'mutations',
  'workflows',
  'requirements',
  'scenarios',
] as const;

/** The id-keyed record collections a removeRecord patch may target. */
export type CollectionName = (typeof COLLECTIONS)[number];

/** A `set` payload: each listed field optional, and `null` removes an optional field. */
export type Settable<T> = { [K in keyof T]?: T[K] | null };

/**
 * A single structured edit. In the `change*` ops, `set` may name only the fields
 * listed for that op; a `null` value removes an optional field.
 */
export type Patch =
  | { op: 'addComponent'; component: Component }
  | { op: 'addType'; type: TypeDef }
  | { op: 'changeType'; typeId: string; set: Settable<Pick<TypeDef, 'version' | 'table' | 'key' | 'stateProperty'>> }
  | { op: 'addProperty'; typeId: string; property: Property }
  | { op: 'removeProperty'; typeId: string; propertyName: string }
  | { op: 'changeProperty'; typeId: string; propertyName: string; set: Settable<Property> }
  | { op: 'addEnumValue'; typeId: string; propertyName: string; value: string }
  | { op: 'removeEnumValue'; typeId: string; propertyName: string; value: string }
  | { op: 'addOperation'; operation: Operation }
  | {
      op: 'changeOperation';
      operationId: string;
      set: Settable<Pick<Operation, 'version' | 'kind' | 'bindings' | 'request' | 'response' | 'result'>>;
    }
  | { op: 'addRoutine'; routine: Routine }
  | {
      op: 'changeRoutine';
      routineId: string;
      set: Settable<Pick<Routine, 'version' | 'host' | 'source' | 'params' | 'resultSet' | 'writesTables' | 'writesColumns'>>;
    }
  | { op: 'addMutation'; mutation: Mutation }
  | { op: 'changeMutation'; mutationId: string; set: Settable<Omit<Mutation, 'id'>> }
  | { op: 'setAuthority'; target: 'operation' | 'routine'; id: string; authority: Authority }
  | { op: 'setVersion'; target: 'type' | 'operation' | 'routine'; id: string; version: number }
  | { op: 'addWorkflow'; workflow: Workflow }
  | { op: 'changeWorkflowImport'; workflowId: string; typeId: string; version: number }
  | { op: 'addEdge'; edge: Edge }
  | { op: 'addRequirement'; requirement: Requirement }
  | { op: 'addScenario'; scenario: Scenario }
  | { op: 'removeRecord'; collection: CollectionName; id: string };

export interface MutateOptions {
  /**
   * Ids of elements whose breaking change is intended. Every element with a
   * breaking change must be listed, so a contract is never broken silently.
   */
  acknowledgeBreaking?: string[];
}

export interface MutateResult {
  /** The new model, or null if the batch was REFUSED (any error finding). */
  model: Model | null;
  findings: Finding[];
  /** Consumers of the touched elements (reverse-reachability) — the blast radius. */
  impact: string[];
  /** Every change the batch makes, classified breaking or compatible. */
  changes: Change[];
}

class PatchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
  }
}

const notFound = (message: string): PatchError => new PatchError(FINDING.PATCH_TARGET_NOT_FOUND, message);
const invalid = (message: string): PatchError => new PatchError(FINDING.PATCH_INVALID, message);

const PROPERTY_FIELDS = ['name', 'kind', 'required', 'nullable', 'immutable', 'origin', 'enumValues', 'bounds'];
const MUTATION_FIELDS = ['type', 'owner', 'from', 'to', 'writes', 'guard', 'effect', 'requirements', 'scenarios'];
const TYPE_FIELDS = ['version', 'table', 'key', 'stateProperty'];
const OPERATION_FIELDS = ['version', 'kind', 'bindings', 'request', 'response', 'result'];
const ROUTINE_FIELDS = ['version', 'host', 'source', 'params', 'resultSet', 'writesTables', 'writesColumns'];

function assignAllowed(target: object, set: unknown, allowed: readonly string[], op: string): void {
  if (set === null || typeof set !== 'object' || Array.isArray(set)) {
    throw invalid(`${op}: 'set' must be an object`);
  }
  const t = target as Record<string, unknown>;
  const s = set as Record<string, unknown>;
  for (const key of Object.keys(s).sort()) {
    if (!allowed.includes(key)) {
      throw invalid(`${op} may set only ${allowed.join(', ')}; got '${key}'`);
    }
    const v = s[key];
    if (v === null || v === undefined) delete t[key];
    else t[key] = v;
  }
}

function findType(model: Model, id: string): TypeDef {
  const t = model.types.find((x) => x.id === id);
  if (!t) throw notFound(`type '${id}' does not exist`);
  return t;
}

function findProperty(model: Model, typeId: string, propertyName: string): Property {
  const p = findType(model, typeId).properties.find((x) => x.name === propertyName);
  if (!p) throw notFound(`property '${propertyName}' does not exist on type '${typeId}'`);
  return p;
}

function findOperation(model: Model, id: string): Operation {
  const o = model.operations.find((x) => x.id === id);
  if (!o) throw notFound(`operation '${id}' does not exist`);
  return o;
}

function findRoutine(model: Model, id: string): Routine {
  const r = model.routines.find((x) => x.id === id);
  if (!r) throw notFound(`routine '${id}' does not exist`);
  return r;
}

function findVersioned(model: Model, target: 'type' | 'operation' | 'routine', id: string): { version: number } {
  if (target === 'type') return findType(model, id);
  if (target === 'operation') return findOperation(model, id);
  if (target === 'routine') return findRoutine(model, id);
  throw invalid(`unknown version target '${String(target)}'`);
}

/** Apply one patch to `model` in place; return the id of the element it touched. */
function applyPatch(model: Model, patch: Patch): string {
  if (patch === null || typeof patch !== 'object') throw invalid('patch must be an object');
  switch (patch.op) {
    case 'addComponent':
      model.components.push(patch.component);
      return patch.component.id;
    case 'addType':
      model.types.push(patch.type);
      return patch.type.id;
    case 'changeType':
      assignAllowed(findType(model, patch.typeId), patch.set, TYPE_FIELDS, 'changeType');
      return patch.typeId;
    case 'addProperty':
      findType(model, patch.typeId).properties.push(patch.property);
      return patch.typeId;
    case 'removeProperty': {
      const t = findType(model, patch.typeId);
      const i = t.properties.findIndex((p) => p.name === patch.propertyName);
      if (i < 0) throw notFound(`property '${patch.propertyName}' does not exist on type '${patch.typeId}'`);
      t.properties.splice(i, 1);
      return t.id;
    }
    case 'changeProperty':
      assignAllowed(
        findProperty(model, patch.typeId, patch.propertyName),
        patch.set,
        PROPERTY_FIELDS,
        'changeProperty',
      );
      return patch.typeId;
    case 'addEnumValue': {
      const p = findProperty(model, patch.typeId, patch.propertyName);
      p.enumValues = [...(p.enumValues ?? []), patch.value];
      return patch.typeId;
    }
    case 'removeEnumValue': {
      const p = findProperty(model, patch.typeId, patch.propertyName);
      p.enumValues = (p.enumValues ?? []).filter((v) => v !== patch.value);
      return patch.typeId;
    }
    case 'addOperation':
      model.operations.push(patch.operation);
      return patch.operation.id;
    case 'changeOperation':
      assignAllowed(findOperation(model, patch.operationId), patch.set, OPERATION_FIELDS, 'changeOperation');
      return patch.operationId;
    case 'addRoutine':
      model.routines.push(patch.routine);
      return patch.routine.id;
    case 'changeRoutine':
      assignAllowed(findRoutine(model, patch.routineId), patch.set, ROUTINE_FIELDS, 'changeRoutine');
      return patch.routineId;
    case 'addMutation':
      model.mutations.push(patch.mutation);
      return patch.mutation.id;
    case 'changeMutation': {
      const m = model.mutations.find((x) => x.id === patch.mutationId);
      if (!m) throw notFound(`mutation '${patch.mutationId}' does not exist`);
      assignAllowed(m, patch.set, MUTATION_FIELDS, 'changeMutation');
      return m.id;
    }
    case 'setAuthority': {
      const el = patch.target === 'operation' ? findOperation(model, patch.id) : findRoutine(model, patch.id);
      el.authority = patch.authority;
      return el.id;
    }
    case 'setVersion':
      findVersioned(model, patch.target, patch.id).version = patch.version;
      return patch.id;
    case 'addWorkflow':
      model.workflows.push(patch.workflow);
      return patch.workflow.id;
    case 'changeWorkflowImport': {
      const w = model.workflows.find((x) => x.id === patch.workflowId);
      if (!w) throw notFound(`workflow '${patch.workflowId}' does not exist`);
      const im = w.imports.find((x) => x.typeId === patch.typeId);
      if (!im) throw notFound(`workflow '${patch.workflowId}' does not import type '${patch.typeId}'`);
      im.version = patch.version;
      return w.id;
    }
    case 'addEdge':
      model.edges.push(patch.edge);
      return patch.edge.to;
    case 'addRequirement':
      model.requirements.push(patch.requirement);
      return patch.requirement.id;
    case 'addScenario':
      model.scenarios.push(patch.scenario);
      return patch.scenario.id;
    case 'removeRecord': {
      if (!COLLECTIONS.includes(patch.collection)) {
        throw invalid(`removeRecord: collection must be one of ${COLLECTIONS.join(', ')}`);
      }
      const records = model[patch.collection] as Array<{ id: string }>;
      const i = records.findIndex((x) => x.id === patch.id);
      if (i < 0) throw notFound(`${patch.collection} has no record '${patch.id}'`);
      records.splice(i, 1);
      return patch.id;
    }
    default: {
      const unknownOp: never = patch;
      throw invalid(`unknown patch op '${String((unknownOp as { op?: unknown }).op)}'`);
    }
  }
}

const COLLECTION_OF: Record<ElementKind, string> = {
  type: 'types',
  operation: 'operations',
  routine: 'routines',
  mutation: 'mutations',
  workflow: 'workflows',
};

function versionOf(model: Model, kind: ElementKind, id: string): number | undefined {
  let list: ReadonlyArray<{ id: string; version: number }> | null = null;
  if (kind === 'type') list = model.types;
  else if (kind === 'operation') list = model.operations;
  else if (kind === 'routine') list = model.routines;
  return list?.find((x) => x.id === id)?.version;
}

/**
 * The breaking-change gate. For each element with a breaking change: a versioned
 * contract (type, operation, routine) that still exists must carry a higher
 * version, and every such element must be named in acknowledgeBreaking.
 */
function breakingGuards(before: Model, after: Model, changes: Change[], acknowledged: string[]): Finding[] {
  const acked = new Set(acknowledged);
  const byElement = new Map<string, { kind: ElementKind; reasons: string[]; consumers: Set<string> }>();
  for (const c of changes) {
    if (c.kind !== 'breaking') continue;
    let g = byElement.get(c.element);
    if (!g) {
      g = { kind: c.elementKind, reasons: [], consumers: new Set() };
      byElement.set(c.element, g);
    }
    g.reasons.push(c.reason);
    for (const x of c.consumers) g.consumers.add(x);
  }

  const out: Finding[] = [];
  for (const [id, g] of byElement) {
    const consumers = [...g.consumers].sort();
    const reasons = g.reasons.join('; ');
    const collection = COLLECTION_OF[g.kind];
    const bv = versionOf(before, g.kind, id);
    const av = versionOf(after, g.kind, id);
    if (bv !== undefined && av !== undefined && !(av > bv)) {
      out.push({
        code: FINDING.BREAKING_CHANGE_WITHOUT_VERSION_BUMP,
        severity: 'error',
        path: `${collection}/${id}/version`,
        message: `${g.kind} '${id}' has a breaking change without a version bump (${bv} -> ${av}): ${reasons}`,
        impact: consumers,
        fix: `bump ${g.kind} '${id}' version above ${bv} and list '${id}' in acknowledgeBreaking`,
      });
    }
    if (!acked.has(id)) {
      out.push({
        code: FINDING.BREAKING_CHANGE_UNACKNOWLEDGED,
        severity: 'error',
        path: `${collection}/${id}`,
        message: `${g.kind} '${id}' has an unacknowledged breaking change: ${reasons}`,
        impact: consumers,
        fix: `list '${id}' in acknowledgeBreaking to confirm the breaking change is intended`,
      });
    }
  }
  return out;
}

function computeImpact(before: Model, after: Model | null, touched: string[]): string[] {
  const resolvers = [makeConsumerResolver(before)];
  if (after) resolvers.push(makeConsumerResolver(after));
  const out = new Set<string>();
  for (const t of touched) {
    for (const resolve of resolvers) for (const c of resolve([t])) out.add(c);
  }
  return [...out].sort();
}

function refusal(finding: Finding): MutateResult {
  return { model: null, findings: [finding], impact: [], changes: [] };
}

/**
 * Apply one patch or a batch atomically, then gate the result. The input model
 * is never modified; all patches edit one clone, so a correct breaking change
 * (bump the version, change the contract, fix every consumer) can land in one
 * step even though each intermediate state is invalid. The batch is REFUSED
 * (model: null) if any patch misses its target, if the result has any error
 * finding, or if a breaking change lacks a version bump or an acknowledgment.
 */
export function mutate(
  model: Model,
  patchOrPatches: Patch | Patch[],
  options: MutateOptions = {},
): MutateResult {
  const inputStructural = structuralFindings(model);
  if (inputStructural.length > 0) {
    return { model: null, findings: inputStructural, impact: [], changes: [] };
  }

  const list = Array.isArray(patchOrPatches) ? patchOrPatches : [patchOrPatches];
  if (list.length === 0) {
    return refusal({
      code: FINDING.PATCH_INVALID,
      severity: 'error',
      path: 'patches',
      message: 'the batch contains no patch',
      impact: [],
      fix: 'submit at least one patch',
    });
  }

  const patches = deepClone(list);
  const next = deepClone(model);
  const touched: string[] = [];
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i] as Patch;
    try {
      touched.push(applyPatch(next, patch));
    } catch (e) {
      const code = e instanceof PatchError ? e.code : FINDING.PATCH_INVALID;
      const reason = e instanceof Error ? e.message : String(e);
      const op = patch !== null && typeof patch === 'object' ? String((patch as { op?: unknown }).op) : '?';
      return refusal({
        code,
        severity: 'error',
        path: `patches[${i}]`,
        message: `patch ${i} (${op}): ${reason}; the whole batch was refused`,
        impact: [],
        fix:
          code === FINDING.PATCH_TARGET_NOT_FOUND
            ? `name an existing target in patch ${i} and resubmit the whole batch`
            : `correct patch ${i} and resubmit the whole batch`,
      });
    }
  }

  const findings = validate(next);
  const broken = findings.some((f) => f.code === FINDING.STRUCTURAL_INVALID);
  const changes = broken ? [] : diff(model, next);
  const guards = broken ? [] : breakingGuards(model, next, changes, options.acknowledgeBreaking ?? []);
  // Each finding keeps its own reverse-reachable impact; the batch's blast
  // radius is reported once, as `impact`, rather than copied onto findings.
  const impact = computeImpact(model, broken ? null : next, touched);
  const all = [...findings, ...guards];
  const refused = all.some((f) => f.severity === 'error');
  return { model: refused ? null : next, findings: all, impact, changes };
}
