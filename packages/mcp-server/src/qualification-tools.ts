import { randomUUID } from 'node:crypto';
import { envelope, refusal, artifactInputs, type ResultEnvelope, type EvaluationInputs, type Model } from '@loom/core';
import { openSession, type HandleRegistry, type Session } from '@loom/workspace';
import { RunRegistry } from '@loom/qualification';

interface Context { workspace: string; trustedRef?: string; handles?: HandleRegistry; }
interface Call { args: Record<string, unknown>; context: Context; session: Session | null; model: Model | null; inputs: EvaluationInputs; stamp(env: ResultEnvelope): ResultEnvelope; }
const registries = new WeakMap<Context, { registry: RunRegistry; sessionId: string }>();
function registryOf(context: Context): { registry: RunRegistry; sessionId: string } {
  const previous = registries.get(context); if (previous) return previous;
  const sessionId = randomUUID();
  const registry = new RunRegistry(async (_session, request) => {
    const handles = context.handles; const workspace = handles?.resolve(request.workspace);
    if (!workspace || !handles?.can(request.workspace, 'qualify')) throw new Error('qualification requires an edit handle with an explicit qualify grant');
    const session = openSession(workspace.root, context.trustedRef ? { trustedRef: context.trustedRef } : {});
    const policy = session.inputs.policy;
    if (!session.model || !policy || policy.id !== request.executionPolicy) throw new Error('the named trusted execution policy is unavailable');
    const baselineVector = (handles.status(request.workspace).data as { revisionVector: string }).revisionVector;
    const rendering = artifactInputs(session.inputs);
    return { workspaceId: request.workspace, executionPolicy: policy.id, qualifyGranted: true, checks: [...policy.qualification.required, ...policy.qualification.optional], options: { root: workspace.root, model: session.model, checks: request.checks, policy, ...(rendering ? { inputs: rendering } : {}), store: true, runner: 'loom-mcp' }, assertCurrent: () => { if (!handles.can(request.workspace, 'qualify') || (handles.status(request.workspace).data as { revisionVector?: string } | undefined)?.revisionVector !== baselineVector) throw new Error('qualification source vector or grant changed while queued'); } };
  });
  const value = { registry, sessionId }; registries.set(context, value); return value;
}
export async function qualificationCall(c: Call): Promise<ResultEnvelope> {
  const tool = 'loom.qualify'; const workspaceId = String(c.args['workspaceId'] ?? '');
  const handles = c.context.handles;
  if (!handles?.resolve(workspaceId)) return envelope(tool, { model: null, findings: [], refusal: refusal('unknown-handle', 'qualification needs a workspace handle owned by this session') });
  const { registry, sessionId } = registryOf(c.context);
  try {
    let data: unknown;
    switch (c.args['action']) {
      case 'start': {
        if (!handles.can(workspaceId, 'qualify')) return envelope(tool, { model: c.model, findings: [], refusal: refusal('access-denied', 'the handle has no qualify grant') });
        const vector = (handles.status(workspaceId).data as { revisionVector: string }).revisionVector;
        if (c.args['expectedVector'] !== vector) return envelope(tool, { model: c.model, findings: [], refusal: refusal('stale-base', 'qualification requires the current source revision vector') });
        const target = c.args['target'] as { kind?: string } | undefined;
        if (!target || target.kind !== 'workspace') return envelope(tool, { model: c.model, findings: [], refusal: refusal('unmet-prerequisite', 'native execution currently requires an explicit workspace target; record-scoped qualification cannot be silently widened') });
        data = await registry.start(sessionId, { workspace: workspaceId, executionPolicy: String(c.args['executionPolicy'] ?? ''), checks: c.args['checks'] as string[] }); break;
      }
      case 'status': data = registry.status(sessionId, String(c.args['runId'] ?? '')); break;
      case 'cancel': data = registry.cancel(sessionId, String(c.args['runId'] ?? '')); break;
      case 'recover': data = await registry.recover(sessionId, String(c.args['runId'] ?? '')); break;
      default: return envelope(tool, { model: c.model, findings: [], refusal: refusal('invalid-input', 'unknown qualification action') });
    }
    return c.stamp(envelope(tool, { model: c.model, findings: [], data }));
  } catch (error) { return c.stamp(envelope(tool, { model: c.model, findings: [], refusal: refusal('unmet-prerequisite', String(error)) })); }
}
export async function closeQualificationRuns(context: Context, workspaceId?: string): Promise<void> { const current = registries.get(context); if (current) await current.registry.close(current.sessionId, workspaceId); }
