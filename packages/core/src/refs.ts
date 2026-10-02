/**
 * Resolution of the two composite references in the model: a binding
 * 'typeId.propertyName' and a schema-qualified table '<component>.<table>'.
 *
 * Ids may themselves contain dots (e.g. a type id 'type.user'), so splitting on
 * the first or last dot would mis-parse. Both resolve by the LONGEST known id
 * that prefixes the value followed by a dot. Property names are therefore
 * assumed to contain no dot.
 */

function longestIdPrefix(value: string, ids: Iterable<string>): string | null {
  let best: string | null = null;
  for (const id of ids) {
    if (value.length > id.length + 1 && value.startsWith(`${id}.`)) {
      if (best === null || id.length > best.length) best = id;
    }
  }
  return best;
}

export interface BindingRef {
  typeId: string;
  property: string;
}

/** Resolve 'typeId.propertyName' against the known type ids; null if no type matches. */
export function resolveBinding(binds: string, typeIds: Iterable<string>): BindingRef | null {
  const typeId = longestIdPrefix(binds, typeIds);
  if (typeId === null) return null;
  return { typeId, property: binds.slice(typeId.length + 1) };
}

export interface TableOwner {
  /** The qualifying component id (or the text before the first dot when unknown). */
  owner: string;
  /** Whether `owner` is a known component id. */
  known: boolean;
  /** The table name without its qualifier. */
  bare: string;
}

/**
 * Owner of a schema-qualified table. Returns null for an unqualified name, which
 * is implicitly owned by the owner of the element that declares it.
 */
export function tableOwner(table: string, componentIds: Iterable<string>): TableOwner | null {
  if (!table.includes('.')) return null;
  const known = longestIdPrefix(table, componentIds);
  if (known !== null) return { owner: known, known: true, bare: table.slice(known.length + 1) };
  const dot = table.indexOf('.');
  return { owner: table.slice(0, dot), known: false, bare: table.slice(dot + 1) };
}

/** Canonical qualified form of a table, qualifying an unqualified name with `defaultOwner`. */
export function qualifyTable(table: string, defaultOwner: string): string {
  return table.includes('.') ? table : `${defaultOwner}.${table}`;
}
