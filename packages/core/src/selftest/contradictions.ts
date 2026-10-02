import type { FindingCode, Model, TypeDef, Operation, Routine, Mutation, Storage } from '../generated/types.js';
import { pick } from './harness.js';

/** A deliberate contradiction of the valid sample and the code that must catch it. */
export interface Contradiction {
  label: string;
  code: FindingCode;
  pathIncludes?: string;
  break(m: Model): void;
}

const type = (m: Model, id: string): TypeDef => pick(m.types, id);
const op = (m: Model, id: string): Operation => pick(m.operations, id);
const routine = (m: Model, id: string): Routine => pick(m.routines, id);
const mutation = (m: Model, id: string): Mutation => pick(m.mutations, id);
const storage = (m: Model, id: string): Storage => pick(m.storage, id);
const prop = (m: Model, typeId: string, name: string) => pick(type(m, typeId).properties, name);
const column = (m: Model, storageId: string, name: string) => pick(storage(m, storageId).columns, name);

export const CONTRADICTIONS: readonly Contradiction[] = [
  { label: 'an unknown member is structurally invalid', code: 'STRUCTURAL_INVALID', break: (m) => Object.assign(type(m, 'order'), { table: 'orders' }) },
  { label: 'a fractional negative length is structurally invalid', code: 'STRUCTURAL_INVALID', pathIncludes: 'maxLength', break: (m) => (prop(m, 'order', 'note').bounds = { maxLength: -1.5 }) },
  { label: 'another model format is refused, not reinterpreted', code: 'MODEL_FORMAT_UNSUPPORTED', break: (m) => Object.assign(m, { version: 2 }) },
  { label: 'two records share an id', code: 'DUPLICATE_ID', break: (m) => m.components.push({ id: 'order', purpose: 'Clashes with the type.', responsibilities: [] }) },
  { label: 'a criterion id repeats a record id', code: 'DUPLICATE_ID', break: (m) => (pick(m.requirements, 'req.pay-order').criteria[0]!.id = 'order') },
  {
    label: 'a duplicate property name is rejected',
    code: 'DUPLICATE_KEY',
    pathIncludes: 'properties/note',
    break: (m) => type(m, 'order').properties.push({ name: 'note', kind: 'string', required: false, nullable: true, immutable: false, origin: 'client' }),
  },
  { label: 'a reference names no record', code: 'DANGLING_REF', pathIncludes: 'owner', break: (m) => (type(m, 'order').owner = 'nowhere') },
  { label: 'a reference names a record of another kind', code: 'REFERENCE_KIND_MISMATCH', break: (m) => (op(m, 'order.place').request = 'order.pay') },
  { label: 'a pinned published contract is not resolved in plain validation', code: 'PUBLISHED_CONTRACT_UNRESOLVED', break: (m) => {
    m.publishedContracts.push({ id: 'payments', publisher: 'team-payments', contract: 'payments-api', version: 1, digest: `sha256:${'a'.repeat(64)}`, schemaVersion: 1, consumers: ['billing'] });
    type(m, 'invoice').properties.push({ name: 'payment', kind: 'ref', ref: 'payments:payment', required: false, nullable: true, immutable: false, origin: 'external' });
  } },
  { label: 'length bounds on a non-string', code: 'BOUNDS_KIND_MISMATCH', break: (m) => (prop(m, 'order', 'total').bounds = { maxLength: 3 }) },
  { label: 'an inverted range', code: 'BOUNDS_INVERTED', break: (m) => (prop(m, 'order', 'note').bounds = { minLength: 10, maxLength: 5 }) },
  { label: 'an enum without values', code: 'ENUM_WITHOUT_VALUES', break: (m) => (prop(m, 'invoice', 'state').enumValues = []) },
  { label: 'an enum value listed twice', code: 'ENUM_DUPLICATE_VALUE', break: (m) => prop(m, 'invoice', 'state').enumValues!.push('draft') },
  { label: 'a decimal without precision', code: 'DECIMAL_SHAPE_INVALID', break: (m) => delete prop(m, 'invoice', 'amount').decimal },
  { label: 'a scale above the precision', code: 'DECIMAL_SHAPE_INVALID', break: (m) => (prop(m, 'invoice', 'amount').decimal = { precision: 2, scale: 4 }) },
  { label: 'a ref without its type', code: 'VALUE_SHAPE_INCOMPLETE', break: (m) => type(m, 'invoice').properties.push({ name: 'customer', kind: 'ref', required: false, nullable: true, immutable: false, origin: 'client' }) },
  { label: 'a literal default of the wrong kind', code: 'DEFAULT_KIND_MISMATCH', break: (m) => (prop(m, 'order', 'note').default = { policy: 'literal', value: 3, appliesOn: 'create' }) },
  { label: 'a state property that is not an enum', code: 'TYPE_STATE_PROPERTY_INVALID', break: (m) => (type(m, 'order').stateProperty = 'total') },
  { label: 'a key naming an optional property', code: 'TYPE_KEY_INVALID', break: (m) => (type(m, 'order').key = ['note']) },
  { label: 'a binds to a non-key property', code: 'BINDING_NOT_KEY', break: (m) => (prop(m, 'shipment', 'orderId').binds = 'order.total') },
  { label: 'a binds of another kind', code: 'BINDING_KIND_MISMATCH', break: (m) => Object.assign(prop(m, 'shipment', 'orderId'), { kind: 'integer', bounds: undefined }) },
  { label: 'a stored reference of another width', code: 'BINDING_SQL_TYPE_MISMATCH', break: (m) => (column(m, 'fulfillment.shipments', 'order_id').sqlType = { name: 'nvarchar', length: 128 }) },
  { label: 'a routine param of other nullability than its binds', code: 'BINDING_NULLABILITY_MISMATCH', break: (m) => (pick(routine(m, 'ordering.sp_place_order').params, 'p_total').nullable = true) },
  { label: 'an enum param without binds', code: 'ENUM_PARAM_UNBOUND', break: (m) => delete pick(routine(m, 'fulfillment.rb_dispatch').params, 'InitialState').binds },
  { label: 'a storage record of another owner', code: 'STORAGE_NONOWNER', break: (m) => (storage(m, 'billing.invoices').owner = 'ordering') },
  { label: 'two storage records on one table', code: 'STORAGE_TABLE_DUPLICATE', break: (m) => Object.assign(storage(m, 'billing.invoices'), { schema: 'ordering', table: 'orders', owner: 'billing' }) },
  { label: 'a primary key on a nullable column', code: 'STORAGE_KEY_INVALID', break: (m) => (storage(m, 'ordering.orders').primaryKey = ['note']) },
  { label: 'a primary key wider than 900 bytes', code: 'STORAGE_KEY_WIDE', break: (m) => {
    prop(m, 'order', 'id').bounds = { minLength: 1, maxLength: 600 };
    column(m, 'ordering.orders', 'id').sqlType = { name: 'nvarchar', length: 600 };
    for (const t of ['shipment', 'invoice']) prop(m, t, 'orderId').bounds = { minLength: 1, maxLength: 600 };
    column(m, 'fulfillment.shipments', 'order_id').sqlType = { name: 'nvarchar', length: 600 };
    column(m, 'billing.invoices', 'order_id').sqlType = { name: 'nvarchar', length: 600 };
  } },
  { label: 'a column mapping an unknown property', code: 'STORAGE_COLUMN_UNKNOWN_PROPERTY', break: (m) => (column(m, 'ordering.orders', 'note').property = 'memo') },
  { label: 'a decimal stored as float', code: 'STORAGE_COLUMN_TYPE_MISMATCH', break: (m) => (column(m, 'ordering.orders', 'total').sqlType = { name: 'float' }) },
  { label: 'a decimal stored with fewer digits', code: 'STORAGE_COLUMN_LOSSY', break: (m) => (column(m, 'ordering.orders', 'total').sqlType = { name: 'decimal', precision: 10, scale: 1 }) },
  { label: 'a nullable property in a NOT NULL column', code: 'STORAGE_COLUMN_NULLABILITY_MISMATCH', break: (m) => (column(m, 'ordering.orders', 'note').nullable = false) },
  { label: 'a required property without a column', code: 'STORAGE_PROPERTY_UNMAPPED', break: (m) => {
    const s = storage(m, 'ordering.orders');
    s.columns = s.columns.filter((c) => c.name !== 'total');
    s.checks = [];
  } },
  { label: 'a foreign key to a non-key column', code: 'STORAGE_FOREIGN_KEY_INVALID', break: (m) => (storage(m, 'fulfillment.shipments').foreignKeys![0]!.referencedColumns = ['status']) },
  { label: 'an incomplete physical type', code: 'STORAGE_TYPE_UNSUPPORTED', break: (m) => (column(m, 'ordering.orders', 'note').sqlType = { name: 'nvarchar' }) },
  { label: 'an HTTP binding without a path', code: 'HTTP_BINDING_INCOMPLETE', break: (m) => delete op(m, 'order.get').bindings![0]!.path },
  { label: 'a malformed route', code: 'HTTP_ROUTE_INVALID', break: (m) => (op(m, 'order.get').bindings![0]!.path = '/orders//{id}') },
  { label: 'two operations on one method and route', code: 'HTTP_ROUTE_DUPLICATE', break: (m) => Object.assign(op(m, 'order.get').bindings![0]!, { method: 'POST', path: '/orders', parameters: [] }) },
  { label: 'a template variable without its parameter', code: 'HTTP_PATH_PARAMETER_UNDECLARED', break: (m) => (op(m, 'order.get').bindings![0]!.parameters = []) },
  { label: 'a path parameter missing from the route', code: 'HTTP_PARAMETER_NOT_IN_PATH', break: (m) => op(m, 'order.get').bindings![0]!.parameters!.push({ name: 'version', in: 'path', kind: 'integer', required: true }) },
  { label: 'a parameter carrying an unknown property', code: 'HTTP_PARAMETER_UNKNOWN_PROPERTY', break: (m) => op(m, 'order.place').bindings![0]!.parameters!.push({ name: 'currency', in: 'query', property: 'currency', required: false }) },
  { label: 'a GET that would need a body', code: 'HTTP_BODY_NOT_ALLOWED', break: (m) => (op(m, 'order.get').request = 'order-request') },
  { label: 'an accepted response on a synchronous operation', code: 'HTTP_RESPONSE_INVALID', break: (m) => op(m, 'order.place').bindings![0]!.responses!.push({ status: 202, kind: 'accepted', description: 'Accepted.' }) },
  { label: 'an HTTP operation without a security scheme', code: 'OPERATION_SECURITY_UNDECLARED', break: (m) => delete op(m, 'order.get').authority.scheme },
  { label: 'a query that invokes a mutation', code: 'OPERATION_INVOCATION_INVALID', break: (m) => (op(m, 'order.get').invokes = [{ kind: 'mutation', id: 'order.pay' }]) },
  { label: 'an operation exchanging a storage representation', code: 'OPERATION_REPRESENTATION_MISMATCH', break: (m) => (type(m, 'order-response').representation = 'storage') },
  { label: 'a routine writing another component\'s storage', code: 'ROUTINE_NONOWNER_STORAGE_WRITE', break: (m) => {
    const r = routine(m, 'fulfillment.rb_dispatch');
    r.writes!.push({ storage: 'ordering.orders', columns: ['status'] });
    r.transactionScope!.push('ordering.orders');
  } },
  { label: 'a routine performing another component\'s mutation', code: 'ROUTINE_MUTATION_OWNER_MISMATCH', break: (m) => routine(m, 'fulfillment.rb_dispatch').performsMutations.push('order.pay') },
  { label: 'a routine without result columns', code: 'ROUTINE_EMPTY_RESULTSET', break: (m) => (routine(m, 'fulfillment.rb_dispatch').resultSet = []) },
  { label: 'a routine missing a written column', code: 'ROUTINE_WRITE_SET_INCOMPLETE', break: (m) => (routine(m, 'ordering.sp_place_order').writes![0]!.columns = ['id', 'status']) },
  { label: 'a routine writing an undeclared column', code: 'ROUTINE_WRITES_UNKNOWN_COLUMN', break: (m) => routine(m, 'ordering.sp_place_order').writes![0]!.columns.push('currency') },
  { label: 'a transaction scope naming undeclared storage', code: 'ROUTINE_TRANSACTION_SCOPE_INVALID', break: (m) => routine(m, 'ordering.sp_place_order').transactionScope!.push('billing.ledger') },
  { label: 'a write outside the transaction scope', code: 'ROUTINE_WRITE_OUTSIDE_TRANSACTION', break: (m) => (routine(m, 'ordering.sp_place_order').transactionScope = ['billing.invoices']) },
  { label: 'a mutation of another component\'s type', code: 'MUTATION_NONOWNER', break: (m) => (mutation(m, 'order.pay').owner = 'billing') },
  { label: 'a mutation on a type without states', code: 'MUTATION_NO_STATE_PROPERTY', break: (m) => {
    m.mutations.push({ id: 'request.touch', type: 'order-request', owner: 'ordering', from: ['placed'], to: 'paid', writes: ['note'], guard: { form: 'prose', text: 'Always.' }, effect: 'Touched.', requirements: ['req.pay-order'], scenarios: ['scn.pay'] });
  } },
  { label: 'an illegal target state', code: 'MUTATION_ILLEGAL_STATE', break: (m) => (mutation(m, 'order.pay').to = 'refunded') },
  { label: 'a write of an unknown property', code: 'MUTATION_WRITE_UNKNOWN_PROPERTY', break: (m) => mutation(m, 'order.pay').writes.push('currency') },
  { label: 'an update writing an immutable property', code: 'MUTATION_IMMUTABLE_WRITE', break: (m) => mutation(m, 'order.pay').writes.push('id') },
  { label: 'a creation missing a required property', code: 'MUTATION_CREATION_MISSING_REQUIRED', break: (m) => (mutation(m, 'order.create').writes = ['id', 'status']) },
  { label: '$absent beside an existing state', code: 'MUTATION_MIXED_ORIGIN', break: (m) => (mutation(m, 'order.pay').from = ['$absent', 'placed']) },
  { label: 'a state change with an empty write set', code: 'MUTATION_STATE_WRITE_UNDECLARED', break: (m) => (mutation(m, 'order.pay').writes = []) },
  { label: 'a mutation without a requirement', code: 'MUTATION_NO_REQUIREMENT', break: (m) => (mutation(m, 'order.pay').requirements = []) },
  { label: 'a mutation without a scenario', code: 'MUTATION_NO_SCENARIO', break: (m) => (mutation(m, 'order.pay').scenarios = []) },
  { label: 'a prose guard without a scenario', code: 'PREDICATE_UNVERIFIED', break: (m) => (mutation(m, 'order.pay').scenarios = []) },
  { label: 'a predicate naming an unknown property', code: 'PREDICATE_PROPERTY_UNKNOWN', break: (m) => (mutation(m, 'order.create').guard = { form: 'expression', profile: 'loom-predicate-1', expression: { op: 'ge', left: { property: 'amount' }, right: { literal: 0 } } }) },
  { label: 'a predicate comparing incompatible kinds', code: 'PREDICATE_TYPE_MISMATCH', break: (m) => (mutation(m, 'order.create').guard = { form: 'expression', profile: 'loom-predicate-1', expression: { op: 'eq', left: { property: 'total' }, right: { literal: 'zero' } } }) },
  { label: 'a workflow dependency cycle', code: 'WORKFLOW_DEPENDENCY_CYCLE', break: (m) => pick(m.workflows, 'wf.checkout').dependsOn.push('wf.fulfil') },
  { label: 'a workflow pinning a stale version', code: 'WORKFLOW_IMPORT_VERSION_MISMATCH', break: (m) => (pick(m.workflows, 'wf.checkout').imports[0]!.version = 2) },
  { label: 'a build dependency cycle', code: 'EDGE_BUILD_CYCLE', break: (m) => m.edges.push({ from: 'wf.checkout', to: 'wf.fulfil', kind: 'build' }) },
  { label: 'a runtime cycle without defined behavior', code: 'EDGE_RUNTIME_CYCLE_UNDEFINED', break: (m) => m.edges.push({ from: 'ordering', to: 'fulfillment', kind: 'runtime' }) },
  { label: 'an active requirement without criteria', code: 'REQUIREMENT_WITHOUT_CRITERIA', break: (m) => {
    pick(m.requirements, 'req.cancel-order').criteria = [];
    mutation(m, 'order.cancel').criteria = [];
    pick(m.scenarios, 'scn.cancel').criteria = [];
  } },
  { label: 'a criterion without its scenario', code: 'CRITERION_UNCOVERED', break: (m) => (pick(m.scenarios, 'scn.pay').criteria = []) },
  { label: 'a machine path in the portable model', code: 'PORTABILITY_VIOLATION', break: (m) => (pick(m.components, 'ordering').purpose = 'Reads D:\\exports\\orders.csv every night.') },
  { label: 'a credential in the portable model', code: 'PORTABILITY_VIOLATION', break: (m) => (pick(m.deploymentUnits, 'du.ordering-api').isolation = 'Server=db;Password=hunter2') },
];
