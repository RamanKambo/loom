import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { LoomInvalidModelError, asFinding, findRecord, indexModel, prohibitedMarkers, renderTarget, schemaErrors } from '@loom/core';
import type { Finding, MarkerKind, Model, RecordKind, RecordRef } from '@loom/core';
import { checkOutputs, readManifest, manifestPath, type Session } from '@loom/workspace';

/**
 * History markers from the documentation doctrine: narration of an artifact's
 * past content. The patterns name the narrative forms only, so a statement of
 * purpose or a description of runtime state is not matched.
 */
const HISTORY = [
  /\bpreviously\b/i,
  /\bformerly\b/i,
  /\bused to (?:be|say|have|use|hold|return|live|call|work)\b/i,
  /\ban? (?:earlier|older|previous|prior) (?:version|revision|release)\b/i,
  /\bwas changed (?:to|from)\b/i,
];

/** String literals removed, so a comment marker or a history phrase quoted inside a string is not read as a comment. */
const withoutStrings = (line: string): string => line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");

/** Directories never read: dependencies, build output, tool state and agent configuration, none of which is the repository's own text. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.git', '.angular', 'coverage', 'bin', 'obj', '.loom', '.tmp', '.claude']);

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), accept, out);
    } else if (accept(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

const rel = (root: string, p: string): string => relative(root, p).replace(/\\/g, '/');

/** GitHub-style heading anchors of a Markdown file. */
function anchorsOf(text: string): Set<string> {
  const out = new Set<string>();
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) out.add((m[1] as string).toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-'));
  }
  return out;
}

/** Lines outside fenced code blocks, with their line numbers. */
function proseLines(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let fence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      return;
    }
    if (!fence) out.push([i + 1, line.replace(/`[^`]*`/g, '')]);
  });
  return out;
}

const LINK = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** Relative links and anchors, and loom:<kind>/<id> record references, in one Markdown file. */
function linkFindings(root: string, file: string, model: Model | null): Finding[] {
  const text = readFileSync(file, 'utf8');
  const findings: Finding[] = [];
  const index = model ? indexModel(model) : null;
  for (const [n, line] of proseLines(text)) {
    for (const m of line.matchAll(LINK)) {
      const target = m[1] as string;
      const at = `${rel(root, file)}:${n}`;
      if (/^(?:https?:|mailto:|data:)/i.test(target)) continue;
      if (target.startsWith('loom:')) {
        const r = /^loom:([A-Za-z]+)\/(.+)$/.exec(target);
        const ref = r ? ({ kind: r[1] as RecordKind, id: decodeURIComponent(r[2] as string) } as RecordRef) : null;
        if (!ref || !index || !findRecord(index, ref)) {
          findings.push(asFinding('DOCUMENT_RECORD_UNKNOWN', at, `'${target}' names no record of the governing model${index ? '' : ' (no model governs this document)'}`, 'cite a record the model declares, as loom:<kind>/<id>'));
        }
        continue;
      }
      const [pathPart, anchor] = target.split('#', 2) as [string, string | undefined];
      const dest = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
      if (!existsSync(dest)) {
        findings.push(asFinding('DOCUMENT_LINK_BROKEN', at, `link '${target}' resolves to nothing`, 'point the link at an existing file, or remove it'));
        continue;
      }
      if (anchor && statSync(dest).isFile() && extname(dest).toLowerCase() === '.md' && !anchorsOf(readFileSync(dest, 'utf8')).has(anchor.toLowerCase())) {
        findings.push(asFinding('DOCUMENT_LINK_BROKEN', at, `anchor '#${anchor}' does not name a heading of ${rel(root, dest)}`, 'link to an existing heading'));
      }
    }
  }
  return findings;
}

function historyInProse(root: string, file: string): Finding[] {
  const findings: Finding[] = [];
  for (const [n, line] of proseLines(readFileSync(file, 'utf8'))) {
    const hit = HISTORY.find((re) => re.test(line));
    if (hit) findings.push(asFinding('DOCUMENT_HISTORY_MARKER', `${rel(root, file)}:${n}`, `'${(hit.exec(line) as RegExpExecArray)[0]}' narrates the artifact's history`, 'state the current fact; the change history belongs to version control'));
  }
  return findings;
}

