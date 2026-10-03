import type { Expression, Operand, Predicate, RecordRef } from '../generated/types.js';
import type { EvaluationInputs } from '../inputs.js';

/** A construct the target profile cannot express, met while rendering. */
export interface Unsupported {
  construct: string;
  ref: RecordRef;
  reason: string;
}

/** What a renderer may report besides its output. */
export interface RenderContext {
  /** The component a per-component instance is rendered for; absent for a singleton. */
  component?: string;
  /** Baselines, acceptance, evidence and policy for views that report readiness or evidence; absent means not evaluated. */
  inputs?: EvaluationInputs;
  /** Record a construct the target cannot express; the projection refuses or, where the profile permits, renders a draft. */
  unsupported(construct: string, ref: RecordRef, reason: string): void;
  /**
   * Record that `ref` is projected into `file`. Each location is a JSON Pointer
   * into an object artifact, or a literal substring of a text artifact; the
   * projection checks every one against the rendered output.
   */
  covered(ref: RecordRef, file: string, ...locations: string[]): void;
}

const operandText = (o: Operand): string => ('property' in o ? o.property : JSON.stringify(o.literal));

const OPS: Record<string, string> = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' };

/** Human-readable text of a loom-predicate-1 expression. */
export function expressionText(e: Expression): string {
  switch (e.op) {
    case 'and':
    case 'or':
      return e.args.map((a) => `(${expressionText(a)})`).join(` ${e.op} `);
    case 'not':
      return `not (${expressionText(e.arg)})`;
    case 'in':
      return `${operandText(e.operand)} in [${e.values.map((v) => JSON.stringify(v)).join(', ')}]`;
    case 'isNull':
      return `${operandText(e.operand)} is null`;
    case 'isNotNull':
      return `${operandText(e.operand)} is not null`;
    default:
      return `${operandText(e.left)} ${OPS[e.op] ?? e.op} ${operandText(e.right)}`;
  }
}

/** Text of a predicate: prose verbatim, an expression rendered. */
export function predicateText(p: Predicate): string {
  return p.form === 'prose' ? p.text : expressionText(p.expression);
}

/** A JSON Pointer from unescaped segments. */
export function pointer(...segments: string[]): string {
  return segments.map((s) => `/${s.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

/** PascalCase of an id or a member name: 'order-request' -> 'OrderRequest', 'order_id' -> 'OrderId'. */
export function pascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter((p) => p.length > 0)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('');
}
