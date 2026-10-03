import { stringify } from 'yaml';
import type { Model, RecordKind } from '../generated/types.js';
import { COLLECTIONS } from '../generated/registry.js';
import { recordKey, type CollectionName } from '../records.js';
import { HASH_NOTICE } from './notice.js';
import type { RenderContext } from './context.js';

export const YAML_FILE = 'model.yaml';

/** The YAML text of one scalar exactly as the document serializer writes it. */
const scalar = (v: unknown): string => stringify(v, { lineWidth: 0 }).trim();

/**
 * The canonical model as YAML 1.2 (core schema): mapping keys sorted, no line
 * folding, so the same model always yields the same text. importModel() reads
 * it back losslessly; strings a YAML reader would take for another type
 * ('true', 'null', '1.0') are quoted by the serializer.
 */
export function projectYaml(model: Model, ctx: RenderContext): Record<string, string> {
  for (const c of COLLECTIONS) {
    const list = (model as unknown as Record<string, Array<Record<string, unknown>>>)[c.collection] ?? [];
    const first = c.key[0] as string;
    for (const r of list) ctx.covered({ kind: c.kind as RecordKind, id: recordKey(c.collection as CollectionName, r) }, YAML_FILE, `${first}: ${scalar(r[first])}\n`);
  }
  return { [YAML_FILE]: `${HASH_NOTICE}\n${stringify(model, { sortMapEntries: true, lineWidth: 0 })}` };
}
