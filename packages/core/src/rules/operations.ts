import type { Operation } from '../generated/types.js';
import { FINDING } from '../codes.js';
import { intentRepair, mechanicalRepair, ref, type Rule, type RuleContext } from './context.js';

const BODYLESS = new Set(['GET', 'HEAD', 'DELETE']);
const SEGMENT = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]|\{[A-Za-z_][A-Za-z0-9_]*\})+$/;

export interface ParsedRoute {
  /** Template variable names in order. */
  variables: string[];
  /** The path with every variable replaced by '{}', so equivalent templates compare equal. */
  normalized: string;
  problems: string[];
}

/** Parse an HTTP path template; a route is '/' or '/'-separated non-empty segments. */
export function parseRoute(path: string): ParsedRoute {
  const problems: string[] = [];
  if (!path.startsWith('/')) problems.push('does not start with /');
  if (/[?#]/.test(path)) problems.push('carries a query or fragment');
  if (path !== '/' && path.endsWith('/')) problems.push('ends with /');
  const segments = path === '/' ? [] : path.slice(1).split('/');
  for (const s of segments) {
    if (s.length === 0) problems.push('has an empty segment');
    else if (!SEGMENT.test(s)) problems.push(`segment '${s}' is not a literal or {name} template`);
  }
  const variables = [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1] as string);
  for (const v of variables.filter((x, i) => variables.indexOf(x) !== i)) problems.push(`repeats variable {${v}}`);
  return { variables, normalized: path.replace(/\{[^}]*\}/g, '{}'), problems: [...new Set(problems)] };
}

function representationRules(ctx: RuleContext, o: Operation): void {
  const typed: Array<[string, string | undefined]> = [
    ['request', o.request],
    ['response', o.response],
    ['result', o.result],
    ['async/accepted/type', o.async?.accepted?.type],
    ['async/completion/result', o.async?.completion?.result],
    ...(o.errors ?? []).map((e): [string, string | undefined] => [`errors/${e.code}/type`, e.type]),
  ];
  (o.bindings ?? []).forEach((b, i) => {
    for (const r of b.responses ?? []) typed.push([`bindings/${i}/responses/${r.status}/type`, r.type]);
  });
  for (const [field, id] of typed) {
    if (id === undefined) continue;
    const t = ctx.index.types.get(id);
    if (t && t.representation === 'storage') {
      ctx.report(FINDING.OPERATION_REPRESENTATION_MISMATCH, `operations/${o.id}/${field}`, `operation '${o.id}' ${field} is type '${id}', a storage representation`, [ref('operation', o.id)], `declare a request or response type for operation '${o.id}' and map it to '${id}'`);
    }
  }
}

