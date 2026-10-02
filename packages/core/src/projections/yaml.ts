import { stringify } from 'yaml';
import type { Model } from '../generated/types.js';
import { HASH_NOTICE } from './notice.js';

/**
 * The canonical model as YAML 1.2 (core schema): mapping keys sorted, no line
 * folding, so the same model always yields the same text. importModel() reads
 * it back losslessly; strings a YAML reader would take for another type
 * ('true', 'null', '1.0') are quoted by the serializer.
 */
export function projectYaml(model: Model): string {
  return `${HASH_NOTICE}\n${stringify(model, { sortMapEntries: true, lineWidth: 0 })}`;
}
