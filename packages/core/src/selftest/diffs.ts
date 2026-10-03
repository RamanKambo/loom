import type { ChangeKind, Model } from '../generated/types.js';
import type { DiffRuleId } from '../field-policy.js';
import { pick } from './harness.js';

/** One edit of the sample and the classification it must receive. */
export interface DiffCase {
  rule: DiffRuleId;
  /** The expected kind; 'none' asserts the edit yields no change at all. */
  kind: ChangeKind | 'none';
  /** Applied to both sides first, for an edit that needs an existing element. */
  prepare?(m: Model): void;
  edit(m: Model): void;
}

const t = (m: Model, id: string) => pick(m.types, id);
const p = (m: Model, typeId: string, name: string) => pick(t(m, typeId).properties, name);
const op = (m: Model, id: string) => pick(m.operations, id);
const r = (m: Model, id: string) => pick(m.routines, id);
const mu = (m: Model, id: string) => pick(m.mutations, id);
const st = (m: Model, id: string) => pick(m.storage, id);
const prose = (text: string) => ({ form: 'prose' as const, text });
const supported = (m: Model): void => {
  t(m, 'order').supported = [{ version: 1, baseline: 'b1', status: 'supported', retirement: { condition: 'no-active-required-consumers' } }];
};
const attachment = (m: Model): void => {
  m.attachments.push({ id: 'att.store', title: 'Order store rationale', source: { kind: 'document', ref: 'decisions/order-store.md', revision: '1' }, digest: `sha256:${'b'.repeat(64)}`, explains: [{ kind: 'decision', id: 'dec.order-store' }], reviewedAgainst: [] });
};
const migration = (m: Model): void => {
  m.migrations.push({ id: 'mig.orders', contract: { kind: 'storage', id: 'ordering.orders' }, fromVersion: 1, toVersion: 2, dependsOn: [], readers: { old: true, new: true }, writers: { old: false, new: true }, transaction: 'batched', locking: 'Row locks per batch.', recovery: 'roll-forward', evidence: ['migration'] });
};
const pinned = (m: Model): void => {
  m.publishedContracts.push({ id: 'payments', publisher: 'team-payments', contract: 'payments-api', version: 1, digest: `sha256:${'a'.repeat(64)}`, schemaVersion: 1, consumers: ['billing'] });
};

