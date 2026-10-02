import type {
  Model,
  Change,
  ChangeKind,
  ElementKind,
  TypeDef,
  Property,
  Bounds,
  Routine,
  Operation,
  Binding,
  Authority,
} from './types.js';
import { makeConsumerResolver } from './reachability.js';
import { qualifyTable } from './refs.js';

export interface DiffRule {
  /** Breaking changes need a version bump and an acknowledgment in mutate(). */
  kind: ChangeKind;
  /** What the rule applies to. */
  subject: string;
  /** The change, in one line, as the `reference` projection lists it. */
  change: string;
}

/**
 * Every rule diff() classifies a change by: the single home of its kind and
 * its one-line description. Each recorded Change names its rule id, and the
 * recorder accepts only an id of the matching kind, so the classification
 * cannot drift from this table; selfTest() proves every rule is emitted.
 */
export const DIFF_RULES = {
  OWNER_CHANGED: {
    kind: 'breaking',
    subject: 'type, operation or routine',
    change: 'The owner changed; the owner holds the write authority, so moving a contract breaks its writers.',
  },
  STATE_PROPERTY_CHANGED: { kind: 'breaking', subject: 'type', change: 'The stateProperty changed, was added or was removed.' },
  TABLE_CHANGED: {
    kind: 'breaking',
    subject: 'type',
    change: 'The table changed, was added or was removed; tables compare schema-qualified, so qualifying an own-component table is no change.',
  },
  KEY_CHANGED: { kind: 'breaking', subject: 'type', change: 'The key changed: a property added, removed or reordered.' },
  PROPERTY_REMOVED: { kind: 'breaking', subject: 'type property', change: 'The property was removed.' },
  PROPERTY_KIND_CHANGED: { kind: 'breaking', subject: 'type property', change: 'The kind changed.' },
  PROPERTY_NULLABILITY_CHANGED: { kind: 'breaking', subject: 'type property', change: 'The nullability changed, in either direction.' },
  PROPERTY_BECAME_REQUIRED: { kind: 'breaking', subject: 'type property', change: 'The property became required.' },
  PROPERTY_BECAME_OPTIONAL: {
    kind: 'breaking',
    subject: 'type property',
    change: 'The property became optional; readers may now see it absent.',
  },
  PROPERTY_BECAME_IMMUTABLE: { kind: 'breaking', subject: 'type property', change: 'The property became immutable.' },
  PROPERTY_BECAME_MUTABLE: { kind: 'compatible', subject: 'type property', change: 'The property became mutable.' },
  ENUM_VALUE_REMOVED: { kind: 'breaking', subject: 'type property', change: 'An enum value was removed.' },
  ENUM_VALUE_ADDED: { kind: 'compatible', subject: 'type property', change: 'An enum value was added.' },
  BOUND_TIGHTENED: {
    kind: 'breaking',
    subject: 'type property',
    change: 'A bound tightened: added, min or minLength raised, or max or maxLength lowered.',
  },
  BOUND_LOOSENED: {
    kind: 'compatible',
    subject: 'type property',
    change: 'A bound loosened: removed, min or minLength lowered, or max or maxLength raised.',
  },
  REQUIRED_PROPERTY_ADDED: { kind: 'breaking', subject: 'type property', change: 'A required property was added.' },
  OPTIONAL_PROPERTY_ADDED: { kind: 'compatible', subject: 'type property', change: 'An optional property was added.' },
  BINDS_CHANGED: {
    kind: 'breaking',
    subject: 'type property, routine param or result column',
    change: 'Its binds was added, changed or removed: an added reference constrains writers, and a changed or removed one breaks the consumers that rely on it.',
  },
  HOST_CHANGED: { kind: 'breaking', subject: 'routine', change: 'The host changed.' },
  SOURCE_CHANGED: { kind: 'compatible', subject: 'routine', change: 'The source file moved, was added or was removed.' },
  PARAM_REMOVED: { kind: 'breaking', subject: 'routine param', change: 'The param was removed.' },
  PARAM_RETYPED: { kind: 'breaking', subject: 'routine param', change: 'The kind changed.' },
  PARAM_NULLABILITY_CHANGED: { kind: 'breaking', subject: 'routine param', change: 'The nullability changed, in either direction.' },
  PARAM_BECAME_REQUIRED: { kind: 'breaking', subject: 'routine param', change: 'The param went from optional to required.' },
  PARAM_BECAME_OPTIONAL: { kind: 'compatible', subject: 'routine param', change: 'The param went from required to optional.' },
  REQUIRED_PARAM_ADDED: { kind: 'breaking', subject: 'routine param', change: 'A required param was added.' },
  OPTIONAL_PARAM_ADDED: { kind: 'compatible', subject: 'routine param', change: 'An optional param was added.' },
  COLUMN_REMOVED: { kind: 'breaking', subject: 'routine result column', change: 'The column was removed.' },
  COLUMN_REORDERED: { kind: 'breaking', subject: 'routine result column', change: 'The column moved to another position.' },
  COLUMN_RETYPED: { kind: 'breaking', subject: 'routine result column', change: 'The kind changed.' },
  COLUMN_NULLABILITY_CHANGED: {
    kind: 'breaking',
    subject: 'routine result column',
    change: 'The nullability changed, in either direction.',
  },
  COLUMN_ADDED: {
    kind: 'compatible',
    subject: 'routine result column',
    change: 'A column was added; one inserted before existing columns also reorders them.',
  },
  OPERATION_KIND_CHANGED: { kind: 'breaking', subject: 'operation', change: 'The operation kind changed.' },
  OPERATION_TYPE_CHANGED: {
    kind: 'breaking',
    subject: 'operation',
    change: 'The request, response or result type changed, was added or was removed.',
  },
  OPERATION_BINDING_CHANGED: {
    kind: 'breaking',
    subject: 'operation',
    change: 'A binding changed: its position now holds a different binding of the same transport, such as a new HTTP method or path.',
  },
  OPERATION_BINDING_REMOVED: { kind: 'breaking', subject: 'operation', change: 'A binding was removed.' },
  OPERATION_BINDING_ADDED: { kind: 'compatible', subject: 'operation', change: 'A binding was added.' },
  PERMISSION_CHANGED: { kind: 'breaking', subject: 'operation or routine', change: 'The authority permission changed.' },
  SCOPE_CHANGED: { kind: 'breaking', subject: 'operation or routine', change: 'An authority scope was added or changed.' },
  SCOPE_REMOVED: { kind: 'compatible', subject: 'operation or routine', change: 'The authority scope was removed.' },
  RECORD_REMOVED: {
    kind: 'breaking',
    subject: 'type, operation, routine, mutation or workflow',
    change: 'The record was removed.',
  },
  RECORD_ADDED: {
    kind: 'compatible',
    subject: 'type, operation, routine, mutation or workflow',
    change: 'The record was added.',
  },
} as const satisfies Record<string, DiffRule>;

