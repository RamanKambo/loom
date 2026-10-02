import type { Finding, FindingCode, Model, RecordRef, Repair, RecordKind } from '../generated/types.js';
import { FINDING_RULES } from '../codes.js';
import type { ModelIndex } from '../records.js';
import type { DependencyGraph } from '../graph.js';

export interface ReportExtra {
  repairs?: Repair[];
  refs?: RecordRef[];
}

export interface RuleContext {
  readonly model: Model;
  readonly index: ModelIndex;
  readonly graph: DependencyGraph;
  /**
   * Record a finding. Severity comes from FINDING_RULES, so it has one home;
   * impact is every transitive consumer of `about`.
   */
  report(code: FindingCode, path: string, message: string, about: readonly RecordRef[], fix: string, extra?: ReportExtra): void;
}

/** One semantic rule pass. Rules are pure and total: an unresolved reference is a finding, never an exception. */
export type Rule = (ctx: RuleContext) => void;

export function createContext(model: Model, index: ModelIndex, graph: DependencyGraph, sink: Finding[]): RuleContext {
  return {
    model,
    index,
    graph,
    report(code, path, message, about, fix, extra) {
      const finding: Finding = { code, severity: FINDING_RULES[code].severity, path, message, fix };
      const impact = graph.affected(about);
      if (impact.length) finding.impact = impact;
      const refs = extra?.refs ?? about;
      if (refs.length) finding.refs = [...refs];
      if (extra?.repairs?.length) finding.repairs = extra.repairs;
      sink.push(finding);
    },
  };
}

export const ref = (kind: RecordKind, id: string): RecordRef => ({ kind, id });

/** A repair alternative that changes accepted intent; never applied automatically. */
export function intentRepair(id: string, description: string, consequences: string[], preconditions: string[] = []): Repair {
  return { id, description, kind: 'intent-change', requiresAcceptance: true, preconditions, consequences };
}

/** A repair that preserves meaning, with the patches that perform it. */
export function mechanicalRepair(id: string, description: string, patches: Repair['patches'], preconditions: string[] = []): Repair {
  const r: Repair = { id, description, kind: 'mechanical', requiresAcceptance: false, preconditions, consequences: ['No contract meaning changes.'] };
  if (patches && patches.length) r.patches = patches;
  return r;
}
