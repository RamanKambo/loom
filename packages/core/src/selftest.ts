import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Model, Finding, Kind, Change } from './types.js';
import { FINDING, FINDING_RULES, type FindingCode } from './codes.js';
import { validate } from './validate.js';
import { diff, DIFF_RULES, type DiffRule } from './diff.js';
import {
  project,
  projectToFiles,
  JSON_SCHEMA_ID,
  PROJECTION_TARGETS,
  PROJECTION_FILES,
  SOURCE_NOTICE,
} from './project.js';
import { procedureName } from './projections/sql.js';
import { exportModel, importModel } from './exportModel.js';
import { mutate, type Patch } from './mutate.js';
import { deepClone, deepEqual, canonicalStringify } from './canonical.js';
import { reverseReachable } from './reachability.js';
import { sampleModel } from './sample.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`self-test failed: ${message}`);
}

function assertThrows(fn: () => unknown, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`self-test failed: expected a throw for ${message}`);
}

function errorsOf(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'error');
}

function errorCodes(findings: Finding[]): Set<string> {
  return new Set(errorsOf(findings).map((f) => f.code));
}

const list = (codes: Set<string>): string => [...codes].sort().join(', ') || '(none)';

function findMutation(m: Model, id: string): Model['mutations'][number] {
  const x = m.mutations.find((y) => y.id === id);
  assert(x, `sample should contain mutation '${id}'`);
  return x;
}
function findRoutine(m: Model, id: string): Model['routines'][number] {
  const x = m.routines.find((y) => y.id === id);
  assert(x, `sample should contain routine '${id}'`);
  return x;
}
function findType(m: Model, id: string): Model['types'][number] {
  const x = m.types.find((y) => y.id === id);
  assert(x, `sample should contain type '${id}'`);
  return x;
}
function findOperation(m: Model, id: string): Model['operations'][number] {
  const x = m.operations.find((y) => y.id === id);
  assert(x, `sample should contain operation '${id}'`);
  return x;
}
function findProperty(m: Model, typeId: string, name: string): Model['types'][number]['properties'][number] {
  const x = findType(m, typeId).properties.find((p) => p.name === name);
  assert(x, `sample type '${typeId}' should contain property '${name}'`);
  return x;
}
function findParam(m: Model, routineId: string, name: string): Model['routines'][number]['params'][number] {
  const x = findRoutine(m, routineId).params.find((p) => p.name === name);
  assert(x, `sample routine '${routineId}' should contain param '${name}'`);
  return x;
}
function findColumn(m: Model, routineId: string, name: string): Model['routines'][number]['resultSet'][number] {
  const x = findRoutine(m, routineId).resultSet.find((c) => c.name === name);
  assert(x, `sample routine '${routineId}' should contain result column '${name}'`);
  return x;
}

const PLACE = 'ordering.sp_place_order';
const DISPATCH = 'fulfillment.rb_dispatch';
/** The sample's one referencing property: 'shipment.orderId' binds 'order.id'. */
const ORDER_REF = 'types/shipment/properties/orderId/binds';

interface Contradiction {
  label: string;
  code: FindingCode;
  /** When set, the finding's path must contain this, pinning the offending element. */
  pathIncludes?: string;
  break: (m: Model) => void;
}

