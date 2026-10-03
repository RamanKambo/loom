import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalHash, textHash } from '@loom/core';
import type { Finding, LoomConfig, Model, OwnershipResult, WorkspaceCoverage } from '@loom/core';
import { CACHE_DIR, LOOM_DIR, openWorkspace, readConfig, readModelDocument, type Workspace } from './config.js';
import { finding } from './findings.js';
import { readJson, toPosix, writeFileAtomic, documentText } from './fsx.js';
import { containsPath, realPathOf, relativeTo, resolveRoot, type ResolvedRoot } from './paths.js';
import { declaredSubmodules, findBoundary, isRepositoryRoot } from './repo.js';

export interface Descriptor {
  /** Directory holding the .loom directory. */
  home: string;
  loomDir: string;
  /** .loom location relative to the boundary, forward slashes. */
  location: string;
  readable: boolean;
  config: LoomConfig | null;
  claims: ResolvedRoot[];
  findings: Finding[];
}

export const hasDescriptor = (dir: string): boolean => {
  try {
    return statSync(join(dir, LOOM_DIR)).isDirectory();
  } catch {
    return false;
  }
};

/** Read one descriptor's claims. An unreadable descriptor claims nothing that can be relied on. */
export function readDescriptor(home: string, boundary: string): Descriptor {
  const loomDir = join(home, LOOM_DIR);
  const location = relativeTo(boundary, loomDir);
  const config = readConfig(loomDir);
  if (!config.value) return { home, loomDir, location, readable: false, config: null, claims: [], findings: config.findings };
  const claims: ResolvedRoot[] = [];
  const findings: Finding[] = [];
  for (const [component, rels] of Object.entries(config.value.scope)) {
    (rels ?? []).forEach((rel, i) => {
      const r = resolveRoot(home, rel, component, `${location}/loom.json#/scope/${component}/${i}`);
      // A missing root is still claimed: its owner is declared even before the checkout exists.
      findings.push(...r.findings.filter((f) => f.code !== 'SCOPE_ROOT_MISSING'));
      if (r.root) claims.push(r.root);
    });
  }
  return { home, loomDir, location, readable: true, config: config.value, claims, findings };
}

