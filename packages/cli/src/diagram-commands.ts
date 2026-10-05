import { canonicalHash, envelope, modelRevision, renderDiagram, refusal, schemaErrors, type DiagramKind, type Finding, type RecordKind, type RenderingBudget, type TargetReference } from '@loom/core';
import { defaultToolLocator, renderTerminal, TERMINAL_RENDERER_PIN } from '@loom/qualification';
import { HandleRegistry, findRepositoryRoot, openSession, stampSession } from '@loom/workspace';
import { resolve } from 'node:path';
import { UsageError, flag, integer, list } from './args.js';
import type { CommandResult, Context } from './commands.js';

/** The CLI uses the same graph builders and pinned native adapter as loom.diagram. */
export async function cmdDiagram(ctx: Context): Promise<CommandResult> {
  const path = resolve(ctx.cwd, flag(ctx.args, 'workspace') ?? '.');
  const session = openSession(path);
  if (!session.model || !session.workspace) return { env: stampSession(envelope('loom.diagram', { model: session.model, findings: session.findings, refusal: refusal('unresolved-context', 'open a readable initialized workspace before drawing a diagram') }), session) };
  const targetText = flag(ctx.args, 'target') ?? 'workspace';
  const split = targetText.indexOf(':');
  const target: TargetReference = targetText === 'workspace' ? { kind: 'workspace' } : split > 0 ? { kind: 'record', ref: { kind: targetText.slice(0, split) as RecordKind, id: targetText.slice(split + 1) } } : (() => { throw new UsageError('--target is workspace or kind:id'); })();
  const kind = (flag(ctx.args, 'kind') ?? 'component-dependency') as DiagramKind;
  const budget: RenderingBudget = {};
  for (const [name, key] of [['max-nodes', 'maxNodes'], ['max-bytes', 'maxBytes'], ['max-width', 'maxWidth'], ['max-duration-ms', 'maxDurationMs'], ['max-memory-bytes', 'maxMemoryBytes']] as const) { const value = integer(ctx.args, name); if (value !== undefined) budget[key] = value; }
  const formats = list(ctx.args, 'formats') ?? list(ctx.args, 'format') ?? ['mermaid'];
  const handles = new HandleRegistry({ allowedRoots: [findRepositoryRoot(path) ?? path] });
  const opened = handles.open(path, 'read', { view: false });
  const handle = (opened.data as { workspace: { workspaceId: string } }).workspace;
  const resume = handle.workspaceId ? handles.resumeInputs(handle.workspaceId) : null;
  const vector = resume ? canonicalHash(resume.revisionVector) : session.inputs.composition?.snapshotDigest ?? modelRevision(session.model);
  const input = { workspaceId: handle.workspaceId ?? 'ws_cli', target, scope: { kind, depth: integer(ctx.args, 'depth') ?? 2 }, formats, budget };
  const errors = schemaErrors('DiagramInput', input);
  if (errors.length) throw new UsageError(errors.map((e) => `${e.pointer}: ${e.message}`).join('; '));
  const requested = flag(ctx.args, 'snapshot-digest');
  if (requested && requested !== vector) return { env: stampSession(envelope('loom.diagram', { model: session.model, findings: [], refusal: refusal('stale-base', 'the requested diagram snapshot is no longer current') }), session) };
  const result = renderDiagram(session.model, kind, { target, depth: input.scope.depth, budget, sourceVectorDigest: vector, modelId: session.workspace.config.modelId });
  const findings: Finding[] = [];
  if (formats.includes('terminal-ascii') && formats.includes('terminal-unicode')) throw new UsageError('choose one terminal character set per diagram');
  const terminal = formats.find((f) => f.startsWith('terminal-'));
  const detail: string[] = [];
  if (terminal && 'nodes' in result.diagram) {
    const tool = await defaultToolLocator()('mermaid-ascii', { exact: TERMINAL_RENDERER_PIN.version, digest: TERMINAL_RENDERER_PIN.digest });
    if (tool.status === 'found') { const rendered = await renderTerminal(result.diagram, { tool: tool.tool, budget, charset: terminal === 'terminal-ascii' ? 'ascii' : 'unicode' }); Object.assign(result, rendered.result); if (rendered.finding) findings.push(rendered.finding); if (!result.terminal) detail.push(rendered.semanticTable); }
    else { result.fidelity.level = 'unsupported'; findings.push({ code: 'DIAGRAM_TERMINAL_UNFAITHFUL', severity: 'warning', path: 'renderer', message: tool.reason, fix: 'provision the pinned native renderer, or request Mermaid' }); }
  }
  if (result.terminal) detail.push(result.terminal.text);
  if (formats.includes('mermaid') && typeof result.mermaid === 'string') detail.push(result.mermaid);
  return { env: stampSession(envelope('loom.diagram', { model: session.model, findings, data: { result } }), session), detail };
}
