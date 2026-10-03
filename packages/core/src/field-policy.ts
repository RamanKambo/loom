import type { ChangeKind, Dimension, Model, Property, RecordRef, TypeDef } from './generated/types.js';

/** One field-level delta the differ found, with the context a classifier needs. */
export interface Delta {
  /** Policy key: '<Definition>.<inline path>', for example 'Property.bounds' or 'Bounds.maxLength'. */
  key: string;
  event: 'changed' | 'added' | 'removed' | 'moved';
  before: unknown;
  after: unknown;
  /** Id-based path of the value. */
  path: string;
  element: RecordRef;
  recordBefore: unknown;
  recordAfter: unknown;
  /** The nearest enclosing keyed item (a property, param, column ...) on each side. */
  itemBefore: unknown;
  itemAfter: unknown;
  /** The field name of the nearest enclosing keyed array ('properties', 'params' ...). */
  itemField: string | undefined;
  modelBefore: Model;
  modelAfter: Model;
}

export interface Verdict {
  rule: DiffRuleId;
  kind: ChangeKind;
  dimension: Dimension;
}

export type FieldPolicy = { nonSemantic: string } | { classify: (d: Delta) => Verdict };

export interface DiffRule {
  subject: string;
  /** The change in one line, as the reference projection lists it. */
  change: string;
  /** The kind, or 'contextual' when the representation or direction decides it. */
  kind: ChangeKind | 'contextual';
  dimension: Dimension | 'contextual';
}

/**
 * Every rule a change is classified by: the single home of its description.
 * A change names one of these ids, and the self-test fails on a rule no case
 * emits.
 */
