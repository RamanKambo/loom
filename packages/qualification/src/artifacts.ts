import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECTION_TARGETS, filesOf, projectedPath, renderAll, type EvaluationInputs, type Model, type ProjectedFile, type ProjectionTarget } from '@loom/core';
import type { ArtifactFile, ArtifactSet } from './types.js';

/** The target that writes a file name; every name belongs to exactly one target. */
export function targetOfFile(file: string): ProjectionTarget {
  const t = PROJECTION_TARGETS.find((x) => filesOf(x).includes(file));
  if (!t) throw new Error(`no projection target writes ${file}`);
  return t;
}

/** Write already rendered files into `dir` at their projected paths. */
export function writeArtifacts(files: readonly ProjectedFile[], dir: string, draft = false): ArtifactSet {
  const out: ArtifactFile[] = [];
  for (const f of files) {
    const path = join(dir, ...projectedPath(f).split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.content, 'utf8');
    out.push({ ...f, target: targetOfFile(f.file), path });
  }
  return { dir, files: out, draft };
}

/** Render the targets of a valid model and write them into `dir`. Fail-closed: an invalid model throws. */
export function materialize(model: Model, dir: string, options: { targets?: readonly ProjectionTarget[]; draft?: boolean; inputs?: EvaluationInputs } = {}): ArtifactSet {
  const bundle = renderAll(model, options);
  return writeArtifacts(bundle.files, dir, bundle.draft);
}

export const filesOfTarget = (set: ArtifactSet, target: ProjectionTarget): ArtifactFile[] => set.files.filter((f) => f.target === target);

export const fileOf = (set: ArtifactSet, target: ProjectionTarget, component?: string): ArtifactFile | undefined =>
  set.files.find((f) => f.target === target && f.component === component);
