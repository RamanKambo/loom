import type { Model, RecordKind, RecordRef } from '../generated/types.js';
import type { EvaluationInputs } from '../inputs.js';
import { canonicalHash, modelRevision } from '../hash.js';
import { indexModel, type ModelIndex } from '../records.js';
import { ownersOf } from '../scope.js';
import { code, label } from './mermaid.js';
import { MARKDOWN_NOTICE } from './notice.js';

/** A table cell: one line, pipes escaped, angle brackets escaped so ids are never read as HTML. */
export const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/[<>]/g, '\\$&');
export const codes = (values: readonly string[]): string => (values.length ? values.map(code).join(', ') : '(none)');
export const refText = (r: RecordRef): string => `${r.kind} ${code(r.id)}`;

/**
 * The heading lines every generated view opens with: the source notice, the
 * title, and the revisions it was rendered from, so a reader can tell which
 * inputs a view reflects. Nothing time- or machine-dependent is included.
 */
export function viewHeader(model: Model, title: string, inputs: EvaluationInputs | undefined): string[] {
  return [MARKDOWN_NOTICE, `# ${title}`, '', `Model revision ${code(modelRevision(model))}.`, '', inputsLine(inputs), ''];
}

/** One sentence naming the evaluation inputs, or stating that none were supplied. */
export function inputsLine(inputs: EvaluationInputs | undefined): string {
  if (!inputs) return 'Evaluation inputs: none were supplied, so readiness, acceptance and evidence are not evaluated.';
  const parts: string[] = [];
  if (inputs.baseline) parts.push(`baseline ${code(inputs.baseline.record.id)} (${code(inputs.baseline.record.model.hash)}, ${inputs.baseline.verified ? 'verified' : 'not verified'})`);
  else parts.push('no baseline');
  if (inputs.policy) parts.push(`policy ${code(inputs.policy.id)} revision ${inputs.policy.revision}`);
  else parts.push('no policy');
  const evidence = inputs.evidence ?? [];
  parts.push(
    evidence.length
      ? `${evidence.length} evidence record(s) ${code(canonicalHash(evidence.map((e) => ({ id: e.record.id, trusted: e.trusted, result: e.record.result }))))}`
      : 'no evidence records',
  );
  if (inputs.acceptances?.length) parts.push(`${inputs.acceptances.length} acceptance record(s)`);
  if (inputs.asOf) parts.push(`evaluated as of ${inputs.asOf}`);
  return `Evaluation inputs: ${parts.join('; ')}.`;
}

/** The kind of a record id when exactly one record kind declares it. */
export function kindOfId(index: ModelIndex, id: string): RecordKind | undefined {
  const kinds = index.kindsOfId.get(id);
  return kinds && kinds.length === 1 ? kinds[0] : undefined;
}

/** Owning components of a record named by id alone, as edges name them. */
export function ownersOfId(index: ModelIndex, id: string): string[] {
  const kind = kindOfId(index, id);
  return kind ? ownersOf(index, { kind, id }) : [];
}

export { code, label, indexModel };