export const DIFF_RULES = {
  RECORD_ADDED: { subject: 'any record', change: 'A record was added.', kind: 'compatible', dimension: 'contextual' },
  RECORD_REMOVED: { subject: 'any record', change: 'A record was removed; its consumers lose it.', kind: 'breaking', dimension: 'contextual' },
  MODEL_FORMAT_CHANGED: { subject: 'model', change: 'The model format version changed.', kind: 'breaking', dimension: 'none' },
  SYSTEM_PROFILE_CHANGED: { subject: 'system profile', change: 'The system kind or traits changed, which changes the applicable design concerns.', kind: 'breaking', dimension: 'intent' },
  RESPONSIBILITY_CHANGED: { subject: 'component', change: 'The purpose or responsibilities changed.', kind: 'breaking', dimension: 'intent' },
  IMPLEMENTATION_CHANGED: { subject: 'component', change: 'The kind or implementation languages changed, which changes the generated conformance artifacts.', kind: 'compatible', dimension: 'deployment' },
  OWNER_CHANGED: { subject: 'owned record', change: 'The owning component changed; the owner holds the write authority, so moving a contract breaks its writers.', kind: 'breaking', dimension: 'behavior' },
  ACCOUNTABLE_OWNER_CHANGED: { subject: 'knowledge record', change: 'The accountable team alias changed.', kind: 'compatible', dimension: 'intent' },
  NOT_APPLICABLE_CHANGED: { subject: 'any record', change: 'A not-applicable justification was added, changed or removed.', kind: 'compatible', dimension: 'intent' },
  REPRESENTATION_CHANGED: { subject: 'type', change: 'The representation changed.', kind: 'breaking', dimension: 'shape-consumer' },
  VISIBILITY_CHANGED: { subject: 'type or property', change: 'The visibility changed: wider visibility exposes the value, narrower visibility removes it from consumers.', kind: 'breaking', dimension: 'contextual' },
  STATE_PROPERTY_CHANGED: { subject: 'type', change: 'The stateProperty changed, was added or was removed.', kind: 'breaking', dimension: 'behavior' },
  KEY_CHANGED: { subject: 'type', change: 'The key changed: a property added, removed or reordered.', kind: 'breaking', dimension: 'shape-consumer' },
  EXTERNAL_SCHEMA_CHANGED: { subject: 'type', change: 'The pinned external schema changed.', kind: 'breaking', dimension: 'shape-consumer' },
  RETENTION_CHANGED: { subject: 'type or property', change: 'The retention or deletion behavior changed.', kind: 'breaking', dimension: 'storage' },
  INVARIANT_CHANGED: { subject: 'type or property', change: 'An invariant was added, changed or removed.', kind: 'breaking', dimension: 'behavior' },
  SUPPORTED_VERSION_ADDED: { subject: 'versioned contract', change: 'A superseded contract version is declared supported.', kind: 'compatible', dimension: 'shape-consumer' },
  SUPPORTED_VERSION_REMOVED: { subject: 'versioned contract', change: 'A supported superseded contract version was retired.', kind: 'breaking', dimension: 'shape-consumer' },
  SUPPORTED_VERSION_CHANGED: { subject: 'versioned contract', change: 'The baseline, status, retirement or rollout of a supported version changed.', kind: 'compatible', dimension: 'deployment' },
  PROPERTY_REMOVED: { subject: 'type property', change: 'The property was removed.', kind: 'breaking', dimension: 'shape-consumer' },
  REQUIRED_PROPERTY_ADDED: { subject: 'type property', change: 'A required property was added; inputs must now carry it.', kind: 'contextual', dimension: 'contextual' },
  OPTIONAL_PROPERTY_ADDED: { subject: 'type property', change: 'An optional property was added.', kind: 'compatible', dimension: 'shape-provider' },
  PROPERTY_REORDERED: { subject: 'type property', change: 'The declaration order of properties changed.', kind: 'nonSemantic', dimension: 'none' },
  PROPERTY_KIND_CHANGED: { subject: 'type property', change: 'The kind changed.', kind: 'breaking', dimension: 'shape-consumer' },
  PROPERTY_SHAPE_CHANGED: { subject: 'type property', change: 'The referenced type, union variants, discriminator or array items changed.', kind: 'breaking', dimension: 'shape-consumer' },
  PROPERTY_NULLABILITY_CHANGED: { subject: 'type property', change: 'The nullability changed, in either direction.', kind: 'breaking', dimension: 'shape-consumer' },
  PROPERTY_BECAME_REQUIRED: { subject: 'type property', change: 'The property became required: inputs must now carry it.', kind: 'contextual', dimension: 'contextual' },
  PROPERTY_BECAME_OPTIONAL: { subject: 'type property', change: 'The property became optional: readers may now see it absent.', kind: 'contextual', dimension: 'contextual' },
  PROPERTY_BECAME_IMMUTABLE: { subject: 'type property', change: 'The property became immutable.', kind: 'breaking', dimension: 'behavior' },
  PROPERTY_BECAME_MUTABLE: { subject: 'type property', change: 'The property became mutable.', kind: 'compatible', dimension: 'behavior' },
  PROPERTY_ORIGIN_CHANGED: { subject: 'type property', change: 'Who supplies the value changed.', kind: 'breaking', dimension: 'security' },
  UNITS_CHANGED: { subject: 'type property', change: 'The units changed, which changes the meaning of every value.', kind: 'breaking', dimension: 'shape-consumer' },
  CLASSIFICATION_CHANGED: { subject: 'type property', change: 'The data classification changed.', kind: 'breaking', dimension: 'security' },
  WRITERS_CHANGED: { subject: 'type property', change: 'The components permitted to write the value changed.', kind: 'breaking', dimension: 'security' },
  DEFAULT_CHANGED: { subject: 'type property', change: 'The defaulting semantics changed.', kind: 'breaking', dimension: 'behavior' },
  UNKNOWN_ENUM_POLICY_CHANGED: { subject: 'enum value', change: 'How consumers treat an unknown enum value changed.', kind: 'breaking', dimension: 'shape-consumer' },
  ENUM_VALUE_REMOVED: { subject: 'enum value', change: 'An enum value was removed.', kind: 'breaking', dimension: 'shape-consumer' },
  ENUM_VALUE_ADDED: { subject: 'enum value', change: 'An enum value was added; output consumers that reject unknown values break.', kind: 'contextual', dimension: 'shape-consumer' },
  BOUND_TIGHTENED: { subject: 'value shape', change: 'A bound tightened: added, min or minLength raised, max or maxLength lowered, precision narrowed, or a pattern added or changed.', kind: 'contextual', dimension: 'contextual' },
  BOUND_LOOSENED: { subject: 'value shape', change: 'A bound loosened: removed, min or minLength lowered, max or maxLength raised, or precision widened.', kind: 'contextual', dimension: 'contextual' },
  BINDS_CHANGED: { subject: 'property, routine param or result column', change: 'Its binds was added, changed or removed.', kind: 'breaking', dimension: 'shape-consumer' },
  SECURITY_SCHEME_CHANGED: { subject: 'security scheme', change: 'A security scheme member changed; callers must present different credentials.', kind: 'breaking', dimension: 'security' },
  PERMISSION_CHANGED: { subject: 'operation or routine', change: 'The authority permission changed.', kind: 'breaking', dimension: 'security' },
  SCOPE_CHANGED: { subject: 'operation or routine', change: 'An authority scope was added or changed.', kind: 'breaking', dimension: 'security' },
  SCOPE_REMOVED: { subject: 'operation or routine', change: 'The authority scope was removed: callers become easier to satisfy, and the data the permission covers widens.', kind: 'breaking', dimension: 'security' },
  AUTHORITY_SCHEME_CHANGED: { subject: 'operation or routine', change: 'The security scheme carrying the permission changed.', kind: 'breaking', dimension: 'security' },
  OPERATION_KIND_CHANGED: { subject: 'operation', change: 'The operation kind changed.', kind: 'breaking', dimension: 'behavior' },
  OPERATION_TYPE_CHANGED: { subject: 'operation', change: 'The request, response or result type changed, was added or was removed.', kind: 'breaking', dimension: 'shape-consumer' },
  OPERATION_ERROR_ADDED: { subject: 'operation', change: 'An externally visible failure was declared.', kind: 'compatible', dimension: 'behavior' },
  OPERATION_ERROR_REMOVED: { subject: 'operation', change: 'A declared failure was removed.', kind: 'compatible', dimension: 'behavior' },
  OPERATION_ERROR_CHANGED: { subject: 'operation', change: 'The status, type or retry semantics of a failure changed.', kind: 'breaking', dimension: 'behavior' },
  OPERATION_BINDING_ADDED: { subject: 'operation', change: 'A binding was added.', kind: 'compatible', dimension: 'shape-consumer' },
  OPERATION_BINDING_REMOVED: { subject: 'operation', change: 'A binding was removed.', kind: 'breaking', dimension: 'shape-consumer' },
  OPERATION_BINDING_CHANGED: { subject: 'operation', change: 'A binding changed: its transport, method, path, media type or channel.', kind: 'breaking', dimension: 'shape-consumer' },
  HTTP_PARAMETER_ADDED: { subject: 'HTTP binding', change: 'A parameter was added; a required one must now be sent.', kind: 'contextual', dimension: 'shape-consumer' },
  HTTP_PARAMETER_REMOVED: { subject: 'HTTP binding', change: 'A parameter was removed.', kind: 'breaking', dimension: 'shape-consumer' },
  HTTP_PARAMETER_CHANGED: { subject: 'HTTP binding', change: 'A parameter changed its property, kind, values or required flag.', kind: 'breaking', dimension: 'shape-consumer' },
  HTTP_RESPONSE_ADDED: { subject: 'HTTP binding', change: 'A response was declared.', kind: 'compatible', dimension: 'shape-consumer' },
  HTTP_RESPONSE_REMOVED: { subject: 'HTTP binding', change: 'A response was removed.', kind: 'breaking', dimension: 'shape-consumer' },
  HTTP_RESPONSE_CHANGED: { subject: 'HTTP binding', change: 'A response changed its kind, type or media type.', kind: 'breaking', dimension: 'shape-consumer' },
  INVOCATION_CHANGED: { subject: 'operation', change: 'The mutations, routines or operations an operation invokes changed.', kind: 'breaking', dimension: 'behavior' },
  ENFORCEMENT_CHANGED: { subject: 'operation', change: 'A component accountable for enforcement changed.', kind: 'breaking', dimension: 'behavior' },
  CONDITION_CHANGED: { subject: 'operation', change: 'A precondition or postcondition was added, changed or removed.', kind: 'breaking', dimension: 'behavior' },
  IDEMPOTENCY_CHANGED: { subject: 'operation', change: 'The behavior on a repeated request changed.', kind: 'breaking', dimension: 'behavior' },
  CONCURRENCY_CHANGED: { subject: 'operation', change: 'Concurrency control changed.', kind: 'breaking', dimension: 'behavior' },
  TRANSACTION_CHANGED: { subject: 'operation', change: 'The transaction boundary changed.', kind: 'breaking', dimension: 'behavior' },
  ASYNC_CONTRACT_CHANGED: { subject: 'operation', change: 'The acceptance, completion, timeout, cancellation, retry, deduplication or recovery contract changed.', kind: 'breaking', dimension: 'behavior' },
  TRACE_LINKS_CHANGED: { subject: 'any record', change: 'Links to requirements, criteria or scenarios changed.', kind: 'compatible', dimension: 'intent' },
  HOST_CHANGED: { subject: 'routine', change: 'The host changed.', kind: 'breaking', dimension: 'behavior' },
  SOURCE_CHANGED: { subject: 'routine', change: 'The source file moved, was added or was removed.', kind: 'compatible', dimension: 'deployment' },
  PARAMETER_PASSING_CHANGED: { subject: 'routine', change: 'The calling convention changed between positional and named.', kind: 'breaking', dimension: 'shape-consumer' },
  PARAM_REMOVED: { subject: 'routine param', change: 'The param was removed.', kind: 'breaking', dimension: 'shape-consumer' },
  REQUIRED_PARAM_ADDED: { subject: 'routine param', change: 'A required param was added.', kind: 'breaking', dimension: 'shape-consumer' },
  OPTIONAL_PARAM_ADDED: { subject: 'routine param', change: 'An optional param was added.', kind: 'compatible', dimension: 'shape-consumer' },
  PARAM_REORDERED: { subject: 'routine param', change: 'The param order changed; under positional passing every caller binds the wrong values.', kind: 'contextual', dimension: 'shape-consumer' },
  PARAM_RETYPED: { subject: 'routine param', change: 'The kind or decimal shape changed.', kind: 'breaking', dimension: 'shape-consumer' },
  PARAM_NULLABILITY_CHANGED: { subject: 'routine param', change: 'The nullability changed, in either direction.', kind: 'breaking', dimension: 'shape-consumer' },
  PARAM_BECAME_REQUIRED: { subject: 'routine param', change: 'The param went from optional to required.', kind: 'breaking', dimension: 'shape-consumer' },
  PARAM_BECAME_OPTIONAL: { subject: 'routine param', change: 'The param went from required to optional.', kind: 'compatible', dimension: 'shape-provider' },
  COLUMN_REMOVED: { subject: 'routine result column', change: 'The column was removed.', kind: 'breaking', dimension: 'shape-consumer' },
  COLUMN_ADDED: { subject: 'routine result column', change: 'A column was added.', kind: 'compatible', dimension: 'shape-consumer' },
  COLUMN_REORDERED: { subject: 'routine result column', change: 'A column moved to another position.', kind: 'breaking', dimension: 'shape-consumer' },
  COLUMN_RETYPED: { subject: 'routine result column', change: 'The kind or decimal shape changed.', kind: 'breaking', dimension: 'shape-consumer' },
  COLUMN_NULLABILITY_CHANGED: { subject: 'routine result column', change: 'The nullability changed, in either direction.', kind: 'breaking', dimension: 'shape-consumer' },
  ROUTINE_MUTATIONS_CHANGED: { subject: 'routine', change: 'The mutations a routine performs changed.', kind: 'breaking', dimension: 'behavior' },
  ROUTINE_WRITES_CHANGED: { subject: 'routine', change: 'The storage or columns a routine writes changed.', kind: 'breaking', dimension: 'storage' },
  TRANSACTION_SCOPE_CHANGED: { subject: 'routine', change: 'The storage one transaction of the routine spans changed.', kind: 'breaking', dimension: 'behavior' },
  MUTATION_TYPE_CHANGED: { subject: 'mutation', change: 'The type a mutation changes was replaced.', kind: 'breaking', dimension: 'behavior' },
  TRANSITION_CHANGED: { subject: 'mutation', change: 'The origin or target state changed.', kind: 'breaking', dimension: 'behavior' },
  MUTATION_WRITES_CHANGED: { subject: 'mutation', change: 'The declared write set changed.', kind: 'breaking', dimension: 'behavior' },
  GUARD_CHANGED: { subject: 'mutation', change: 'The guard changed.', kind: 'breaking', dimension: 'behavior' },
  EFFECT_CHANGED: { subject: 'mutation', change: 'The stated effect changed.', kind: 'breaking', dimension: 'behavior' },
  WORKFLOW_STATUS_CHANGED: { subject: 'workflow', change: 'The workflow status changed.', kind: 'compatible', dimension: 'intent' },
  WORKFLOW_DEPENDENCY_CHANGED: { subject: 'workflow', change: 'A workflow dependency was added or removed.', kind: 'breaking', dimension: 'behavior' },
  WORKFLOW_IMPORT_CHANGED: { subject: 'workflow', change: 'A type import was added, removed or re-pinned.', kind: 'compatible', dimension: 'shape-consumer' },
  WORKFLOW_SCOPE_CHANGED: { subject: 'workflow', change: 'The operations, mutations or requirements of a workflow changed.', kind: 'compatible', dimension: 'intent' },
  EDGE_RATIONALE_CHANGED: { subject: 'edge', change: 'The rationale of a dependency changed.', kind: 'compatible', dimension: 'intent' },
  READINESS_DEPENDENCY_CHANGED: { subject: 'edge', change: 'What the dependent task requires of its target changed.', kind: 'breaking', dimension: 'behavior' },
  CYCLE_BEHAVIOR_CHANGED: { subject: 'edge', change: 'The defined behavior of a runtime cycle changed.', kind: 'breaking', dimension: 'behavior' },
  REQUIREMENT_CHANGED: { subject: 'requirement', change: 'The outcome, scope or status of a requirement changed.', kind: 'breaking', dimension: 'intent' },
  REQUIREMENT_METADATA_CHANGED: { subject: 'requirement', change: 'The revision, source, basis or priority of a requirement changed.', kind: 'compatible', dimension: 'intent' },
  CRITERION_ADDED: { subject: 'acceptance criterion', change: 'An acceptance criterion was added; a new obligation needs coverage and evidence.', kind: 'breaking', dimension: 'intent' },
  CRITERION_REMOVED: { subject: 'acceptance criterion', change: 'An acceptance criterion was removed.', kind: 'breaking', dimension: 'intent' },
  CRITERION_CHANGED: { subject: 'acceptance criterion', change: 'The statement, verification method, evidence kinds or required flag of a criterion changed.', kind: 'breaking', dimension: 'intent' },
  SCENARIO_CHANGED: { subject: 'scenario', change: 'The kind, situation or expected outcome of a scenario changed.', kind: 'breaking', dimension: 'intent' },
  KNOWLEDGE_CHANGED: { subject: 'constraint, observation, assumption, unknown, decision, inventory item, retained behavior or workload', change: 'A claim, condition or choice the design rests on changed.', kind: 'breaking', dimension: 'intent' },
  KNOWLEDGE_METADATA_CHANGED: { subject: 'knowledge record', change: 'A source, rationale, note or explanatory member changed.', kind: 'compatible', dimension: 'intent' },
  ATTACHMENT_CHANGED: { subject: 'attachment', change: 'The pinned rationale, its digest or what it explains changed.', kind: 'compatible', dimension: 'intent' },
  MAPPING_CHANGED: { subject: 'mapping', change: 'How a representation maps to another changed, and with it the values its consumers observe.', kind: 'breaking', dimension: 'behavior' },
  STORAGE_TABLE_CHANGED: { subject: 'storage', change: 'The type, owner, platform, schema or table of a storage record changed.', kind: 'breaking', dimension: 'storage' },
  STORAGE_COLUMN_ADDED: { subject: 'storage column', change: 'A column was added; a NOT NULL column without a default fails on existing rows.', kind: 'contextual', dimension: 'storage' },
  STORAGE_COLUMN_REMOVED: { subject: 'storage column', change: 'A column was removed.', kind: 'breaking', dimension: 'storage' },
  STORAGE_COLUMN_CHANGED: { subject: 'storage column', change: 'A column changed its mapped property, type, nullability, collation, default or identity.', kind: 'breaking', dimension: 'storage' },
  STORAGE_COLUMN_REORDERED: { subject: 'storage column', change: 'The column order changed.', kind: 'compatible', dimension: 'storage' },
  STORAGE_KEY_CHANGED: { subject: 'storage', change: 'The primary key changed.', kind: 'breaking', dimension: 'storage' },
  STORAGE_CONSTRAINT_ADDED: { subject: 'storage', change: 'A unique, foreign-key or check constraint was added; existing rows may violate it.', kind: 'breaking', dimension: 'storage' },
  STORAGE_CONSTRAINT_REMOVED: { subject: 'storage', change: 'A unique, foreign-key or check constraint was removed.', kind: 'compatible', dimension: 'storage' },
  STORAGE_CONSTRAINT_CHANGED: { subject: 'storage', change: 'A unique, foreign-key or check constraint changed.', kind: 'breaking', dimension: 'storage' },
  STORAGE_INDEX_CHANGED: { subject: 'storage', change: 'A non-unique index was added, changed or removed.', kind: 'compatible', dimension: 'storage' },
  MIGRATION_CHANGED: { subject: 'migration', change: 'A migration contract changed.', kind: 'breaking', dimension: 'storage' },
  DEPLOYMENT_CHANGED: { subject: 'deployment unit, host or trust boundary', change: 'Hosting, invocation, limits, identity, configuration or isolation changed.', kind: 'breaking', dimension: 'deployment' },
  DEPLOYMENT_NOTE_CHANGED: { subject: 'deployment unit, host or trust boundary', change: 'An explanatory member of a hosting record changed.', kind: 'compatible', dimension: 'deployment' },
  CONSUMER_BINDING_CHANGED: { subject: 'consumer binding', change: 'The contract, version, compatibility policy, required flag or status a consumer binds changed.', kind: 'breaking', dimension: 'shape-consumer' },
  PUBLISHED_CONTRACT_PIN_CHANGED: { subject: 'published contract', change: 'The publisher, contract, version, digest or schema version of a pinned contract changed.', kind: 'breaking', dimension: 'shape-consumer' },
  PUBLISHED_CONTRACT_CONSUMERS_CHANGED: { subject: 'published contract', change: 'The components consuming a pinned contract changed.', kind: 'compatible', dimension: 'intent' },
  AGREEMENT_CHANGED: { subject: 'agreement', change: 'The kind, constraint, providers or consumers of a boundary agreement changed; every binding to it must be established again.', kind: 'breaking', dimension: 'behavior' },
} as const satisfies Record<string, DiffRule>;