/** Descriptors in `start` and every ancestor directory up to and including `boundary`, nearest first. */
export function ancestorDescriptors(start: string, boundary: string): Descriptor[] {
  const out: Descriptor[] = [];
  let cur = resolve(start);
  const b = resolve(boundary);
  for (;;) {
    if (hasDescriptor(cur)) out.push(readDescriptor(cur, b));
    if (!containsPath(b, cur) || containsPath(cur, b)) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

const claimOf = (d: Descriptor, abs: string): ResolvedRoot | undefined => {
  const real = realPathOf(abs);
  return d.claims.find((c) => containsPath(c.real, real));
};

/** A declared submodule whose checkout is absent and whose path contains `abs`. */
function missingCheckoutContaining(abs: string, boundary: string): string | null {
  let cur = resolve(abs);
  for (;;) {
    if (isRepositoryRoot(cur)) {
      for (const s of declaredSubmodules(cur)) {
        const p = join(cur, ...s.path.split('/'));
        if (!s.checkedOut && containsPath(p, abs)) return relativeTo(boundary, p);
      }
    }
    if (containsPath(cur, boundary)) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export interface OwnerOutcome {
  result: OwnershipResult;
  owner: Descriptor | null;
  candidates: Descriptor[];
  findings: Finding[];
}

/**
 * Owner of one path. Every candidate ancestor descriptor up to the boundary is
 * inspected, claiming or not, and uniqueness is verified before an owner is
 * named: a nearer non-claiming descriptor never hides an ancestor owner, two
 * claims are an overlap rather than a first match, and 'ungoverned' is returned
 * only when every candidate was readable and every required checkout present.
 */
export function resolveOwner(path: string, options: { boundary?: string } = {}): OwnerOutcome {
  const abs = resolve(path);
  const boundary = findBoundary(abs, options.boundary);
  const start = existsSync(abs) && !statSync(abs).isDirectory() ? dirname(abs) : abs;
  const candidates = ancestorDescriptors(start, boundary);
  const rel = relativeTo(boundary, abs);
  const inspected: OwnershipResult['candidates'] = candidates.map((d) => {
    const c = d.readable ? claimOf(d, abs) : undefined;
    const entry: OwnershipResult['candidates'][number] = { descriptor: d.location, claims: c !== undefined, readable: d.readable };
    if (c) entry.component = c.component;
    return entry;
  });
  const claimers = candidates.filter((d) => d.readable && claimOf(d, abs));
  const unreadable = candidates.filter((d) => !d.readable);
  const missing = missingCheckoutContaining(abs, boundary);
  const findings: Finding[] = [];
  let status: OwnershipResult['status'];
  if (claimers.length > 1) {
    status = 'overlap';
    findings.push(finding('SCOPE_OVERLAP', rel, `'${rel}' is claimed by ${claimers.map((d) => d.location).join(' and ')}`, 'narrow one scope so the path has a single owning model'));
  } else if (unreadable.length || missing) {
    status = 'unresolved';
    const why = [
      ...unreadable.map((d) => `descriptor ${d.location} cannot be read`),
      ...(missing ? [`required checkout ${missing} is absent`] : []),
    ].join('; ');
    findings.push(finding('SCOPE_UNRESOLVED', rel, `ownership of '${rel}' is unresolved: ${why}`, 'repair the descriptor or check out the submodule, then resolve again'));
  } else if (claimers.length === 1) {
    status = 'owned';
  } else {
    status = 'ungoverned';
    findings.push(finding('SCOPE_NO_OWNER', rel, `no model claims '${rel}' after inspecting ${candidates.length} descriptor(s)`, 'claim the path in the owning loom.json scope if it should be governed'));
  }
  const result: OwnershipResult = { path: rel, status, candidates: inspected };
  const owner = status === 'owned' ? (claimers[0] as Descriptor) : null;
  if (owner) {
    const c = claimOf(owner, abs) as ResolvedRoot;
    result.owner = { descriptor: owner.location, component: c.component, root: c.rel };
  }
  return { result, owner, candidates, findings };
}

export interface ModelResolution {
  /** 'workspace': the discovered model; 'explicit': a supplied document under the governing workspace's policy; 'validation-only': no descriptor applies. */
  mode: 'workspace' | 'explicit' | 'validation-only';
  model: Model | null;
  modelPath: string | null;
  workspace: Workspace | null;
  ownership: OwnershipResult;
  findings: Finding[];
}

/**
 * The model for a working directory. An explicit model path selects the
 * document but never exempts it: when the directory is governed, the governing
 * workspace (its scope, baseline and policy bindings) is returned with it, so a
 * replacement model is compared against the same accepted baseline.
 */
export function resolveModel(cwd: string, options: { model?: string; boundary?: string } = {}): ModelResolution {
  const dir = resolve(cwd);
  const owner = resolveOwner(dir, options.boundary ? { boundary: options.boundary } : {});
  const findings: Finding[] = [];
  let governing: string | null = owner.owner?.home ?? null;
  // At a descriptor's own repository root the descriptor governs model commands even when its narrowed scope does not claim the root directory.
  if (!governing && owner.result.status === 'ungoverned' && hasDescriptor(dir)) governing = dir;
  const ws = governing ? openWorkspace(governing) : null;
  if (ws) findings.push(...ws.findings);
  if (options.model) {
    const path = resolve(dir, options.model);
    const doc = readModelDocument(path, toPosix(options.model));
    findings.push(...doc.findings);
    if (owner.result.status === 'overlap' || owner.result.status === 'unresolved') findings.push(...owner.findings);
    if (!ws || !ws.value) {
      findings.push(finding('VALIDATION_ONLY_MODE', toPosix(options.model), 'no workspace descriptor governs this directory; only model validity is evaluated', 'run inside a governed workspace to apply its scope, baseline and policy'));
      return { mode: 'validation-only', model: doc.value, modelPath: path, workspace: null, ownership: owner.result, findings };
    }
    return { mode: 'explicit', model: doc.value, modelPath: path, workspace: ws.value, ownership: owner.result, findings };
  }
  if (ws && ws.value) return { mode: 'workspace', model: ws.value.model, modelPath: ws.value.modelPath, workspace: ws.value, ownership: owner.result, findings };
  return { mode: 'validation-only', model: null, modelPath: null, workspace: null, ownership: owner.result, findings: [...findings, ...owner.findings] };
}

export interface Traversal {
  /** Directory names never descended into. */
  exclude: string[];
}

/** Dependency, build-output and cache directories hold no descriptor and are skipped by declared policy. */
export const DEFAULT_TRAVERSAL: Traversal = { exclude: ['node_modules', 'dist', 'bin', 'obj', '.git', '.angular', 'coverage'] };

export interface DiscoveryResult {
  coverage: WorkspaceCoverage;
  descriptors: Descriptor[];
  findings: Finding[];
  /** True when the walk was answered from a cache whose invalidation identity still matched. */
  cached: boolean;
}

interface WalkRecord {
  homes: string[];
  excluded: string[];
  missing: string[];
  unreadable: string[];
  /** Per traversed directory: mtime and a hash of its sorted entry names. */
  dirs: Record<string, string>;
}

function dirIdentity(dir: string): string | null {
  try {
    const names = readdirSync(dir).sort();
    return `${statSync(dir).mtimeMs}:${textHash(names.join('\n'))}`;
  } catch {
    return null;
  }
}

function walk(boundary: string, traversal: Traversal): WalkRecord {
  const rec: WalkRecord = { homes: [], excluded: [], missing: [], unreadable: [], dirs: {} };
  const skip = new Set(traversal.exclude);
  const visit = (dir: string): void => {
    const rel = relativeTo(boundary, dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      rec.unreadable.push(rel);
      return;
    }
    rec.dirs[rel] = dirIdentity(dir) ?? '';
    if (isRepositoryRoot(dir)) {
      for (const s of declaredSubmodules(dir)) if (!s.checkedOut) rec.missing.push(relativeTo(boundary, join(dir, ...s.path.split('/'))));
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = join(dir, e.name);
      if (e.name === LOOM_DIR && e.isDirectory()) {
        rec.homes.push(dir);
        continue;
      }
      if (e.isSymbolicLink()) {
        rec.excluded.push(`${relativeTo(boundary, child)} (link, not followed)`);
        continue;
      }
      if (!e.isDirectory()) continue;
      if (skip.has(e.name)) {
        rec.excluded.push(relativeTo(boundary, child));
        continue;
      }
      visit(child);
    }
  };
  visit(boundary);
  return rec;
}

interface CacheFile {
  boundary: string;
  traversal: Traversal;
  record: WalkRecord;
  descriptors: Record<string, string>;
}

const descriptorHash = (home: string): string => {
  try {
    return textHash(readFileSync(join(home, LOOM_DIR, 'loom.json'), 'utf8'));
  } catch {
    return 'unreadable';
  }
};

function cacheValid(cache: CacheFile, boundary: string, traversal: Traversal): boolean {
  if (cache.boundary !== toPosix(boundary) || canonicalHash(cache.traversal) !== canonicalHash(traversal)) return false;
  for (const [rel, identity] of Object.entries(cache.record.dirs)) {
    const dir = rel === '.' ? boundary : join(boundary, ...rel.split('/'));
    if (dirIdentity(dir) !== identity) return false;
  }
  for (const [home, hash] of Object.entries(cache.descriptors)) if (descriptorHash(home) !== hash) return false;
  return true;
}

/**
 * The explicit full walk of a declared boundary: every descriptor, what the
 * traversal policy excluded, declared submodules without a checkout and
 * unreadable directories, plus pairwise overlap across every descriptor.
 * Incomplete coverage is reported as such and never establishes disjointness.
 * The cache only saves the walk; descriptors are re-read every time, and a
 * missing or invalid cache gives the same result.
 */
export function discoverAll(boundary: string, options: { traversal?: Traversal; cacheDir?: string | null } = {}): DiscoveryResult {
  const b = resolve(boundary);
  const traversal = options.traversal ?? DEFAULT_TRAVERSAL;
  const cacheDir = options.cacheDir === undefined ? (hasDescriptor(b) ? join(b, LOOM_DIR, CACHE_DIR) : null) : options.cacheDir;
  const cachePath = cacheDir ? join(cacheDir, 'discovery.json') : null;
  let record: WalkRecord | null = null;
  let cached = false;
  if (cachePath) {
    const r = readJson(cachePath);
    if (r.ok && cacheValid(r.value as CacheFile, b, traversal)) {
      record = (r.value as CacheFile).record;
      cached = true;
    }
  }
  if (!record) {
    record = walk(b, traversal);
    if (cachePath && cacheDir) {
      const file: CacheFile = { boundary: toPosix(b), traversal, record, descriptors: Object.fromEntries(record.homes.map((h) => [h, descriptorHash(h)])) };
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileAtomic(cachePath, documentText(file));
      } catch {
        // A cache that cannot be written only costs the next walk; the result does not depend on it.
      }
    }
  }
  const descriptors = record.homes.map((h) => readDescriptor(h, b));
  const findings: Finding[] = descriptors.flatMap((d) => d.findings);
  const unreadable = [...record.unreadable, ...descriptors.filter((d) => !d.readable).map((d) => d.location)];
  findings.push(...overlapFindings(descriptors));
  const coverage: WorkspaceCoverage = {
    boundary: toPosix(b),
    complete: record.missing.length === 0 && unreadable.length === 0,
    descriptors: descriptors.map((d) => d.location),
    excluded: record.excluded,
    missing: record.missing,
    unreadable,
  };
  for (const m of record.missing) findings.push(finding('SCOPE_UNRESOLVED', m, `declared submodule ${m} has no checkout; coverage is incomplete`, 'check out the submodule before relying on global disjointness'));
  return { coverage, descriptors, findings, cached };
}

/** Every pair of descriptors whose claimed roots overlap, and every pair of components within one descriptor. */
export function overlapFindings(descriptors: readonly Descriptor[]): Finding[] {
  const out: Finding[] = [];
  const readable = descriptors.filter((d) => d.readable);
  for (let i = 0; i < readable.length; i++) {
    const a = readable[i] as Descriptor;
    for (let x = 0; x < a.claims.length; x++) {
      for (let y = x + 1; y < a.claims.length; y++) {
        const ca = a.claims[x] as ResolvedRoot;
        const cb = a.claims[y] as ResolvedRoot;
        if (ca.component !== cb.component && (containsPath(ca.real, cb.real) || containsPath(cb.real, ca.real))) {
          out.push(finding('SCOPE_COMPONENT_ROOT_OVERLAP', `${a.location}/loom.json#/scope`, `root '${ca.rel}' of '${ca.component}' and root '${cb.rel}' of '${cb.component}' overlap in ${a.location}`, 'narrow the roots so each governed path has exactly one owning component'));
        }
      }
    }
    for (let j = i + 1; j < readable.length; j++) {
      const b = readable[j] as Descriptor;
      const hit = a.claims.flatMap((ca) => b.claims.filter((cb) => containsPath(ca.real, cb.real) || containsPath(cb.real, ca.real)).map((cb) => [ca, cb] as const));
      const first = hit[0];
      if (first) {
        out.push(finding('SCOPE_OVERLAP', a.location, `${a.location} ('${first[0].component}': '${first[0].rel}') and ${b.location} ('${first[1].component}': '${first[1].rel}') claim overlapping paths`, 'narrow one scope in the same change so every path has one owning model'));
      }
    }
  }
  return out;
}