const COMMENT_EXT: Record<string, RegExp> = {
  '.ts': /\/\/(.*)$|\/\*(.*?)\*\/|^\s*\*(.*)$/,
  '.js': /\/\/(.*)$|\/\*(.*?)\*\/|^\s*\*(.*)$/,
  '.mjs': /\/\/(.*)$|\/\*(.*?)\*\/|^\s*\*(.*)$/,
  '.cs': /\/\/(.*)$|\/\*(.*?)\*\/|^\s*\*(.*)$/,
  '.ps1': /#(.*)$/,
  '.sql': /--(.*)$/,
};

/** Source comments with their line numbers; string literals and code are not prose. */
function commentLines(file: string): Array<[number, string]> {
  const re = COMMENT_EXT[extname(file).toLowerCase()];
  if (!re) return [];
  const out: Array<[number, string]> = [];
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const m = re.exec(withoutStrings(line));
    if (m) out.push([i + 1, m.slice(1).find((g) => g !== undefined) ?? '']);
  });
  return out;
}

/** History markers inside source comments only. */
function historyInComments(root: string, file: string): Finding[] {
  const findings: Finding[] = [];
  for (const [n, comment] of commentLines(file)) {
    const hit = HISTORY.find((h) => h.test(comment));
    if (hit) findings.push(asFinding('DOCUMENT_HISTORY_MARKER', `${rel(root, file)}:${n}`, `comment narrates history: '${(hit.exec(comment) as RegExpExecArray)[0]}'`, 'keep the reason as one clause and move the story to the commit message'));
  }
  return findings;
}

/** The string values of a JSON file that hold prose; a value without whitespace is an identifier, a pattern or a digest. */
function jsonProse(file: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/"((?:\\.|[^"\\])*)"/g)) if (/\s/.test(m[1] as string)) out.push([i + 1, m[1] as string]);
  });
  return out;
}

const MARKER_TEXT: Record<MarkerKind, string> = {
  label: 'an internal requirement, task or phase label',
  iteration: 'a release-iteration label',
  generation: 'a product-generation term',
};

/**
 * Loom's own release wording: every document, source comment and JSON prose
 * string under the root names each capability descriptively. Dependencies and
 * build output are never read.
 */
export function releaseWordingFindings(root: string): Finding[] {
  const findings: Finding[] = [];
  const report = (file: string, lines: Array<[number, string]>): void => {
    for (const [n, text] of lines) {
      for (const m of prohibitedMarkers(text)) findings.push(asFinding('DOCUMENT_PROHIBITED_MARKER', `${rel(root, file)}:${n}`, `'${m.match}' is ${MARKER_TEXT[m.kind]}`, 'name the capability descriptively, as the current release states it'));
    }
  };
  for (const file of walk(root, (n) => n.toLowerCase().endsWith('.md'))) report(file, proseLines(readFileSync(file, 'utf8')));
  for (const file of walk(root, (n) => extname(n).toLowerCase() in COMMENT_EXT)) report(file, commentLines(file));
  for (const file of walk(root, (n) => n.toLowerCase().endsWith('.json') && n !== 'package-lock.json')) report(file, jsonProse(file));
  return findings;
}

/** A hand-authored table row citing a record a generated register owns makes the document a second editable source. */
function duplicatesGenerated(root: string, file: string, model: Model): Finding[] {
  const owned = new Set([...model.unknowns, ...model.decisions, ...model.assumptions, ...model.constraints].map((r) => r.id));
  if (!owned.size) return [];
  const rows = proseLines(readFileSync(file, 'utf8')).filter(([, l]) => /^\s*\|/.test(l) && [...owned].some((id) => new RegExp(`(^|[^A-Za-z0-9._-])${id.replace(/[.]/g, '\\.')}([^A-Za-z0-9._-]|$)`).test(l)));
  if (!rows.length) return [];
  return [asFinding('DOCUMENT_DUPLICATES_GENERATED', `${rel(root, file)}:${(rows[0] as [number, string])[0]}`, `${rows.length} table row(s) restate records the generated registers view owns`, 'cite the generated registers view instead of restating its rows')];
}

/**
 * The regenerated documentation keeps every interface and retained behavior the
 * cumulative accepted contract set still supports: a record the trusted
 * baseline accepted is either still in the model and in the reference view, or
 * its removal is visible as a dropped interface.
 */
