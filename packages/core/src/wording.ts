/**
 * The marker patterns Loom's own explanatory text never carries: documents,
 * comments, docstrings, schema descriptions, examples and generated prose name
 * a capability descriptively ("workspace ownership", "SQL cleanup"), never by
 * an internal label or by the release iteration that introduced it.
 */
export type MarkerKind = 'label' | 'iteration' | 'generation';

export interface ProhibitedMarker {
  kind: MarkerKind;
  match: string;
}

/**
 * Prefixes of external standards and license identifiers, which share the shape
 * of an internal label (SHA-256, UTF-8, RFC-9110, MPL-2.0) and are legitimate
 * technical content.
 */
const STANDARD_PREFIXES = new Set([
  'AES', 'AGPL', 'ANSI', 'BSD', 'CC', 'CVE', 'CWE', 'ECMA', 'EPL', 'ES', 'FIPS', 'GPL', 'HTTP', 'IEC', 'IEEE',
  'IPV', 'ISO', 'LGPL', 'MD', 'MPL', 'NIST', 'PKCS', 'RFC', 'RSA', 'SHA', 'SQL', 'SSL', 'TLS', 'UCS', 'UTF',
]);

/** Technology names that carry a version suffix of their own, removed before matching. */
const TECHNOLOGY_TOKENS = ['stateDiagram-v2'];

/**
 * A label is an upper-case prefix of two or more characters, a hyphen and a
 * number (an abbreviated requirement, task or phase marker). A single letter
 * is not matched: a letter, a hyphen and a number is also the common shape of
 * a domain identifier such as account A-1.
 */
const LABEL = /(?<![\w-])([A-Z][A-Z0-9]{1,6})-\d+[a-z]?\b/g;

/** A following ".<digit>" makes the number a version ("release 1.0.0"), which is legitimate. */
const ITERATION: readonly RegExp[] = [
  /\b(?:phase|iteration|milestone|sprint|wave|increment|gate|release|round)\s+\d+\b(?!\.\d)/gi,
  /\bv\d+\b(?!\.\d)/gi,
];

const GENERATION: readonly RegExp[] = [
  /\blegacy\b/gi,
  /\bbackwards?[- ]compat\w*/gi,
  /\bnew in (?:v?\d|version|release|this (?:version|release))\b/gi,
  /\b(?:first|second|third|next|new|old|previous|prior)[- ]generation\b/gi,
];

/** Every prohibited marker in one line of explanatory text. */
export function prohibitedMarkers(text: string): ProhibitedMarker[] {
  let line = text;
  for (const token of TECHNOLOGY_TOKENS) line = line.split(token).join(' ');
  const out: ProhibitedMarker[] = [];
  for (const m of line.matchAll(LABEL)) if (!STANDARD_PREFIXES.has(m[1] as string)) out.push({ kind: 'label', match: m[0] });
  for (const re of ITERATION) for (const m of line.matchAll(re)) out.push({ kind: 'iteration', match: m[0] });
  for (const re of GENERATION) for (const m of line.matchAll(re)) out.push({ kind: 'generation', match: m[0] });
  return out;
}