/** Each yields the expected finding from validate(), at the severity FINDING_RULES gives its code, carrying a fix. */
const CONTRADICTIONS: Contradiction[] = [
  {
    label: 'duplicate id',
    code: FINDING.DUPLICATE_ID,
    break: (m) => m.components.push({ id: 'order', purpose: 'duplicate of a type id' }),
  },
  {
    label: 'dangling reference',
    code: FINDING.DANGLING_REF,
    pathIncludes: 'operations/order.place/request',
    break: (m) => {
      findOperation(m, 'order.place').request = 'ghost-type';
    },
  },
  {
    label: 'non-owner mutation',
    code: FINDING.MUTATION_NONOWNER,
    break: (m) => {
      findMutation(m, 'order.pay').owner = 'fulfillment';
    },
  },
  {
    label: 'illegal destination state',
    code: FINDING.MUTATION_ILLEGAL_STATE,
    break: (m) => {
      findMutation(m, 'order.pay').to = 'frozen';
    },
  },
  {
    label: 'immutable write outside creation',
    code: FINDING.MUTATION_IMMUTABLE_WRITE,
    break: (m) => findMutation(m, 'order.pay').writes.push('id'),
  },
  {
    label: 'creation missing a required field',
    code: FINDING.MUTATION_CREATION_MISSING_REQUIRED,
    break: (m) => {
      findMutation(m, 'order.create').writes = ['id', 'status'];
    },
  },
  {
    label: 'routine non-owner table write',
    code: FINDING.ROUTINE_NONOWNER_TABLE_WRITE,
    break: (m) => {
      findRoutine(m, PLACE).writesTables = ['ordering.orders', 'billing.ledger'];
    },
  },
  {
    label: 'routine performs a mutation it does not own',
    code: FINDING.ROUTINE_MUTATION_OWNER_MISMATCH,
    break: (m) => {
      findRoutine(m, PLACE).performsMutations = ['shipment.create'];
    },
  },
  {
    label: 'routine duplicate result column',
    code: FINDING.ROUTINE_DUPLICATE_COLUMN,
    break: (m) => {
      findRoutine(m, PLACE).resultSet.push({ name: 'order_id', kind: 'string', nullable: false });
    },
  },
  {
    label: 'routine empty result set',
    code: FINDING.ROUTINE_EMPTY_RESULTSET,
    break: (m) => {
      findRoutine(m, DISPATCH).resultSet = [];
    },
  },
  {
    label: 'workflow dependency cycle',
    code: FINDING.WORKFLOW_DEPENDENCY_CYCLE,
    break: (m) => {
      const wf = m.workflows.find((x) => x.id === 'wf.checkout');
      assert(wf, 'sample should contain workflow wf.checkout');
      wf.dependsOn = ['wf.reporting'];
    },
  },
  {
    label: 'mutation with no scenario',
    code: FINDING.MUTATION_NO_SCENARIO,
    break: (m) => {
      findMutation(m, 'order.pay').scenarios = [];
    },
  },
  {
    label: 'scenario does not cover the mutation requirement',
    code: FINDING.MUTATION_TRACEABILITY_UNCOVERED,
    break: (m) => {
      findMutation(m, 'order.pay').scenarios = ['scn.place-order'];
    },
  },
  {
    label: 'mutation writes an unknown property',
    code: FINDING.MUTATION_WRITE_UNKNOWN_PROPERTY,
    break: (m) => {
      findMutation(m, 'order.pay').writes = ['ghost-prop'];
    },
  },
  // (e) binds to an unknown property
  {
    label: 'binding to an unknown property',
    code: FINDING.DANGLING_REF,
    pathIncludes: `routines/${PLACE}/params/p_note/binds`,
    break: (m) => {
      findParam(m, PLACE, 'p_note').binds = 'order.ghost';
    },
  },
  {
    label: 'binding to an unknown type',
    code: FINDING.DANGLING_REF,
    pathIncludes: `routines/${DISPATCH}/params/OrderId/binds`,
    break: (m) => {
      findParam(m, DISPATCH, 'OrderId').binds = 'parcel.id';
    },
  },
  {
    label: 'binding kind mismatch',
    code: FINDING.BINDING_KIND_MISMATCH,
    pathIncludes: `routines/${PLACE}/params/p_total/binds`,
    break: (m) => {
      findParam(m, PLACE, 'p_total').kind = 'integer';
    },
  },
  // (f) nullability mismatch, across a component boundary
  {
    label: 'cross-component binding nullability mismatch',
    code: FINDING.BINDING_NULLABILITY_MISMATCH,
    pathIncludes: `routines/${DISPATCH}/params/OrderId/binds`,
    break: (m) => {
      findParam(m, DISPATCH, 'OrderId').nullable = true;
    },
  },
  {
    label: 'table qualified by an unknown component',
    code: FINDING.TABLE_COMPONENT_UNKNOWN,
    pathIncludes: 'types/order/table',
    break: (m) => {
      findType(m, 'order').table = 'ghost.orders';
    },
  },
  {
    label: 'stateProperty names a non-enum property',
    code: FINDING.TYPE_STATE_PROPERTY_INVALID,
    pathIncludes: 'types/order/stateProperty',
    break: (m) => {
      findType(m, 'order').stateProperty = 'total';
    },
  },
  {
    label: 'mutation on a type without a stateProperty',
    code: FINDING.MUTATION_NO_STATE_PROPERTY,
    pathIncludes: 'mutations/order.create',
    break: (m) => {
      delete findType(m, 'order').stateProperty;
    },
  },
  {
    label: 'mutation with no requirement',
    code: FINDING.MUTATION_NO_REQUIREMENT,
    pathIncludes: 'mutations/order.pay/requirements',
    break: (m) => {
      findMutation(m, 'order.pay').requirements = [];
    },
  },
  {
    label: 'table-backed key over 900 bytes (a warning)',
    code: FINDING.TYPE_KEY_WIDE,
    pathIncludes: 'types/invoice/key',
    break: (m) => {
      findProperty(m, 'invoice', 'id').bounds = { maxLength: 451 };
    },
  },
  // (g) stale workflow import is an error
  {
    label: 'stale workflow import pin',
    code: FINDING.WORKFLOW_IMPORT_VERSION_MISMATCH,
    pathIncludes: 'workflows/wf.checkout/imports/order',
    break: (m) => {
      findType(m, 'order').version = 2;
    },
  },
  // (h) incomplete routine write-set
  {
    label: 'incomplete routine write-set',
    code: FINDING.ROUTINE_WRITE_SET_INCOMPLETE,
    pathIncludes: `routines/${PLACE}/writesTables`,
    break: (m) => {
      findRoutine(m, PLACE).writesTables = [];
    },
  },
  // (k) type table owner prefix mismatch
  {
    label: 'type table owned by another component',
    code: FINDING.TYPE_TABLE_NONOWNER,
    pathIncludes: 'types/order/table',
    break: (m) => {
      findType(m, 'order').table = 'billing.orders';
    },
  },
  {
    label: 'table-backed type without a key',
    code: FINDING.TYPE_TABLE_WITHOUT_KEY,
    pathIncludes: 'types/order/key',
    break: (m) => {
      delete findType(m, 'order').key;
    },
  },
  {
    label: 'key names an unknown property',
    code: FINDING.TYPE_KEY_INVALID,
    pathIncludes: 'types/order/key',
    break: (m) => {
      findType(m, 'order').key = ['ghost'];
    },
  },
  {
    label: 'key property is optional and nullable',
    code: FINDING.TYPE_KEY_INVALID,
    pathIncludes: 'types/order/key',
    break: (m) => {
      findType(m, 'order').key = ['note'];
    },
  },
  {
    label: 'key column would be NVARCHAR(MAX)',
    code: FINDING.TYPE_KEY_INVALID,
    pathIncludes: 'types/order/key',
    break: (m) => {
      delete findProperty(m, 'order', 'id').bounds;
    },
  },
  {
    label: 'two types bind the same table',
    code: FINDING.TYPE_TABLE_DUPLICATE,
    pathIncludes: 'types/order_view/table',
    break: (m) => {
      m.types.push({
        id: 'order_view',
        version: 1,
        owner: 'ordering',
        table: 'orders',
        key: ['id'],
        properties: [
          { name: 'id', kind: 'string', required: true, nullable: false, immutable: true, origin: 'system', bounds: { maxLength: 64 } },
        ],
      });
    },
  },
  {
    label: 'length bound on a number',
    code: FINDING.BOUNDS_KIND_MISMATCH,
    pathIncludes: 'types/order/properties/total/bounds',
    break: (m) => {
      findProperty(m, 'order', 'total').bounds = { min: 0, maxLength: 10 };
    },
  },
  {
    label: 'numeric bound on an enum',
    code: FINDING.BOUNDS_KIND_MISMATCH,
    pathIncludes: 'types/order/properties/status/bounds',
    break: (m) => {
      findProperty(m, 'order', 'status').bounds = { min: 1 };
    },
  },
  {
    label: 'routine source is an absolute path',
    code: FINDING.ROUTINE_SOURCE_NOT_RELATIVE,
    pathIncludes: `routines/${PLACE}/source`,
    break: (m) => {
      findRoutine(m, PLACE).source = '/repo/ordering/sp_place_order.sql';
    },
  },
  {
    label: 'routine source carries a drive letter',
    code: FINDING.ROUTINE_SOURCE_NOT_RELATIVE,
    pathIncludes: `routines/${DISPATCH}/source`,
    break: (m) => {
      findRoutine(m, DISPATCH).source = 'C:\\runbooks\\rb_dispatch.ps1';
    },
  },
  {
    label: 'routine writes a column the bound type lacks',
    code: FINDING.ROUTINE_WRITES_UNKNOWN_COLUMN,
    pathIncludes: `routines/${PLACE}/writesColumns`,
    break: (m) => findRoutine(m, PLACE).writesColumns?.push('ordering.orders.ghost'),
  },
  {
    label: 'routine writes a column of a table outside its writesTables',
    code: FINDING.ROUTINE_WRITES_UNKNOWN_COLUMN,
    pathIncludes: `routines/${PLACE}/writesColumns`,
    break: (m) => findRoutine(m, PLACE).writesColumns?.push('fulfillment.shipments.state'),
  },
  {
    label: 'routine writes a column of an unknown table',
    code: FINDING.ROUTINE_WRITES_UNKNOWN_COLUMN,
    pathIncludes: `routines/${PLACE}/writesColumns`,
    break: (m) => findRoutine(m, PLACE).writesColumns?.push('ordering.carts.id'),
  },
  {
    label: 'enum property with an empty enumValues',
    code: FINDING.ENUM_WITHOUT_VALUES,
    pathIncludes: 'types/invoice/properties/state/enumValues',
    break: (m) => {
      findProperty(m, 'invoice', 'state').enumValues = [];
    },
  },
  {
    label: 'enum property with no enumValues',
    code: FINDING.ENUM_WITHOUT_VALUES,
    pathIncludes: 'types/order/properties/priority/enumValues',
    break: (m) => {
      findType(m, 'order').properties.push({
        name: 'priority',
        kind: 'enum',
        required: false,
        nullable: true,
        immutable: false,
        origin: 'client',
      });
    },
  },
  {
    label: 'enum param that binds no enum property',
    code: FINDING.ENUM_PARAM_UNBOUND,
    pathIncludes: `routines/${DISPATCH}/params/InitialState/binds`,
    break: (m) => {
      delete findParam(m, DISPATCH, 'InitialState').binds;
    },
  },
  {
    label: 'enum result column that binds no enum property',
    code: FINDING.ENUM_PARAM_UNBOUND,
    pathIncludes: `routines/${PLACE}/resultSet/status/binds`,
    break: (m) => {
      delete findColumn(m, PLACE, 'status').binds;
    },
  },
  {
    label: 'property binding to an unknown type',
    code: FINDING.DANGLING_REF,
    pathIncludes: ORDER_REF,
    break: (m) => {
      findProperty(m, 'shipment', 'orderId').binds = 'parcel.id';
    },
  },
  {
    label: 'property binding to an unknown property',
    code: FINDING.DANGLING_REF,
    pathIncludes: ORDER_REF,
    break: (m) => {
      findProperty(m, 'shipment', 'orderId').binds = 'order.ghost';
    },
  },
  {
    label: 'property binding to a non-key property',
    code: FINDING.BINDING_NOT_KEY,
    pathIncludes: ORDER_REF,
    break: (m) => {
      findProperty(m, 'shipment', 'orderId').binds = 'order.note';
    },
  },
  {
    label: 'property binding to a composite key',
    code: FINDING.BINDING_NOT_KEY,
    pathIncludes: ORDER_REF,
    break: (m) => {
      findType(m, 'order').key = ['id', 'status'];
    },
  },
  {
    label: 'property binding kind mismatch',
    code: FINDING.BINDING_KIND_MISMATCH,
    pathIncludes: ORDER_REF,
    break: (m) => {
      const p = findProperty(m, 'shipment', 'orderId');
      p.kind = 'integer';
      delete p.bounds;
    },
  },
  {
    label: 'property binding SQL length mismatch',
    code: FINDING.BINDING_SQL_TYPE_MISMATCH,
    pathIncludes: ORDER_REF,
    break: (m) => {
      findProperty(m, 'shipment', 'orderId').bounds = { maxLength: 128 };
    },
  },
];

