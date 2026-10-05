import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { exportModel, importModel, indexModel, renderAll, sampleObject } from '@loom/core';
import { checkOutputs, openSession, openWorkspace } from '@loom/workspace';
import { filesOfTarget } from '../artifacts.js';
import { outcome, type Runner } from '../types.js';
import { mermaidTerminal } from './diagrams.js';

const requireHere = createRequire(import.meta.url);

// ajv-formats ships only a CommonJS default export; normalise both import shapes.
type FormatsPlugin = (ajv: unknown) => unknown;
const rawFormats = addFormatsModule as unknown as FormatsPlugin | { default: FormatsPlugin };
const addFormats: FormatsPlugin = typeof rawFormats === 'function' ? rawFormats : rawFormats.default;

const jsonSchemaCompile: Runner = async (ctx) => {
  const file = filesOfTarget(ctx.artifacts, 'json-schema')[0];
  if (!file) return outcome('NOT_APPLICABLE', 'the model declares no type');
  const schema = JSON.parse(file.content) as { $id: string; $defs?: Record<string, unknown> };
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  try {
    ajv.addSchema(schema);
  } catch (e) {
    return outcome('FAIL', `Ajv ${ctx.tool.version} rejects the schema in strict 2020-12 mode: ${e instanceof Error ? e.message : String(e)}`);
  }
  const index = indexModel(ctx.model);
  const problems: string[] = [];
  let checked = 0;
  for (const t of ctx.model.types) {
    if (!schema.$defs?.[t.id]) continue;
    let validate;
    try {
      validate = ajv.getSchema(`${schema.$id}#/$defs/${t.id}`);
    } catch (e) {
      problems.push(`${t.id} does not compile: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!validate) {
      problems.push(`${t.id} is not addressable as #/$defs/${t.id}`);
      continue;
    }
    const sample = sampleObject(index, t);
    if (!validate(sample)) problems.push(`${t.id} rejects a conforming sample: ${ajv.errorsText(validate.errors)}`);
    const required = t.properties.find((p) => p.required);
    if (required) {
      const { [required.name]: _dropped, ...missing } = sample;
      if (validate(missing)) problems.push(`${t.id} accepts an instance missing required member ${required.name}`);
    }
    checked++;
  }
  return problems.length
    ? outcome('FAIL', problems.slice(0, 6).join('; '))
    : outcome('PASS', `the schema compiles under Ajv ${ctx.tool.version} strict 2020-12; ${checked} type(s) accept a conforming sample and reject one missing a required member`, {
        records: ctx.model.types.map((t) => `type:${t.id}`),
      });
};

/** Every ```mermaid fenced block in a Markdown document, in document order. */
export function mermaidBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/**
 * An unterminated composite state, which mermaid's own grammar rejects: the
 * negative control that proves the check can fail.
 */
const BROKEN_DIAGRAM = ['stateDiagram-v2', '    state s0 {', '        s0a --> s0b'].join('\n');

const mermaidError = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const lines = e.message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 1 ? `${lines[0]} ${lines[lines.length - 1]}` : (lines[0] ?? e.name);
};

let mermaidParse: Promise<((text: string) => Promise<unknown>) | string> | null = null;
let dom: { window: unknown; document: unknown } | null = null;

/**
 * mermaid's diagram detection needs DOMPurify and therefore a document. jsdom
 * supplies one, set on the global object only while mermaid runs: left in
 * place, it makes other libraries in this process take the browser code path
 * (swagger-parser then resolves references against a jsdom URL and fails).
 */
async function withDom<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = 'window' in g;
  const hadDocument = 'document' in g;
  if (dom) {
    if (!hadWindow) g['window'] = dom.window;
    if (!hadDocument) g['document'] = dom.document;
  }
  try {
    return await fn();
  } finally {
    if (!hadWindow) delete g['window'];
    if (!hadDocument) delete g['document'];
  }
}

function loadMermaid(): Promise<((text: string) => Promise<unknown>) | string> {
  mermaidParse ??= (async () => {
    try {
      const { JSDOM } = await import('jsdom');
      const page = new JSDOM('<!DOCTYPE html><html><body></body></html>');
      dom = { window: page.window, document: page.window.document };
      const mermaid = (await withDom(() => import('mermaid'))).default;
      return (text: string) => withDom(() => mermaid.parse(text) as Promise<unknown>);
    } catch (e) {
      return `mermaid or jsdom did not load: ${e instanceof Error ? e.message : String(e)}`;
    }
  })();
  return mermaidParse;
}

