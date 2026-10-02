/**
 * Deterministic JSON helpers. Pure and isomorphic: no fs, no Node globals.
 *
 * Object keys are sorted recursively; array order is preserved because array
 * order is load-bearing in the model (e.g. a reordered routine resultSet is a
 * breaking change). `undefined` members are dropped so optional-field presence
 * never perturbs the canonical string.
 */

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

/** Canonical, stable, pretty JSON. Same input value -> identical string. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value), null, 2);
}

/** Structural equality that is key-order independent but array-order sensitive. */
export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

/** Deep clone of plain JSON data (the model is pure data, so this is sufficient). */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
