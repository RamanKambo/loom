import { closeSync, existsSync, linkSync, openSync, readdirSync, rmSync, statSync, writeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalHash, schemaErrors } from '@loom/core';
import type { EvidenceRecord, Finding } from '@loom/core';
import { LOOM_DIR, loomDirOf } from './config.js';
import { finding, type Outcome } from './findings.js';
import { documentText, readJson } from './fsx.js';

export const EVIDENCE_DIR = 'evidence';

const storeDir = (root: string): string => join(loomDirOf(root), EVIDENCE_DIR);

function storeProblem(root: string): Finding | null {
  const dir = storeDir(root);
  if (!existsSync(dir)) return null;
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    readdirSync(dir);
    return null;
  } catch (err) {
    return finding('EVIDENCE_STORE_UNAVAILABLE', `${LOOM_DIR}/${EVIDENCE_DIR}`, `the durable evidence store cannot be read: ${(err as Error).message}`, 'restore .loom/evidence from version control; a cache never substitutes for it');
  }
}

export type StoreOutcome = { stored: boolean; path: string; findings: Finding[]; refused?: string };

/**
 * Record evidence durably in the Git-tracked store. The store is append-only:
 * an id that already holds different content is refused, because rewriting a
 * run record would change what an earlier acceptance relied on. The record is
 * created through a hard link of a fully written temporary file, so it appears
 * complete or not at all, and a concurrent writer of the same id cannot be
 * silently replaced.
 */
export function putEvidence(root: string, record: EvidenceRecord): StoreOutcome {
  const rel = `${LOOM_DIR}/${EVIDENCE_DIR}/${record.id}.json`;
  const problem = storeProblem(root);
  if (problem) return { stored: false, path: rel, findings: [problem], refused: problem.message };
  const errs = schemaErrors('EvidenceRecord', record);
  if (errs.length) {
    const findings = errs.map((e) => finding('STRUCTURAL_INVALID', `${rel}#${e.pointer}`, e.message, 'correct the evidence record to satisfy its contract'));
    return { stored: false, path: rel, findings, refused: 'the evidence record does not satisfy its contract' };
  }
  const dir = storeDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.id}.json`);
  const existing = readJson(path);
  if (existing.ok) {
    if (canonicalHash(existing.value) === canonicalHash(record)) return { stored: false, path: rel, findings: [] };
    return { stored: false, path: rel, findings: [], refused: `evidence ${record.id} already exists with different content; evidence is append-only` };
  }
  const tmp = join(dir, `.${record.id}.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, documentText(record));
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { stored: false, path: rel, findings: [], refused: `evidence ${record.id} was written concurrently; evidence is append-only` };
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
  return { stored: true, path: rel, findings: [] };
}

/** Every record in the store; a record that fails its contract is reported and left out. */
export function listEvidence(root: string): Outcome<EvidenceRecord[]> {
  const problem = storeProblem(root);
  if (problem) return { value: null, findings: [problem] };
  const dir = storeDir(root);
  if (!existsSync(dir)) return { value: [], findings: [] };
  const findings: Finding[] = [];
  const records: EvidenceRecord[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    const r = readJson(join(dir, name));
    const rel = `${LOOM_DIR}/${EVIDENCE_DIR}/${name}`;
    if (!r.ok) {
      findings.push(finding('EVIDENCE_STORE_UNAVAILABLE', rel, `${rel} ${r.error}`, 'restore the record from version control'));
      continue;
    }
    const errs = schemaErrors('EvidenceRecord', r.value);
    if (errs.length) {
      findings.push(...errs.map((e) => finding('STRUCTURAL_INVALID', `${rel}#${e.pointer}`, e.message, 'correct or remove the malformed evidence record')));
      continue;
    }
    records.push(r.value as EvidenceRecord);
  }
  return { value: records, findings };
}

export function readEvidence(root: string, id: string): EvidenceRecord | null {
  const r = readJson(join(storeDir(root), `${id}.json`));
  return r.ok && schemaErrors('EvidenceRecord', r.value).length === 0 ? (r.value as EvidenceRecord) : null;
}
