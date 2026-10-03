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
