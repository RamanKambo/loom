import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { canonicalStringify } from '@loom/core';

export type JsonRead = { ok: true; value: unknown; text: string } | { ok: false; missing: boolean; error: string };

export function readJson(path: string): JsonRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, missing: code === 'ENOENT', error: code === 'ENOENT' ? 'file does not exist' : String((err as Error).message) };
  }
  try {
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')), text };
  } catch (err) {
    return { ok: false, missing: false, error: `not JSON: ${(err as Error).message}` };
  }
}

/** The on-disk form of every document this adapter writes: canonical key order and one trailing newline. */
export const documentText = (value: unknown): string => `${canonicalStringify(value)}\n`;

/**
 * Write through a sibling temporary file and rename it into place, so a reader
 * sees either the old or the new content, never a torn file. The temporary file
 * must be on the same volume as the target for the rename to be atomic, which is
 * why it is created beside the target rather than in the OS temp directory.
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Forward-slash form of a relative path; the contract's RelativePath never carries a backslash. */
export const toPosix = (p: string): string => p.replace(/\\/g, '/');