export type DiffRuleId = keyof typeof DIFF_RULES;

/** The rule ids whose kind is K, so a call site cannot record a rule under the other kind. */
type RuleOfKind<K extends ChangeKind> = {
  [R in DiffRuleId]: (typeof DIFF_RULES)[R]['kind'] extends K ? R : never;
}[DiffRuleId];

type Consumers = (targets: string[]) => string[];

/** Records the changes of one element; only breaking changes carry consumers. */
class ElementChanges {
  constructor(
    private readonly out: Change[],
    private readonly elementKind: ElementKind,
    private readonly element: string,
    private readonly consumers: string[],
  ) {}

  breaking(rule: RuleOfKind<'breaking'>, path: string, reason: string): void {
    this.add(rule, path, reason);
  }

  compatible(rule: RuleOfKind<'compatible'>, path: string, reason: string): void {
    this.add(rule, path, reason);
  }

  private add(rule: DiffRuleId, path: string, reason: string): void {
    const kind = DIFF_RULES[rule].kind;
    this.out.push({
      path,
      kind,
      rule,
      reason,
      consumers: kind === 'breaking' ? [...this.consumers] : [],
      element: this.element,
      elementKind: this.elementKind,
    });
  }
}

const nullability = (nullable: boolean): string => (nullable ? 'nullable' : 'non-nullable');

