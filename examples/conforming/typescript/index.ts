// Conformance fixture: the fulfillment module '@loom-fixtures/fulfillment', implementing the sample
// contract's fulfillment types and their codecs, so the generated contract.test.ts passes against it.
// The violating copy differs only in that its parsers accept a missing orderId.

export type ShipmentState = 'pending' | 'dispatched' | 'delivered';

export interface Shipment {
  readonly id: string;
  readonly orderId: string;
  state: ShipmentState;
}

export interface DispatchRequest {
  orderId: string;
  notify?: boolean;
}

export interface DispatchAccepted {
  jobId: string;
}

export interface ShipmentStatus {
  id: string;
  state: ShipmentState;
}

const STATES: readonly string[] = ['pending', 'dispatched', 'delivered'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(json: unknown): Record<string, unknown> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new TypeError('expected a JSON object');
  return json as Record<string, unknown>;
}

function id(o: Record<string, unknown>, name: string): string {
  const v = o[name];
  if (typeof v !== 'string' || v.length < 1 || v.length > 64) throw new TypeError(`${name} must be a string of 1 to 64 characters`);
  return v;
}

function state(o: Record<string, unknown>, name: string): ShipmentState {
  const v = o[name];
  if (typeof v !== 'string' || !STATES.includes(v)) throw new TypeError(`${name} must be one of ${STATES.join(', ')}`);
  return v as ShipmentState;
}

export const codecs = {
  shipment: {
    parse(json: unknown): Shipment {
      const o = object(json);
      return { id: id(o, 'id'), orderId: id(o, 'orderId'), state: state(o, 'state') };
    },
    serialize(v: Shipment): unknown {
      return { id: v.id, orderId: v.orderId, state: v.state };
    },
  },
  'dispatch-request': {
    parse(json: unknown): DispatchRequest {
      const o = object(json);
      const out: DispatchRequest = { orderId: id(o, 'orderId') };
      if (o['notify'] !== undefined) {
        if (typeof o['notify'] !== 'boolean') throw new TypeError('notify must be a boolean');
        out.notify = o['notify'];
      }
      return out;
    },
    serialize(v: DispatchRequest): unknown {
      return v.notify === undefined ? { orderId: v.orderId } : { orderId: v.orderId, notify: v.notify };
    },
  },
  'dispatch-accepted': {
    parse(json: unknown): DispatchAccepted {
      const o = object(json);
      const jobId = o['jobId'];
      if (typeof jobId !== 'string' || !UUID.test(jobId)) throw new TypeError('jobId must be a UUID');
      return { jobId };
    },
    serialize(v: DispatchAccepted): unknown {
      return { jobId: v.jobId };
    },
  },
  'shipment-status': {
    parse(json: unknown): ShipmentStatus {
      const o = object(json);
      return { id: id(o, 'id'), state: state(o, 'state') };
    },
    serialize(v: ShipmentStatus): unknown {
      return { id: v.id, state: v.state };
    },
  },
};
