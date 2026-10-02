import type { RecordRef } from './generated/types.js';
import { KIND_OF_COLLECTION, keyFieldsAt, keyOf, type CollectionName } from './records.js';

export interface Visit {
  value: unknown;
  /** Id-based path, as findings report it: 'types/order/properties/note/binds'. */
  path: string;
  /** The top-level record holding the value. */
  holder: RecordRef;
  /** Enclosing objects from the record down to the value's direct parent. */
  parents: unknown[];
}

/**
 * Visit every value at a registry path such as 'types[].properties[].binds' or
 * 'requirements[].scope[]'. Keyed arrays contribute their element key to the
 * id path, other arrays their index, so a path stays stable when unrelated
 * elements are reordered.
 */
export function visitPath(root: unknown, registryPath: string, visit: (v: Visit) => void): void {
  const segments = registryPath.split('.');
  const step = (
    value: unknown,
    i: number,
    path: string,
    prefix: string,
    holder: RecordRef | null,
    parents: unknown[],
  ): void => {
    if (value === undefined || value === null) return;
    if (i === segments.length) {
      if (holder) visit({ value, path, holder, parents });
      return;
    }
    const seg = segments[i] as string;
    const isArray = seg.endsWith('[]');
    const name = isArray ? seg.slice(0, -2) : seg;
    const obj = value as Record<string, unknown>;
    const child = obj[name];
    if (child === undefined || child === null) return;
    const childPrefix = prefix ? `${prefix}.${seg}` : seg;
    const childPath = path ? `${path}/${name}` : name;
    if (!isArray) {
      step(child, i + 1, childPath, childPrefix, holder, [...parents, obj]);
      return;
    }
    if (!Array.isArray(child)) return;
    const key = keyFieldsAt(childPrefix);
    child.forEach((element, index) => {
      const k = key ? keyOf(element, key) : String(index);
      const p = `${childPath}/${k}`;
      const h: RecordRef = holder ?? { kind: KIND_OF_COLLECTION[name as CollectionName], id: k };
      step(element, i + 1, p, childPrefix, h, holder ? [...parents, obj] : []);
    });
  };
  step(root, 0, '', '', null, []);
}
