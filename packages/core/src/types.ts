/**
 * The Loom model. One portable, plain-data JSON document is the single source of
 * truth; every artifact (JSON Schema, OpenAPI, ...) is projected from it. These
 * types are the in-memory shape; the authoring/file shape is pinned by the
 * meta-schema in meta-schema.ts, which runs before any of the semantic rules.
 */

export type Kind = 'string' | 'integer' | 'number' | 'boolean' | 'enum';

export interface Bounds {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
}

export interface Property {
  name: string;
  kind: Kind;
  required: boolean;
  nullable: boolean;
  immutable: boolean;
  origin: string;
  enumValues?: string[];
  bounds?: Bounds;
}

export interface Component {
  id: string;
  purpose: string;
}

export interface TypeDef {
  id: string;
  version: number;
  owner: string;
  stateProperty?: string;
  /**
   * Backing table, schema-qualified '<component>.<table>' (qualifier must equal
   * `owner`) or unqualified (implicitly owned by `owner`). Column names are the
   * property names.
   */
  table?: string;
  /** Property names forming the row identity; required when `table` is set. */
  key?: string[];
  properties: Property[];
}

export type OperationKind = 'query' | 'command' | 'async-command';

export interface Authority {
  permission: string;
  scope?: string;
}

export interface Binding {
  transport: string;
  method?: string;
  path?: string;
}

export interface Operation {
  id: string;
  version: number;
  owner: string;
  kind: OperationKind;
  request?: string;
  response?: string;
  result?: string;
  authority: Authority;
  bindings?: Binding[];
}

export type RoutineHost = 'sql-procedure' | 'runbook' | 'function';

export interface RoutineParam {
  name: string;
  kind: Kind;
  required: boolean;
  nullable: boolean;
  /** Producer property this param expects, 'typeId.propertyName'; kind and nullability must match it exactly. */
  binds?: string;
}

export interface ResultColumn {
  name: string;
  kind: Kind;
  nullable: boolean;
  /** Producer property this column carries, 'typeId.propertyName'; kind and nullability must match it exactly. */
  binds?: string;
}

export interface Routine {
  id: string;
  version: number;
  owner: string;
  host: RoutineHost;
  /** Repository-relative path of the procedure or script file (never absolute). */
  source?: string;
  params: RoutineParam[];
  resultSet: ResultColumn[];
  performsMutations: string[];
  writesTables?: string[];
  writesColumns?: string[];
  transactionScope?: string[];
  authority: Authority;
}

/**
 * Sentinel state meaning "the record does not yet exist". A mutation whose
 * `from` includes this is a creation and must write every required property.
 */
export const ABSENT_STATE = '$absent';

export interface Mutation {
  id: string;
  type: string;
  owner: string;
  from: string[];
  to: string;
  writes: string[];
  guard: string;
  effect: string;
  requirements: string[];
  scenarios: string[];
}

export type WorkflowStatus = 'planned' | 'active';

export interface TypeImport {
  typeId: string;
  version: number;
}

export interface Workflow {
  id: string;
  status: WorkflowStatus;
  dependsOn: string[];
  imports: TypeImport[];
  operations?: string[];
  mutations?: string[];
  requirements: string[];
}

export type EdgeKind = 'semantic' | 'structural' | 'runtime' | 'build' | 'integration';

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Requirement {
  id: string;
  outcome: string;
}

export interface Scenario {
  id: string;
  requirements: string[];
  expected: string;
}

export interface Model {
  version: number;
  components: Component[];
  types: TypeDef[];
  operations: Operation[];
  routines: Routine[];
  mutations: Mutation[];
  workflows: Workflow[];
  edges: Edge[];
  requirements: Requirement[];
  scenarios: Scenario[];
}

export type Severity = 'error' | 'warning';

export interface Finding {
  code: string;
  severity: Severity;
  path: string;
  message: string;
  /** Element ids that consume the offending element (reverse-reachability). */
  impact?: string[];
  /** One imperative line stating the correct approach. */
  fix?: string;
}

export type ChangeKind = 'breaking' | 'compatible';

/** The kind of element a Change belongs to; type, operation and routine are versioned contracts. */
export type ElementKind = 'type' | 'operation' | 'routine' | 'mutation' | 'workflow';

export interface Change {
  path: string;
  kind: ChangeKind;
  reason: string;
  /** Element ids affected by this change (reverse-reachability over the before-model). */
  consumers: string[];
  /** Id of the element that changed. */
  element: string;
  elementKind: ElementKind;
}

export type ProjectionTarget =
  | 'json-schema'
  | 'openapi'
  | 'sql'
  | 'sql-contract-tests'
  | 'pester-contract-tests'
  | 'yaml'
  | 'workflow'
  | 'reference';
