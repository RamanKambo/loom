import type { Model } from './types.js';

/**
 * A small but complete, valid model used by selfTest and the CLI self-test.
 * Returns a fresh object each call so callers can mutate it freely. It is
 * deliberately cross-cutting so every rule has something to bite on:
 * table-backed types, a property that references another type's key across a
 * component boundary ('shipment.orderId' binds 'order.id', a foreign key), a
 * sql-procedure and a runbook whose params and result columns bind producer
 * properties (the runbook reads an ordering-owned property across a component
 * boundary), operations with HTTP bindings, workflows that pin type versions,
 * and typed edges.
 *
 * The selfTest scenarios depend on these facts: 'order.note' is a string bound
 * only by 'ordering.sp_place_order' param 'p_note'; 'fulfillment.rb_dispatch'
 * reaches type 'order' only through its param 'OrderId' binding 'order.id' and
 * through type 'shipment', which reaches it only through 'shipment.orderId';
 * 'wf.checkout' and 'wf.reporting' pin 'order' at version 1 and 'wf.fulfil'
 * pins 'shipment' at version 1. The runbook's contract matches the fixture
 * examples/conforming/fulfillment/rb_dispatch.ps1.
 */
export function sampleModel(): Model {
  return {
    version: 1,
    components: [
      { id: 'ordering', purpose: 'Owns orders and their lifecycle.' },
      { id: 'fulfillment', purpose: 'Owns shipments and dispatch.' },
      { id: 'billing', purpose: 'Owns invoices and the ledger.' },
    ],
    types: [
      {
        id: 'order',
        version: 1,
        owner: 'ordering',
        stateProperty: 'status',
        table: 'ordering.orders',
        key: ['id'],
        properties: [
          {
            name: 'id',
            kind: 'string',
            required: true,
            nullable: false,
            immutable: true,
            origin: 'client',
            bounds: { maxLength: 64 },
          },
          {
            name: 'status',
            kind: 'enum',
            required: true,
            nullable: false,
            immutable: false,
            origin: 'system',
            enumValues: ['placed', 'paid', 'shipped', 'cancelled'],
          },
          {
            name: 'total',
            kind: 'number',
            required: true,
            nullable: false,
            immutable: false,
            origin: 'client',
            bounds: { min: 0 },
          },
          {
            name: 'note',
            kind: 'string',
            required: false,
            nullable: true,
            immutable: false,
            origin: 'client',
            bounds: { maxLength: 280 },
          },
        ],
      },
      {
        id: 'shipment',
        version: 1,
        owner: 'fulfillment',
        stateProperty: 'state',
        table: 'fulfillment.shipments',
        key: ['id'],
        properties: [
          {
            name: 'id',
            kind: 'string',
            required: true,
            nullable: false,
            immutable: true,
            origin: 'system',
            bounds: { maxLength: 64 },
          },
          {
            name: 'state',
            kind: 'enum',
            required: true,
            nullable: false,
            immutable: false,
            origin: 'system',
            enumValues: ['pending', 'dispatched', 'delivered'],
          },
          {
            name: 'orderId',
            kind: 'string',
            required: true,
            nullable: false,
            immutable: true,
            origin: 'ordering',
            bounds: { maxLength: 64 },
            binds: 'order.id',
          },
        ],
      },
      {
        id: 'invoice',
        version: 1,
        owner: 'billing',
        stateProperty: 'state',
        table: 'invoices',
        key: ['id'],
        properties: [
          {
            name: 'id',
            kind: 'string',
            required: true,
            nullable: false,
            immutable: true,
            origin: 'system',
            bounds: { maxLength: 64 },
          },
          {
            name: 'state',
            kind: 'enum',
            required: true,
            nullable: false,
            immutable: false,
            origin: 'system',
            enumValues: ['draft', 'issued', 'settled'],
          },
          {
            name: 'amount',
            kind: 'number',
            required: true,
            nullable: false,
            immutable: false,
            origin: 'billing',
            bounds: { min: 0 },
          },
        ],
      },
    ],
    operations: [
      {
        id: 'order.place',
        version: 1,
        owner: 'ordering',
        kind: 'command',
        request: 'order',
        response: 'order',
        authority: { permission: 'order.write' },
        bindings: [{ transport: 'http', method: 'POST', path: '/orders' }],
      },
      {
        id: 'order.get',
        version: 1,
        owner: 'ordering',
        kind: 'query',
        response: 'order',
        authority: { permission: 'order.read' },
        bindings: [{ transport: 'http', method: 'GET', path: '/orders' }],
      },
      {
        id: 'shipment.dispatch',
        version: 1,
        owner: 'fulfillment',
        kind: 'async-command',
        request: 'shipment',
        result: 'shipment',
        authority: { permission: 'shipment.write', scope: 'fulfillment' },
        bindings: [{ transport: 'http', method: 'POST', path: '/shipments' }],
      },
    ],
    routines: [
      {
        id: 'ordering.sp_place_order',
        version: 1,
        owner: 'ordering',
        host: 'sql-procedure',
        source: 'ordering/sp_place_order.sql',
        params: [
          { name: 'p_total', kind: 'number', required: true, nullable: false, binds: 'order.total' },
          { name: 'p_note', kind: 'string', required: false, nullable: true, binds: 'order.note' },
        ],
        resultSet: [
          { name: 'order_id', kind: 'string', nullable: false, binds: 'order.id' },
          { name: 'status', kind: 'enum', nullable: false, binds: 'order.status' },
        ],
        performsMutations: ['order.create'],
        writesTables: ['ordering.orders'],
        writesColumns: [
          'ordering.orders.id',
          'ordering.orders.status',
          'ordering.orders.total',
          'ordering.orders.note',
        ],
        transactionScope: ['ordering.orders'],
        authority: { permission: 'order.write' },
      },
      {
        id: 'fulfillment.rb_dispatch',
        version: 1,
        owner: 'fulfillment',
        host: 'runbook',
        source: 'fulfillment/rb_dispatch.ps1',
        params: [
          { name: 'OrderId', kind: 'string', required: true, nullable: false, binds: 'order.id' },
          { name: 'InitialState', kind: 'enum', required: false, nullable: false, binds: 'shipment.state' },
          { name: 'Notify', kind: 'boolean', required: false, nullable: false },
        ],
        resultSet: [
          { name: 'shipment_id', kind: 'string', nullable: false, binds: 'shipment.id' },
          { name: 'state', kind: 'enum', nullable: false, binds: 'shipment.state' },
        ],
        performsMutations: ['shipment.create'],
        writesTables: ['fulfillment.shipments'],
        writesColumns: ['fulfillment.shipments.id', 'fulfillment.shipments.state', 'fulfillment.shipments.orderId'],
        authority: { permission: 'shipment.write', scope: 'fulfillment' },
      },
    ],
    mutations: [
      {
        id: 'order.create',
        type: 'order',
        owner: 'ordering',
        from: ['$absent'],
        to: 'placed',
        writes: ['id', 'status', 'total'],
        guard: 'request is well-formed',
        effect: 'persist a new order in the placed state',
        requirements: ['req.place-order'],
        scenarios: ['scn.place-order'],
      },
      {
        id: 'order.pay',
        type: 'order',
        owner: 'ordering',
        from: ['placed'],
        to: 'paid',
        writes: ['status'],
        guard: 'payment captured',
        effect: 'mark the order paid',
        requirements: ['req.pay-order'],
        scenarios: ['scn.pay-order'],
      },
      {
        id: 'order.cancel',
        type: 'order',
        owner: 'ordering',
        from: ['placed', 'paid'],
        to: 'cancelled',
        writes: ['status'],
        guard: 'order not yet shipped',
        effect: 'cancel the order',
        requirements: ['req.cancel-order'],
        scenarios: ['scn.cancel-order'],
      },
      {
        id: 'shipment.create',
        type: 'shipment',
        owner: 'fulfillment',
        from: ['$absent'],
        to: 'pending',
        writes: ['id', 'state', 'orderId'],
        guard: 'order is paid',
        effect: 'create a pending shipment',
        requirements: ['req.dispatch'],
        scenarios: ['scn.dispatch'],
      },
    ],
    workflows: [
      {
        id: 'wf.checkout',
        status: 'active',
        dependsOn: [],
        imports: [{ typeId: 'order', version: 1 }],
        operations: ['order.place', 'order.get'],
        mutations: ['order.create', 'order.pay'],
        requirements: ['req.place-order', 'req.pay-order'],
      },
      {
        id: 'wf.fulfil',
        status: 'active',
        dependsOn: ['wf.checkout'],
        imports: [{ typeId: 'shipment', version: 1 }],
        operations: ['shipment.dispatch'],
        mutations: ['shipment.create'],
        requirements: ['req.dispatch'],
      },
      {
        id: 'wf.reporting',
        status: 'planned',
        dependsOn: ['wf.checkout', 'wf.fulfil'],
        imports: [
          { typeId: 'order', version: 1 },
          { typeId: 'invoice', version: 1 },
        ],
        requirements: ['req.report'],
      },
    ],
    edges: [
      { from: 'wf.checkout', to: 'ordering.sp_place_order', kind: 'runtime' },
      { from: 'wf.fulfil', to: 'fulfillment.rb_dispatch', kind: 'runtime' },
      { from: 'invoice', to: 'order', kind: 'semantic' },
      { from: 'billing', to: 'ordering', kind: 'integration' },
    ],
    requirements: [
      { id: 'req.place-order', outcome: 'A customer can place an order.' },
      { id: 'req.pay-order', outcome: 'A placed order can be paid.' },
      { id: 'req.cancel-order', outcome: 'An unshipped order can be cancelled.' },
      { id: 'req.dispatch', outcome: 'A paid order can be dispatched to fulfillment.' },
      { id: 'req.report', outcome: 'Finance can report across orders and invoices.' },
    ],
    scenarios: [
      {
        id: 'scn.place-order',
        requirements: ['req.place-order'],
        expected: 'POST /orders creates an order in the placed state.',
      },
      {
        id: 'scn.pay-order',
        requirements: ['req.pay-order'],
        expected: 'Paying a placed order moves it to paid.',
      },
      {
        id: 'scn.cancel-order',
        requirements: ['req.cancel-order'],
        expected: 'Cancelling a placed order moves it to cancelled.',
      },
      {
        id: 'scn.dispatch',
        requirements: ['req.dispatch'],
        expected: 'Dispatching a paid order creates a pending shipment.',
      },
    ],
  };
}