export type DiffRuleId = keyof typeof DIFF_RULES;

// ---------- classifier helpers ----------

const ns = (reason: string): FieldPolicy => ({ nonSemantic: reason });
const fixed = (rule: DiffRuleId, kind: ChangeKind, dimension: Dimension): FieldPolicy => ({ classify: () => ({ rule, kind, dimension }) });
const as = (rule: DiffRuleId): FieldPolicy => {
  const r = DIFF_RULES[rule] as DiffRule;
  if (r.kind === 'contextual' || r.dimension === 'contextual') throw new Error(`rule ${rule} needs a classifier`);
  return fixed(rule, r.kind, r.dimension);
};
const cls = (f: (d: Delta) => Verdict): FieldPolicy => ({ classify: f });
const byEvent = (added: DiffRuleId, removed: DiffRuleId, changed: DiffRuleId = removed): FieldPolicy =>
  cls((d) => {
    const rule = d.event === 'added' ? added : d.event === 'removed' ? removed : changed;
    const r = DIFF_RULES[rule] as DiffRule;
    return { rule, kind: r.kind === 'contextual' ? 'breaking' : r.kind, dimension: r.dimension === 'contextual' ? 'behavior' : r.dimension };
  });

/** The type a delta inside 'types' belongs to, on the side that has it. */
function typeOf(d: Delta): TypeDef | undefined {
  if (d.element.kind !== 'type') return undefined;
  return (d.recordAfter ?? d.recordBefore) as TypeDef | undefined;
}
const OUTPUT = new Set(['response', 'event']);
const isOutput = (d: Delta): boolean => d.itemField === 'resultSet' || OUTPUT.has(typeOf(d)?.representation ?? 'domain');

