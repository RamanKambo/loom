import type { Model, RecordRef } from './generated/types.js';
import { canonicalJson } from './canonical.js';
import { sha256Hex } from './sha256.js';
import { findRecord, indexModel } from './records.js';

/** 'sha256:' + hex SHA-256 of the canonical JSON of `value`. */
export function canonicalHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** 'sha256:' + hex SHA-256 of exact text, as a generated file's bytes are hashed. */
export function textHash(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}

/** The model revision: the canonical hash of the whole document. */
export function modelRevision(model: Model): string {
  return canonicalHash(model);
}

/** Canonical hash of one record, or null when the reference resolves to nothing. */
export function recordHash(model: Model, ref: RecordRef): string | null {
  const record = findRecord(indexModel(model), ref);
  return record === undefined ? null : canonicalHash(record);
}
