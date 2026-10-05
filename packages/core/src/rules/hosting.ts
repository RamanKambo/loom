import type { Enforcer, Predicate } from '../generated/types.js';
import { FINDING } from '../codes.js';
import { durationSeconds } from '../inputs.js';
import { findCycles } from './structure.js';
import { ref, type Rule, type RuleContext } from './context.js';

const UNDEPLOYED_EXEMPT = new Set(['library', 'external']);
const DEPLOYED_SYSTEMS = new Set(['service', 'application', 'distributed-system']);

/** Deployment units against the declared capabilities of their hosts, never their names. */
export const hostingRules: Rule = (ctx) => {
  const boundaries = new Map(ctx.model.trustBoundaries.map((b) => [b.id, b]));
  for (const cycle of findCycles([...boundaries.keys()], (id) => { const parent = boundaries.get(id)?.within; return parent && boundaries.has(parent) ? [parent] : []; })) {
    ctx.report(FINDING.TRUST_BOUNDARY_CYCLE, `trustBoundaries/${cycle[0]}/within`, `trust boundary containment cycle: ${cycle.join(' -> ')}`, cycle.slice(0, -1).map((id) => ref('trustBoundary', id)), `remove one within link from ${cycle.join(' -> ')}`);
  }
  const hosts = new Map(ctx.model.hosts.map((h) => [h.id, h]));
  for (const u of ctx.model.deploymentUnits) {
    const host = hosts.get(u.host);
    if (host) {
      const caps = host.capabilities;
      const problems: string[] = [];
      if (!caps.triggers.includes(u.invocation.trigger)) problems.push(`trigger '${u.invocation.trigger}' is not among the host's triggers (${caps.triggers.join(', ')})`);
      if (u.timeout && caps.maxTimeout) {
        const unit = durationSeconds(u.timeout);
        const max = durationSeconds(caps.maxTimeout);
        if (unit !== null && max !== null && unit > max) problems.push(`timeout ${u.timeout} exceeds the host's maximum ${caps.maxTimeout}`);
      }
      if (caps.maxConcurrency !== undefined && u.concurrency) {
        if (u.concurrency.model === 'unbounded') problems.push(`unbounded concurrency exceeds the host's maximum of ${caps.maxConcurrency}`);
        else if (u.concurrency.max !== undefined && u.concurrency.max > caps.maxConcurrency) problems.push(`concurrency ${u.concurrency.max} exceeds the host's maximum of ${caps.maxConcurrency}`);
      }
      if (u.identity && caps.identities && !caps.identities.includes(u.identity.kind)) problems.push(`identity kind '${u.identity.kind}' is not one the host provides (${caps.identities.join(', ')})`);
      if (problems.length) {
        ctx.report(FINDING.HOST_CAPABILITY_MISMATCH, `deploymentUnits/${u.id}`, `deployment unit '${u.id}' does not fit host '${host.id}': ${problems.join('; ')}`, [ref('deploymentUnit', u.id), ref('host', host.id)], `choose a host whose declared capabilities cover deployment unit '${u.id}', or change the unit's declaration`);
      }
    }
    if (u.components.length > 1 && u.decision === undefined) {
      ctx.report(FINDING.COHOSTING_UNJUSTIFIED, `deploymentUnits/${u.id}/decision`, `deployment unit '${u.id}' co-hosts ${u.components.join(', ')} without a decision`, [ref('deploymentUnit', u.id), ...u.components.map((c) => ref('component', c))], `record a decision for deployment unit '${u.id}' with the isolation, scaling and failure consequences of co-hosting, and name it in decision`);
    }
  }
  const profile = ctx.model.systemProfile;
  if (profile && DEPLOYED_SYSTEMS.has(profile.kind)) {
    const hosted = new Set(ctx.model.deploymentUnits.flatMap((u) => u.components));
    for (const c of ctx.model.components) {
      if (hosted.has(c.id) || UNDEPLOYED_EXEMPT.has(c.kind ?? '')) continue;
      ctx.report(FINDING.COMPONENT_UNDEPLOYED, `components/${c.id}`, `component '${c.id}' of a ${profile.kind} has no deployment unit`, [ref('component', c.id)], `declare the deployment unit that hosts component '${c.id}', or mark it a library or external component`);
    }
  }
};

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

function enforcementConflict(enforcers: readonly Enforcer[]): string | null {
  const layers = enforcers.map((e) => `${e.component}/${e.layer}`);
  const layer = layers.find((l, i) => layers.indexOf(l) !== i);
  if (layer) return `layer ${layer} is named twice`;
  const purposes = enforcers.map((e) => normalize(e.purpose));
  const purpose = purposes.find((p, i) => purposes.indexOf(p) !== i);
  return purpose ? `two enforcers state the same purpose '${purpose}'` : null;
}

/** Every invariant has an accountable owner; several owners record distinct purposes. */
export const enforcementRules: Rule = (ctx: RuleContext) => {
  const invariants: Array<{ predicate: Predicate; path: string; about: ReturnType<typeof ref> }> = [];
  for (const t of ctx.model.types) {
    (t.invariants ?? []).forEach((p, i) => invariants.push({ predicate: p, path: `types/${t.id}/invariants/${i}`, about: ref('type', t.id) }));
    for (const prop of t.properties) (prop.invariants ?? []).forEach((p, i) => invariants.push({ predicate: p, path: `types/${t.id}/properties/${prop.name}/invariants/${i}`, about: ref('property', `${t.id}.${prop.name}`) }));
  }
  for (const inv of invariants) {
    if (!inv.predicate.enforcedBy?.length) {
      ctx.report(FINDING.INVARIANT_ENFORCER_MISSING, `${inv.path}/enforcedBy`, `invariant at ${inv.path} names no enforcement owner`, [inv.about], `name the component and layer that enforce the invariant at ${inv.path}`);
    }
  }
  const all: Array<{ predicate: Predicate; path: string; about: ReturnType<typeof ref> }> = [...invariants];
  for (const mu of ctx.model.mutations) all.push({ predicate: mu.guard, path: `mutations/${mu.id}/guard`, about: ref('mutation', mu.id) });
  for (const o of ctx.model.operations) {
    (o.preconditions ?? []).forEach((p, i) => all.push({ predicate: p, path: `operations/${o.id}/preconditions/${i}`, about: ref('operation', o.id) }));
    (o.postconditions ?? []).forEach((p, i) => all.push({ predicate: p, path: `operations/${o.id}/postconditions/${i}`, about: ref('operation', o.id) }));
  }
  for (const x of all) {
    const conflict = enforcementConflict(x.predicate.enforcedBy ?? []);
    if (!conflict) continue;
    ctx.report(FINDING.INVARIANT_ENFORCEMENT_CONFLICT, `${x.path}/enforcedBy`, `the predicate at ${x.path} is enforced ambiguously: ${conflict}`, [x.about], `give each enforcement layer at ${x.path} its own purpose, or remove the duplicate`);
  }
};
