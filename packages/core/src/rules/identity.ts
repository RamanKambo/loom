import { COLLECTIONS, KEYED_ARRAYS } from '../generated/registry.js';
import type { RecordKind } from '../generated/types.js';
import { FINDING } from '../codes.js';
import { keyOf, recordKey, recordsOf, type CollectionName } from '../records.js';
import { collectReferences, resolveReference } from '../refs.js';
import { visitPath } from '../walk.js';
import { intentRepair, ref, type Rule } from './context.js';

/** Record ids, criterion ids included, are unique across the whole model. */
export const duplicateIds: Rule = (ctx) => {
  const seen = new Map<string, Array<{ path: string; kind: RecordKind }>>();
  const register = (id: string, path: string, kind: RecordKind): void => {
    const list = seen.get(id) ?? [];
    list.push({ path, kind });
    seen.set(id, list);
  };
  for (const c of COLLECTIONS) {
    if (c.kind === 'edge') continue;
    for (const r of recordsOf(ctx.model, c.collection as CollectionName)) {
      const id = recordKey(c.collection as CollectionName, r);
      register(id, `${c.collection}/${id}`, c.kind);
    }
  }
  for (const req of ctx.model.requirements) {
    for (const cr of req.criteria) register(cr.id, `requirements/${req.id}/criteria/${cr.id}`, 'criterion');
  }
  for (const [id, entries] of seen) {
    if (entries.length < 2) continue;
    ctx.report(
      FINDING.DUPLICATE_ID,
      entries.map((e) => e.path).join(', '),
      `id '${id}' is declared ${entries.length} times; ids must be unique across all records`,
      [ref(entries[0]!.kind, id)],
      `rename all but one of the records declaring '${id}'`,
      { repairs: [intentRepair('rename-duplicate', `Rename all but one record declaring '${id}'.`, ['Every reference to the renamed record must be updated.'])] },
    );
  }
};

/** Every keyed array other than the top-level id collections holds each key once. */
export const duplicateKeys: Rule = (ctx) => {
  for (const k of KEYED_ARRAYS) {
    const segments = k.path.split('.');
    if (segments.length === 1 && k.path !== 'edges[]') continue;
    if (k.path === 'requirements[].criteria[]') continue;
    const last = segments[segments.length - 1] as string;
    const field = last.slice(0, -2);
    const check = (container: unknown, containerPath: string, holder: { kind: RecordKind; id: string }): void => {
      const items = (container as Record<string, unknown>)[field];
      if (!Array.isArray(items)) return;
      const counts = new Map<string, number>();
      for (const item of items) {
        const key = keyOf(item, k.key as readonly string[]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const [key, n] of counts) {
        if (n < 2) continue;
        const path = `${containerPath ? `${containerPath}/` : ''}${field}/${key}`;
        ctx.report(
          FINDING.DUPLICATE_KEY,
          path,
          `${containerPath || 'the model'} lists ${field} '${key}' ${n} times; each ${(k.key as readonly string[]).join('+')} is unique`,
          [holder],
          `remove or rename the duplicate ${field} '${key}'`,
          {
            repairs: [
              intentRepair('remove-duplicate', `Keep one ${field} '${key}' and remove the others.`, [
                'The removed declarations no longer contribute to the contract; choose the one that states the intended meaning.',
              ]),
            ],
          },
        );
      }
    };
    if (segments.length === 1) {
      check(ctx.model, '', { kind: 'edge', id: '(edges)' });
      continue;
    }
    visitPath(ctx.model, segments.slice(0, -1).join('.'), (v) => check(v.value, v.path, v.holder));
  }
};

/** Every reference resolves to a declared record of the expected kind. */
export const references: Rule = (ctx) => {
  const external = new Map<string, string[]>();
  for (const r of collectReferences(ctx.model)) {
    const res = resolveReference(ctx.index, r);
    const shown = typeof r.value === 'string' ? `'${r.value}'` : JSON.stringify(r.value);
    if (res.status === 'resolved') continue;
    if (res.status === 'external') {
      const list = external.get(res.publishedContract) ?? [];
      list.push(r.path);
      external.set(res.publishedContract, list);
      continue;
    }
    if (res.status === 'wrong-kind') {
      ctx.report(
        FINDING.REFERENCE_KIND_MISMATCH,
        r.path,
        `${r.path} references ${shown}, which is a ${res.actual.join(' and a ')}, not a ${res.expected}`,
        [r.holder],
        `point ${r.path} at a ${res.expected}`,
      );
      continue;
    }
    const code = r.field === 'routines[].transactionScope[]' ? FINDING.ROUTINE_TRANSACTION_SCOPE_INVALID : FINDING.DANGLING_REF;
    ctx.report(code, r.path, `${r.path} references ${shown}: ${res.reason}`, [r.holder], `point ${r.path} at a declared record, or remove the reference`, {
      repairs: [
        intentRepair('remove-reference', `Remove the reference at ${r.path}.`, ['The holder no longer depends on the referenced record; its contract changes.']),
        intentRepair('declare-target', `Declare the referenced record ${shown}.`, ['A new record joins the model and needs its own acceptance.']),
      ],
    });
  }
  for (const [id, paths] of [...external].sort(([a], [b]) => a.localeCompare(b))) {
    ctx.report(
      FINDING.PUBLISHED_CONTRACT_UNRESOLVED,
      `publishedContracts/${id}`,
      `${paths.length} reference(s) into published contract '${id}' are not checked: its bundle is not resolved in plain validation`,
      [ref('publishedContract', id)],
      `resolve the pinned bundle of '${id}' through the workspace adapter before dependent work proceeds`,
    );
  }
};
