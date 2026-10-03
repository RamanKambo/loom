import type { ItemShape, Property, TypeDef } from '../generated/types.js';
import type { ModelIndex } from '../records.js';

/**
 * Deterministic, contract-conforming sample payloads in the wire form the JSON
 * Schema and OpenAPI projections declare (a decimal travels as a string). The
 * C# and TypeScript conformance tests round-trip them through the
 * implementation's own serializer, so the samples are inputs to a check, never
 * the expected business outcome.
 */

type Shape = Pick<Property, 'kind' | 'enumValues' | 'bounds' | 'decimal' | 'ref' | 'items'>;

const STRING_CANDIDATES = ['a', 'A', '1', 'abc', 'ABC', 'EUR', 'a1', 'x'];

function stringSample(shape: Shape): string {
  const b = shape.bounds ?? {};
  const length = Math.max(1, b.minLength ?? 1);
  const fits = (s: string): boolean => (b.maxLength === undefined || s.length <= b.maxLength) && s.length >= (b.minLength ?? 0);
  let pattern: RegExp | null = null;
  if (b.pattern !== undefined) {
    try {
      pattern = new RegExp(b.pattern, 'u');
    } catch {
      pattern = null;
    }
  }
  for (const c of STRING_CANDIDATES) {
    const s = c.repeat(Math.ceil(length / c.length)).slice(0, Math.max(length, c.length));
    if (fits(s) && (pattern === null || pattern.test(s))) return s;
  }
  return 'a'.repeat(length);
}

function numberSample(shape: Shape, preferred: number): number {
  const b = shape.bounds ?? {};
  if (b.min !== undefined && preferred < b.min) return b.min;
  if (b.max !== undefined && preferred > b.max) return b.max;
  return preferred;
}

/** An exact decimal string within the declared precision and scale, for example '12.34'. */
export function decimalSample(precision: number, scale: number): string {
  const intDigits = Math.max(1, precision - scale);
  const integer = '12'.slice(0, intDigits);
  const fraction = '3456789012345678901234567890123456789'.slice(0, scale);
  return scale > 0 ? `${integer}.${fraction}` : integer;
}

/** One conforming wire value of a shape; references expand to depth 3 and stop there. */
export function sampleValue(index: ModelIndex, shape: Shape, depth = 0): unknown {
  switch (shape.kind) {
    case 'string':
      return stringSample(shape);
    case 'integer':
      return numberSample(shape, 1);
    case 'number':
      return numberSample(shape, 1.5);
    case 'decimal':
      return decimalSample(shape.decimal?.precision ?? 18, shape.decimal?.scale ?? 0);
    case 'boolean':
      return true;
    case 'enum':
      return shape.enumValues?.[0] ?? '';
    case 'date':
      return '2026-01-31';
    case 'datetime':
      return '2026-01-31T12:30:00+00:00';
    case 'uuid':
      return '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    case 'ref': {
      const target = shape.ref !== undefined ? index.types.get(shape.ref) : undefined;
      return target && depth < 3 ? sampleObject(index, target, depth + 1) : {};
    }
    case 'array': {
      const count = Math.max(1, shape.bounds?.minItems ?? 1);
      const item = shape.items as ItemShape | undefined;
      return item ? Array.from({ length: count }, () => sampleValue(index, item, depth)) : [];
    }
    default:
      return null;
  }
}

/** A conforming payload of a type with every property present and non-null. */
export function sampleObject(index: ModelIndex, type: TypeDef, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of type.properties) out[p.name] = sampleValue(index, p, depth);
  return out;
}
