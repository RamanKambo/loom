import type { CataloguePresenceRule } from './generated/types.js';

/**
 * The mismatches between the names the operation catalogue exposes on one
 * interface and the handlers an adapter registers for it: a catalogued name
 * without a handler, and a handler without a catalogue entry. An adapter's
 * test holds this list empty, so neither side can grow alone.
 */
export function handlerGaps(catalogued: readonly string[], handled: readonly string[]): string[] {
  const handledNames = new Set(handled);
  const catalogueNames = new Set(catalogued);
  return [
    ...catalogued.filter((n) => !handledNames.has(n)).map((n) => `'${n}' is catalogued but has no handler`),
    ...handled.filter((n) => !catalogueNames.has(n)).map((n) => `'${n}' has a handler but no catalogue entry`),
  ];
}

/**
 * The presence rules a request breaks, in the order given. A rule applies
 * when every condition of its 'when' holds, the member carrying one of the
 * listed values; an applicable rule holds when one of its accepted
 * combinations has every member it lists as present sent and every member it
 * lists as absent left out. A member is sent when its value is not undefined.
 */
export function unmetPresenceRules(rules: readonly CataloguePresenceRule[], args: Readonly<Record<string, unknown>>): CataloguePresenceRule[] {
  const has = (member: string): boolean => args[member] !== undefined;
  const applies = (rule: CataloguePresenceRule): boolean => (rule.when ?? []).every((c) => c.in.some((value) => args[c.member] === value));
  return rules.filter((rule) => applies(rule) && !rule.accept.some((a) => a.present.every(has) && a.absent.every((m) => !has(m))));
}