/** Tightening breaks whoever supplies values; on an output representation loosening breaks the readers instead. */
function boundVerdict(d: Delta, tightened: boolean): Verdict {
  const output = isOutput(d);
  const breaking = output ? !tightened : tightened;
  return {
    rule: tightened ? 'BOUND_TIGHTENED' : 'BOUND_LOOSENED',
    kind: breaking ? 'breaking' : 'compatible',
    dimension: breaking ? 'shape-consumer' : 'shape-provider',
  };
}
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const lower: FieldPolicy =
  cls((d) => {
    const b = num(d.before);
    const a = num(d.after);
    return boundVerdict(d, a !== undefined && (b === undefined || a > b));
  });
const upper: FieldPolicy =
  cls((d) => {
    const b = num(d.before);
    const a = num(d.after);
    return boundVerdict(d, a !== undefined && (b === undefined || a < b));
  });


function enumConsumersReject(d: Delta): boolean {
  const t = typeOf(d);
  const p = (d.itemAfter ?? d.itemBefore) as Property | undefined;
  if (!t || !p) return false;
  const rejects = (x: Property | undefined): boolean => x !== undefined && (x.unknownEnumPolicy === undefined || x.unknownEnumPolicy === 'reject');
  if (OUTPUT.has(t.representation) && rejects(p)) return true;
  const ref = `${t.id}.${p.name}`;
  const m = d.modelAfter;
  for (const other of m.types) {
    if (!OUTPUT.has(other.representation)) continue;
    for (const q of other.properties) if (q.binds === ref && rejects(q)) return true;
  }
  for (const mapping of m.mappings) {
    if (mapping.from !== t.id) continue;
    const target = m.types.find((x) => x.id === mapping.to);
    if (!target || !OUTPUT.has(target.representation)) continue;
    for (const f of mapping.fields) {
      if ((f.from ?? f.to) !== p.name) continue;
      if (rejects(target.properties.find((x) => x.name === f.to))) return true;
    }
  }
  return false;
}

const enumValues = cls((d) => {
  if (d.event === 'removed') return { rule: 'ENUM_VALUE_REMOVED', kind: 'breaking', dimension: 'shape-consumer' };
  return enumConsumersReject(d)
    ? { rule: 'ENUM_VALUE_ADDED', kind: 'breaking', dimension: 'shape-consumer' }
    : { rule: 'ENUM_VALUE_ADDED', kind: 'compatible', dimension: 'shape-consumer' };
});

const required = cls((d) => {
  const becameRequired = d.after === true;
  const output = isOutput(d);
  if (becameRequired) return { rule: 'PROPERTY_BECAME_REQUIRED', kind: output ? 'compatible' : 'breaking', dimension: output ? 'shape-provider' : 'shape-consumer' };
  const input = typeOf(d)?.representation === 'request';
  return { rule: 'PROPERTY_BECAME_OPTIONAL', kind: input ? 'compatible' : 'breaking', dimension: input ? 'shape-provider' : 'shape-consumer' };
});

const immutable = cls((d) =>
  d.after === true ? { rule: 'PROPERTY_BECAME_IMMUTABLE', kind: 'breaking', dimension: 'behavior' } : { rule: 'PROPERTY_BECAME_MUTABLE', kind: 'compatible', dimension: 'behavior' },
);

const VISIBILITY_RANK: Record<string, number> = { private: 0, internal: 1, public: 2 };
const visibility = cls((d) => {
  const b = VISIBILITY_RANK[String(d.before ?? 'public')] ?? 2;
  const a = VISIBILITY_RANK[String(d.after ?? 'public')] ?? 2;
  return { rule: 'VISIBILITY_CHANGED', kind: 'breaking', dimension: a > b ? 'security' : 'shape-consumer' };
});

const properties = cls((d): Verdict => {
  if (d.event === 'moved') return { rule: 'PROPERTY_REORDERED', kind: 'nonSemantic', dimension: 'none' };
  if (d.event === 'removed') return { rule: 'PROPERTY_REMOVED', kind: 'breaking', dimension: 'shape-consumer' };
  const p = d.after as Property;
  if (!p.required) return { rule: 'OPTIONAL_PROPERTY_ADDED', kind: 'compatible', dimension: 'shape-provider' };
  const output = isOutput(d);
  return { rule: 'REQUIRED_PROPERTY_ADDED', kind: output ? 'compatible' : 'breaking', dimension: output ? 'shape-provider' : 'shape-consumer' };
});

/** A param reorder breaks every caller under positional passing; under named passing order carries no meaning. */
const params = cls((d): Verdict => {
  if (d.event === 'moved') {
    const r = (d.recordAfter ?? d.recordBefore) as { parameterPassing?: string };
    return r.parameterPassing === 'named'
      ? { rule: 'PARAM_REORDERED', kind: 'nonSemantic', dimension: 'none' }
      : { rule: 'PARAM_REORDERED', kind: 'breaking', dimension: 'shape-consumer' };
  }
  if (d.event === 'removed') return { rule: 'PARAM_REMOVED', kind: 'breaking', dimension: 'shape-consumer' };
  return (d.after as { required: boolean }).required
    ? { rule: 'REQUIRED_PARAM_ADDED', kind: 'breaking', dimension: 'shape-consumer' }
    : { rule: 'OPTIONAL_PARAM_ADDED', kind: 'compatible', dimension: 'shape-consumer' };
});
const resultColumns = cls((d): Verdict =>
  d.event === 'moved'
    ? { rule: 'COLUMN_REORDERED', kind: 'breaking', dimension: 'shape-consumer' }
    : d.event === 'removed'
      ? { rule: 'COLUMN_REMOVED', kind: 'breaking', dimension: 'shape-consumer' }
      : { rule: 'COLUMN_ADDED', kind: 'compatible', dimension: 'shape-consumer' },
);

/** Inside a routine slot the rule names a param or a column; inside a type, a property. */
function slotRule(d: Delta, param: DiffRuleId, column: DiffRuleId, property: DiffRuleId): Verdict {
  const rule = d.itemField === 'params' ? param : d.itemField === 'resultSet' ? column : property;
  const r = DIFF_RULES[rule] as DiffRule;
  return { rule, kind: r.kind === 'contextual' ? 'breaking' : r.kind, dimension: r.dimension === 'contextual' ? 'shape-consumer' : r.dimension };
}
const slotKind = cls((d) => slotRule(d, 'PARAM_RETYPED', 'COLUMN_RETYPED', 'PROPERTY_KIND_CHANGED'));
const slotNullable = cls((d) => slotRule(d, 'PARAM_NULLABILITY_CHANGED', 'COLUMN_NULLABILITY_CHANGED', 'PROPERTY_NULLABILITY_CHANGED'));
/** A routine slot's decimal shape is its exact type; a property's precision is a bound. */
const decimalShape = cls((d) => {
  if (d.itemField === 'params' || d.itemField === 'resultSet') return slotRule(d, 'PARAM_RETYPED', 'COLUMN_RETYPED', 'PROPERTY_KIND_CHANGED');
  const b = num(d.before);
  const a = num(d.after);
  return boundVerdict(d, a !== undefined && (b === undefined || a < b));
});
const paramRequired = cls((d) =>
  d.after === true ? { rule: 'PARAM_BECAME_REQUIRED', kind: 'breaking', dimension: 'shape-consumer' } : { rule: 'PARAM_BECAME_OPTIONAL', kind: 'compatible', dimension: 'shape-provider' },
);
const pattern = cls((d) => boundVerdict(d, d.after !== undefined));

