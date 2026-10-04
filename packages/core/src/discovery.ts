import type { Completeness, DiscoveryBudget, NextAction, RecordRef, ToolEffect } from './generated/types.js';
import { SCHEMA_BUNDLE } from './generated/schemas.js';
import { AGENT_TOOLS, MCP_TOOLS } from './generated/operations.js';
import { canonicalJson, deepClone } from './canonical.js';
import { canonicalHash } from './hash.js';

interface BudgetKeywords {
  default: number;
  minimum: number;
  maximum: number;
}
const BUDGET = SCHEMA_BUNDLE.$defs.DiscoveryBudget.properties as unknown as { maxBytes: BudgetKeywords; maxRecords: BudgetKeywords };

/** The defaults, minima and maxima of a discovery page, read from the keywords of DiscoveryBudget, their only home. */
export const DISCOVERY_LIMITS = {
  defaultBytes: BUDGET.maxBytes.default,
  minBytes: BUDGET.maxBytes.minimum,
  maxBytes: BUDGET.maxBytes.maximum,
  defaultRecords: BUDGET.maxRecords.default,
  minRecords: BUDGET.maxRecords.minimum,
  maxRecords: BUDGET.maxRecords.maximum,
} as const;

export interface ResolvedBudget {
  maxBytes: number;
  maxRecords: number;
}

/** A budget with every member it leaves out at its default. */
export const resolveBudget = (budget: DiscoveryBudget = {}): ResolvedBudget => ({
  maxBytes: budget.maxBytes ?? DISCOVERY_LIMITS.defaultBytes,
  maxRecords: budget.maxRecords ?? DISCOVERY_LIMITS.defaultRecords,
});

/** The UTF-8 length of a string, counted without encoding it. */
export function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** The size a budget counts: the UTF-8 bytes of the canonical JSON of a data representation, without the envelope around it. */
export const dataBytes = (value: unknown): number => utf8Bytes(canonicalJson(value));

// ---------- continuations ----------

/** The tools whose pages continue, each with the prefix of its continuations. */
export type ContinuationKind = 'context' | 'describe';

export interface Continuation {
  kind: ContinuationKind;
  /** The revision the page answers for. */
  revision: string;
  /** The digest of the filters and the budget of the request that issued it. */
  filters: string;
  /** The position in the page sequence the next page starts at. */
  offset: number;
}

const TOKEN = /^(context|describe)\.(sha256:[0-9a-f]{64})\.([0-9a-f]{16})\.(\d{1,9})$/;

/**
 * The binding of a request's filters and budget. Sixteen hex digits of their canonical hash keep the
 * token short; the binding detects a changed request, and the token carries no authority to guard.
 */
export const filtersDigest = (filters: unknown): string => canonicalHash(filters).slice('sha256:'.length, 'sha256:'.length + 16);

/** A continuation: the tool's prefix, the revision the page answers for, the binding of the request and the offset to resume at. */
export const continuationToken = (kind: ContinuationKind, revision: string, filters: unknown, offset: number): string => `${kind}.${revision}.${filtersDigest(filters)}.${offset}`;

/** A continuation's parts, or null when the token is not one Loom issued. */
export function readContinuation(token: string): Continuation | null {
  const m = TOKEN.exec(token);
  return m ? { kind: m[1] as ContinuationKind, revision: m[2] as string, filters: m[3] as string, offset: Number(m[4]) } : null;
}

export type ContinuationCheck = { ok: true; offset: number } | { ok: false; cause: 'invalid-input' | 'stale-base'; message: string };

/**
 * Whether a continuation still applies to a request: issued by the same tool, for the same filters
 * and budget, at the same revision, for a position inside the sequence. A changed revision is a stale
 * base; any other mismatch is a continuation of another request.
 */
export function checkContinuation(token: string, kind: ContinuationKind, revision: string, filters: unknown, length: number): ContinuationCheck {
  const c = readContinuation(token);
  if (!c || c.kind !== kind) return { ok: false, cause: 'invalid-input', message: `the continuation is not one ${kind === 'context' ? 'loom.context' : 'loom.describe'} issued` };
  if (c.revision !== revision) return { ok: false, cause: 'stale-base', message: `the continuation was issued for ${c.revision}, but the request now answers for ${revision}` };
  if (c.filters !== filtersDigest(filters)) return { ok: false, cause: 'invalid-input', message: 'the continuation was issued for another target, filter or budget' };
  if (c.offset > length) return { ok: false, cause: 'invalid-input', message: 'the continuation names no position of this sequence' };
  return { ok: true, offset: c.offset };
}

// ---------- pages ----------

/** One entry of a page sequence. */
export interface PageEntry {
  /** The data member the entry is placed in: one element of an array member, or the whole member when `single`. */
  member: string;
  /** The part or section the entry belongs to, as completeness names it. */
  section: string;
  /** The entry's key within its section, which completeness names when the entry cannot fit any page; empty for an entry that is its section's whole value. */
  key: string;
  value: unknown;
  single?: boolean;
  /** The model record the entry is. */
  ref?: RecordRef;
}