interface DiffCase {
  label: string;
  /** The element the change must be attributed to (breaking cases only). */
  element?: string;
  reasonIncludes: string;
  after: (m: Model) => void;
}

/** Each must yield a breaking Change on `element`, carrying consumers. */
const BREAKING_DIFFS: DiffCase[] = [
  {
    label: 'routine resultSet column removed',
    element: PLACE,
    reasonIncludes: "result column 'status' removed",
    after: (m) => {
      const r = findRoutine(m, PLACE);
      r.resultSet = r.resultSet.filter((c) => c.name !== 'status');
    },
  },
  {
    label: 'enum value removed (narrowed)',
    element: 'order',
    reasonIncludes: "enum value 'shipped' removed",
    after: (m) => {
      const p = findProperty(m, 'order', 'status');
      p.enumValues = (p.enumValues ?? []).filter((v) => v !== 'shipped');
    },
  },
  {
    label: 'newly-required property',
    element: 'order',
    reasonIncludes: "new required property 'priority' added",
    after: (m) => {
      findType(m, 'order').properties.push({
        name: 'priority',
        kind: 'integer',
        required: true,
        nullable: false,
        immutable: false,
        origin: 'client',
      });
    },
  },
  {
    label: 'property kind change',
    element: 'order',
    reasonIncludes: "property 'total' kind changed 'number' -> 'string'",
    after: (m) => {
      findProperty(m, 'order', 'total').kind = 'string';
    },
  },
  {
    label: 'operation authority permission changed',
    element: 'order.place',
    reasonIncludes: "authority permission changed 'order.write' -> 'order.admin'",
    after: (m) => {
      findOperation(m, 'order.place').authority.permission = 'order.admin';
    },
  },
  // (i) property removal is breaking
  {
    label: 'property removed',
    element: 'order',
    reasonIncludes: "property 'note' removed",
    after: (m) => {
      const t = findType(m, 'order');
      t.properties = t.properties.filter((p) => p.name !== 'note');
    },
  },
  {
    label: 'property nullability changed',
    element: 'order',
    reasonIncludes: "property 'total' nullability changed non-nullable -> nullable",
    after: (m) => {
      findProperty(m, 'order', 'total').nullable = true;
    },
  },
  {
    label: 'property required -> optional',
    element: 'order',
    reasonIncludes: "property 'total' became optional",
    after: (m) => {
      findProperty(m, 'order', 'total').required = false;
    },
  },
  {
    label: 'property optional -> required',
    element: 'order',
    reasonIncludes: "property 'note' became required",
    after: (m) => {
      findProperty(m, 'order', 'note').required = true;
    },
  },
  {
    label: 'property became immutable',
    element: 'order',
    reasonIncludes: "property 'total' became immutable",
    after: (m) => {
      findProperty(m, 'order', 'total').immutable = true;
    },
  },
  {
    label: 'bound tightened (maxLength lowered)',
    element: 'order',
    reasonIncludes: "property 'note' bound maxLength tightened 280 -> 100",
    after: (m) => {
      findProperty(m, 'order', 'note').bounds = { maxLength: 100 };
    },
  },
  {
    label: 'bound tightened (min raised)',
    element: 'order',
    reasonIncludes: "property 'total' bound min tightened 0 -> 1",
    after: (m) => {
      findProperty(m, 'order', 'total').bounds = { min: 1 };
    },
  },
  {
    label: 'bound tightened (bound added)',
    element: 'order',
    reasonIncludes: "property 'total' bound max tightened (none) -> 1000",
    after: (m) => {
      findProperty(m, 'order', 'total').bounds = { min: 0, max: 1000 };
    },
  },
  {
    label: 'routine required param added',
    element: PLACE,
    reasonIncludes: "required param 'p_channel' added",
    after: (m) => {
      findRoutine(m, PLACE).params.push({ name: 'p_channel', kind: 'string', required: true, nullable: false });
    },
  },
  {
    label: 'routine param removed',
    element: PLACE,
    reasonIncludes: "param 'p_note' removed",
    after: (m) => {
      const r = findRoutine(m, PLACE);
      r.params = r.params.filter((p) => p.name !== 'p_note');
    },
  },
  {
    label: 'routine param retyped',
    element: PLACE,
    reasonIncludes: "param 'p_total' retyped 'number' -> 'integer'",
    after: (m) => {
      findParam(m, PLACE, 'p_total').kind = 'integer';
    },
  },
  {
    label: 'routine param nullability changed',
    element: PLACE,
    reasonIncludes: "param 'p_total' nullability changed non-nullable -> nullable",
    after: (m) => {
      findParam(m, PLACE, 'p_total').nullable = true;
    },
  },
  {
    label: 'routine param optional -> required',
    element: PLACE,
    reasonIncludes: "param 'p_note' became required",
    after: (m) => {
      findParam(m, PLACE, 'p_note').required = true;
    },
  },
  {
    label: 'routine param binds changed',
    element: PLACE,
    reasonIncludes: "param 'p_total' binds changed 'order.total' -> '(none)'",
    after: (m) => {
      delete findParam(m, PLACE, 'p_total').binds;
    },
  },
  {
    label: 'result column retyped',
    element: PLACE,
    reasonIncludes: "result column 'status' retyped 'enum' -> 'string'",
    after: (m) => {
      findColumn(m, PLACE, 'status').kind = 'string';
    },
  },
  {
    label: 'result column reordered',
    element: PLACE,
    reasonIncludes: "result column 'order_id' reordered (position 0 -> 1)",
    after: (m) => {
      findRoutine(m, PLACE).resultSet.reverse();
    },
  },
  {
    label: 'result column nullability changed',
    element: PLACE,
    reasonIncludes: "result column 'order_id' nullability changed non-nullable -> nullable",
    after: (m) => {
      findColumn(m, PLACE, 'order_id').nullable = true;
    },
  },
  {
    label: 'result column binds changed',
    element: DISPATCH,
    reasonIncludes: "result column 'shipment_id' binds changed 'shipment.id' -> 'shipment.orderId'",
    after: (m) => {
      findColumn(m, DISPATCH, 'shipment_id').binds = 'shipment.orderId';
    },
  },
  {
    label: 'routine authority permission changed',
    element: DISPATCH,
    reasonIncludes: "authority permission changed 'shipment.write' -> 'shipment.admin'",
    after: (m) => {
      findRoutine(m, DISPATCH).authority.permission = 'shipment.admin';
    },
  },
  {
    label: 'operation kind changed',
    element: 'order.place',
    reasonIncludes: "operation kind changed 'command' -> 'async-command'",
    after: (m) => {
      findOperation(m, 'order.place').kind = 'async-command';
    },
  },
  {
    label: 'operation request type changed',
    element: 'order.place',
    reasonIncludes: "request type changed 'order' -> 'shipment'",
    after: (m) => {
      findOperation(m, 'order.place').request = 'shipment';
    },
  },
  // (j) HTTP path change is breaking
  {
    label: 'HTTP binding path changed',
    element: 'order.place',
    reasonIncludes: "binding changed 'http POST /orders' -> 'http POST /v2/orders'",
    after: (m) => {
      const b = findOperation(m, 'order.place').bindings?.[0];
      assert(b, 'order.place should have an http binding');
      b.path = '/v2/orders';
    },
  },
  {
    label: 'HTTP binding method changed',
    element: 'order.get',
    reasonIncludes: "binding changed 'http GET /orders' -> 'http PUT /orders'",
    after: (m) => {
      const b = findOperation(m, 'order.get').bindings?.[0];
      assert(b, 'order.get should have an http binding');
      b.method = 'PUT';
    },
  },
  {
    label: 'HTTP binding removed',
    element: 'shipment.dispatch',
    reasonIncludes: "binding 'http POST /shipments' removed",
    after: (m) => {
      findOperation(m, 'shipment.dispatch').bindings = [];
    },
  },
  {
    label: 'operation authority scope added',
    element: 'order.place',
    reasonIncludes: "authority scope changed '(none)' -> 'admin'",
    after: (m) => {
      findOperation(m, 'order.place').authority.scope = 'admin';
    },
  },
  {
    label: 'type removed',
    element: 'invoice',
    reasonIncludes: "type 'invoice' removed",
    after: (m) => {
      m.types = m.types.filter((t) => t.id !== 'invoice');
    },
  },
  {
    label: 'type key changed',
    element: 'order',
    reasonIncludes: 'key changed [id] -> [id, status]',
    after: (m) => {
      findType(m, 'order').key = ['id', 'status'];
    },
  },
  {
    label: 'type table changed',
    element: 'order',
    reasonIncludes: "table changed 'ordering.orders' -> 'ordering.order_rows'",
    after: (m) => {
      findType(m, 'order').table = 'ordering.order_rows';
    },
  },
  {
    label: 'routine host changed',
    element: DISPATCH,
    reasonIncludes: "host changed 'runbook' -> 'function'",
    after: (m) => {
      findRoutine(m, DISPATCH).host = 'function';
    },
  },
  {
    label: 'type owner changed',
    element: 'order',
    reasonIncludes: "owner changed 'ordering' -> 'billing'",
    after: (m) => {
      findType(m, 'order').owner = 'billing';
    },
  },
  {
    label: 'operation owner changed',
    element: 'order.get',
    reasonIncludes: "owner changed 'ordering' -> 'billing'",
    after: (m) => {
      findOperation(m, 'order.get').owner = 'billing';
    },
  },
  {
    label: 'routine owner changed',
    element: DISPATCH,
    reasonIncludes: "owner changed 'fulfillment' -> 'ordering'",
    after: (m) => {
      findRoutine(m, DISPATCH).owner = 'ordering';
    },
  },
  {
    label: 'type stateProperty changed',
    element: 'order',
    reasonIncludes: "stateProperty changed 'status' -> '(none)'",
    after: (m) => {
      delete findType(m, 'order').stateProperty;
    },
  },
  {
    label: 'property binds added',
    element: 'order',
    reasonIncludes: "property 'note' binds changed '(none)' -> 'invoice.id'",
    after: (m) => {
      findProperty(m, 'order', 'note').binds = 'invoice.id';
    },
  },
  {
    label: 'property binds changed',
    element: 'shipment',
    reasonIncludes: "property 'orderId' binds changed 'order.id' -> 'invoice.id'",
    after: (m) => {
      findProperty(m, 'shipment', 'orderId').binds = 'invoice.id';
    },
  },
  {
    label: 'property binds removed',
    element: 'shipment',
    reasonIncludes: "property 'orderId' binds changed 'order.id' -> '(none)'",
    after: (m) => {
      delete findProperty(m, 'shipment', 'orderId').binds;
    },
  },
];

