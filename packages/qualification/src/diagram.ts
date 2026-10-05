import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { canonicalHash, diagramSemanticTable, resolveRenderingBudget, textHash, toMermaid, type Diagram, type Finding, type RenderingBudget, type RenderResult } from '@loom/core';
import { fileDigest, type ToolInfo } from './tools.js';
import { which } from './exec.js';
import { windowsRendererScript } from './windows-renderer.js';

export const TERMINAL_RENDERER_PIN = { version: '0.0.0-20260908213847-5f00e3d9ac9f', digest: 'sha256:fd751149989a32ea6b3472aa146ca184936f33268ddc59fb867f1f25c652b02e' } as const;
export interface TerminalOptions { tool: ToolInfo; budget?: RenderingBudget; charset?: 'ascii' | 'unicode'; signal?: AbortSignal }
export interface TerminalResult { result: RenderResult; semanticTable: string; finding?: Finding; status: 'PASS' | 'FAIL' | 'UNKNOWN'; reason: string; durationMs: number; bytes: number }

/** No tool path is accepted from a client: callers supply the provisioned ToolLocator result. */
export async function renderTerminal(diagram: Diagram, options: TerminalOptions): Promise<TerminalResult> {
  const budget = resolveRenderingBudget(options.budget ?? diagram.limits.budget), charset = options.charset ?? 'unicode';
  const original = toMermaid(diagram);
  const result: RenderResult = { diagram, sourceVectorDigest: diagram.sourceVectorDigest, graphDigest: canonicalHash(diagram), mermaidDigest: textHash(original), mermaid: original, coverage: diagram.coverage, completeness: { complete: diagram.coverage.complete, truncated: diagram.limits.reached.length > 0, omitted: diagram.coverage.items.filter((i) => i.status !== 'drawn').map((i) => ({ owner: i.ref, reason: i.status === 'out-of-scope' ? 'out-of-scope' : 'unsupported' })) }, fidelity: { level: 'unsupported', transformations: [] } };
  const started = Date.now();
  const refuse = (status: TerminalResult['status'], reason: string): TerminalResult => ({ result, semanticTable: diagramSemanticTable(diagram), status, reason, durationMs: Date.now() - started, bytes: 0, finding: { code: 'DIAGRAM_TERMINAL_UNFAITHFUL', severity: 'warning', path: `diagram/${diagram.diagramId}`, message: reason, fix: 'use the preserved Mermaid and semantic table, or provision a faithful renderer within the requested budget' } });
  const binaryDigest = fileDigest(options.tool.path);
  result.renderer = { tool: 'mermaid-ascii', version: options.tool.version, binaryDigest: binaryDigest ?? TERMINAL_RENDERER_PIN.digest, optionDigest: canonicalHash({ charset, budget, nodeLabels: 'semantic-token', edgeLabels: 'semantic-token', flattenedGroups: true }) };
  if (options.tool.name !== 'mermaid-ascii' || binaryDigest !== TERMINAL_RENDERER_PIN.digest || options.tool.version.replace(/^v/, '') !== TERMINAL_RENDERER_PIN.version) return refuse('UNKNOWN', 'terminal renderer identity does not match the exact version and binary digest pin');
  if (diagram.nodes.length > budget.maxNodes || diagram.limits.reached.length || !diagram.coverage.complete) return refuse('FAIL', 'the graph is incomplete or exceeds its rendering budget; no terminal rendering can claim completeness');
  // Token labels preserve hostile text as data and allow independent accounting of every rendered element.
  const nodeTokens = new Map(diagram.nodes.map((n, i) => [n.key, `N${String(i).padStart(3, '0')}`]));
  const edgeTokens = new Map(diagram.edges.map((e, i) => [e.key, `E${String(i).padStart(3, '0')}`]));
  const edgeGroups = new Map<string, Diagram['edges']>();
  for (const e of diagram.edges) { const k = `${e.source}\0${e.target}\0${e.direction}`; const list = edgeGroups.get(k) ?? []; list.push(e); edgeGroups.set(k, list); }
  const merge = diagram.kind !== 'sequence';
  const layout: Diagram = { ...diagram, nodes: diagram.nodes.map((n) => ({ ...n, label: nodeTokens.get(n.key)! })), edges: merge ? [...edgeGroups.values()].map((list) => ({ ...list[0]!, label: list.map((e) => edgeTokens.get(e.key)!).join(' ') })) : diagram.edges.map((e) => ({ ...e, label: edgeTokens.get(e.key)! })), groups: [] };
  const input = toMermaid(layout, { terminal: diagram.kind !== 'sequence' });
  result.fidelity = { level: 'annotated-layout', transformations: [
    { kind: 'abbreviated-labels', description: 'Native layout uses unique node and edge tokens; the legend and semantic table retain every exact label, direction and owner.', elements: [...nodeTokens.keys(), ...edgeTokens.keys()] },
    ...(diagram.kind === 'state' ? [{ kind: 'state-as-flowchart' as const, description: 'Start, end and transition semantics are shown by explicit flowchart nodes and edges.', elements: diagram.nodes.map((n) => n.key) }] : []),
    ...(diagram.groups.length ? [{ kind: 'flattened-groups' as const, description: 'The legend records every group meaning, membership and enclosing group.', elements: diagram.groups.map((g) => g.key) }] : []),
    ...(merge && [...edgeGroups.values()].some((list) => list.length > 1) ? [{ kind: 'merged-parallel-edges' as const, description: 'Parallel layout arcs carry every edge token; the semantic table preserves their separate directions, relationships and owners.', elements: [...edgeGroups.values()].filter((list) => list.length > 1).flatMap((list) => list.map((e) => e.key)) }] : []),
  ] };
  const run = await runRenderer(options.tool.path, ['-f', '-', '--max-width', String(budget.maxWidth), ...(charset === 'ascii' ? ['--ascii'] : [])], input, budget, options.signal);
  if (run.status !== 'PASS') { result.fidelity.level = 'unsupported'; return refuse(run.status, run.reason); }
  const tokens = [...nodeTokens.values(), ...edgeTokens.values()];
  const missing = tokens.filter((t) => !run.text.includes(t));
  if (missing.length) { result.fidelity.level = 'unsupported'; return refuse('FAIL', `renderer omitted semantic elements ${missing.join(', ')}`); }
  const legend = ['Legend (tokens refer to the semantic table):', ...[...nodeTokens, ...edgeTokens].map(([key, token]) => `${token} = ${key}`), '', diagramSemanticTable(diagram)].join('\n');
  const wrap = (line: string): string[] => { const chars = Array.from(line), rows: string[] = []; for (let i = 0; i < chars.length; i += budget.maxWidth) rows.push(chars.slice(i, i + budget.maxWidth).join('')); return rows.length ? rows : ['']; };
  const text = `${run.text.trimEnd()}\n\n${legend.split('\n').flatMap(wrap).join('\n')}\n`;
  const bytes = Buffer.byteLength(text);
  if (bytes > budget.maxBytes || run.text.split('\n').some((line) => Array.from(line).length > budget.maxWidth)) { result.fidelity.level = 'unsupported'; return refuse('FAIL', 'terminal layout and semantic legend exceed the byte or width budget'); }
  if (charset === 'ascii' && /[^\x00-\x7f]/.test(text)) { result.fidelity.level = 'unsupported'; return refuse('FAIL', 'ASCII rendering cannot retain the authored Unicode legend faithfully; request Unicode'); }
  result.terminal = { charset, view: diagram.kind === 'state' ? 'state-flowchart' : diagram.kind, text, digest: textHash(text) };
  return { result, semanticTable: diagramSemanticTable(diagram), status: 'PASS', reason: `all ${diagram.nodes.length} nodes and ${diagram.edges.length} relationships are visible with explicit semantics; ${process.platform === 'win32' ? 'Windows Job Object enforces native process memory' : 'resident memory is sampled and the Go heap soft limit is applied'}`, durationMs: Date.now() - started, bytes };
}

