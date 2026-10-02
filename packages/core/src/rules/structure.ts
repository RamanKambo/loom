import type { Edge } from '../generated/types.js';
import { FINDING } from '../codes.js';
import { splitQualified } from '../refs.js';
import { intentRepair, ref, type Rule } from './context.js';

/** Elementary cycles of a directed graph, each reported once regardless of its starting node. */
export function findCycles(nodes: readonly string[], next: (n: string) => readonly string[]): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const found = new Map<string, string[]>();
  const visit = (u: string): void => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of next(u)) {
      const c = color.get(v) ?? WHITE;
      if (c === WHITE) visit(v);
      else if (c === GRAY) {
        const cycle = stack.slice(stack.indexOf(v)).concat(v);
        const key = [...new Set(cycle)].sort().join('|');
        if (!found.has(key)) found.set(key, cycle);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };
  for (const n of nodes) if ((color.get(n) ?? WHITE) === WHITE) visit(n);
  return [...found.values()];
}

/** Workflow dependency cycles and import pins; edge cycles by relationship kind. */
export const structureRules: Rule = (ctx) => {
  const workflowIds = ctx.model.workflows.map((w) => w.id);
  const known = new Set(workflowIds);
  const deps = new Map(ctx.model.workflows.map((w) => [w.id, w.dependsOn.filter((d) => known.has(d))]));
  for (const cycle of findCycles(workflowIds, (n) => deps.get(n) ?? [])) {
    ctx.report(FINDING.WORKFLOW_DEPENDENCY_CYCLE, `workflows: ${cycle.join(' -> ')}`, `workflow dependency cycle: ${cycle.join(' -> ')}`, cycle.map((id) => ref('workflow', id)), `remove one dependsOn link in ${cycle.join(' -> ')}`);
  }
  for (const w of ctx.model.workflows) {
    for (const im of w.imports) {
      if (splitQualified(im.typeId)) continue;
      const t = ctx.index.types.get(im.typeId);
      if (t && t.version !== im.version) {
        ctx.report(
          FINDING.WORKFLOW_IMPORT_VERSION_MISMATCH,
          `workflows/${w.id}/imports/${im.typeId}`,
          `workflow '${w.id}' pins type '${im.typeId}' at version ${im.version}, but the type is at version ${t.version}`,
          [ref('workflow', w.id)],
          `set workflow '${w.id}' import of '${im.typeId}' to version ${t.version} in the same change`,
          { repairs: [intentRepair('adopt-version', `Pin '${im.typeId}' at version ${t.version}.`, [`Workflow '${w.id}' adopts the changed contract of '${im.typeId}'.`])] },
        );
      }
    }
  }

  const byKind = (kinds: ReadonlySet<Edge['kind']>): Map<string, Edge[]> => {
    const out = new Map<string, Edge[]>();
    for (const e of ctx.model.edges) {
      if (!kinds.has(e.kind)) continue;
      const list = out.get(e.from) ?? [];
      list.push(e);
      out.set(e.from, list);
    }
    return out;
  };
  const nodes = [...new Set(ctx.model.edges.flatMap((e) => [e.from, e.to]))].sort();
  const build = byKind(new Set(['build', 'structural']));
  for (const cycle of findCycles(nodes, (n) => (build.get(n) ?? []).map((e) => e.to))) {
    ctx.report(FINDING.EDGE_BUILD_CYCLE, `edges: ${cycle.join(' -> ')}`, `build or structural dependency cycle: ${cycle.join(' -> ')}`, [], `remove one build or structural edge in ${cycle.join(' -> ')}, or merge the cycle into one accepted design package`);
  }
  const runtime = byKind(new Set(['runtime']));
  for (const cycle of findCycles(nodes, (n) => (runtime.get(n) ?? []).map((e) => e.to))) {
    const arcs = cycle.slice(0, -1).map((from, i) => (runtime.get(from) ?? []).find((e) => e.to === cycle[i + 1]));
    if (arcs.some((e) => e?.cycle?.behavior !== undefined)) continue;
    ctx.report(FINDING.EDGE_RUNTIME_CYCLE_UNDEFINED, `edges: ${cycle.join(' -> ')}`, `runtime interaction cycle without defined behavior: ${cycle.join(' -> ')}`, [], `declare cycle.behavior on one runtime edge of ${cycle.join(' -> ')}`);
  }
};