function cumulativeFindings(model: Model, baseline: Model): Finding[] {
  const findings: Finding[] = [];
  let reference: string | null = null;
  try {
    reference = renderTarget(model, 'reference').files.map((f) => f.content).join('\n');
  } catch (err) {
    // An invalid model renders no view; removals are still reported, mentions cannot be checked.
    if (!(err instanceof LoomInvalidModelError)) throw err;
  }
  const groups: Array<[RecordKind, readonly { id: string }[], readonly { id: string }[]]> = [
    ['type', baseline.types, model.types],
    ['operation', baseline.operations, model.operations],
    ['routine', baseline.routines, model.routines],
  ];
  for (const [kind, before, after] of groups) {
    const now = new Set(after.map((r) => r.id));
    for (const r of before) {
      if (!now.has(r.id)) findings.push(asFinding('DOCUMENT_INTERFACE_DROPPED', `${kind}/${r.id}`, `the accepted ${kind} '${r.id}' is gone from the model, so the regenerated views no longer document it`, 'restore the record, or retire it through an accepted change before regenerating'));
      else if (reference !== null && !reference.includes(r.id)) findings.push(asFinding('DOCUMENT_INTERFACE_DROPPED', `${kind}/${r.id}`, `the reference view does not mention the accepted ${kind} '${r.id}'`, 'regenerate the reference view from the current model'));
    }
  }
  const retained = new Set(model.retainedBehaviors.filter((b) => b.status === 'retained').map((b) => b.id));
  for (const b of baseline.retainedBehaviors.filter((x) => x.status === 'retained')) {
    if (!retained.has(b.id)) findings.push(asFinding('DOCUMENT_INTERFACE_DROPPED', `retainedBehavior/${b.id}`, `the accepted retained behavior '${b.id}' is no longer retained`, 'keep the retained behavior, or change it through an accepted decision'));
  }
  return findings;
}

export interface DocumentationScope {
  root: string;
  /** Directories whose source comments are scanned; defaults to every package and app source tree under the root, or the whole root for a release check. */
  sources?: string[];
  /**
   * Loom's own repository: every document and comment under the root is
   * checked, and the release wording applies. An adopting repository's text is
   * its own, so the release wording is never applied to it.
   */
  release?: boolean;
}

/**
 * Every documentation check: links and record references, history markers in
 * documents and comments, hand-authored copies of generated registers, the
 * installed views against their manifest, the cumulative accepted contract
 * set, the separation of durable records from transient workflow state and,
 * for Loom's own repository, the release wording.
 */
export function documentationFindings(scope: DocumentationScope, s: Session | null): Finding[] {
  const root = scope.root;
  const generated = new Set<string>();
  const ws = s?.workspace ?? null;
  if (ws) for (const a of readManifest(manifestPath(ws))?.artifacts ?? []) generated.add(resolve(ws.root, ...a.path.split('/')));
  const isDoc = (n: string): boolean => n.toLowerCase().endsWith('.md');
  const docs = scope.release ? walk(root, isDoc) : [join(root, 'README.md'), ...walk(join(root, 'Docs'), isDoc)].filter((p) => existsSync(p));
  const model = s?.model ?? null;
  const findings: Finding[] = [];
  for (const file of docs) {
    findings.push(...linkFindings(root, file, model));
    if (generated.has(file)) continue;
    findings.push(...historyInProse(root, file));
    if (model) findings.push(...duplicatesGenerated(root, file, model));
  }
  const sources = scope.sources ?? (scope.release ? [root] : ['packages', 'apps'].flatMap((b) => (existsSync(join(root, b)) ? readdirSync(join(root, b), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, b, d.name, 'src')) : [])));
  for (const dir of sources) for (const file of walk(dir, (n) => extname(n).toLowerCase() in COMMENT_EXT)) findings.push(...historyInComments(root, file));
  if (scope.release) findings.push(...releaseWordingFindings(root));
  if (ws && s) {
    findings.push(...checkOutputs(ws, { inputs: s.inputs }).findings);
    if (s.inputs.baseline && model) findings.push(...cumulativeFindings(model, s.inputs.baseline.model));
    if (ws.state) for (const e of schemaErrors('WorkflowState', ws.state)) findings.push(asFinding('CONFIG_INVALID', `.loom/state.json${e.pointer}`, `workflow state ${e.message}`, 'keep only transient workflow state in state.json; decisions, acceptance and evidence are durable records'));
  }
  return findings;
}
