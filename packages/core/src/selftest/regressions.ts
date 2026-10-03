import type { Model } from '../generated/types.js';
import { validate } from '../validate.js';
import { diff } from '../diff.js';
import { mutate } from '../mutate.js';
import { project } from '../project.js';
import { assert, codesOf, fresh, observe, pick, type Tally } from './harness.js';

/**
 * Single-field edits that an engine checking less would accept or report as
 * no change. Each case states the behavior it proves; together they are the
 * permanent seeded-defect corpus the outcome metrics count.
 */
export interface Regression {
  behavior: string;
  run(t: Tally): void;
}

const codes = (t: Tally, m: Model): string[] => codesOf(observe(t, validate(m)));

export const REGRESSIONS: readonly Regression[] = [
  {
    behavior: 'a guard or effect changed through a patch is reported as a change',
    run: (t) => {
      const before = fresh();
      const r = mutate(before, { op: 'update', collection: 'mutations', id: 'order.pay', set: { guard: { form: 'prose', text: 'Payment was authorized.' }, effect: 'Paid.' } }, { acknowledgeBreaking: ['order.pay'] });
      assert(t, r.model !== null, `the acknowledged guard change is accepted: ${codesOf(r.findings).join(', ')}`);
      const rules = r.changes.map((c) => c.rule);
      assert(t, rules.includes('GUARD_CHANGED') && rules.includes('EFFECT_CHANGED'), `guard and effect changes are reported: ${rules.join(', ')}`);
      const refused = mutate(before, { op: 'update', collection: 'mutations', id: 'order.pay', set: { effect: 'Paid.' } });
      assert(t, refused.model === null && codesOf(observe(t, refused.findings)).includes('BREAKING_CHANGE_UNACKNOWLEDGED'), 'an unacknowledged effect change is refused');
    },
  },
  {
    behavior: 'a changed requirement outcome is reported',
    run: (t) => {
      const before = fresh();
      const after = fresh();
      pick(after.requirements, 'req.pay-order').outcome = 'A placed order can be paid by card.';
      assert(t, diff(before, after).some((c) => c.rule === 'REQUIREMENT_CHANGED' && c.dimension === 'intent'), 'the outcome change carries the intent dimension');
    },
  },
  {
    behavior: 'a duplicate property name is rejected rather than collapsed in the projection',
    run: (t) => {
      const m = fresh();
      pick(m.types, 'order').properties.push({ name: 'note', kind: 'string', required: false, nullable: true, immutable: false, origin: 'client' });
      assert(t, codes(t, m).includes('DUPLICATE_KEY'), 'the duplicate is a DUPLICATE_KEY');
    },
  },
  {
    behavior: 'a negative fractional maxLength is rejected before any projection',
    run: (t) => {
      const m = fresh();
      pick(pick(m.types, 'order').properties, 'note').bounds = { maxLength: -1.5 };
      const c = codes(t, m);
      assert(t, c.length > 0 && c.every((x) => x === 'STRUCTURAL_INVALID'), `only structural findings: ${c.join(', ')}`);
    },
  },
  {
    behavior: 'a state change with an empty write set is rejected',
    run: (t) => {
      const m = fresh();
      pick(m.mutations, 'order.pay').writes = [];
      assert(t, codes(t, m).includes('MUTATION_STATE_WRITE_UNDECLARED'), 'the hidden state write is reported');
    },
  },
  {
    behavior: 'an update beside $absent cannot borrow the creation exemption for immutable writes',
    run: (t) => {
      const m = fresh();
      Object.assign(pick(m.mutations, 'order.pay'), { from: ['$absent', 'placed'], writes: ['id', 'status', 'total'] });
      const c = codes(t, m);
      assert(t, c.includes('MUTATION_MIXED_ORIGIN') && c.includes('MUTATION_IMMUTABLE_WRITE'), `mixed origin and immutable write are reported: ${c.join(', ')}`);
    },
  },
  {
    behavior: 'two operations on one method and an equivalent route are rejected',
    run: (t) => {
      const m = fresh();
      Object.assign(pick(m.operations, 'order.get').bindings![0]!, { method: 'POST', path: '/orders', parameters: [] });
      assert(t, codes(t, m).includes('HTTP_ROUTE_DUPLICATE'), 'POST /orders twice is a duplicate');
      const n = fresh();
      Object.assign(pick(n.operations, 'shipment.status').bindings![0]!, { path: '/orders/{orderId}', parameters: [{ name: 'orderId', in: 'path', kind: 'string', required: true }] });
      assert(t, codes(t, n).includes('HTTP_ROUTE_DUPLICATE'), '/orders/{id} and /orders/{orderId} are the same route');
    },
  },
  {
    behavior: 'a templated route needs its path parameter and a security scheme, and the projection declares both',
    run: (t) => {
      const m = fresh();
      const get = pick(m.operations, 'order.get');
      get.bindings![0]!.parameters = [];
      delete get.authority.scheme;
      const c = codes(t, m);
      assert(t, c.includes('HTTP_PATH_PARAMETER_UNDECLARED') && c.includes('OPERATION_SECURITY_UNDECLARED'), `both omissions are reported: ${c.join(', ')}`);
      const api = project(fresh(), 'openapi') as { paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }>; security?: unknown[] }>> };
      const o = api.paths['/orders/{id}']?.['get'];
      assert(t, o?.parameters?.some((p) => p.name === 'id' && p.in === 'path') === true, 'the projection declares the path parameter');
      assert(t, Array.isArray(o?.security) && o!.security!.length === 1, 'the projection declares the security requirement');
    },
  },
  {
    behavior: 'a permission change at an unchanged version is reported and needs a version bump',
    run: (t) => {
      const r = mutate(fresh(), { op: 'update', collection: 'operations', id: 'order.place', set: { authority: { permission: 'order.admin', scheme: 'bearer' } } }, { acknowledgeBreaking: ['order.place'] });
      assert(t, r.changes.some((c) => c.rule === 'PERMISSION_CHANGED' && c.dimension === 'security'), 'the permission change is a security change');
      assert(t, codesOf(observe(t, r.findings)).includes('BREAKING_CHANGE_WITHOUT_VERSION_BUMP'), 'the same-version change is refused');
    },
  },
  {
    behavior: 'reversed positional params are a breaking change naming the operations that call the routine',
    run: (t) => {
      const before = fresh();
      const after = fresh();
      pick(after.routines, 'ordering.sp_place_order').params.reverse();
      const c = diff(before, after).find((x) => x.rule === 'PARAM_REORDERED');
      assert(t, c?.kind === 'breaking', 'the reorder is breaking');
      assert(t, c!.consumers.some((x) => x.ref.kind === 'operation' && x.ref.id === 'order.place'), 'order.place is an affected caller');
    },
  },
  {
    behavior: 'a transaction scope naming undeclared storage is rejected, and a scope change is reported',
    run: (t) => {
      const m = fresh();
      pick(m.routines, 'ordering.sp_place_order').transactionScope!.push('billing.ledger');
      assert(t, codes(t, m).includes('ROUTINE_TRANSACTION_SCOPE_INVALID'), 'the undeclared target is reported');
      const after = fresh();
      pick(after.routines, 'ordering.sp_place_order').transactionScope = ['ordering.orders', 'billing.invoices'];
      assert(t, diff(fresh(), after).some((c) => c.rule === 'TRANSACTION_SCOPE_CHANGED'), 'the scope change is reported');
    },
  },
  {
    behavior: 'money cannot be stored as floating point or with fewer digits',
    run: (t) => {
      const m = fresh();
      pick(pick(m.storage, 'ordering.orders').columns, 'total').sqlType = { name: 'float' };
      assert(t, codes(t, m).includes('STORAGE_COLUMN_LOSSY'), 'float storage of a decimal is rejected as lossy');
      const n = fresh();
      pick(pick(n.storage, 'ordering.orders').columns, 'total').sqlType = { name: 'decimal', precision: 10, scale: 2 };
      assert(t, codes(t, n).includes('STORAGE_COLUMN_LOSSY'), 'narrower precision is lossy');
    },
  },
  {
    behavior: 'each required criterion needs its own scenario; covering a sibling criterion does not count',
    run: (t) => {
      const m = fresh();
      pick(m.scenarios, 'scn.place-invalid').criteria = [];
      assert(t, codes(t, m).includes('CRITERION_UNCOVERED'), 'the rejection criterion is uncovered although its requirement has another covered criterion');
    },
  },
];
