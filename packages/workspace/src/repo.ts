import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { segmentsOf } from './paths.js';

/** A repository root holds '.git': a directory for a top-level clone, a file for a submodule checkout. */
export const isRepositoryRoot = (dir: string): boolean => existsSync(join(dir, '.git'));

/**
 * The repository's real Git directory: `.git` itself for an ordinary clone, or
 * the target a `.git` file's `gitdir:` line names for a worktree or submodule
 * checkout. A lock placed here is never an index, ref or gitlink.
 */
export function gitDirOf(repoRoot: string): string {
  const dotGit = join(repoRoot, '.git');
  if (statSync(dotGit).isDirectory()) return dotGit;
  const text = readFileSync(dotGit, 'utf8');
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  const target = m?.[1] ?? dotGit;
  return isAbsolute(target) ? resolve(target) : resolve(repoRoot, target);
}

/** The nearest enclosing repository root of `start`, itself included; null outside any repository. */
export function findRepositoryRoot(start: string): string | null {
  let cur = resolve(start);
  for (;;) {
    if (isRepositoryRoot(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * The declared workspace boundary: an explicit directory when given, otherwise
 * the outermost repository root enclosing `start`, which in a superproject is
 * the superproject itself so ancestor claims across submodules are inspected.
 */
export function findBoundary(start: string, explicit?: string): string {
  if (explicit) return resolve(explicit);
  let cur = resolve(start);
  let outermost: string | null = null;
  for (;;) {
    if (isRepositoryRoot(cur)) outermost = cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return outermost ?? resolve(start);
}

export interface Submodule {
  name: string;
  /** Path relative to the declaring repository, forward slashes. */
  path: string;
  checkedOut: boolean;
}

/** Submodules declared in a repository's .gitmodules, each with whether its checkout is present. */
export function declaredSubmodules(repoRoot: string): Submodule[] {
  const file = join(repoRoot, '.gitmodules');
  if (!existsSync(file)) return [];
  const out: Submodule[] = [];
  let name: string | null = null;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[submodule\s+"(.+)"\]$/.exec(line);
    if (section) {
      name = section[1] ?? null;
      continue;
    }
    const kv = /^path\s*=\s*(.+)$/.exec(line);
    if (kv && name !== null) {
      const path = segmentsOf(kv[1] ?? '').join('/');
      out.push({ name, path, checkedOut: isRepositoryRoot(join(repoRoot, ...path.split('/'))) });
    }
  }
  return out;
}

/**
 * Run git read-only with an argument vector; never a shell string, so no value
 * from a model, a path or configuration can be interpreted as a command.
 */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** Committed content of `path` (repository-relative, forward slashes) at `ref`, or null when absent there. */
export function showAt(repoRoot: string, ref: string, path: string): string | null {
  return tryGit(repoRoot, ['show', `${ref}:${path}`]);
}

/** Repository-relative file paths under `dir` at `ref`. */
export function listAt(repoRoot: string, ref: string, dir: string): string[] {
  const out = tryGit(repoRoot, ['ls-tree', '-r', '--name-only', ref, '--', dir]);
  return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

export const refExists = (repoRoot: string, ref: string): boolean => tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;

export function headRevision(repoRoot: string): string | null {
  const out = tryGit(repoRoot, ['rev-parse', 'HEAD']);
  return out ? out.trim() : null;
}

export function isDirty(repoRoot: string): boolean {
  const out = tryGit(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  return out !== null && out.trim() !== '';
}

/** Repository-relative paths Git's index tracks under `pathspec`, read from the index only. */
export function trackedPaths(repoRoot: string, pathspec: string): string[] {
  const out = tryGit(repoRoot, ['ls-files', '-z', '--', pathspec]);
  return out ? out.split('\0').filter(Boolean) : [];
}

/** Repository-relative paths Git reports untracked and not ignored under `pathspec`, read from status only. */
export function untrackedPaths(repoRoot: string, pathspec: string): string[] {
  const out = tryGit(repoRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--', pathspec]);
  if (!out) return [];
  return out
    .split('\0')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3));
}