/**
 * Compare two models and classify each change as breaking or compatible. Every
 * Change names the element it belongs to, so mutate() can demand a version bump
 * and an acknowledgment per broken contract. Breaking changes carry the
 * consumers that would be affected, by reverse-reachability over the before-model.
 */
export function diff(before: Model, after: Model): Change[] {
  const out: Change[] = [];
  const consumersOf = makeConsumerResolver(before);
  const recorder = (kind: ElementKind, id: string): ElementChanges =>
    new ElementChanges(out, kind, id, consumersOf([id]));

  const afterTypes = new Map(after.types.map((t) => [t.id, t]));
  for (const b of before.types) {
    const a = afterTypes.get(b.id);
    if (a) diffType(b, a, recorder('type', b.id));
  }
  const afterRoutines = new Map(after.routines.map((r) => [r.id, r]));
  for (const b of before.routines) {
    const a = afterRoutines.get(b.id);
    if (a) diffRoutine(b, a, recorder('routine', b.id));
  }
  const afterOperations = new Map(after.operations.map((o) => [o.id, o]));
  for (const b of before.operations) {
    const a = afterOperations.get(b.id);
    if (a) diffOperation(b, a, recorder('operation', b.id));
  }
  diffWholeRecords(before, after, out, consumersOf);
  return out;
}

function diffOwner(path: string, b: string, a: string, ch: ElementChanges): void {
  if (b !== a) ch.breaking('OWNER_CHANGED', `${path}/owner`, `owner changed '${b}' -> '${a}'`);
}

function diffType(b: TypeDef, a: TypeDef, ch: ElementChanges): void {
  diffOwner(`types/${b.id}`, b.owner, a.owner, ch);
  if ((b.stateProperty ?? '') !== (a.stateProperty ?? '')) {
    ch.breaking(
      'STATE_PROPERTY_CHANGED',
      `types/${b.id}/stateProperty`,
      `stateProperty changed '${b.stateProperty ?? '(none)'}' -> '${a.stateProperty ?? '(none)'}'`,
    );
  }
  const bTable = b.table === undefined ? '' : qualifyTable(b.table, b.owner);
  const aTable = a.table === undefined ? '' : qualifyTable(a.table, a.owner);
  if (bTable !== aTable) {
    ch.breaking('TABLE_CHANGED', `types/${b.id}/table`, `table changed '${bTable || '(none)'}' -> '${aTable || '(none)'}'`);
  }
  const bKey = (b.key ?? []).join(', ');
  const aKey = (a.key ?? []).join(', ');
  if (bKey !== aKey) ch.breaking('KEY_CHANGED', `types/${b.id}/key`, `key changed [${bKey}] -> [${aKey}]`);

  const afterProps = new Map(a.properties.map((p) => [p.name, p]));
  const beforeNames = new Set(b.properties.map((p) => p.name));
  for (const bp of b.properties) {
    const path = `types/${b.id}/properties/${bp.name}`;
    const ap = afterProps.get(bp.name);
    if (!ap) {
      ch.breaking('PROPERTY_REMOVED', path, `property '${bp.name}' removed`);
      continue;
    }
    diffProperty(bp, ap, path, ch);
  }
  for (const ap of a.properties) {
    if (beforeNames.has(ap.name)) continue;
    const path = `types/${b.id}/properties/${ap.name}`;
    if (ap.required) ch.breaking('REQUIRED_PROPERTY_ADDED', path, `new required property '${ap.name}' added`);
    else ch.compatible('OPTIONAL_PROPERTY_ADDED', path, `optional property '${ap.name}' added`);
  }
}

