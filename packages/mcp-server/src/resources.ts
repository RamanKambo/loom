import { readDiagramResource } from './diagram-tools.js';
import { OPERATION_CATALOGUE, guide, guides } from '@loom/core';
import type { CatalogueResource, RecordRef } from '@loom/core';
import { advertisedDefinitions, handlesOf, schemaResource, schemaUri, workspaceRecord, type ToolContext } from './tools.js';

/** The protocol's error code for a resource the server does not hold. */
export const RESOURCE_NOT_FOUND = -32002;

export interface ListedResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * One family of resources the server serves. Each family owns one URI prefix,
 * lists a bounded set of its resources and reads any URI under its prefix,
 * returning null for a URI it does not hold.
 */
export interface ResourceFamily {
  prefix: string;
  list(): ListedResource[];
  read(uri: string): ResourceContents | null;
}

const SCHEMA_PREFIX = schemaUri('');
const SCHEMA_MIME = 'application/schema+json';

/**
 * The full contract of every definition. The list names only the definitions
 * the advertised tool schemas point at, so it stays bounded by those schemas;
 * a read serves any definition of the contract bundle.
 */
const SCHEMAS: ResourceFamily = {
  prefix: SCHEMA_PREFIX,
  list: () =>
    advertisedDefinitions().map((name) => ({ uri: schemaUri(name), name, description: `The full contract of ${name}: its schema, its $defs closure and the contract digest.`, mimeType: SCHEMA_MIME })),
  read(uri) {
    const name = uri.slice(SCHEMA_PREFIX.length);
    const schema = /^[A-Za-z0-9_]+$/.test(name) ? schemaResource(name) : null;
    return schema ? { uri, mimeType: SCHEMA_MIME, text: JSON.stringify(schema) } : null;
  },
};

const GUIDE_PREFIX = 'loom://guide/';
const GUIDE_MIME = 'application/json';

/**
 * The guidance: each guide the catalogue resources list, as its GuideResource
 * with the digest of its text and the contract digest. A guide the catalogue
 * holds but does not list is neither listed nor served, so the server never
 * serves more than its catalogue states.
 */
export function guideFamily(resources: readonly CatalogueResource[]): ResourceFamily {
  const listed = new Map(resources.filter((r) => r.exposure === 'listed').map((r) => [r.uri, r.purpose]));
  return {
    prefix: GUIDE_PREFIX,
    list: () =>
      guides()
        .filter((g) => listed.has(g.uri))
        .map((g) => ({ uri: g.uri, name: g.title, description: listed.get(g.uri) as string, mimeType: GUIDE_MIME })),
    read(uri) {
      const g = listed.has(uri) ? guide(uri) : null;
      return g ? { uri, mimeType: GUIDE_MIME, text: JSON.stringify(g) } : null;
    },
  };
}

const FAMILIES: readonly ResourceFamily[] = [guideFamily(OPERATION_CATALOGUE.resources), SCHEMAS];

/** Every listed resource of every family. */
export function listResources(ctx?: ToolContext): ListedResource[] {
  return [...FAMILIES.flatMap((f) => f.list()), ...(ctx ? handlesOf(ctx).ids().map((id) => ({ uri: `loom://workspaces/${id}/status`, name: `${id} status`, description: 'Current revisions and pending activity for this session workspace.', mimeType: GUIDE_MIME })) : [])];
}

/** The contents of one resource, or null when no family holds the URI. */
export function readResource(uri: string, ctx?: ToolContext): ResourceContents | null {
  const diagram = /^loom:\/\/workspaces\/([^/]+)\/diagrams\/([^/]+)$/.exec(uri);
  if (diagram && ctx) { const data = readDiagramResource(ctx, diagram[1]!, diagram[2]!); return data ? { uri, mimeType: GUIDE_MIME, text: JSON.stringify(data) } : null; }
  const match = /^loom:\/\/workspaces\/([^/]+)\/(status|records\/([^/]+)\/(.+))$/.exec(uri);
  if (match && ctx) {
    const id = match[1] as string;
    const status = handlesOf(ctx).status(id);
    if (status.refusal) return null;
    if (match[2] === 'status') return { uri, mimeType: GUIDE_MIME, text: JSON.stringify(status.data) };
    let recordId: string;
    try { recordId = decodeURIComponent(match[4] as string); } catch { return null; }
    const record = workspaceRecord(ctx, id, { kind: match[3], id: recordId } as RecordRef);
    return record ? { uri, mimeType: GUIDE_MIME, text: JSON.stringify(record) } : null;
  }
  const family = FAMILIES.find((f) => uri.startsWith(f.prefix));
  return family ? family.read(uri) : null;
}