/** Each must yield no breaking Change and a compatible Change with the given reason. */
const COMPATIBLE_DIFFS: DiffCase[] = [
  {
    label: 'optional property added',
    reasonIncludes: "optional property 'label' added",
    after: (m) => {
      findType(m, 'order').properties.push({
        name: 'label',
        kind: 'string',
        required: false,
        nullable: true,
        immutable: false,
        origin: 'client',
      });
    },
  },
  {
    label: 'bound loosened (maxLength raised)',
    reasonIncludes: "property 'note' bound maxLength loosened 280 -> 500",
    after: (m) => {
      findProperty(m, 'order', 'note').bounds = { maxLength: 500 };
    },
  },
  {
    label: 'bound loosened (bound removed)',
    reasonIncludes: "property 'total' bound min loosened 0 -> (none)",
    after: (m) => {
      delete findProperty(m, 'order', 'total').bounds;
    },
  },
  {
    label: 'property became mutable',
    reasonIncludes: "property 'id' became mutable",
    after: (m) => {
      findProperty(m, 'order', 'id').immutable = false;
    },
  },
  {
    label: 'enum value added',
    reasonIncludes: "enum value 'refunded' added",
    after: (m) => {
      findProperty(m, 'order', 'status').enumValues?.push('refunded');
    },
  },
  {
    label: 'routine optional param added',
    reasonIncludes: "optional param 'p_channel' added",
    after: (m) => {
      findRoutine(m, PLACE).params.push({ name: 'p_channel', kind: 'string', required: false, nullable: true });
    },
  },
  {
    label: 'routine param required -> optional',
    reasonIncludes: "param 'p_total' became optional",
    after: (m) => {
      findParam(m, PLACE, 'p_total').required = false;
    },
  },
  {
    label: 'result column appended',
    reasonIncludes: "result column 'placed_at' added",
    after: (m) => {
      findRoutine(m, PLACE).resultSet.push({ name: 'placed_at', kind: 'string', nullable: true });
    },
  },
  {
    label: 'HTTP binding added',
    reasonIncludes: "binding 'http GET /orders/{id}' added",
    after: (m) => {
      findOperation(m, 'order.get').bindings?.push({ transport: 'http', method: 'GET', path: '/orders/{id}' });
    },
  },
  {
    label: 'operation authority scope removed',
    reasonIncludes: "authority scope removed (was 'fulfillment')",
    after: (m) => {
      delete findOperation(m, 'shipment.dispatch').authority.scope;
    },
  },
  {
    label: 'routine source moved',
    reasonIncludes: "source changed 'ordering/sp_place_order.sql' -> 'sql/ordering/sp_place_order.sql'",
    after: (m) => {
      findRoutine(m, PLACE).source = 'sql/ordering/sp_place_order.sql';
    },
  },
  {
    label: 'workflow added',
    reasonIncludes: "workflow 'wf.refund' added",
    after: (m) => {
      m.workflows.push({ id: 'wf.refund', status: 'planned', dependsOn: [], imports: [], requirements: [] });
    },
  },
];