export interface Page {
  data: Record<string, unknown>;
  /** The position of the first entry the page does not hold. */
  next: number;
  /** Entries placed on the page, a stand-in counting as one. */
  placed: number;
  /** Entries too large for any page of this budget, each with the stand-in placed for it, if any. */
  oversized: Array<{ entry: PageEntry; standIn: PageEntry | null }>;
}

function place(data: Record<string, unknown>, e: PageEntry): () => void {
  if (e.single) {
    data[e.member] = e.value;
    return () => delete data[e.member];
  }
  const existed = Array.isArray(data[e.member]);
  if (!existed) data[e.member] = [];
  (data[e.member] as unknown[]).push(e.value);
  return () => {
    (data[e.member] as unknown[]).pop();
    if (!existed) delete data[e.member];
  };
}

/**
 * One page: the head, then the entries from `offset` while the page stays within the budget, in
 * bytes of the representation `measure` counts and in entries. An entry that does not fit even on a
 * page holding only the head can fit no page of this budget: `standIn` may offer a smaller entry in
 * its place, such as a summary naming the resource that returns it, and otherwise it is skipped. The
 * caller reports every oversized entry, so none is omitted silently.
 */
export function fillPage(
  head: Record<string, unknown>,
  entries: readonly PageEntry[],
  offset: number,
  budget: ResolvedBudget,
  measure: (data: Record<string, unknown>) => number = dataBytes,
  standIn?: (e: PageEntry) => PageEntry | null,
): Page {
  const data = deepClone(head);
  const oversized: Page['oversized'] = [];
  const fits = (): boolean => measure(data) <= budget.maxBytes;
  let placed = 0;
  let i = offset;
  for (; i < entries.length && placed < budget.maxRecords; i++) {
    const e = entries[i] as PageEntry;
    const undo = place(data, e);
    if (fits()) {
      placed++;
      continue;
    }
    undo();
    // A page that already holds an entry ends here; the entry starts the next page.
    if (placed > 0) break;
    const stand = standIn?.(e) ?? null;
    if (stand) {
      const undoStand = place(data, stand);
      if (fits()) {
        placed++;
        oversized.push({ entry: e, standIn: stand });
        continue;
      }
      undoStand();
    }
    oversized.push({ entry: e, standIn: null });
  }
  return { data, next: i, placed, oversized };
}

/**
 * The completeness of one page of a sequence: every section with entries on earlier pages, every
 * section with entries left for later pages and the continuation that retrieves them, every entry too
 * large for any page, and every section the request did not ask for. Sections are named rather than
 * each record, so the envelope stays bounded whatever the size of the sequence.
 */
export function pageCompleteness(entries: readonly PageEntry[], offset: number, page: Page, continuation: string | undefined, unrequested: readonly string[] = []): Completeness {
  const before = new Set(entries.slice(0, offset).map((e) => e.section));
  const after = new Set(entries.slice(page.next).map((e) => e.section));
  const omitted: Completeness['omitted'] = [
    ...[...before].map((section) => ({ section, reason: 'not-requested' as const })),
    ...page.oversized.map(({ entry }) => (entry.ref ? { ref: entry.ref, section: entry.section, reason: 'budget' as const } : { section: entry.key ? `${entry.section}/${entry.key}` : entry.section, reason: 'budget' as const })),
    ...[...after].map((section) => ({ section, reason: 'budget' as const, continuation: continuation as string })),
    ...unrequested.map((section) => ({ section, reason: 'not-requested' as const })),
  ];
  const completeness: Completeness = { complete: omitted.length === 0, truncated: omitted.some((o) => o.reason === 'budget'), omitted };
  if (continuation) completeness.continuation = continuation;
  return completeness;
}

// ---------- next actions ----------

/** The effect on persisted state of a catalogued tool or of one action of an agent tool, read from the operation catalogue. */
export function toolEffects(tool: string, action?: string): ToolEffect {
  const advertised = MCP_TOOLS.find((t) => t.name === tool);
  if (advertised) return advertised.effects;
  const agent = AGENT_TOOLS.find((t) => t.name === tool)?.actions.find((a) => a.action === action);
  if (!agent) throw new Error(`the operation catalogue holds no tool '${tool}'${action ? ` with action '${action}'` : ''}`);
  return agent.effects;
}

/** A next action whose effect is the catalogued effect of its tool. */
export function nextAction(purpose: string, tool: string, args: Record<string, unknown>, prerequisites: string[] = []): NextAction {
  const action = typeof args['action'] === 'string' ? (args['action'] as string) : undefined;
  return { purpose, tool, arguments: args, prerequisites, effects: toolEffects(tool, action), blockedBy: [] };
}
