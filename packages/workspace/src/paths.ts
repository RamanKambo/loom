import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Finding } from '@loom/core';
import { finding } from './findings.js';
import { toPosix } from './fsx.js';

export const segmentsOf = (p: string): string[] => toPosix(p).split('/').filter((s) => s !== '' && s !== '.');

const swapCase = (s: string): string => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');

const caseCache = new Map<string, boolean>();

/**
 * Whether names in the directory holding `path` compare case-sensitively. It is
 * probed, not inferred from the platform, because case sensitivity is a property
 * of the volume (and, on Windows, of each directory): the nearest existing
 * lettered entry is looked up under its case-swapped name and the two are
 * compared by file identity. Read-only: nothing is created to probe.
 */
export function isCaseSensitive(path: string): boolean {
  let p = resolve(path);
  while (!(existsSync(p) && /[A-Za-z]/.test(basename(p)))) {
    const parent = dirname(p);
    if (parent === p) return true;
    p = parent;
  }
  const key = dirname(p);
  const cached = caseCache.get(key);
  if (cached !== undefined) return cached;
  const swapped = join(dirname(p), swapCase(basename(p)));
  let sensitive = true;
  if (existsSync(swapped)) {
    const a = statSync(p, { bigint: true });
    const b = statSync(swapped, { bigint: true });
    sensitive = !(a.ino === b.ino && a.dev === b.dev);
  }
  caseCache.set(key, sensitive);
  return sensitive;
}

/** The real path of `p`; a non-existent tail is appended to the real path of its nearest existing ancestor. */
export function realPathOf(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(basename(cur));
    cur = parent;
  }
  let real = cur;
  try {
    real = realpathSync.native(cur);
  } catch {
    real = cur;
  }
  return rest.length ? join(real, ...rest) : real;
}

/**
 * Containment by whole path segments under the volume's case rules, so 'src/a'
 * contains 'src/a/x' but never 'src/ab'. Both paths are absolute; callers pass
 * real paths when links must not decide the answer.
 */
export function containsPath(root: string, child: string, caseSensitive = isCaseSensitive(root)): boolean {
  const fold = (s: string): string => (caseSensitive ? s : s.toLowerCase());
  const a = segmentsOf(resolve(root)).map(fold);
  const b = segmentsOf(resolve(child)).map(fold);
  if (a.length > b.length) return false;
  return a.every((s, i) => s === b[i]);
}

export const samePath = (a: string, b: string): boolean => containsPath(a, b) && containsPath(b, a);

/** Normalized repository-relative form: forward slashes, no './' or trailing '/', '.' for the root itself. */
export function normalizeRelative(rel: string): string {
  const segs = segmentsOf(rel);
  return segs.length ? segs.join('/') : '.';
}

/** Why a configured relative path is not acceptable, or null when it is. */
export function relativePathProblem(rel: string): string | null {
  if (rel.trim() === '') return 'is empty';
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return 'is absolute; scope roots and outputs are repository-relative';
  if (segmentsOf(rel).includes('..')) return "contains a '..' segment that escapes the repository";
  return null;
}

export interface ResolvedRoot {
  component: string;
  /** Normalized repository-relative root. */
  rel: string;
  abs: string;
  /** Real path; for a missing root, the real path of its nearest existing ancestor plus the remainder. */
  real: string;
  exists: boolean;
}

/** Resolve one configured scope root against the repository that holds the descriptor. */
export function resolveRoot(repoRoot: string, rel: string, component: string, at: string): { root: ResolvedRoot | null; findings: Finding[] } {
  const problem = relativePathProblem(rel);
  if (problem) {
    return { root: null, findings: [finding('SCOPE_ROOT_INVALID', at, `scope root '${rel}' of '${component}' ${problem}`, 'declare the root as a repository-relative directory inside the workspace')] };
  }
  const norm = normalizeRelative(rel);
  const abs = norm === '.' ? resolve(repoRoot) : join(resolve(repoRoot), ...norm.split('/'));
  const real = realPathOf(abs);
  const findings: Finding[] = [];
  if (!containsPath(realPathOf(repoRoot), real)) {
    findings.push(finding('SCOPE_ROOT_INVALID', at, `scope root '${rel}' of '${component}' resolves to '${toPosix(real)}', outside the workspace, through a link or junction`, 'declare a root whose real path stays inside the workspace'));
    return { root: null, findings };
  }
  const exists = existsSync(abs);
  if (!exists) findings.push(finding('SCOPE_ROOT_MISSING', at, `scope root '${norm}' of '${component}' does not exist`, 'create or check out the root, or remove it from the scope'));
  return { root: { component, rel: norm, abs, real, exists }, findings };
}

/** Forward-slash path of `target` relative to `from`; '.' when they are the same. */
export function relativeTo(from: string, target: string): string {
  const r = toPosix(relative(resolve(from), resolve(target)));
  return r === '' ? '.' : r;
}