function diffProperty(bp: Property, ap: Property, path: string, ch: ElementChanges): void {
  const n = bp.name;
  if (bp.kind !== ap.kind) {
    ch.breaking('PROPERTY_KIND_CHANGED', path, `property '${n}' kind changed '${bp.kind}' -> '${ap.kind}'`);
  }
  if (bp.nullable !== ap.nullable) {
    ch.breaking(
      'PROPERTY_NULLABILITY_CHANGED',
      path,
      `property '${n}' nullability changed ${nullability(bp.nullable)} -> ${nullability(ap.nullable)}`,
    );
  }
  if (!bp.required && ap.required) ch.breaking('PROPERTY_BECAME_REQUIRED', path, `property '${n}' became required`);
  if (bp.required && !ap.required) {
    ch.breaking('PROPERTY_BECAME_OPTIONAL', path, `property '${n}' became optional; readers may now see it absent`);
  }
  if (!bp.immutable && ap.immutable) ch.breaking('PROPERTY_BECAME_IMMUTABLE', path, `property '${n}' became immutable`);
  if (bp.immutable && !ap.immutable) ch.compatible('PROPERTY_BECAME_MUTABLE', path, `property '${n}' became mutable`);

  if (bp.enumValues && ap.enumValues) {
    const afterSet = new Set(ap.enumValues);
    for (const v of bp.enumValues) {
      if (!afterSet.has(v)) ch.breaking('ENUM_VALUE_REMOVED', `${path}/enumValues`, `enum value '${v}' removed from '${n}'`);
    }
    const beforeSet = new Set(bp.enumValues);
    for (const v of ap.enumValues) {
      if (!beforeSet.has(v)) ch.compatible('ENUM_VALUE_ADDED', `${path}/enumValues`, `enum value '${v}' added to '${n}'`);
    }
  }
  diffBounds(n, bp.bounds, ap.bounds, `${path}/bounds`, ch);
  diffBinds('property', n, bp.binds, ap.binds, path, ch);
}

const BOUND_KEYS = ['min', 'max', 'minLength', 'maxLength'] as const;

/** A lower bound (min, minLength) tightens when raised; an upper bound when lowered. Adding a bound tightens. */
function diffBounds(
  name: string,
  b: Bounds | undefined,
  a: Bounds | undefined,
  path: string,
  ch: ElementChanges,
): void {
  for (const key of BOUND_KEYS) {
    const bv = b?.[key];
    const av = a?.[key];
    if (bv === av) continue;
    const isLower = key === 'min' || key === 'minLength';
    let tightened: boolean;
    if (bv === undefined) tightened = true;
    else if (av === undefined) tightened = false;
    else tightened = isLower ? av > bv : av < bv;
    const reason = `property '${name}' bound ${key} ${tightened ? 'tightened' : 'loosened'} ${bv ?? '(none)'} -> ${av ?? '(none)'}`;
    if (tightened) ch.breaking('BOUND_TIGHTENED', `${path}/${key}`, reason);
    else ch.compatible('BOUND_LOOSENED', `${path}/${key}`, reason);
  }
}

function diffBinds(
  role: string,
  name: string,
  b: string | undefined,
  a: string | undefined,
  path: string,
  ch: ElementChanges,
): void {
  if ((b ?? '') !== (a ?? '')) {
    ch.breaking('BINDS_CHANGED', path, `${role} '${name}' binds changed '${b ?? '(none)'}' -> '${a ?? '(none)'}'`);
  }
}