/**
 * Prove the engine end to end. Asserts a valid sample passes; that every
 * deliberate contradiction yields the expected finding (with a fix) or breaking
 * diff; that compatible changes stay compatible; that mutate() refuses breaking
 * changes lacking a version bump or acknowledgment and accepts the complete
 * atomic batch; determinism, round-trip losslessness, fail-closed projection and
 * export; and that the JSON Schema projection compiles under Ajv (2020-12) and
 * accepts/rejects hand-authored payloads. Prints one summary line; throws on failure.
 */
export function selfTest(): void {
  const sample = sampleModel();

  // 0. every finding code has its rule, and every rule names a real code
  const codes: string[] = Object.values(FINDING);
  const ruled = Object.keys(FINDING_RULES);
  const undescribed = codes.filter((c) => !ruled.includes(c));
  const stray = ruled.filter((c) => !codes.includes(c));
  assert(
    undescribed.length === 0 && stray.length === 0,
    `FINDING and FINDING_RULES should list the same codes; no rule for: ${list(new Set(undescribed))}; no code for: ${list(new Set(stray))}`,
  );
  for (const [key, value] of Object.entries(FINDING)) assert(key === value, `FINDING.${key} should equal its own name, got '${value}'`);
  for (const [c, r] of Object.entries(FINDING_RULES)) {
    assert(r.rule.trim().length > 0, `FINDING_RULES.${c} should describe its rule`);
    assert(r.severity === 'error' || r.severity === 'warning', `FINDING_RULES.${c} should be an error or a warning`);
  }
  for (const [id, r] of Object.entries(DIFF_RULES) as Array<[string, DiffRule]>) {
    assert(r.change.trim().length > 0 && r.subject.trim().length > 0, `DIFF_RULES.${id} should describe its subject and change`);
  }

  // 1. valid sample passes
  const baseErrors = errorsOf(validate(sample));
  assert(baseErrors.length === 0, `sample should have no error findings, got: ${baseErrors.map((f) => f.code).join(', ')}`);

  // 2. validate-based contradictions; every code that fires is recorded as proven
  const provenCodes = new Set<string>();
  for (const c of CONTRADICTIONS) {
    const broken = deepClone(sample);
    c.break(broken);
    const severity = FINDING_RULES[c.code].severity;
    const hit = validate(broken).find(
      (f) => f.code === c.code && f.severity === severity && (c.pathIncludes === undefined || f.path.includes(c.pathIncludes)),
    );
    assert(
      hit,
      `contradiction '${c.label}' should yield ${severity} ${c.code}${c.pathIncludes ? ` at '${c.pathIncludes}'` : ''}`,
    );
    assert(hit.fix && hit.fix.length > 0, `finding ${c.code} for '${c.label}' should carry a fix`);
    provenCodes.add(c.code);
  }

  // 3. diff classification; every change must name a described rule of its own kind
  const emittedRules = new Set<string>();
  const diffed = (after: Model): Change[] => {
    const changes = diff(sample, after);
    for (const ch of changes) {
      const rule = (DIFF_RULES as Readonly<Record<string, DiffRule>>)[ch.rule];
      assert(rule, `change '${ch.reason}' names rule '${ch.rule}', which DIFF_RULES does not describe`);
      assert(rule.kind === ch.kind, `change '${ch.reason}' is ${ch.kind} but its rule '${ch.rule}' is ${rule.kind}`);
      emittedRules.add(ch.rule);
    }
    return changes;
  };
  for (const d of BREAKING_DIFFS) {
    const after = deepClone(sample);
    d.after(after);
    const hit = diffed(after).find(
      (ch) => ch.kind === 'breaking' && ch.element === d.element && ch.reason.includes(d.reasonIncludes),
    );
    assert(hit, `diff '${d.label}' should yield a breaking change on '${d.element}': "${d.reasonIncludes}"`);
    assert(hit.consumers.length > 0, `breaking diff '${d.label}' should list consumers`);
  }
  for (const d of COMPATIBLE_DIFFS) {
    const after = deepClone(sample);
    d.after(after);
    const changes = diffed(after);
    const breaking = changes.filter((ch) => ch.kind === 'breaking');
    assert(breaking.length === 0, `diff '${d.label}' should be compatible, got: ${breaking.map((b) => b.reason).join('; ')}`);
    assert(
      changes.some((ch) => ch.kind === 'compatible' && ch.reason.includes(d.reasonIncludes)),
      `diff '${d.label}' should yield a compatible change: "${d.reasonIncludes}"`,
    );
  }
  // ... and every described rule is one diff() really emits, proved by a case above.
  const unexercised = Object.keys(DIFF_RULES).filter((id) => !emittedRules.has(id));
  assert(unexercised.length === 0, `every DIFF_RULES entry needs a BREAKING_DIFFS or COMPATIBLE_DIFFS case; none for: ${unexercised.join(', ')}`);

  // 4. reachability: a binding alone makes a routine a consumer of the producer
  // type, and a property binding alone makes its type a consumer of the referenced type
  assert(
    reverseReachable(sample, ['order']).includes('shipment'),
    "'shipment' should consume 'order' through its 'shipment.orderId' binding",
  );
  const unreferenced = deepClone(sample);
  delete findProperty(unreferenced, 'shipment', 'orderId').binds;
  assert(
    !reverseReachable(unreferenced, ['order']).includes('shipment'),
    "'shipment' should reach 'order' only through 'shipment.orderId'",
  );
  assert(
    reverseReachable(unreferenced, ['order']).includes(DISPATCH),
    `'${DISPATCH}' should consume 'order' through its 'order.id' binding`,
  );
  const unbound = deepClone(unreferenced);
  delete findParam(unbound, DISPATCH, 'OrderId').binds;
  assert(
    !reverseReachable(unbound, ['order']).includes(DISPATCH),
    `'${DISPATCH}' should reach 'order' only through its binding and through 'shipment'`,
  );

  // 5. mutate: the breaking-change gate
  let mutateRefusals = 0;
  let mutateAccepts = 0;
  const refuse = (label: string, result: ReturnType<typeof mutate>): Set<string> => {
    assert(result.model === null, `mutate ${label} should be REFUSED`);
    mutateRefusals++;
    const refusedCodes = errorCodes(result.findings);
    for (const c of refusedCodes) provenCodes.add(c);
    return refusedCodes;
  };
  const accept = (label: string, result: ReturnType<typeof mutate>): Model => {
    const errs = errorsOf(result.findings);
    assert(
      result.model !== null && errs.length === 0,
      `mutate ${label} should be ACCEPTED, got: ${errs.map((f) => `${f.code} ${f.path}`).join('; ')}`,
    );
    mutateAccepts++;
    return result.model;
  };

  // A boolean takes no length bounds, so the change clears them (null removes).
  const noteToBoolean: Patch = {
    op: 'changeProperty',
    typeId: 'order',
    propertyName: 'note',
    set: { kind: 'boolean', bounds: null },
  };
  const bumpOrder: Patch = { op: 'setVersion', target: 'type', id: 'order', version: 2 };
  const repinImports: Patch[] = [
    { op: 'changeWorkflowImport', workflowId: 'wf.checkout', typeId: 'order', version: 2 },
    { op: 'changeWorkflowImport', workflowId: 'wf.reporting', typeId: 'order', version: 2 },
  ];

  // (a) kind change string -> boolean without a version bump
  const a = mutate(sample, noteToBoolean);
  const aCodes = refuse('(a) kind change without version bump', a);
  const aBump = a.findings.find((f) => f.code === FINDING.BREAKING_CHANGE_WITHOUT_VERSION_BUMP);
  assert(aBump, `(a) should yield BREAKING_CHANGE_WITHOUT_VERSION_BUMP, got: ${list(aCodes)}`);
  assert(aBump.path === 'types/order/version', `(a) the bump finding should name type 'order'`);
  assert(aBump.impact?.includes(PLACE), `(a) impact should include the bound routine '${PLACE}'`);
  assert(aBump.fix?.includes("'order'"), '(a) the bump finding should carry a fix naming the type');
  assert(deepEqual(sample, sampleModel()), 'mutate must not modify its input model');

  // (b) version bumped but not acknowledged
  const bCodes = refuse('(b) bump without acknowledgment', mutate(sample, [bumpOrder, noteToBoolean]));
  assert(bCodes.has(FINDING.BREAKING_CHANGE_UNACKNOWLEDGED), `(b) should yield BREAKING_CHANGE_UNACKNOWLEDGED, got: ${list(bCodes)}`);
  assert(!bCodes.has(FINDING.BREAKING_CHANGE_WITHOUT_VERSION_BUMP), '(b) a bumped version should satisfy the bump rule');

  // (c) bump + acknowledgment, but the bound consumer still declares the old kind
  const typeSide: Patch[] = [bumpOrder, noteToBoolean, ...repinImports];
  const c = mutate(sample, typeSide, { acknowledgeBreaking: ['order'] });
  const cCodes = refuse('(c) consumer binding left stale', c);
  assert(
    cCodes.size === 1 && cCodes.has(FINDING.BINDING_KIND_MISMATCH),
    `(c) the only error should be BINDING_KIND_MISMATCH, got: ${list(cCodes)}`,
  );
  const cHit = c.findings.find((f) => f.code === FINDING.BINDING_KIND_MISMATCH);
  assert(cHit?.path === `routines/${PLACE}/params/p_note/binds`, '(c) the mismatch should name the stale param');

  // (d) the full correct batch is ACCEPTED atomically
  const newParams = findRoutine(sample, PLACE).params.map((p) =>
    p.name === 'p_note' ? { ...p, kind: 'boolean' as Kind } : p,
  );
  const d = mutate(
    sample,
    [...typeSide, { op: 'changeRoutine', routineId: PLACE, set: { params: newParams, version: 2 } }],
    { acknowledgeBreaking: ['order', PLACE] },
  );
  const dModel = accept('(d) complete breaking batch', d);
  assert(
    d.changes.some((ch) => ch.kind === 'breaking' && ch.element === 'order') &&
      d.changes.some((ch) => ch.kind === 'breaking' && ch.element === PLACE),
    '(d) the accepted batch should still report both breaking changes',
  );
  exportModel(dModel);
  project(dModel, 'json-schema');
  project(dModel, 'openapi');

  // (l) a compatible change needs neither a version bump nor an acknowledgment
  const l = mutate(sample, {
    op: 'addProperty',
    typeId: 'order',
    property: { name: 'label', kind: 'string', required: false, nullable: true, immutable: false, origin: 'client' },
  });
  accept('(l) compatible change', l);
  assert(l.changes.length > 0 && l.changes.every((ch) => ch.kind === 'compatible'), '(l) changes should all be compatible');
  assert(l.impact.length > 0, '(l) an accepted mutation should report the impact set of order');

  // (j) an HTTP path change is refused without a bump, accepted with bump + ack
  const v2Binding = [{ transport: 'http', method: 'POST', path: '/v2/orders' }];
  const jCodes = refuse(
    '(j) HTTP path change without bump',
    mutate(sample, { op: 'changeOperation', operationId: 'order.place', set: { bindings: v2Binding } }),
  );
  assert(jCodes.has(FINDING.BREAKING_CHANGE_WITHOUT_VERSION_BUMP), `(j) should require a bump, got: ${list(jCodes)}`);
  accept(
    '(j) HTTP path change with bump + ack',
    mutate(
      sample,
      { op: 'changeOperation', operationId: 'order.place', set: { bindings: v2Binding, version: 2 } },
      { acknowledgeBreaking: ['order.place'] },
    ),
  );

  // (w) the README Walkthrough: order.id from string to integer reaches both
  // bound routines and shipment.orderId, the property that references order.id.
  const w1 = mutate(sample, { op: 'changeProperty', typeId: 'order', propertyName: 'id', set: { kind: 'integer' } });
  refuse('(w1) order.id to integer as a single patch', w1);
  const staleBindings = w1.findings.filter((f) => f.code === FINDING.BINDING_KIND_MISMATCH).map((f) => f.path).sort();
  const expectedStale = [`routines/${DISPATCH}/params/OrderId/binds`, `routines/${PLACE}/resultSet/order_id/binds`, ORDER_REF].sort();
  assert(
    canonicalStringify(staleBindings) === canonicalStringify(expectedStale),
    `(w1) BINDING_KIND_MISMATCH should name ${expectedStale.join(', ')}, got: ${staleBindings.join(', ')}`,
  );
  const w1Ref = w1.findings.find((f) => f.code === FINDING.BINDING_KIND_MISMATCH && f.path === ORDER_REF);
  assert(
    w1Ref?.fix?.includes("set property 'orderId' kind to 'integer'") && w1Ref.fix.includes("list 'shipment' in acknowledgeBreaking"),
    '(w1) the shipment.orderId finding should tell the consumer to retype, bump and acknowledge shipment',
  );
  assert(w1.impact.includes('shipment'), "(w1) the impact of changing 'order' should include 'shipment'");

  const walkthroughOrder: Patch[] = [
    bumpOrder,
    { op: 'changeProperty', typeId: 'order', propertyName: 'id', set: { kind: 'integer', bounds: null } },
    {
      op: 'changeRoutine',
      routineId: PLACE,
      set: {
        version: 2,
        resultSet: [
          { name: 'order_id', kind: 'integer', nullable: false, binds: 'order.id' },
          { name: 'status', kind: 'enum', nullable: false, binds: 'order.status' },
        ],
      },
    },
    {
      op: 'changeRoutine',
      routineId: DISPATCH,
      set: {
        version: 2,
        params: [
          { name: 'OrderId', kind: 'integer', required: true, nullable: false, binds: 'order.id' },
          { name: 'InitialState', kind: 'enum', required: false, nullable: false, binds: 'shipment.state' },
          { name: 'Notify', kind: 'boolean', required: false, nullable: false },
        ],
      },
    },
    ...repinImports,
  ];
  const shipmentRetype: Patch[] = [
    { op: 'changeProperty', typeId: 'shipment', propertyName: 'orderId', set: { kind: 'integer', bounds: null } },
    { op: 'setVersion', target: 'type', id: 'shipment', version: 2 },
  ];
  const repinShipment: Patch = { op: 'changeWorkflowImport', workflowId: 'wf.fulfil', typeId: 'shipment', version: 2 };
  const walkthroughAck = ['order', PLACE, DISPATCH, 'shipment'];

  // (w2) the batch that fixes only the routines leaves the referencing property stale
  const w2 = mutate(sample, walkthroughOrder, { acknowledgeBreaking: ['order', PLACE, DISPATCH] });
  const w2Codes = refuse('(w2) Walkthrough batch without the shipment changes', w2);
  const w2Errors = errorsOf(w2.findings);
  assert(
    w2Errors.length === 1 && w2Errors[0]?.code === FINDING.BINDING_KIND_MISMATCH && w2Errors[0]?.path === ORDER_REF,
    `(w2) the only error should be BINDING_KIND_MISMATCH at ${ORDER_REF}, got: ${list(w2Codes)}`,
  );

  // (w3) bumping shipment without its pinned workflow is refused by the existing pin rule
  const w3 = mutate(sample, [...walkthroughOrder, ...shipmentRetype], { acknowledgeBreaking: walkthroughAck });
  refuse('(w3) Walkthrough batch with a stale wf.fulfil pin', w3);
  const w3Errors = errorsOf(w3.findings);
  assert(
    w3Errors.length === 1 &&
      w3Errors[0]?.code === FINDING.WORKFLOW_IMPORT_VERSION_MISMATCH &&
      w3Errors[0]?.path === 'workflows/wf.fulfil/imports/shipment',
    `(w3) the only error should be the stale wf.fulfil pin of shipment, got: ${w3Errors.map((f) => `${f.code} ${f.path}`).join('; ')}`,
  );

  // (w4) the complete Walkthrough batch is ACCEPTED, one breaking change per acknowledged element
  const w4 = mutate(sample, [...walkthroughOrder, ...shipmentRetype, repinShipment], { acknowledgeBreaking: walkthroughAck });
  const w4Model = accept('(w4) complete Walkthrough batch', w4);
  const w4Broken = w4.changes.filter((ch) => ch.kind === 'breaking');
  assert(
    canonicalStringify(w4Broken.map((ch) => ch.element).sort()) === canonicalStringify([...walkthroughAck].sort()),
    `(w4) the breaking changes should be one per acknowledged element, got: ${w4Broken.map((ch) => ch.element).join(', ')}`,
  );
  const w4Sql = project(w4Model, 'sql') as string;
  assert(
    w4Sql.includes('[orderId] BIGINT NOT NULL') && w4Sql.includes('FOREIGN KEY ([orderId]) REFERENCES [ordering].[orders] ([id])'),
    '(w4) the accepted model should project shipments.orderId as BIGINT with its foreign key',
  );

  // increment-1 cascade: a newly-required property breaks the creation mutation
  const reqCodes = refuse(
    'adding a required property',
    mutate(sample, {
      op: 'addProperty',
      typeId: 'order',
      property: { name: 'priority', kind: 'integer', required: true, nullable: false, immutable: false, origin: 'client' },
    }),
  );
  assert(reqCodes.has(FINDING.MUTATION_CREATION_MISSING_REQUIRED), 'required property should break the creation mutation');

  // structural: a patch that sets an illegal value is refused, never exported
  const sCodes = refuse(
    'patch with an illegal kind',
    mutate(sample, {
      op: 'changeProperty',
      typeId: 'order',
      propertyName: 'total',
      set: { kind: 'decimal' as unknown as Kind },
    }),
  );
  assert(sCodes.has(FINDING.STRUCTURAL_INVALID), `illegal kind should be STRUCTURAL_INVALID, got: ${list(sCodes)}`);

  // atomicity: one missing target refuses the whole batch
  const t = mutate(sample, [
    {
      op: 'addProperty',
      typeId: 'order',
      property: { name: 'label', kind: 'string', required: false, nullable: true, immutable: false, origin: 'client' },
    },
    { op: 'changeProperty', typeId: 'ghost', propertyName: 'x', set: {} },
  ]);
  refuse('batch with a missing target', t);
  assert(
    t.findings.length === 1 && t.findings[0]?.code === FINDING.PATCH_TARGET_NOT_FOUND && t.findings[0]?.path === 'patches[1]',
    'a missing target should refuse the whole batch with PATCH_TARGET_NOT_FOUND at patches[1]',
  );

  // a change op may set only its listed fields
  const fCodes = refuse(
    'changeRoutine setting a disallowed field',
    mutate(sample, {
      op: 'changeRoutine',
      routineId: PLACE,
      set: { owner: 'billing' } as never,
    }),
  );
  assert(fCodes.has(FINDING.PATCH_INVALID), `a disallowed field should be PATCH_INVALID, got: ${list(fCodes)}`);

  // Every finding code is proven to fire, by a contradiction or a mutate refusal.
  const unproven = codes.filter((c) => !provenCodes.has(c));
  assert(unproven.length === 0, `every finding code needs a CONTRADICTIONS entry or a mutate refusal that raises it; none for: ${unproven.join(', ')}`);

  // 6. determinism of the export and of every projection
  const s1 = exportModel(sample);
  const s2 = exportModel(sampleModel());
  assert(s1 === s2, 'exportModel must be deterministic for the same model');
  const serialize = (v: unknown): string => (typeof v === 'string' ? v : canonicalStringify(v));
  for (const target of PROJECTION_TARGETS) {
    assert(
      serialize(project(sample, target)) === serialize(project(sampleModel(), target)),
      `projection '${target}' must be deterministic`,
    );
  }
  const files = projectToFiles(sample);
  assert(canonicalStringify(files) === canonicalStringify(projectToFiles(sampleModel())), 'projectToFiles must be deterministic');
  assert(
    canonicalStringify(Object.keys(files).sort()) === canonicalStringify(Object.keys(PROJECTION_FILES).sort()),
    'projectToFiles must emit exactly the PROJECTION_FILES',
  );

  // 7. round-trip losslessness, from JSON and from YAML
  const roundTripped = importModel(s1);
  assert(exportModel(roundTripped) === s1, 'export(import(x)) must equal x');
  assert(deepEqual(roundTripped, sample), 'import(export(model)) must deep-equal the model');
  const fromYaml = importModel(files['model.yaml'] ?? '');
  assert(deepEqual(fromYaml, sample), 'import(model.yaml) must deep-equal the model');
  assert(exportModel(fromYaml) === s1, 'export(import(model.yaml)) must equal the canonical JSON');

  // 8. fail-closed: every projection, projectToFiles and export throw on an invalid model
  const invalid = deepClone(sample);
  findOperation(invalid, 'order.place').request = 'ghost-type';
  for (const target of PROJECTION_TARGETS) {
    assertThrows(() => project(invalid, target), `project('${target}') on invalid model`);
  }
  assertThrows(() => projectToFiles(invalid), 'projectToFiles on invalid model');
  assertThrows(() => exportModel(invalid), 'exportModel on invalid model');

  // 9. every artifact carries the source notice in its own syntax and ends in one newline
  const noticeLine: Record<string, string> = {
    '.sql': `-- ${SOURCE_NOTICE}`,
    '.ps1': `# ${SOURCE_NOTICE}`,
    '.yaml': `# ${SOURCE_NOTICE}`,
    '.md': `<!-- ${SOURCE_NOTICE} -->`,
  };
  for (const [file, text] of Object.entries(files)) {
    assert(text.endsWith('\n') && !text.endsWith('\n\n'), `${file} must end in exactly one newline`);
    if (file.endsWith('.json')) {
      assert(text.includes(SOURCE_NOTICE), `${file} must carry the source notice`);
      continue;
    }
    const line = noticeLine[file.slice(file.lastIndexOf('.'))];
    assert(line && text.startsWith(`${line}\n`), `${file} must begin with the source notice`);
  }

  // 10. spot assertions on each artifact
  const sql = files['schema.sql'] ?? '';
  assert(sql.includes('CREATE TABLE [ordering].[orders] ('), 'schema.sql should create [ordering].[orders]');
  assert(sql.includes('CONSTRAINT [PK_orders] PRIMARY KEY ([id])'), 'schema.sql should declare the orders primary key');
  assert(
    sql.includes("CONSTRAINT [CK_orders_status] CHECK ([status] IN (N'placed', N'paid', N'shipped', N'cancelled'))"),
    'schema.sql should constrain the status enum',
  );
  assert(
    sql.includes('[id] NVARCHAR(64) NOT NULL') && sql.includes('[note] NVARCHAR(280) NULL') && sql.includes('[total] FLOAT NOT NULL'),
    'schema.sql should map kinds, lengths and nullability',
  );
  assert(sql.includes('CREATE TABLE [billing].[invoices] ('), 'an unqualified table should land in its owner schema');
  const foreignKey =
    'ALTER TABLE [fulfillment].[shipments] ADD CONSTRAINT [FK_shipments_orderId] FOREIGN KEY ([orderId]) REFERENCES [ordering].[orders] ([id]);';
  assert(sql.includes(foreignKey), 'schema.sql should add the shipments.orderId foreign key');
  assert(sql.indexOf(foreignKey) > sql.lastIndexOf('CREATE TABLE '), 'schema.sql should add foreign keys after every CREATE TABLE');

  const contract = files['contract-tests.sql'] ?? '';
  const procedures = sample.routines.filter((r) => r.host === 'sql-procedure');
  for (const r of procedures) {
    const { schema, name } = procedureName(r);
    assert(
      contract.includes(`THROW 50001, N'Loom contract: procedure [${schema}].[${name}] does not exist', 1;`),
      `contract-tests.sql should THROW when procedure ${r.id} is missing`,
    );
  }
  assert((contract.match(/THROW 50001,/g) ?? []).length === procedures.length, 'one existence THROW per procedure');
  assert((contract.match(/THROW 50011,/g) ?? []).length === sample.types.filter((t) => t.table).length, 'one table block per typed table');
  // Every sample type is table-backed, so every property binding is a foreign key.
  const referencing = sample.types.flatMap((t) => t.properties.filter((p) => p.binds !== undefined)).length;
  assert(
    referencing > 0 && (contract.match(/THROW 50015,/g) ?? []).length === referencing,
    'one foreign-key check per referencing property',
  );
  assert(
    contract.includes(
      "THROW 50015, N'Loom contract: table [fulfillment].[shipments] column [orderId] has no enabled single-column foreign key referencing [ordering].[orders] ([id])', 1;",
    ),
    'contract-tests.sql should THROW when the shipments.orderId foreign key is missing',
  );
  assert(contract.includes("(VALUES (1, N'@p_total'), (2, N'@p_note'))"), 'the parameter contract should list names in order');
  const contractCode = contract
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n')
    .replace(/N'(?:[^']|'')*'/g, "N''");
  assert(
    !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|EXEC|EXECUTE|TRUNCATE|GRANT|DENY|REVOKE)\b/i.test(contractCode),
    'contract-tests.sql must be read-only (SELECT and THROW only)',
  );

  const pester = files['Routines.Contract.Tests.ps1'] ?? '';
  const scripted = sample.routines.filter((r) => (r.host === 'runbook' || r.host === 'function') && r.source);
  for (const r of scripted) {
    assert(pester.includes(`Describe 'Routine ${r.id} (`), `the Pester file should hold a Describe for ${r.id}`);
  }
  assert((pester.match(/^Describe '/gm) ?? []).length === scripted.length, 'one Describe per scripted routine');
  assert(
    pester.includes("Compare-Object -ReferenceObject @('pending', 'dispatched', 'delivered')"),
    'an enum param bound to an enum property should be checked against its ValidateSet',
  );

  const workflows = files['workflows.md'] ?? '';
  const stateful = sample.types.filter((t) => t.stateProperty !== undefined).length;
  assert((workflows.match(/^stateDiagram-v2$/gm) ?? []).length === stateful, 'one state diagram per stateful type');
  assert((workflows.match(/^flowchart LR$/gm) ?? []).length === 1, 'one workflow flowchart');
  assert(workflows.includes('[*] --> s0 : order.create'), 'a creation mutation should start from [*]');

  const reference = files['reference.md'] ?? '';
  for (const c of sample.components) {
    assert(reference.includes(`## Component \`${c.id}\``), `reference.md should hold a section for component ${c.id}`);
  }
  assert(reference.includes('## Consumers index') && reference.includes('stateDiagram-v2'), 'reference.md should index consumers and embed the diagrams');
  const unlisted = [
    ...Object.values(FINDING).filter((c) => !reference.includes(`| \`${c}\` | ${FINDING_RULES[c].severity} |`)),
    ...(Object.entries(DIFF_RULES) as Array<[string, DiffRule]>)
      .filter(([id, r]) => !reference.includes(`| \`${id}\` | ${r.subject} | ${r.kind} |`))
      .map(([id]) => id),
  ];
  assert(reference.includes('\n## Rules\n') && unlisted.length === 0, `reference.md should list every rule; missing: ${unlisted.join(', ')}`);

  // 11. json-schema projection compiles under Ajv (2020-12) and gates payloads
  const payloadsChecked = checkJsonSchemaProjection(sample);

  const rejected = CONTRADICTIONS.length + BREAKING_DIFFS.length + mutateRefusals;
  const acceptedCount = COMPATIBLE_DIFFS.length + mutateAccepts;
  console.log(
    `loom self-test PASS: ${rejected} contradictions rejected ` +
      `(${CONTRADICTIONS.length} validate, ${BREAKING_DIFFS.length} breaking diff, ${mutateRefusals} mutate refusal), ` +
      `${acceptedCount} correct changes accepted (${COMPATIBLE_DIFFS.length} compatible diff, ${mutateAccepts} mutate), ` +
      `${PROJECTION_TARGETS.length} projection targets deterministic and fail-closed, ` +
      `${payloadsChecked} schema payloads checked, JSON and YAML round-trip lossless, ` +
      `${codes.length} finding codes described and proven to fire, ${emittedRules.size} change rules described and exercised, all listed in reference.md.`,
  );
}

function checkJsonSchemaProjection(model: Model): number {
  const schema = project(model, 'json-schema') as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(schema);

  // Compiling a $ref to every type forces each projected schema to compile.
  let orderValidate: ((data: unknown) => boolean) | null = null;
  for (const t of model.types) {
    const v = ajv.compile({ $ref: `${JSON_SCHEMA_ID}#/$defs/${t.id}` });
    if (t.id === 'order') orderValidate = v as (data: unknown) => boolean;
  }
  assert(orderValidate, 'order schema should compile from the json-schema projection');

  const cases: Array<{ data: unknown; valid: boolean; label: string }> = [
    { data: { id: 'o1', status: 'placed', total: 9.99 }, valid: true, label: 'minimal valid order' },
    { data: { id: 'o2', status: 'placed', total: 0, note: null }, valid: true, label: 'nullable note = null' },
    { data: { id: 'o3', status: 'paid', total: 5, note: 'thanks' }, valid: true, label: 'full valid order' },
    { data: { id: 'o4', status: 'placed' }, valid: false, label: 'missing required total' },
    { data: { id: 'o5', status: 'frozen', total: 5 }, valid: false, label: 'status not in enum' },
    { data: { id: 'o6', status: 'placed', total: 'free' }, valid: false, label: 'total wrong type' },
    { data: { id: 'o7', status: 'placed', total: 5, extra: true }, valid: false, label: 'extra property rejected' },
  ];
  for (const c of cases) {
    const ok = orderValidate(c.data);
    assert(ok === c.valid, `payload '${c.label}' should be ${c.valid ? 'accepted' : 'rejected'}`);
  }
  return cases.length;
}