const mermaidParseRunner: Runner = async (ctx) => {
  const docs = ctx.artifacts.files.filter((f) => f.file.endsWith('.md') && mermaidBlocks(f.content).length > 0);
  if (!docs.length) return outcome('FAIL', 'no generated view contains a Mermaid block');
  const parse = await loadMermaid();
  if (typeof parse === 'string') return outcome('UNKNOWN', parse);
  const jsdom = String((requireHere('jsdom/package.json') as { version: string }).version);
  const failed: string[] = [];
  let count = 0;
  for (const d of docs) {
    for (const block of mermaidBlocks(d.content)) {
      count++;
      try {
        await parse(block);
      } catch (e) {
        failed.push(`${d.instance}: ${mermaidError(e)}`);
      }
    }
  }
  let rejected = 'the malformed negative control was accepted';
  let rejectedOk = false;
  try {
    await parse(BROKEN_DIAGRAM);
  } catch (e) {
    rejectedOk = true;
    rejected = mermaidError(e);
  }
  const via = `mermaid ${ctx.tool.version} + jsdom ${jsdom}`;
  if (failed.length) return outcome('FAIL', `${failed.length} of ${count} diagram(s) do not parse (${via}): ${failed.slice(0, 4).join('; ')}`);
  if (!rejectedOk) return outcome('FAIL', `${count} diagram(s) parse, but ${rejected}, so the check cannot fail (${via})`);
  return outcome('PASS', `${count} diagram(s) across ${docs.length} view(s) parse (${via}); the malformed negative control is rejected`, { instances: docs.map((d) => d.instance) });
};

/**
 * Generated files equal a fresh projection. In a workspace the installed
 * bundle and its manifest are checked, rendered with the verified inputs of
 * the workspace session that `loom write` installs with; otherwise the run's
 * own artifacts are re-rendered and compared byte for byte, CRLF read as LF.
 */
const projectionDrift: Runner = async (ctx) => {
  const ws = openWorkspace(ctx.root);
  if (ws.value) {
    // The readiness, coverage and evidence views summarize these inputs, so without them every such view reads as drift.
    const r = checkOutputs(ws.value, { inputs: openSession(ctx.root).inputs });
    const errors = r.findings.filter((f) => f.severity === 'error');
    return errors.length
      ? outcome('FAIL', `${errors.length} output finding(s): ${errors.slice(0, 5).map((f) => `${f.code} ${f.path}`).join('; ')}`)
      : outcome('PASS', `${r.artifacts.length} installed artifact(s) equal a fresh projection and the manifest is current`);
  }
  const fresh = new Map(renderAll(ctx.model, { targets: [...new Set(ctx.artifacts.files.map((f) => f.target))] }).files.map((f) => [f.instance, f.content]));
  const drifted: string[] = [];
  for (const f of ctx.artifacts.files) {
    const onDisk = readFileSync(f.path, 'utf8').replace(/\r\n/g, '\n');
    if (fresh.get(f.instance) !== onDisk) drifted.push(f.instance);
  }
  return drifted.length
    ? outcome('FAIL', `${drifted.length} generated file(s) differ from a fresh projection: ${drifted.slice(0, 6).join(', ')}`)
    : outcome('PASS', `${ctx.artifacts.files.length} generated file(s) equal a fresh projection of the model`);
};

const yamlRoundTrip: Runner = async (ctx) => {
  const file = filesOfTarget(ctx.artifacts, 'yaml')[0];
  if (!file) return outcome('NOT_APPLICABLE', 'the YAML export is not among the artifacts');
  try {
    const same = exportModel(importModel(readFileSync(file.path, 'utf8'))) === exportModel(ctx.model);
    return same
      ? outcome('PASS', 'model.yaml parses back to a model whose canonical JSON equals the source model')
      : outcome('FAIL', 'model.yaml parses back to a model that differs from the source model');
  } catch (e) {
    return outcome('FAIL', `model.yaml does not parse back: ${e instanceof Error ? e.message : String(e)}`);
  }
};

export const DOCUMENT_RUNNERS: Readonly<Record<string, Runner>> = {
  'mermaid-terminal': mermaidTerminal,
  'json-schema-compile': jsonSchemaCompile,
  'mermaid-parse': mermaidParseRunner,
  'projection-drift': projectionDrift,
  'yaml-roundtrip': yamlRoundTrip,
};