const authorityScope = cls((d): Verdict =>
  d.after === undefined ? { rule: 'SCOPE_REMOVED', kind: 'breaking', dimension: 'security' } : { rule: 'SCOPE_CHANGED', kind: 'breaking', dimension: 'security' },
);

const RECORD_DIMENSION: Record<string, Dimension> = {
  component: 'intent', type: 'shape-consumer', operation: 'shape-consumer', routine: 'shape-consumer', mutation: 'behavior', workflow: 'intent',
  edge: 'intent', requirement: 'intent', scenario: 'intent', constraint: 'intent', observation: 'intent', assumption: 'intent', unknown: 'intent',
  decision: 'intent', inventory: 'intent', retainedBehavior: 'intent', workload: 'intent', attachment: 'intent', mapping: 'shape-provider',
  storage: 'storage', migration: 'storage', deploymentUnit: 'deployment', host: 'deployment', trustBoundary: 'security', securityScheme: 'security',
  consumerBinding: 'shape-consumer', publishedContract: 'shape-consumer', agreement: 'behavior',
};
const collection = cls((d) => ({
  rule: d.event === 'added' ? 'RECORD_ADDED' : 'RECORD_REMOVED',
  kind: d.event === 'added' ? 'compatible' : 'breaking',
  dimension: RECORD_DIMENSION[d.element.kind] ?? 'intent',
}));

const storageColumns = cls((d): Verdict => {
  if (d.event === 'moved') return { rule: 'STORAGE_COLUMN_REORDERED', kind: 'compatible', dimension: 'storage' };
  if (d.event === 'removed') return { rule: 'STORAGE_COLUMN_REMOVED', kind: 'breaking', dimension: 'storage' };
  const c = d.after as { nullable: boolean; default?: unknown; identity?: boolean };
  const safe = c.nullable || c.default !== undefined || c.identity === true;
  return { rule: 'STORAGE_COLUMN_ADDED', kind: safe ? 'compatible' : 'breaking', dimension: 'storage' };
});
const constraint = byEvent('STORAGE_CONSTRAINT_ADDED', 'STORAGE_CONSTRAINT_REMOVED', 'STORAGE_CONSTRAINT_CHANGED');
const supported = byEvent('SUPPORTED_VERSION_ADDED', 'SUPPORTED_VERSION_REMOVED', 'SUPPORTED_VERSION_CHANGED');
const notApplicable = as('NOT_APPLICABLE_CHANGED');
const trace = as('TRACE_LINKS_CHANGED');
const knowledge = as('KNOWLEDGE_CHANGED');
const knowledgeNote = as('KNOWLEDGE_METADATA_CHANGED');
const deployment = as('DEPLOYMENT_CHANGED');
const deploymentNote = as('DEPLOYMENT_NOTE_CHANGED');
const storageTable = as('STORAGE_TABLE_CHANGED');
const storageColumn = as('STORAGE_COLUMN_CHANGED');
const migration = as('MIGRATION_CHANGED');
const mapping = as('MAPPING_CHANGED');
const binding = as('OPERATION_BINDING_CHANGED');
const httpParam = as('HTTP_PARAMETER_CHANGED');
const httpResponse = as('HTTP_RESPONSE_CHANGED');
const asyncContract = as('ASYNC_CONTRACT_CHANGED');
const scheme = as('SECURITY_SCHEME_CHANGED');
const shape = as('PROPERTY_SHAPE_CHANGED');
const desc = ns('Descriptive text carries no contract meaning.');
const version = ns('A version or revision number accompanies the change it numbers; the guard on versioned contracts checks it separately.');
const keyField = ns('A key field identifies its element; a different key is an added and a removed element.');

/**
 * The comparison decision for every field of the model contract, keyed by
 * '<Definition>.<inline path>'. The self-test walks the contract and fails on
 * any reachable field without an entry here, so a field added to the schema
 * cannot bypass comparison; at run time a missing entry yields requiresReview.
 */