function diffRoutine(b: Routine, a: Routine, ch: ElementChanges): void {
  const id = b.id;
  diffOwner(`routines/${id}`, b.owner, a.owner, ch);
  if (b.host !== a.host) ch.breaking('HOST_CHANGED', `routines/${id}/host`, `host changed '${b.host}' -> '${a.host}'`);
  if ((b.source ?? '') !== (a.source ?? '')) {
    ch.compatible(
      'SOURCE_CHANGED',
      `routines/${id}/source`,
      `source changed '${b.source ?? '(none)'}' -> '${a.source ?? '(none)'}'`,
    );
  }

  const afterParams = new Map(a.params.map((p) => [p.name, p]));
  const beforeParamNames = new Set(b.params.map((p) => p.name));
  for (const bp of b.params) {
    const path = `routines/${id}/params/${bp.name}`;
    const ap = afterParams.get(bp.name);
    if (!ap) {
      ch.breaking('PARAM_REMOVED', path, `param '${bp.name}' removed`);
      continue;
    }
    if (bp.kind !== ap.kind) ch.breaking('PARAM_RETYPED', path, `param '${bp.name}' retyped '${bp.kind}' -> '${ap.kind}'`);
    if (bp.nullable !== ap.nullable) {
      ch.breaking(
        'PARAM_NULLABILITY_CHANGED',
        path,
        `param '${bp.name}' nullability changed ${nullability(bp.nullable)} -> ${nullability(ap.nullable)}`,
      );
    }
    if (!bp.required && ap.required) ch.breaking('PARAM_BECAME_REQUIRED', path, `param '${bp.name}' became required`);
    if (bp.required && !ap.required) ch.compatible('PARAM_BECAME_OPTIONAL', path, `param '${bp.name}' became optional`);
    diffBinds('param', bp.name, bp.binds, ap.binds, path, ch);
  }
  for (const ap of a.params) {
    if (beforeParamNames.has(ap.name)) continue;
    const path = `routines/${id}/params/${ap.name}`;
    if (ap.required) ch.breaking('REQUIRED_PARAM_ADDED', path, `required param '${ap.name}' added`);
    else ch.compatible('OPTIONAL_PARAM_ADDED', path, `optional param '${ap.name}' added`);
  }

  const afterIndex = new Map(a.resultSet.map((c, i) => [c.name, { col: c, index: i }]));
  b.resultSet.forEach((bc, i) => {
    const path = `routines/${id}/resultSet/${bc.name}`;
    const found = afterIndex.get(bc.name);
    if (!found) {
      ch.breaking('COLUMN_REMOVED', path, `result column '${bc.name}' removed`);
      return;
    }
    if (found.index !== i) {
      ch.breaking('COLUMN_REORDERED', path, `result column '${bc.name}' reordered (position ${i} -> ${found.index})`);
    }
    if (found.col.kind !== bc.kind) {
      ch.breaking('COLUMN_RETYPED', path, `result column '${bc.name}' retyped '${bc.kind}' -> '${found.col.kind}'`);
    }
    if (found.col.nullable !== bc.nullable) {
      ch.breaking(
        'COLUMN_NULLABILITY_CHANGED',
        path,
        `result column '${bc.name}' nullability changed ${nullability(bc.nullable)} -> ${nullability(found.col.nullable)}`,
      );
    }
    diffBinds('result column', bc.name, bc.binds, found.col.binds, path, ch);
  });
  const beforeColumnNames = new Set(b.resultSet.map((c) => c.name));
  for (const ac of a.resultSet) {
    if (!beforeColumnNames.has(ac.name)) {
      ch.compatible('COLUMN_ADDED', `routines/${id}/resultSet/${ac.name}`, `result column '${ac.name}' added`);
    }
  }

  diffAuthority(`routines/${id}`, b.authority, a.authority, ch);
}

function bindingLabel(x: Binding): string {
  return [x.transport, x.method, x.path].filter((s) => s !== undefined && s !== '').join(' ');
}

/**
 * Bindings carry no id, so they are compared by their (transport, method, path)
 * label. A before-binding with no identical after-binding is breaking: reported
 * as "changed" when the same position now holds a new binding of the same
 * transport, otherwise as "removed".
 */
