import type { Expression, Operand, Predicate, RecordRef } from '../generated/types.js';

/** A construct the target profile cannot express, met while rendering. */
export interface Unsupported {
  construct: string;
  ref: RecordRef;
  reason: string;
}

/** What a renderer may report besides its output. */
export interface RenderContext {
  /** Record a construct the target cannot express; project() refuses unless rendering a draft. */
  unsupported(construct: string, ref: RecordRef, reason: string): void;
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