export const FIELD_POLICY: Readonly<Record<string, FieldPolicy>> = {
  'Model.version': as('MODEL_FORMAT_CHANGED'),
  'SystemProfile.kind': as('SYSTEM_PROFILE_CHANGED'),
  'SystemProfile.traits[]': as('SYSTEM_PROFILE_CHANGED'),
  ...Object.fromEntries(
    ['components', 'types', 'operations', 'routines', 'mutations', 'workflows', 'edges', 'requirements', 'scenarios', 'constraints', 'observations', 'assumptions', 'unknowns', 'decisions', 'inventory', 'retainedBehaviors', 'workloads', 'attachments', 'mappings', 'storage', 'migrations', 'deploymentUnits', 'hosts', 'trustBoundaries', 'securitySchemes', 'consumerBindings', 'publishedContracts', 'agreements'].map(
      (c) => [`Model.${c}[]`, collection],
    ),
  ),
  'NotApplicable.concern': keyField,
  'NotApplicable.reason': notApplicable,

  'Component.id': keyField,
  'Component.purpose': as('RESPONSIBILITY_CHANGED'),
  'Component.responsibilities[]': as('RESPONSIBILITY_CHANGED'),
  'Component.owner': as('ACCOUNTABLE_OWNER_CHANGED'),
  'Component.kind': as('IMPLEMENTATION_CHANGED'),
  'Component.implementations[]': as('IMPLEMENTATION_CHANGED'),
  'Component.implementations[].language': keyField,
  'Component.implementations[].module': as('IMPLEMENTATION_CHANGED'),
  'Component.notApplicable[]': notApplicable,

  'Bounds.min': lower,
  'Bounds.max': upper,
  'Bounds.minLength': lower,
  'Bounds.maxLength': upper,
  'Bounds.minItems': lower,
  'Bounds.maxItems': upper,
  'Bounds.pattern': pattern,
  'DecimalShape.precision': decimalShape,
  'DecimalShape.scale': decimalShape,
  'Default.policy': as('DEFAULT_CHANGED'),
  'Default.value': as('DEFAULT_CHANGED'),
  'Default.appliesOn': as('DEFAULT_CHANGED'),
  'Default.description': desc,

  'ItemShape.kind': shape,
  'ItemShape.enumValues[]': enumValues,
  'ItemShape.unknownEnumPolicy': as('UNKNOWN_ENUM_POLICY_CHANGED'),
  'ItemShape.ref': shape,
  'ItemShape.variants[]': shape,
  'ItemShape.discriminator': shape,
  'ItemShape.items': shape,

  'Property.name': keyField,
  'Property.kind': slotKind,
  'Property.required': required,
  'Property.nullable': slotNullable,
  'Property.immutable': immutable,
  'Property.origin': as('PROPERTY_ORIGIN_CHANGED'),
  'Property.description': desc,
  'Property.units': as('UNITS_CHANGED'),
  'Property.enumValues[]': enumValues,
  'Property.unknownEnumPolicy': as('UNKNOWN_ENUM_POLICY_CHANGED'),
  'Property.ref': shape,
  'Property.variants[]': shape,
  'Property.discriminator': shape,
  'Property.binds': as('BINDS_CHANGED'),
  'Property.visibility': visibility,
  'Property.classification': as('CLASSIFICATION_CHANGED'),
  'Property.writers[]': as('WRITERS_CHANGED'),
  'Property.retention': as('RETENTION_CHANGED'),
  'Property.invariants[]': as('INVARIANT_CHANGED'),
  'Property.notApplicable[]': notApplicable,

  'SupportedVersion.version': keyField,
  'SupportedVersion.baseline': supported,
  'SupportedVersion.status': supported,
  'SupportedVersion.retirement.condition': supported,
  'SupportedVersion.retirement.decision': supported,
  'SupportedVersion.rollout.order[]': supported,
  'SupportedVersion.rollout.migrations[]': supported,

  'TypeDef.id': keyField,
  'TypeDef.version': version,
  'TypeDef.owner': as('OWNER_CHANGED'),
  'TypeDef.representation': as('REPRESENTATION_CHANGED'),
  'TypeDef.description': desc,
  'TypeDef.visibility': visibility,
  'TypeDef.stateProperty': as('STATE_PROPERTY_CHANGED'),
  'TypeDef.key[]': as('KEY_CHANGED'),
  'TypeDef.properties[]': properties,
  'TypeDef.invariants[]': as('INVARIANT_CHANGED'),
  'TypeDef.externalSchema.source': as('EXTERNAL_SCHEMA_CHANGED'),
  'TypeDef.externalSchema.digest': as('EXTERNAL_SCHEMA_CHANGED'),
  'TypeDef.retention': as('RETENTION_CHANGED'),
  'TypeDef.supported[]': supported,
  'TypeDef.notApplicable[]': notApplicable,

  'SecurityScheme.id': keyField,
  'SecurityScheme.type': scheme,
  'SecurityScheme.scheme': scheme,
  'SecurityScheme.bearerFormat': scheme,
  'SecurityScheme.in': scheme,
  'SecurityScheme.name': scheme,
  'SecurityScheme.openIdConnectUrl': scheme,
  'SecurityScheme.description': desc,
  'OAuthFlow.authorizationUrl': scheme,
  'OAuthFlow.tokenUrl': scheme,
  'OAuthFlow.scopes': scheme,

  'Authority.permission': as('PERMISSION_CHANGED'),
  'Authority.scope': authorityScope,
  'Authority.scheme': as('AUTHORITY_SCHEME_CHANGED'),

  'HttpParameter.name': keyField,
  'HttpParameter.in': keyField,
  'HttpParameter.property': httpParam,
  'HttpParameter.kind': httpParam,
  'HttpParameter.enumValues[]': httpParam,
  'HttpParameter.required': httpParam,
  'HttpParameter.description': desc,
  'HttpResponse.status': keyField,
  'HttpResponse.kind': httpResponse,
  'HttpResponse.type': httpResponse,
  'HttpResponse.mediaType': httpResponse,
  'HttpResponse.description': desc,
  'Binding.transport': binding,
  'Binding.method': binding,
  'Binding.path': binding,
  'Binding.parameters[]': cls((d) =>
    d.event === 'removed'
      ? { rule: 'HTTP_PARAMETER_REMOVED', kind: 'breaking', dimension: 'shape-consumer' }
      : { rule: 'HTTP_PARAMETER_ADDED', kind: (d.after as { required: boolean }).required ? 'breaking' : 'compatible', dimension: 'shape-consumer' },
  ),
  'Binding.requestMediaType': binding,
  'Binding.responses[]': byEvent('HTTP_RESPONSE_ADDED', 'HTTP_RESPONSE_REMOVED'),
  'Binding.channel': binding,

  'OperationError.code': keyField,
  'OperationError.status': as('OPERATION_ERROR_CHANGED'),
  'OperationError.type': as('OPERATION_ERROR_CHANGED'),
  'OperationError.retryable': as('OPERATION_ERROR_CHANGED'),
  'OperationError.description': desc,
  'Enforcement.authorization': as('ENFORCEMENT_CHANGED'),
  'Enforcement.validation': as('ENFORCEMENT_CHANGED'),
  'Enforcement.persistence': as('ENFORCEMENT_CHANGED'),
  'Enforcement.transport': as('ENFORCEMENT_CHANGED'),
  'Enforcement.orchestration': as('ENFORCEMENT_CHANGED'),
  'Idempotency.kind': as('IDEMPOTENCY_CHANGED'),
  'Idempotency.key.in': as('IDEMPOTENCY_CHANGED'),
  'Idempotency.key.name': as('IDEMPOTENCY_CHANGED'),
  'Idempotency.window': as('IDEMPOTENCY_CHANGED'),
  'Idempotency.repeatedRequest': as('IDEMPOTENCY_CHANGED'),
  'Concurrency.control': as('CONCURRENCY_CHANGED'),
  'Concurrency.token': as('CONCURRENCY_CHANGED'),
  'Concurrency.onConflict': as('CONCURRENCY_CHANGED'),
  'Transaction.boundary': as('TRANSACTION_CHANGED'),
  'Transaction.routine': as('TRANSACTION_CHANGED'),
  'Transaction.compensation': as('TRANSACTION_CHANGED'),
  'AsyncContract.accepted.status': asyncContract,
  'AsyncContract.accepted.type': asyncContract,
  'AsyncContract.completion.result': asyncContract,
  'AsyncContract.completion.via': asyncContract,
  'AsyncContract.completion.statusOperation': asyncContract,
  'AsyncContract.completion.event': asyncContract,
  'AsyncContract.jobIdentity': asyncContract,
  'AsyncContract.timeout.after': asyncContract,
  'AsyncContract.timeout.ambiguity': asyncContract,
  'AsyncContract.cancellation.supported': asyncContract,
  'AsyncContract.cancellation.operation': asyncContract,
  'AsyncContract.cancellation.semantics': asyncContract,
  'AsyncContract.retry.owner': asyncContract,
  'AsyncContract.retry.policy': asyncContract,
  'AsyncContract.deduplication.window': asyncContract,
  'AsyncContract.deduplication.key': asyncContract,
  'AsyncContract.partialFailure': asyncContract,

  'Operation.id': keyField,
  'Operation.version': version,
  'Operation.owner': as('OWNER_CHANGED'),
  'Operation.kind': as('OPERATION_KIND_CHANGED'),
  'Operation.description': desc,
  'Operation.request': as('OPERATION_TYPE_CHANGED'),
  'Operation.response': as('OPERATION_TYPE_CHANGED'),
  'Operation.result': as('OPERATION_TYPE_CHANGED'),
  'Operation.errors[]': byEvent('OPERATION_ERROR_ADDED', 'OPERATION_ERROR_REMOVED'),
  'Operation.bindings[]': byEvent('OPERATION_BINDING_ADDED', 'OPERATION_BINDING_REMOVED'),
  'Operation.invokes[]': as('INVOCATION_CHANGED'),
  'Operation.criteria[]': trace,
  'Operation.scenarios[]': trace,
  'Operation.preconditions[]': as('CONDITION_CHANGED'),
  'Operation.postconditions[]': as('CONDITION_CHANGED'),
  'Operation.supported[]': supported,
  'Operation.notApplicable[]': notApplicable,
  'Invocation.kind': keyField,
  'Invocation.id': keyField,

  'RoutineParam.name': keyField,
  'RoutineParam.kind': slotKind,
  'RoutineParam.enumValues[]': enumValues,
  'RoutineParam.required': paramRequired,
  'RoutineParam.nullable': slotNullable,
  'RoutineParam.binds': as('BINDS_CHANGED'),
  'ResultColumn.name': keyField,
  'ResultColumn.kind': slotKind,
  'ResultColumn.enumValues[]': enumValues,
  'ResultColumn.nullable': slotNullable,
  'ResultColumn.binds': as('BINDS_CHANGED'),
  'StorageWrite.storage': keyField,
  'StorageWrite.columns[]': as('ROUTINE_WRITES_CHANGED'),
  'Routine.id': keyField,
  'Routine.version': version,
  'Routine.owner': as('OWNER_CHANGED'),
  'Routine.host': as('HOST_CHANGED'),
  'Routine.source': as('SOURCE_CHANGED'),
  'Routine.parameterPassing': as('PARAMETER_PASSING_CHANGED'),
  'Routine.params[]': params,
  'Routine.resultSet[]': resultColumns,
  'Routine.performsMutations[]': as('ROUTINE_MUTATIONS_CHANGED'),
  'Routine.writes[]': as('ROUTINE_WRITES_CHANGED'),
  'Routine.transactionScope[]': as('TRANSACTION_SCOPE_CHANGED'),
  'Routine.supported[]': supported,
  'Routine.notApplicable[]': notApplicable,

  'Mutation.id': keyField,
  'Mutation.type': as('MUTATION_TYPE_CHANGED'),
  'Mutation.owner': as('OWNER_CHANGED'),
  'Mutation.from[]': as('TRANSITION_CHANGED'),
  'Mutation.to': as('TRANSITION_CHANGED'),
  'Mutation.writes[]': as('MUTATION_WRITES_CHANGED'),
  'Mutation.guard': as('GUARD_CHANGED'),
  'Mutation.effect': as('EFFECT_CHANGED'),
  'Mutation.requirements[]': trace,
  'Mutation.criteria[]': trace,
  'Mutation.scenarios[]': trace,

  'Workflow.id': keyField,
  'Workflow.status': as('WORKFLOW_STATUS_CHANGED'),
  'Workflow.dependsOn[]': as('WORKFLOW_DEPENDENCY_CHANGED'),
  'Workflow.imports[]': as('WORKFLOW_IMPORT_CHANGED'),
  'Workflow.imports[].typeId': keyField,
  'Workflow.imports[].version': as('WORKFLOW_IMPORT_CHANGED'),
  'Workflow.operations[]': as('WORKFLOW_SCOPE_CHANGED'),
  'Workflow.mutations[]': as('WORKFLOW_SCOPE_CHANGED'),
  'Workflow.requirements[]': as('WORKFLOW_SCOPE_CHANGED'),

  'Substitute.kind': keyField,
  'Substitute.permits[]': as('READINESS_DEPENDENCY_CHANGED'),
  'Substitute.limits': as('READINESS_DEPENDENCY_CHANGED'),
  'ReadinessDependency.claim': as('READINESS_DEPENDENCY_CHANGED'),
  'ReadinessDependency.revision': as('READINESS_DEPENDENCY_CHANGED'),
  'ReadinessDependency.compatibleRange.min': as('READINESS_DEPENDENCY_CHANGED'),
  'ReadinessDependency.compatibleRange.max': as('READINESS_DEPENDENCY_CHANGED'),
  'ReadinessDependency.maturity': as('READINESS_DEPENDENCY_CHANGED'),
  'ReadinessDependency.substitutes[]': as('READINESS_DEPENDENCY_CHANGED'),
  'ReadinessDependency.evidence[]': as('READINESS_DEPENDENCY_CHANGED'),
  'ReadinessDependency.invalidatedBy[]': as('READINESS_DEPENDENCY_CHANGED'),
  'Edge.from': keyField,
  'Edge.to': keyField,
  'Edge.kind': keyField,
  'Edge.rationale': as('EDGE_RATIONALE_CHANGED'),
  'Edge.cycle.behavior': as('CYCLE_BEHAVIOR_CHANGED'),

  'Criterion.id': keyField,
  'Criterion.statement': as('CRITERION_CHANGED'),
  'Criterion.verification': as('CRITERION_CHANGED'),
  'Criterion.evidence[]': as('CRITERION_CHANGED'),
  'Criterion.required': as('CRITERION_CHANGED'),
  'Requirement.id': keyField,
  'Requirement.revision': version,
  'Requirement.outcome': as('REQUIREMENT_CHANGED'),
  'Requirement.owner': as('ACCOUNTABLE_OWNER_CHANGED'),
  'Requirement.scope[]': as('REQUIREMENT_CHANGED'),
  'Requirement.source[]': as('REQUIREMENT_METADATA_CHANGED'),
  'Requirement.basis': as('REQUIREMENT_METADATA_CHANGED'),
  'Requirement.priority': as('REQUIREMENT_METADATA_CHANGED'),
  'Requirement.status': as('REQUIREMENT_CHANGED'),
  'Requirement.criteria[]': byEvent('CRITERION_ADDED', 'CRITERION_REMOVED'),
  'Requirement.notApplicable[]': notApplicable,
  'Scenario.id': keyField,
  'Scenario.requirements[]': trace,
  'Scenario.criteria[]': trace,
  'Scenario.kind': as('SCENARIO_CHANGED'),
  'Scenario.given': as('SCENARIO_CHANGED'),
  'Scenario.when': as('SCENARIO_CHANGED'),
  'Scenario.expected': as('SCENARIO_CHANGED'),
  'Scenario.operations[]': trace,
  'Scenario.retainedBehaviors[]': trace,

  'Constraint.id': keyField,
  'Constraint.rule': knowledge,
  'Constraint.appliesTo[]': knowledge,
  'Constraint.source[]': knowledgeNote,
  'Constraint.basis': knowledgeNote,
  'Constraint.hard': knowledge,
  'Constraint.verification': knowledge,
  'Constraint.exceptionPolicy': knowledge,
  'Observation.id': keyField,
  'Observation.claim': knowledge,
  'Observation.about[]': knowledge,
  'Observation.source': knowledgeNote,
  'Observation.vantage': knowledgeNote,
  'Observation.environment': knowledgeNote,
  'Observation.observedAt': knowledgeNote,
  'Observation.evidence[]': knowledgeNote,
  'Observation.limits': knowledge,
  'Assumption.id': keyField,
  'Assumption.claim': knowledge,
  'Assumption.rationale': knowledgeNote,
  'Assumption.affects[]': knowledge,
  'Assumption.consequenceIfFalse': knowledge,
  'Assumption.owner': as('ACCOUNTABLE_OWNER_CHANGED'),
  'Assumption.validation': knowledgeNote,
  'Assumption.expires': knowledgeNote,
  'Assumption.status': knowledge,
  'Assumption.resolvedBy[]': knowledgeNote,
  'Unknown.id': keyField,
  'Unknown.question': knowledge,
  'Unknown.affects[]': knowledge,
  'Unknown.concerns[]': knowledge,
  'Unknown.blocks[]': knowledge,
  'Unknown.owner': as('ACCOUNTABLE_OWNER_CHANGED'),
  'Unknown.evidenceNeeded': knowledgeNote,
  'Unknown.recommendedAction.action': knowledgeNote,
  'Unknown.recommendedAction.reversible': knowledge,
  'Unknown.resolution': knowledgeNote,
  'Unknown.status': knowledge,
  'Unknown.closure.note': knowledgeNote,
  'Unknown.closure.refs[]': knowledge,
  'Unknown.closure.evidence[]': knowledgeNote,
  'Alternative.id': keyField,
  'Alternative.description': knowledge,
  'Alternative.consequences': knowledge,
  'Alternative.rejectedBecause': knowledgeNote,
  'Decision.id': keyField,
  'Decision.revision': version,
  'Decision.question': knowledge,
  'Decision.alternatives[]': knowledge,
  'Decision.criteria[]': knowledge,
  'Decision.constraints[]': knowledge,
  'Decision.basedOn[]': knowledge,
  'Decision.chosen': knowledge,
  'Decision.tradeoffs': knowledgeNote,
  'Decision.rationale': knowledgeNote,
  'Decision.affects[]': knowledge,
  'Decision.authority': as('ACCOUNTABLE_OWNER_CHANGED'),
  'Decision.status': knowledge,
  'Decision.supersededBy': knowledge,
  'Decision.attachments[]': knowledgeNote,
  'InventoryItem.id': keyField,
  'InventoryItem.product': knowledge,
  'InventoryItem.version': knowledge,
  'InventoryItem.role': knowledge,
  'InventoryItem.capabilities[]': knowledge,
  'InventoryItem.limits[]': knowledge,
  'InventoryItem.compatibility': knowledge,
  'InventoryItem.license': knowledge,
  'InventoryItem.support': knowledge,
  'InventoryItem.source[]': knowledgeNote,
  'InventoryItem.disposition': knowledge,
  'InventoryItem.replacedBy': knowledge,
  'InventoryItem.components[]': knowledge,
  'InventoryItem.executableBaseline.status': knowledge,
  'InventoryItem.executableBaseline.evidence[]': knowledgeNote,
  'InventoryItem.executableBaseline.reason': knowledgeNote,
  'RetainedBehavior.id': keyField,
  'RetainedBehavior.description': knowledge,
  'RetainedBehavior.from': knowledge,
  'RetainedBehavior.criteria[]': trace,
  'RetainedBehavior.scenarios[]': trace,
  'RetainedBehavior.evidence[]': knowledge,
  'RetainedBehavior.status': knowledge,
  'RetainedBehavior.decision': knowledgeNote,
  'Workload.id': keyField,
  'Workload.actors[]': knowledge,
  'Workload.operations[]': knowledge,
  'Workload.latency[]': knowledge,
  'Workload.availability.objective': knowledge,
  'Workload.availability.window': knowledge,
  'Workload.dataLifecycle': knowledge,
  'Workload.failureExpectations': knowledge,
  'Workload.source[]': knowledgeNote,
  'Workload.basis': knowledgeNote,
  'Attachment.id': keyField,
  'Attachment.title': desc,
  'Attachment.source': as('ATTACHMENT_CHANGED'),
  'Attachment.digest': as('ATTACHMENT_CHANGED'),
  'Attachment.explains[]': as('ATTACHMENT_CHANGED'),
  'Attachment.reviewedAgainst[]': as('ATTACHMENT_CHANGED'),

  'FieldMapping.from': mapping,
  'FieldMapping.to': keyField,
  'FieldMapping.transform': mapping,
  'FieldMapping.conversion.lossy': mapping,
  'FieldMapping.conversion.rounding': mapping,
  'FieldMapping.conversion.note': desc,
  'FieldMapping.value': mapping,
  'FieldMapping.validation': mapping,
  'FieldMapping.exposure.decision': mapping,
  'Mapping.id': keyField,
  'Mapping.from': mapping,
  'Mapping.to': mapping,
  'Mapping.owner': as('OWNER_CHANGED'),
  'Mapping.fields[]': mapping,
  'Mapping.unmapped[]': mapping,
  'Mapping.unmapped[].side': keyField,
  'Mapping.unmapped[].property': keyField,
  'Mapping.unmapped[].reason': desc,

  'SqlType.name': storageColumn,
  'SqlType.length': storageColumn,
  'SqlType.precision': storageColumn,
  'SqlType.scale': storageColumn,
  'StorageColumn.name': keyField,
  'StorageColumn.property': storageColumn,
  'StorageColumn.nullable': storageColumn,
  'StorageColumn.collation': storageColumn,
  'StorageColumn.default.literal': storageColumn,
  'StorageColumn.default.function': storageColumn,
  'StorageColumn.identity': storageColumn,
  'Storage.id': keyField,
  'Storage.type': storageTable,
  'Storage.owner': storageTable,
  'Storage.platform': storageTable,
  'Storage.schema': storageTable,
  'Storage.table': storageTable,
  'Storage.columns[]': storageColumns,
  'Storage.primaryKey[]': as('STORAGE_KEY_CHANGED'),
  'Storage.unique[]': constraint,
  'Storage.unique[].name': keyField,
  'Storage.unique[].columns[]': constraint,
  'Storage.foreignKeys[]': constraint,
  'Storage.foreignKeys[].name': keyField,
  'Storage.foreignKeys[].columns[]': constraint,
  'Storage.foreignKeys[].references': constraint,
  'Storage.foreignKeys[].referencedColumns[]': constraint,
  'Storage.foreignKeys[].onDelete': constraint,
  'Storage.checks[]': constraint,
  'Storage.checks[].name': keyField,
  'Storage.checks[].predicate': constraint,
  'Storage.indexes[]': cls((d) => {
    const ix = (d.after ?? d.before) as { unique: boolean };
    return ix.unique ? { rule: d.event === 'removed' ? 'STORAGE_CONSTRAINT_REMOVED' : 'STORAGE_CONSTRAINT_ADDED', kind: d.event === 'removed' ? 'compatible' : 'breaking', dimension: 'storage' } : { rule: 'STORAGE_INDEX_CHANGED', kind: 'compatible', dimension: 'storage' };
  }),
  'Storage.indexes[].name': keyField,
  'Storage.indexes[].columns[]': as('STORAGE_INDEX_CHANGED'),
  'Storage.indexes[].unique': constraint,
  'Storage.notApplicable[]': notApplicable,

  'VersionSupport.old': migration,
  'VersionSupport.new': migration,
  'Migration.id': keyField,
  'Migration.contract': migration,
  'Migration.fromVersion': migration,
  'Migration.toVersion': migration,
  'Migration.dependsOn[]': migration,
  'Migration.script': migration,
  'Migration.backfill': migration,
  'Migration.transformation': migration,
  'Migration.transaction': migration,
  'Migration.locking': migration,
  'Migration.recovery': migration,
  'Migration.deploymentOrder[]': migration,
  'Migration.evidence[]': migration,

  'DeploymentUnit.id': keyField,
  'DeploymentUnit.components[]': deployment,
  'DeploymentUnit.host': deployment,
  'DeploymentUnit.trustBoundary': deployment,
  'DeploymentUnit.instances.min': deployment,
  'DeploymentUnit.instances.max': deployment,
  'DeploymentUnit.invocation.trigger': deployment,
  'DeploymentUnit.invocation.schedule': deployment,
  'DeploymentUnit.lifetime': deployment,
  'DeploymentUnit.timeout': deployment,
  'DeploymentUnit.concurrency.model': deployment,
  'DeploymentUnit.concurrency.max': deployment,
  'DeploymentUnit.identity.kind': deployment,
  'DeploymentUnit.identity.name': deployment,
  'DeploymentUnit.ingress[]': deployment,
  'DeploymentUnit.egress[]': deployment,
  'DeploymentUnit.configuration[]': deployment,
  'DeploymentUnit.configuration[].name': keyField,
  'DeploymentUnit.configuration[].kind': deployment,
  'DeploymentUnit.configuration[].description': desc,
  'DeploymentUnit.isolation': deploymentNote,
  'DeploymentUnit.decision': deploymentNote,
  'DeploymentUnit.notApplicable[]': notApplicable,
  'Host.id': keyField,
  'Host.kind': deployment,
  'Host.inventory': deploymentNote,
  'Host.capabilities.triggers[]': deployment,
  'Host.capabilities.maxTimeout': deployment,
  'Host.capabilities.maxConcurrency': deployment,
  'Host.capabilities.scaling': deployment,
  'Host.capabilities.state': deployment,
  'Host.capabilities.identities[]': deployment,
  'Host.limits[]': deployment,
  'TrustBoundary.id': keyField,
  'TrustBoundary.kind': fixed('DEPLOYMENT_CHANGED', 'breaking', 'security'),
  'TrustBoundary.description': deploymentNote,

  'ConsumerBinding.id': keyField,
  'ConsumerBinding.consumer': as('CONSUMER_BINDING_CHANGED'),
  'ConsumerBinding.contract': as('CONSUMER_BINDING_CHANGED'),
  'ConsumerBinding.version': as('CONSUMER_BINDING_CHANGED'),
  'ConsumerBinding.compatibility': as('CONSUMER_BINDING_CHANGED'),
  'ConsumerBinding.required': as('CONSUMER_BINDING_CHANGED'),
  'ConsumerBinding.status': as('CONSUMER_BINDING_CHANGED'),
  'PublishedContractRef.id': keyField,
  'PublishedContractRef.publisher': as('PUBLISHED_CONTRACT_PIN_CHANGED'),
  'PublishedContractRef.contract': as('PUBLISHED_CONTRACT_PIN_CHANGED'),
  'PublishedContractRef.version': as('PUBLISHED_CONTRACT_PIN_CHANGED'),
  'PublishedContractRef.digest': as('PUBLISHED_CONTRACT_PIN_CHANGED'),
  'PublishedContractRef.schemaVersion': as('PUBLISHED_CONTRACT_PIN_CHANGED'),
  'PublishedContractRef.consumers[]': as('PUBLISHED_CONTRACT_CONSUMERS_CHANGED'),

  'Agreement.id': keyField,
  'Agreement.kind': as('AGREEMENT_CHANGED'),
  'Agreement.constraint': as('AGREEMENT_CHANGED'),
  'Agreement.providers[]': as('AGREEMENT_CHANGED'),
  'Agreement.consumers[]': as('AGREEMENT_CHANGED'),
  'Agreement.owner': as('ACCOUNTABLE_OWNER_CHANGED'),
};