function diffBindings(b: Operation, a: Operation, ch: ElementChanges): void {
  const bb = b.bindings ?? [];
  const ab = a.bindings ?? [];
  const beforeLabels = new Set(bb.map(bindingLabel));
  const afterLabels = new Set(ab.map(bindingLabel));
  const pairedAfter = new Set<number>();
  bb.forEach((x, i) => {
    const label = bindingLabel(x);
    if (afterLabels.has(label)) return;
    const path = `operations/${b.id}/bindings/${i}`;
    const counterpart = ab[i];
    if (
      counterpart !== undefined &&
      counterpart.transport === x.transport &&
      !beforeLabels.has(bindingLabel(counterpart))
    ) {
      pairedAfter.add(i);
      ch.breaking('OPERATION_BINDING_CHANGED', path, `binding changed '${label}' -> '${bindingLabel(counterpart)}'`);
    } else {
      ch.breaking('OPERATION_BINDING_REMOVED', path, `binding '${label}' removed`);
    }
  });
  ab.forEach((x, i) => {
    if (beforeLabels.has(bindingLabel(x)) || pairedAfter.has(i)) return;
    ch.compatible('OPERATION_BINDING_ADDED', `operations/${b.id}/bindings/${i}`, `binding '${bindingLabel(x)}' added`);
  });
}

function diffOperation(b: Operation, a: Operation, ch: ElementChanges): void {
  diffOwner(`operations/${b.id}`, b.owner, a.owner, ch);
  if (b.kind !== a.kind) {
    ch.breaking('OPERATION_KIND_CHANGED', `operations/${b.id}/kind`, `operation kind changed '${b.kind}' -> '${a.kind}'`);
  }
  for (const field of ['request', 'response', 'result'] as const) {
    if (b[field] !== a[field]) {
      ch.breaking(
        'OPERATION_TYPE_CHANGED',
        `operations/${b.id}/${field}`,
        `${field} type changed '${b[field] ?? '(none)'}' -> '${a[field] ?? '(none)'}'`,
      );
    }
  }
  diffBindings(b, a, ch);
  diffAuthority(`operations/${b.id}`, b.authority, a.authority, ch);
}

function diffAuthority(path: string, b: Authority, a: Authority, ch: ElementChanges): void {
  if (b.permission !== a.permission) {
    ch.breaking(
      'PERMISSION_CHANGED',
      `${path}/authority`,
      `authority permission changed '${b.permission}' -> '${a.permission}'`,
    );
  }
  const bScope = b.scope ?? '';
  const aScope = a.scope ?? '';
  if (bScope === aScope) return;
  if (aScope === '') {
    ch.compatible('SCOPE_REMOVED', `${path}/authority`, `authority scope removed (was '${bScope}')`);
  } else {
    ch.breaking('SCOPE_CHANGED', `${path}/authority`, `authority scope changed '${bScope || '(none)'}' -> '${aScope}'`);
  }
}

function diffWholeRecords(before: Model, after: Model, out: Change[], consumersOf: Consumers): void {
  const collections: Array<[ElementKind, string, string[], string[]]> = [
    ['type', 'types', before.types.map((x) => x.id), after.types.map((x) => x.id)],
    ['operation', 'operations', before.operations.map((x) => x.id), after.operations.map((x) => x.id)],
    ['routine', 'routines', before.routines.map((x) => x.id), after.routines.map((x) => x.id)],
    ['mutation', 'mutations', before.mutations.map((x) => x.id), after.mutations.map((x) => x.id)],
    ['workflow', 'workflows', before.workflows.map((x) => x.id), after.workflows.map((x) => x.id)],
  ];
  for (const [kind, collection, beforeIds, afterIds] of collections) {
    const afterSet = new Set(afterIds);
    const beforeSet = new Set(beforeIds);
    for (const id of beforeIds) {
      if (afterSet.has(id)) continue;
      new ElementChanges(out, kind, id, consumersOf([id])).breaking('RECORD_REMOVED', `${collection}/${id}`, `${kind} '${id}' removed`);
    }
    for (const id of afterIds) {
      if (beforeSet.has(id)) continue;
      new ElementChanges(out, kind, id, []).compatible('RECORD_ADDED', `${collection}/${id}`, `${kind} '${id}' added`);
    }
  }
}
