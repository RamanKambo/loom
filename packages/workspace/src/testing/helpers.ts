import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { textHash } from '@loom/core';
import type { Finding, FindingCode } from '@loom/core';
import { documentText } from '../fsx.js';

/** A fresh directory per test, so parallel runs never share or delete each other's state. */
export const scratch = (): string => mkdtempSync(join(tmpdir(), 'loom-ws-'));

/** A fixture or workspace directory name, lower-cased and folded to the ModelId pattern. The only place a test derives a model id from a path; product code never does. */
export function foldModelId(name: string): string {
  const folded = name.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '');
  return (folded || 'workspace').slice(0, 128);
}

/**
 * A throwaway repository. Its local config pins line endings and disables commit
 * signing so the fixture behaves the same on every machine; it never touches a
 * real repository's configuration.
 */
export function gitInit(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  for (const [k, v] of [['core.autocrlf', 'false'], ['commit.gpgsign', 'false'], ['user.name', 'loom-fixture'], ['user.email', 'loom-fixture@example.invalid']]) {
    execFileSync('git', ['config', k as string, v as string], { cwd: dir });
  }
  return dir;
}

export function commitAll(dir: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, documentText(value));
}

export const readJsonFile = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export const fileHash = (path: string): string => textHash(readFileSync(path, 'utf8'));

export const codes = (findings: readonly Finding[]): FindingCode[] => findings.map((f) => f.code);

export const withCode = (findings: readonly Finding[], code: FindingCode): Finding[] => findings.filter((f) => f.code === code);