/** HTTP bindings, security declarations, invocations and exchanged representations. */
export const operationRules: Rule = (ctx) => {
  const routes = new Map<string, { op: string; path: string }>();
  for (const o of ctx.model.operations) {
    const about = [ref('operation', o.id)];
    const request = o.request ? ctx.index.types.get(o.request) : undefined;
    let httpBound = false;
    (o.bindings ?? []).forEach((b, i) => {
      if (b.transport !== 'http') return;
      httpBound = true;
      const base = `operations/${o.id}/bindings/${i}`;
      if (!b.method || !b.path) {
        ctx.report(FINDING.HTTP_BINDING_INCOMPLETE, base, `operation '${o.id}' HTTP binding ${i} declares no ${!b.method ? 'method' : 'path'}`, about, `declare the method and path of operation '${o.id}' HTTP binding ${i}`);
        return;
      }
      const route = parseRoute(b.path);
      for (const problem of route.problems) {
        ctx.report(FINDING.HTTP_ROUTE_INVALID, `${base}/path`, `operation '${o.id}' route '${b.path}' ${problem}`, about, `write route '${b.path}' as '/'-separated segments of literals and {name} variables`);
      }
      const key = `${b.method} ${route.normalized}`;
      const first = routes.get(key);
      if (first) {
        ctx.report(
          FINDING.HTTP_ROUTE_DUPLICATE,
          `${base}/path`,
          `operation '${o.id}' binds ${b.method} ${b.path}, equivalent to ${first.path} of operation '${first.op}'`,
          [...about, ref('operation', first.op)],
          `give operation '${o.id}' a distinct method or route`,
        );
      } else routes.set(key, { op: o.id, path: b.path });

      const params = b.parameters ?? [];
      const pathParams = params.filter((p) => p.in === 'path');
      for (const v of route.variables) {
        if (pathParams.some((p) => p.name === v)) continue;
        const carries = request?.properties.some((p) => p.name === v);
        ctx.report(FINDING.HTTP_PATH_PARAMETER_UNDECLARED, `${base}/parameters`, `operation '${o.id}' route '${b.path}' has variable {${v}} without a path parameter`, about, `declare parameter '${v}' in path on operation '${o.id}' HTTP binding ${i}`, {
          repairs: [
            mechanicalRepair(
              'declare-path-parameter',
              `Declare path parameter '${v}'${carries ? ` carrying request property '${v}'` : ''}.`,
              undefined,
              [carries ? `request type '${o.request}' carries property '${v}'` : `the parameter's kind is declared explicitly`],
            ),
          ],
        });
      }
      for (const p of params) {
        const ppath = `${base}/parameters/${p.in}|${p.name}`;
        if (p.in === 'path' && !route.variables.includes(p.name)) {
          ctx.report(FINDING.HTTP_PARAMETER_NOT_IN_PATH, ppath, `operation '${o.id}' path parameter '${p.name}' is not a variable of route '${b.path}'`, about, `remove path parameter '${p.name}' or add {${p.name}} to the route`);
        }
        if (p.in === 'path' && !p.required) {
          ctx.report(FINDING.HTTP_ROUTE_INVALID, ppath, `operation '${o.id}' path parameter '${p.name}' is optional; a path parameter is always present`, about, `set parameter '${p.name}' required to true`);
        }
        if (p.property !== undefined) {
          if (!request || !request.properties.some((x) => x.name === p.property)) {
            ctx.report(FINDING.HTTP_PARAMETER_UNKNOWN_PROPERTY, ppath, `operation '${o.id}' parameter '${p.name}' carries '${p.property}', which is not a property of its request type${o.request ? ` '${o.request}'` : ''}`, about, `carry a property of the request type, or declare the parameter's kind instead`);
          }
        } else if (p.kind === undefined) {
          ctx.report(FINDING.HTTP_BINDING_INCOMPLETE, ppath, `operation '${o.id}' parameter '${p.name}' carries neither a property nor a kind`, about, `declare property or kind on parameter '${p.name}'`);
        }
      }
      if (BODYLESS.has(b.method) && request) {
        const carried = new Set(params.map((p) => p.property).filter((x): x is string => x !== undefined));
        const bodyMembers = request.properties.filter((p) => !carried.has(p.name)).map((p) => p.name);
        if (bodyMembers.length) {
          ctx.report(FINDING.HTTP_BODY_NOT_ALLOWED, `${base}/method`, `operation '${o.id}' ${b.method} would need a request body for ${bodyMembers.join(', ')}`, about, `carry ${bodyMembers.join(', ')} in parameters, or bind operation '${o.id}' with POST, PUT or PATCH`);
        }
      }
      const responses = b.responses ?? [];
      for (const r of responses) {
        const rpath = `${base}/responses/${r.status}`;
        const bad =
          (r.kind === 'success' && (r.status < 200 || r.status > 299 || r.status === 202)) ||
          (r.kind === 'accepted' && (r.status !== 202 || o.kind !== 'async-command')) ||
          (r.kind === 'error' && r.status < 400);
        if (bad) ctx.report(FINDING.HTTP_RESPONSE_INVALID, rpath, `operation '${o.id}' declares a ${r.kind} response with status ${r.status}${r.kind === 'accepted' && o.kind !== 'async-command' ? ' on a synchronous operation' : ''}`, about, `use 2xx for success, 202 only for an asynchronous operation's acceptance, and 4xx or 5xx for errors`);
      }
      if (o.kind === 'async-command' && responses.length && !responses.some((r) => r.kind === 'accepted')) {
        ctx.report(FINDING.HTTP_RESPONSE_INVALID, `${base}/responses`, `asynchronous operation '${o.id}' declares no accepted (202) response`, about, `declare the 202 accepted response of operation '${o.id}'`);
      }
    });

    if (httpBound) {
      const scheme = o.authority.scheme ? ctx.model.securitySchemes.find((s) => s.id === o.authority.scheme) : undefined;
      if (!o.authority.scheme) {
        ctx.report(FINDING.OPERATION_SECURITY_UNDECLARED, `operations/${o.id}/authority/scheme`, `HTTP-bound operation '${o.id}' names no security scheme for permission '${o.authority.permission}'`, about, `set operation '${o.id}' authority.scheme to a declared security scheme`, {
          repairs: [intentRepair('declare-scheme', `Name the security scheme that carries '${o.authority.permission}'.`, ['Callers must present credentials under that scheme.'])],
        });
      } else if (scheme) {
        const scopes = Object.keys({ ...(scheme.flows?.clientCredentials?.scopes ?? {}), ...(scheme.flows?.authorizationCode?.scopes ?? {}) });
        if (scheme.type === 'oauth2' && !scopes.includes(o.authority.permission)) {
          ctx.report(FINDING.OPERATION_SECURITY_UNDECLARED, `operations/${o.id}/authority/permission`, `operation '${o.id}' permission '${o.authority.permission}' is not a scope of OAuth scheme '${scheme.id}'`, [...about, ref('securityScheme', scheme.id)], `declare scope '${o.authority.permission}' on scheme '${scheme.id}'`);
        }
      }
    }

    for (const inv of o.invokes ?? []) {
      const path = `operations/${o.id}/invokes/${inv.kind}|${inv.id}`;
      if (inv.kind === 'operation' && inv.id === o.id) {
        ctx.report(FINDING.OPERATION_INVOCATION_INVALID, path, `operation '${o.id}' invokes itself`, about, `remove the self-invocation from operation '${o.id}'`);
      }
      if (inv.kind !== 'mutation') continue;
      const m = ctx.model.mutations.find((x) => x.id === inv.id);
      if (!m) continue;
      if (o.kind === 'query') {
        ctx.report(FINDING.OPERATION_INVOCATION_INVALID, path, `query '${o.id}' invokes mutation '${m.id}'; a query changes no state`, about, `make operation '${o.id}' a command, or remove the invocation`);
      } else if (m.owner !== o.owner && o.enforcement?.persistence !== m.owner) {
        ctx.report(FINDING.OPERATION_INVOCATION_INVALID, path, `operation '${o.id}' (owner '${o.owner}') invokes mutation '${m.id}' owned by '${m.owner}'`, [...about, ref('mutation', m.id)], `name '${m.owner}' as the persistence enforcer of operation '${o.id}', or invoke an operation or routine owned by '${m.owner}'`);
      }
    }
    representationRules(ctx, o);
  }
};
