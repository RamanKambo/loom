/**
 * Deterministic JSON helpers. Pure and isomorphic: no fs, no Node globals.
 *
 * Object keys are sorted recursively; array order is preserved because array
 * order is load-bearing in the model (a reordered result set is a breaking
 * change). `undefined` members are dropped so optional-field presence never
 * perturbs the canonical form.
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

/** Canonical, stable, pretty JSON (two-space indent). Same input value -> identical string. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value), null, 2);
}

/**
 * Canonical JSON without insignificant whitespace: the form every content hash
 * is taken over. The generator computes the contract digest with the same
 * algorithm, so a hash computed here and one computed there agree.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** Structural equality that is key-order independent but array-order sensitive. */
export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Deep clone of plain JSON data (the model is pure data, so this is sufficient). */
export function deepClone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