type NativeResult = { status: 'PASS' | 'FAIL' | 'UNKNOWN'; text: string; reason: string };
/** Native process output and duration are bounded before collection; Go memory and Linux RSS are bounded during execution. */
async function runRenderer(executable: string, args: string[], input: string, budget: Required<RenderingBudget>, signal?: AbortSignal): Promise<NativeResult> {
  if (signal?.aborted) return { status: 'UNKNOWN', text: '', reason: 'terminal rendering was cancelled before launch' };
  let launcher = executable, launchArgs = args;
  if (process.platform === 'win32') {
    const pwsh = which('pwsh');
    if (!pwsh) return { status: 'UNKNOWN', text: '', reason: 'PowerShell Core is absent; a memory-limited Windows renderer cannot be launched' };
    launcher = pwsh;
    launchArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsRendererScript(executable, args, budget.maxMemoryBytes), 'utf16le').toString('base64')];
  }
  return new Promise((resolve) => {
    const child = spawn(launcher, launchArgs, { shell: false, windowsHide: true, env: { ...process.env, GOMEMLIMIT: String(budget.maxMemoryBytes) } });
    let stdout = '', stderr = '', bytes = 0, stopped: NativeResult | undefined, done = false;
    const stop = (status: NativeResult['status'], reason: string): void => { stopped = { status, text: '', reason }; child.kill(); };
    const abort = (): void => stop('UNKNOWN', 'terminal rendering was cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('UNKNOWN', `renderer exceeded ${budget.maxDurationMs} ms`), budget.maxDurationMs);
    // The Windows launcher supplies GOMEMLIMIT; Linux additionally monitors resident memory from procfs.
    const monitor = setInterval(() => { if (process.platform !== 'linux' || !child.pid) return; try { const stat = readFileSync(`/proc/${child.pid}/status`, 'utf8'); const rss = Number(/VmRSS:\s+(\d+)/.exec(stat)?.[1] ?? 0) * 1024; if (rss > budget.maxMemoryBytes) stop('UNKNOWN', 'renderer exceeded resident-memory budget'); } catch { /* exited */ } }, 50);
    const finish = (value: NativeResult): void => { if (done) return; done = true; clearTimeout(timer); clearInterval(monitor); signal?.removeEventListener('abort', abort); resolve(value); };
    child.stdout.setEncoding('utf8').on('data', (part: string) => { bytes += Buffer.byteLength(part); if (bytes > budget.maxBytes) stop('FAIL', 'renderer exceeded output byte budget'); else stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part: string) => { bytes += Buffer.byteLength(part); if (bytes > budget.maxBytes) stop('FAIL', 'renderer exceeded output byte budget'); else stderr += part; });
    child.on('error', (error) => finish({ status: 'UNKNOWN', text: '', reason: `renderer could not launch: ${error.message}` }));
    child.on('close', (code) => finish(stopped ?? (code === 0 && stdout.trim() ? { status: 'PASS', text: stdout, reason: '' } : { status: 'UNKNOWN', text: '', reason: `renderer failed (${String(code)}): ${stderr.trim()}` })));
    child.stdin.on('error', () => { /* close/error records the process outcome */ });
    child.stdin.end(input);
  });
}