export const DIFF_CASES: readonly DiffCase[] = [
  { rule: 'RECORD_ADDED', kind: 'compatible', edit: (m) => m.components.push({ id: 'audit', purpose: 'Audits orders.', responsibilities: [] }) },
  { rule: 'RECORD_REMOVED', kind: 'breaking', edit: (m) => (m.trustBoundaries = m.trustBoundaries.filter((x) => x.id !== 'tb.public')) },
  { rule: 'MODEL_FORMAT_CHANGED', kind: 'breaking', edit: (m) => Object.assign(m, { version: 2 }) },
  { rule: 'SYSTEM_PROFILE_CHANGED', kind: 'breaking', edit: (m) => m.systemProfile!.traits.push('scheduled') },
  { rule: 'RESPONSIBILITY_CHANGED', kind: 'breaking', edit: (m) => pick(m.components, 'ordering').responsibilities.push('Refunds.') },
  { rule: 'IMPLEMENTATION_CHANGED', kind: 'compatible', edit: (m) => pick(m.components, 'billing').implementations!.push({ language: 'csharp', module: 'Billing.Contracts' }) },
  { rule: 'OWNER_CHANGED', kind: 'breaking', edit: (m) => (t(m, 'invoice').owner = 'ordering') },
  { rule: 'ACCOUNTABLE_OWNER_CHANGED', kind: 'compatible', edit: (m) => (pick(m.requirements, 'req.pay-order').owner = 'team-payments') },
  { rule: 'NOT_APPLICABLE_CHANGED', kind: 'compatible', edit: (m) => (pick(m.components, 'billing').notApplicable = [{ concern: 'operation.errors', reason: 'Billing has no HTTP operations.' }]) },
  { rule: 'REPRESENTATION_CHANGED', kind: 'breaking', edit: (m) => (t(m, 'order-request').representation = 'domain') },
  { rule: 'VISIBILITY_CHANGED', kind: 'breaking', edit: (m) => (t(m, 'order').visibility = 'public') },
  { rule: 'STATE_PROPERTY_CHANGED', kind: 'breaking', edit: (m) => delete t(m, 'invoice').stateProperty },
  { rule: 'KEY_CHANGED', kind: 'breaking', edit: (m) => (t(m, 'order').key = ['id', 'status']) },
  { rule: 'EXTERNAL_SCHEMA_CHANGED', kind: 'breaking', edit: (m) => (t(m, 'invoice').externalSchema = { source: { kind: 'standard', ref: 'invoice-standard', revision: '1' }, digest: `sha256:${'c'.repeat(64)}` }) },
  { rule: 'RETENTION_CHANGED', kind: 'breaking', edit: (m) => (t(m, 'order').retention = 'Ten years.') },
  { rule: 'INVARIANT_CHANGED', kind: 'breaking', edit: (m) => (t(m, 'order').invariants = [prose('A paid order has a positive total.')]) },
  { rule: 'SUPPORTED_VERSION_ADDED', kind: 'compatible', edit: supported },
  { rule: 'SUPPORTED_VERSION_REMOVED', kind: 'breaking', prepare: supported, edit: (m) => (t(m, 'order').supported = []) },
  { rule: 'SUPPORTED_VERSION_CHANGED', kind: 'compatible', prepare: supported, edit: (m) => (t(m, 'order').supported![0]!.status = 'deprecated') },
  { rule: 'PROPERTY_REMOVED', kind: 'breaking', edit: (m) => (t(m, 'order').properties = t(m, 'order').properties.filter((x) => x.name !== 'note')) },
  { rule: 'REQUIRED_PROPERTY_ADDED', kind: 'breaking', edit: (m) => t(m, 'order').properties.push({ name: 'channel', kind: 'string', required: true, nullable: false, immutable: false, origin: 'client' }) },
  { rule: 'REQUIRED_PROPERTY_ADDED', kind: 'compatible', edit: (m) => t(m, 'order-response').properties.push({ name: 'channel', kind: 'string', required: true, nullable: false, immutable: false, origin: 'system' }) },
  { rule: 'OPTIONAL_PROPERTY_ADDED', kind: 'compatible', edit: (m) => t(m, 'order').properties.push({ name: 'channel', kind: 'string', required: false, nullable: true, immutable: false, origin: 'client' }) },
  { rule: 'PROPERTY_REORDERED', kind: 'none', edit: (m) => t(m, 'order').properties.reverse() },
  { rule: 'PROPERTY_KIND_CHANGED', kind: 'breaking', edit: (m) => (p(m, 'order', 'note').kind = 'uuid') },
  { rule: 'PROPERTY_SHAPE_CHANGED', kind: 'breaking', edit: (m) => (p(m, 'order', 'note').ref = 'invoice') },
  { rule: 'PROPERTY_NULLABILITY_CHANGED', kind: 'breaking', edit: (m) => (p(m, 'order', 'note').nullable = false) },
  { rule: 'PROPERTY_BECAME_REQUIRED', kind: 'breaking', edit: (m) => (p(m, 'order', 'note').required = true) },
  { rule: 'PROPERTY_BECAME_OPTIONAL', kind: 'breaking', edit: (m) => (p(m, 'order', 'total').required = false) },
  { rule: 'PROPERTY_BECAME_OPTIONAL', kind: 'compatible', edit: (m) => (p(m, 'order-request', 'total').required = false) },
  { rule: 'PROPERTY_BECAME_IMMUTABLE', kind: 'breaking', edit: (m) => (p(m, 'order', 'total').immutable = true) },
  { rule: 'PROPERTY_BECAME_MUTABLE', kind: 'compatible', edit: (m) => (p(m, 'order', 'id').immutable = false) },
  { rule: 'PROPERTY_ORIGIN_CHANGED', kind: 'breaking', edit: (m) => (p(m, 'order', 'total').origin = 'system') },
  { rule: 'UNITS_CHANGED', kind: 'breaking', edit: (m) => (p(m, 'order', 'total').units = 'USD') },
  { rule: 'CLASSIFICATION_CHANGED', kind: 'breaking', edit: (m) => (p(m, 'order', 'note').classification = 'personal') },
  { rule: 'WRITERS_CHANGED', kind: 'breaking', edit: (m) => (p(m, 'order', 'note').writers = ['billing']) },
  { rule: 'DEFAULT_CHANGED', kind: 'breaking', edit: (m) => (p(m, 'order', 'note').default = { policy: 'literal', value: '', appliesOn: 'read' }) },
  { rule: 'UNKNOWN_ENUM_POLICY_CHANGED', kind: 'breaking', edit: (m) => (p(m, 'order', 'status').unknownEnumPolicy = 'preserve') },
  { rule: 'ENUM_VALUE_REMOVED', kind: 'breaking', edit: (m) => (p(m, 'invoice', 'state').enumValues = ['draft', 'issued']) },
  { rule: 'ENUM_VALUE_ADDED', kind: 'breaking', edit: (m) => p(m, 'order', 'status').enumValues!.push('refunded') },
  { rule: 'ENUM_VALUE_ADDED', kind: 'compatible', edit: (m) => p(m, 'invoice', 'state').enumValues!.push('void') },
  { rule: 'BOUND_TIGHTENED', kind: 'breaking', edit: (m) => (p(m, 'order', 'note').bounds = { maxLength: 140 }) },
  { rule: 'BOUND_TIGHTENED', kind: 'compatible', edit: (m) => (p(m, 'order-response', 'note').bounds = { maxLength: 140 }) },
  { rule: 'BOUND_LOOSENED', kind: 'compatible', edit: (m) => (p(m, 'order', 'note').bounds = { maxLength: 500 }) },
  { rule: 'BOUND_LOOSENED', kind: 'breaking', edit: (m) => (p(m, 'order-response', 'note').bounds = { maxLength: 500 }) },
  { rule: 'BINDS_CHANGED', kind: 'breaking', edit: (m) => delete p(m, 'shipment', 'orderId').binds },
  { rule: 'SECURITY_SCHEME_CHANGED', kind: 'breaking', edit: (m) => (pick(m.securitySchemes, 'bearer').bearerFormat = 'opaque') },
  { rule: 'PERMISSION_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.place').authority.permission = 'order.admin') },
  { rule: 'SCOPE_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.place').authority.scope = 'ordering') },
  { rule: 'SCOPE_REMOVED', kind: 'breaking', edit: (m) => delete op(m, 'shipment.dispatch').authority.scope },
  { rule: 'AUTHORITY_SCHEME_CHANGED', kind: 'breaking', edit: (m) => delete op(m, 'order.place').authority.scheme },
  { rule: 'OPERATION_KIND_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.get').kind = 'command') },
  { rule: 'OPERATION_TYPE_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.get').response = 'shipment-status') },
  { rule: 'OPERATION_ERROR_ADDED', kind: 'compatible', edit: (m) => op(m, 'order.get').errors!.push({ code: 'ORDER_GONE', status: 410, retryable: false, description: 'The order was archived.' }) },
  { rule: 'OPERATION_ERROR_REMOVED', kind: 'compatible', edit: (m) => (op(m, 'order.place').errors = []) },
  { rule: 'OPERATION_ERROR_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.place').errors![0]!.retryable = true) },
  { rule: 'OPERATION_BINDING_ADDED', kind: 'compatible', edit: (m) => op(m, 'order.get').bindings!.push({ transport: 'message', channel: 'orders' }) },
  { rule: 'OPERATION_BINDING_REMOVED', kind: 'breaking', edit: (m) => (op(m, 'order.get').bindings = []) },
  { rule: 'OPERATION_BINDING_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.get').bindings![0]!.method = 'HEAD') },
  { rule: 'HTTP_PARAMETER_ADDED', kind: 'compatible', edit: (m) => op(m, 'order.get').bindings![0]!.parameters!.push({ name: 'expand', in: 'query', kind: 'string', required: false }) },
  { rule: 'HTTP_PARAMETER_REMOVED', kind: 'breaking', edit: (m) => (op(m, 'order.place').bindings![0]!.parameters = []) },
  { rule: 'HTTP_PARAMETER_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.get').bindings![0]!.parameters![0]!.kind = 'uuid') },
  { rule: 'HTTP_RESPONSE_ADDED', kind: 'compatible', edit: (m) => op(m, 'order.get').bindings![0]!.responses!.push({ status: 503, kind: 'error', description: 'Unavailable.' }) },
  { rule: 'HTTP_RESPONSE_REMOVED', kind: 'breaking', edit: (m) => (op(m, 'order.get').bindings![0]!.responses = op(m, 'order.get').bindings![0]!.responses!.filter((x) => x.status !== 404)) },
  { rule: 'HTTP_RESPONSE_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.get').bindings![0]!.responses![0]!.mediaType = 'application/xml') },
  { rule: 'INVOCATION_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.place').invokes = op(m, 'order.place').invokes!.filter((x) => x.kind !== 'mutation')) },
  { rule: 'ENFORCEMENT_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.place').enforcement!.persistence = 'billing') },
  { rule: 'CONDITION_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.place').preconditions = [prose('The caller is a registered customer.')]) },
  { rule: 'IDEMPOTENCY_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.place').idempotency!.window = 'P2D') },
  { rule: 'CONCURRENCY_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.place').concurrency!.control = 'optimistic') },
  { rule: 'TRANSACTION_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'order.place').transaction!.boundary = 'none') },
  { rule: 'ASYNC_CONTRACT_CHANGED', kind: 'breaking', edit: (m) => (op(m, 'shipment.dispatch').async!.timeout!.after = 'PT1M') },
  { rule: 'TRACE_LINKS_CHANGED', kind: 'compatible', edit: (m) => (op(m, 'order.place').scenarios = ['scn.place']) },
  { rule: 'HOST_CHANGED', kind: 'breaking', edit: (m) => (r(m, 'fulfillment.rb_dispatch').host = 'function') },
  { rule: 'SOURCE_CHANGED', kind: 'compatible', edit: (m) => (r(m, 'fulfillment.rb_dispatch').source = 'fulfillment/dispatch.ps1') },
  { rule: 'PARAMETER_PASSING_CHANGED', kind: 'breaking', edit: (m) => (r(m, 'ordering.sp_place_order').parameterPassing = 'named') },
  { rule: 'PARAM_REMOVED', kind: 'breaking', edit: (m) => (r(m, 'ordering.sp_place_order').params = r(m, 'ordering.sp_place_order').params.filter((x) => x.name !== 'p_note')) },
  { rule: 'REQUIRED_PARAM_ADDED', kind: 'breaking', edit: (m) => r(m, 'ordering.sp_place_order').params.push({ name: 'p_channel', kind: 'string', required: true, nullable: false }) },
  { rule: 'OPTIONAL_PARAM_ADDED', kind: 'compatible', edit: (m) => r(m, 'ordering.sp_place_order').params.push({ name: 'p_channel', kind: 'string', required: false, nullable: true }) },
  { rule: 'PARAM_REORDERED', kind: 'breaking', edit: (m) => r(m, 'ordering.sp_place_order').params.reverse() },
  { rule: 'PARAM_REORDERED', kind: 'none', edit: (m) => r(m, 'fulfillment.rb_dispatch').params.reverse() },
  { rule: 'PARAM_RETYPED', kind: 'breaking', edit: (m) => (pick(r(m, 'ordering.sp_place_order').params, 'p_note').kind = 'integer') },
  { rule: 'PARAM_NULLABILITY_CHANGED', kind: 'breaking', edit: (m) => (pick(r(m, 'ordering.sp_place_order').params, 'p_note').nullable = false) },
  { rule: 'PARAM_BECAME_REQUIRED', kind: 'breaking', edit: (m) => (pick(r(m, 'ordering.sp_place_order').params, 'p_note').required = true) },
  { rule: 'PARAM_BECAME_OPTIONAL', kind: 'compatible', edit: (m) => (pick(r(m, 'ordering.sp_place_order').params, 'p_total').required = false) },
  { rule: 'COLUMN_REMOVED', kind: 'breaking', edit: (m) => (r(m, 'ordering.sp_place_order').resultSet = r(m, 'ordering.sp_place_order').resultSet.filter((x) => x.name !== 'status')) },
  { rule: 'COLUMN_ADDED', kind: 'compatible', edit: (m) => r(m, 'ordering.sp_place_order').resultSet.push({ name: 'placed_at', kind: 'datetime', nullable: false }) },
  { rule: 'COLUMN_REORDERED', kind: 'breaking', edit: (m) => r(m, 'ordering.sp_place_order').resultSet.reverse() },
  { rule: 'COLUMN_RETYPED', kind: 'breaking', edit: (m) => (pick(r(m, 'ordering.sp_place_order').resultSet, 'order_id').kind = 'uuid') },
  { rule: 'COLUMN_NULLABILITY_CHANGED', kind: 'breaking', edit: (m) => (pick(r(m, 'ordering.sp_place_order').resultSet, 'order_id').nullable = true) },
  { rule: 'ROUTINE_MUTATIONS_CHANGED', kind: 'breaking', edit: (m) => (r(m, 'ordering.sp_place_order').performsMutations = []) },
  { rule: 'ROUTINE_WRITES_CHANGED', kind: 'breaking', edit: (m) => r(m, 'ordering.sp_place_order').writes![0]!.columns.pop() },
  { rule: 'TRANSACTION_SCOPE_CHANGED', kind: 'breaking', edit: (m) => (r(m, 'ordering.sp_place_order').transactionScope = ['ordering.orders', 'billing.invoices']) },
  { rule: 'MUTATION_TYPE_CHANGED', kind: 'breaking', edit: (m) => (mu(m, 'order.pay').type = 'invoice') },
  { rule: 'TRANSITION_CHANGED', kind: 'breaking', edit: (m) => (mu(m, 'order.pay').to = 'shipped') },
  { rule: 'MUTATION_WRITES_CHANGED', kind: 'breaking', edit: (m) => (mu(m, 'order.pay').writes = []) },
  { rule: 'GUARD_CHANGED', kind: 'breaking', edit: (m) => (mu(m, 'order.pay').guard = prose('Payment was authorized.')) },
  { rule: 'EFFECT_CHANGED', kind: 'breaking', edit: (m) => (mu(m, 'order.pay').effect = 'The order is paid and receipted.') },
  { rule: 'WORKFLOW_STATUS_CHANGED', kind: 'compatible', edit: (m) => (pick(m.workflows, 'wf.reporting').status = 'active') },
  { rule: 'WORKFLOW_DEPENDENCY_CHANGED', kind: 'breaking', edit: (m) => (pick(m.workflows, 'wf.reporting').dependsOn = []) },
  { rule: 'WORKFLOW_IMPORT_CHANGED', kind: 'compatible', edit: (m) => (pick(m.workflows, 'wf.checkout').imports[0]!.version = 2) },
  { rule: 'WORKFLOW_SCOPE_CHANGED', kind: 'compatible', edit: (m) => pick(m.workflows, 'wf.checkout').operations!.pop() },
  { rule: 'EDGE_RATIONALE_CHANGED', kind: 'compatible', edit: (m) => (m.edges[0]!.rationale = 'The worker reads paid orders.') },
  { rule: 'READINESS_DEPENDENCY_CHANGED', kind: 'breaking', edit: (m) => (m.edges[1]!.readiness!.maturity = 'qualified') },
  { rule: 'CYCLE_BEHAVIOR_CHANGED', kind: 'breaking', edit: (m) => (m.edges[0]!.cycle = { behavior: 'The worker polls; ordering never calls back.' }) },
  { rule: 'REQUIREMENT_CHANGED', kind: 'breaking', edit: (m) => (pick(m.requirements, 'req.pay-order').outcome = 'A placed order can be paid in instalments.') },
  { rule: 'REQUIREMENT_METADATA_CHANGED', kind: 'compatible', edit: (m) => (pick(m.requirements, 'req.cancel-order').priority = 'must') },
  { rule: 'CRITERION_ADDED', kind: 'breaking', edit: (m) => pick(m.requirements, 'req.pay-order').criteria.push({ id: 'req.pay-order.receipt', statement: 'A receipt is issued.', verification: 'review', evidence: ['review'], required: false }) },
  { rule: 'CRITERION_REMOVED', kind: 'breaking', edit: (m) => pick(m.requirements, 'req.place-order').criteria.pop() },
  { rule: 'CRITERION_CHANGED', kind: 'breaking', edit: (m) => (pick(m.requirements, 'req.pay-order').criteria[0]!.statement = 'Paying moves the order to paid within one second.') },
  { rule: 'SCENARIO_CHANGED', kind: 'breaking', edit: (m) => (pick(m.scenarios, 'scn.pay').expected = 'The order status is paid and a receipt exists.') },
  { rule: 'KNOWLEDGE_CHANGED', kind: 'breaking', edit: (m) => (pick(m.constraints, 'con.exact-money').rule = 'Monetary amounts are exact decimals with four fraction digits.') },
  { rule: 'KNOWLEDGE_METADATA_CHANGED', kind: 'compatible', edit: (m) => (pick(m.decisions, 'dec.order-store').rationale = 'The relational store meets the exact-decimal constraint.') },
  { rule: 'ATTACHMENT_CHANGED', kind: 'compatible', prepare: attachment, edit: (m) => (pick(m.attachments, 'att.store').digest = `sha256:${'d'.repeat(64)}`) },
  { rule: 'MAPPING_CHANGED', kind: 'breaking', edit: (m) => (pick(m.mappings, 'map.order-request').fields[0]!.transform = 'rename') },
  { rule: 'STORAGE_TABLE_CHANGED', kind: 'breaking', edit: (m) => (st(m, 'ordering.orders').table = 'customer_orders') },
  { rule: 'STORAGE_COLUMN_ADDED', kind: 'breaking', edit: (m) => st(m, 'ordering.orders').columns.push({ name: 'channel', sqlType: { name: 'nvarchar', length: 16 }, nullable: false }) },
  { rule: 'STORAGE_COLUMN_ADDED', kind: 'compatible', edit: (m) => st(m, 'ordering.orders').columns.push({ name: 'channel', sqlType: { name: 'nvarchar', length: 16 }, nullable: true }) },
  { rule: 'STORAGE_COLUMN_REMOVED', kind: 'breaking', edit: (m) => (st(m, 'ordering.orders').columns = st(m, 'ordering.orders').columns.filter((c) => c.name !== 'note')) },
  { rule: 'STORAGE_COLUMN_CHANGED', kind: 'breaking', edit: (m) => (pick(st(m, 'ordering.orders').columns, 'total').sqlType.precision = 14) },
  { rule: 'STORAGE_COLUMN_REORDERED', kind: 'compatible', edit: (m) => st(m, 'ordering.orders').columns.reverse() },
  { rule: 'STORAGE_KEY_CHANGED', kind: 'breaking', edit: (m) => (st(m, 'ordering.orders').primaryKey = ['id', 'status']) },
  { rule: 'STORAGE_CONSTRAINT_ADDED', kind: 'breaking', edit: (m) => (st(m, 'ordering.orders').unique = [{ name: 'note', columns: ['note'] }]) },
  { rule: 'STORAGE_CONSTRAINT_REMOVED', kind: 'compatible', edit: (m) => (st(m, 'ordering.orders').checks = []) },
  { rule: 'STORAGE_CONSTRAINT_CHANGED', kind: 'breaking', edit: (m) => (st(m, 'fulfillment.shipments').foreignKeys![0]!.onDelete = 'cascade') },
  { rule: 'STORAGE_INDEX_CHANGED', kind: 'compatible', edit: (m) => (st(m, 'ordering.orders').indexes = [{ name: 'status', columns: ['status'], unique: false }]) },
  { rule: 'MIGRATION_CHANGED', kind: 'breaking', prepare: migration, edit: (m) => (pick(m.migrations, 'mig.orders').locking = 'Table lock for the whole migration.') },
  { rule: 'DEPLOYMENT_CHANGED', kind: 'breaking', edit: (m) => (pick(m.deploymentUnits, 'du.ordering-api').timeout = 'PT10S') },
  { rule: 'DEPLOYMENT_NOTE_CHANGED', kind: 'compatible', edit: (m) => (pick(m.deploymentUnits, 'du.ordering-api').isolation = 'Billing shares the process.') },
  { rule: 'CONSUMER_BINDING_CHANGED', kind: 'breaking', edit: (m) => (pick(m.consumerBindings, 'cb.billing-order').version = 2) },
  { rule: 'PUBLISHED_CONTRACT_PIN_CHANGED', kind: 'breaking', prepare: pinned, edit: (m) => (pick(m.publishedContracts, 'payments').version = 2) },
  { rule: 'PUBLISHED_CONTRACT_CONSUMERS_CHANGED', kind: 'compatible', prepare: pinned, edit: (m) => pick(m.publishedContracts, 'payments').consumers.push('ordering') },
  { rule: 'KNOWLEDGE_METADATA_CHANGED', kind: 'compatible', edit: (m) => (pick(m.unknowns, 'unk.report-period').evidenceNeeded = 'The billing contract names the reporting period.') },
  { rule: 'KNOWLEDGE_CHANGED', kind: 'breaking', edit: (m) => (pick(m.unknowns, 'unk.report-period').recommendedAction.reversible = false) },
  { rule: 'AGREEMENT_CHANGED', kind: 'breaking', edit: (m) => (pick(m.agreements, 'agr.payment-identity').constraint = 'Every call that pays an order carries the identity of the paying customer.') },
];
