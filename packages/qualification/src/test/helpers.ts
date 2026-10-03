import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepClone, sampleModel, textHash, type Model, type Policy } from '@loom/core';
import { materialize } from '../artifacts.js';
import { readSelfPolicy } from '../selfqualify.js';
import type { ArtifactSet } from '../types.js';

/** The Loom repository root: dist/test sits four levels below it. */
export const LOOM_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export const selfPolicy = (): Policy => readSelfPolicy(LOOM_ROOT);

export function tempDir(prefix: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `loom-qtest-${prefix}-`));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) };
}

/** The sample's artifacts written into a fresh directory. */
export function sampleArtifacts(model: Model = sampleModel()): { set: ArtifactSet; done: () => void } {
  const t = tempDir('artifacts');
  return { set: materialize(model, t.dir), done: t.done };
}

/** Replace one artifact's text on disk and in the set, as a hand edit or a broken generator would. */
export function replaceArtifact(set: ArtifactSet, instance: string, edit: (text: string) => string): void {
  const f = set.files.find((x) => x.instance === instance);
  if (!f) throw new Error(`no artifact ${instance}`);
  f.content = edit(f.content);
  f.hash = textHash(f.content);
  writeFileSync(f.path, f.content, 'utf8');
}

export const clone = <T>(v: T): T => deepClone(v);
