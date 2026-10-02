import type { Severity } from './types.js';

/**
 * Stable finding codes for every rule the engine enforces: structural, semantic
 * (validate), and the mutation gate (mutate). Callers match on these, never on
 * message text, so a code is never renamed once published.
 */
export const FINDING = {
  STRUCTURAL_INVALID: 'STRUCTURAL_INVALID',
  DUPLICATE_ID: 'DUPLICATE_ID',
  DANGLING_REF: 'DANGLING_REF',
  TABLE_COMPONENT_UNKNOWN: 'TABLE_COMPONENT_UNKNOWN',
  TYPE_STATE_PROPERTY_INVALID: 'TYPE_STATE_PROPERTY_INVALID',
  TYPE_TABLE_NONOWNER: 'TYPE_TABLE_NONOWNER',
  TYPE_TABLE_DUPLICATE: 'TYPE_TABLE_DUPLICATE',
  TYPE_TABLE_WITHOUT_KEY: 'TYPE_TABLE_WITHOUT_KEY',
  TYPE_KEY_INVALID: 'TYPE_KEY_INVALID',
  TYPE_KEY_WIDE: 'TYPE_KEY_WIDE',
  BOUNDS_KIND_MISMATCH: 'BOUNDS_KIND_MISMATCH',
  ENUM_WITHOUT_VALUES: 'ENUM_WITHOUT_VALUES',
  ENUM_PARAM_UNBOUND: 'ENUM_PARAM_UNBOUND',
  MUTATION_NONOWNER: 'MUTATION_NONOWNER',
  MUTATION_NO_STATE_PROPERTY: 'MUTATION_NO_STATE_PROPERTY',
  MUTATION_ILLEGAL_STATE: 'MUTATION_ILLEGAL_STATE',
  MUTATION_WRITE_UNKNOWN_PROPERTY: 'MUTATION_WRITE_UNKNOWN_PROPERTY',
  MUTATION_IMMUTABLE_WRITE: 'MUTATION_IMMUTABLE_WRITE',
  MUTATION_CREATION_MISSING_REQUIRED: 'MUTATION_CREATION_MISSING_REQUIRED',
  MUTATION_NO_REQUIREMENT: 'MUTATION_NO_REQUIREMENT',
  MUTATION_NO_SCENARIO: 'MUTATION_NO_SCENARIO',
  MUTATION_TRACEABILITY_UNCOVERED: 'MUTATION_TRACEABILITY_UNCOVERED',
  ROUTINE_NONOWNER_TABLE_WRITE: 'ROUTINE_NONOWNER_TABLE_WRITE',
  ROUTINE_MUTATION_OWNER_MISMATCH: 'ROUTINE_MUTATION_OWNER_MISMATCH',
  ROUTINE_EMPTY_RESULTSET: 'ROUTINE_EMPTY_RESULTSET',
  ROUTINE_DUPLICATE_COLUMN: 'ROUTINE_DUPLICATE_COLUMN',
  ROUTINE_WRITE_SET_INCOMPLETE: 'ROUTINE_WRITE_SET_INCOMPLETE',
  ROUTINE_WRITES_UNKNOWN_COLUMN: 'ROUTINE_WRITES_UNKNOWN_COLUMN',
  ROUTINE_SOURCE_NOT_RELATIVE: 'ROUTINE_SOURCE_NOT_RELATIVE',
  BINDING_KIND_MISMATCH: 'BINDING_KIND_MISMATCH',
  BINDING_NULLABILITY_MISMATCH: 'BINDING_NULLABILITY_MISMATCH',
  BINDING_NOT_KEY: 'BINDING_NOT_KEY',
  BINDING_SQL_TYPE_MISMATCH: 'BINDING_SQL_TYPE_MISMATCH',
  WORKFLOW_DEPENDENCY_CYCLE: 'WORKFLOW_DEPENDENCY_CYCLE',
  WORKFLOW_IMPORT_VERSION_MISMATCH: 'WORKFLOW_IMPORT_VERSION_MISMATCH',
  BREAKING_CHANGE_WITHOUT_VERSION_BUMP: 'BREAKING_CHANGE_WITHOUT_VERSION_BUMP',
  BREAKING_CHANGE_UNACKNOWLEDGED: 'BREAKING_CHANGE_UNACKNOWLEDGED',
  PATCH_TARGET_NOT_FOUND: 'PATCH_TARGET_NOT_FOUND',
  PATCH_INVALID: 'PATCH_INVALID',
} as const;

export type FindingCode = (typeof FINDING)[keyof typeof FINDING];

export interface FindingRule {
  /** The severity every finding with this code carries; validate() and mutate() read it from here. */
  severity: Severity;
  /** The rule in one line, as the `reference` projection lists it. */
  rule: string;
}

/**
 * The rule behind each finding code: the single home of its severity and its
 * one-line description. Keyed by FindingCode, so a code without a rule, or a
 * rule for no code, does not compile; selfTest() checks the same at run time.
 */
export const FINDING_RULES: Readonly<Record<FindingCode, FindingRule>> = {
  STRUCTURAL_INVALID: {
    severity: 'error',
    rule: 'The model does not match the structural meta-schema (meta-schema.ts, via Ajv): a missing, extra or mistyped field. It runs first; the semantic rules run only on a model that passes it.',
  },
  DUPLICATE_ID: {
    severity: 'error',
    rule: 'An id is declared more than once; ids are unique across components, types, operations, routines, mutations, workflows, requirements and scenarios.',
  },
  DANGLING_REF: {
    severity: 'error',
    rule: "A reference names no existing element: an owner; an operation's request, response or result type; a routine's mutation; a mutation's type, requirement or scenario; a workflow's dependency, import, operation, mutation or requirement; a scenario's requirement; an edge endpoint; or the type or property a binding names.",
  },
  TABLE_COMPONENT_UNKNOWN: {
    severity: 'error',
    rule: "A schema-qualified table '<component>.<table>' (a type's table or a routine's writesTables entry) names an unknown component; an unqualified table belongs to the declaring element's owner.",
  },
  TYPE_STATE_PROPERTY_INVALID: {
    severity: 'error',
    rule: "A type's stateProperty does not name an enum property with at least one enumValue.",
  },
  TYPE_TABLE_NONOWNER: {
    severity: 'error',
    rule: "A type's table is qualified by a component other than the type's owner.",
  },
  TYPE_TABLE_DUPLICATE: {
    severity: 'error',
    rule: 'Two types bind the same table.',
  },
  TYPE_TABLE_WITHOUT_KEY: {
    severity: 'error',
    rule: 'A table-backed type declares no key.',
  },
  TYPE_KEY_INVALID: {
    severity: 'error',
    rule: 'A key lists a property twice, names a property the type lacks, or names one that is optional or nullable. A table-backed key must also be a valid SQL Server primary key: every string key property needs a maxLength of at most 4,000, because an NVARCHAR(MAX) column cannot be an index key column, and the key holds at most 32 columns.',
  },
  TYPE_KEY_WIDE: {
    severity: 'warning',
    rule: 'A table-backed key declares more than 900 bytes. SQL Server accepts it but rejects writes whose key data exceeds 900 bytes (Microsoft Learn, Maximum capacity specifications for SQL Server, Database Engine objects).',
  },
  BOUNDS_KIND_MISMATCH: {
    severity: 'error',
    rule: 'A property carries a bound its kind does not take: minLength and maxLength apply only to strings, min and max only to integers and numbers.',
  },
  ENUM_WITHOUT_VALUES: {
    severity: 'error',
    rule: 'An enum property lists no enumValues.',
  },
  ENUM_PARAM_UNBOUND: {
    severity: 'error',
    rule: 'A routine param or result column of kind enum binds no enum property, so its values are unknown.',
  },
  MUTATION_NONOWNER: {
    severity: 'error',
    rule: "A mutation's owner is not the owner of its type.",
  },
  MUTATION_NO_STATE_PROPERTY: {
    severity: 'error',
    rule: 'A mutation targets a type that declares no stateProperty.',
  },
  MUTATION_ILLEGAL_STATE: {
    severity: 'error',
    rule: "A mutation's from or to state is not a value of its type's stateProperty enum; '$absent' in from marks a creation.",
  },
  MUTATION_WRITE_UNKNOWN_PROPERTY: {
    severity: 'error',
    rule: 'A mutation writes a property its type lacks.',
  },
  MUTATION_IMMUTABLE_WRITE: {
    severity: 'error',
    rule: "A mutation writes an immutable property outside creation (its from does not include '$absent').",
  },
  MUTATION_CREATION_MISSING_REQUIRED: {
    severity: 'error',
    rule: "A creation mutation (from includes '$absent') does not write every required property.",
  },
  MUTATION_NO_REQUIREMENT: {
    severity: 'error',
    rule: 'A mutation traces to no requirement.',
  },
  MUTATION_NO_SCENARIO: {
    severity: 'error',
    rule: 'A mutation traces to no scenario.',
  },
  MUTATION_TRACEABILITY_UNCOVERED: {
    severity: 'error',
    rule: "No scenario of a mutation covers one of the mutation's requirements.",
  },
  ROUTINE_NONOWNER_TABLE_WRITE: {
    severity: 'error',
    rule: 'A routine lists in writesTables a table owned by another component.',
  },
  ROUTINE_MUTATION_OWNER_MISMATCH: {
    severity: 'error',
    rule: 'A routine performs a mutation owned by another component.',
  },
  ROUTINE_EMPTY_RESULTSET: {
    severity: 'error',
    rule: 'A routine declares an empty result set.',
  },
  ROUTINE_DUPLICATE_COLUMN: {
    severity: 'error',
    rule: "A routine's result set names a column twice.",
  },
  ROUTINE_WRITE_SET_INCOMPLETE: {
    severity: 'error',
    rule: 'A routine performs a mutation on a table-backed type without listing that table in writesTables.',
  },
  ROUTINE_WRITES_UNKNOWN_COLUMN: {
    severity: 'error',
    rule: "A routine's writesColumns entry '<table>.<column>' names no known table, a table outside its writesTables, a table no type is bound to, or a column the bound type lacks.",
  },
  ROUTINE_SOURCE_NOT_RELATIVE: {
    severity: 'error',
    rule: "A routine's source is not repository-relative: it starts with a slash or backslash, or carries a drive letter.",
  },
  BINDING_KIND_MISMATCH: {
    severity: 'error',
    rule: "A routine param, a result column or a property's binds differs in kind from the property it binds; kinds must match exactly.",
  },
  BINDING_NULLABILITY_MISMATCH: {
    severity: 'error',
    rule: 'A routine param or result column differs in nullability from the property it binds. A property may be nullable while the key it binds is not: that is an optional reference.',
  },
  BINDING_NOT_KEY: {
    severity: 'error',
    rule: "A property's binds names something other than the whole key of a type, possibly its own: a non-key property, a composite key or a type with no key. A property is one column, so it may reference only a single-property key.",
  },
  BINDING_SQL_TYPE_MISMATCH: {
    severity: 'error',
    rule: "A property's binds between two table-backed types projects to a different SQL column type or length than the key it references; a foreign key column must match the data type and size of that key (Microsoft Learn, Modify Foreign Key Relationships, Limitations and Restrictions).",
  },
  WORKFLOW_DEPENDENCY_CYCLE: {
    severity: 'error',
    rule: 'Workflow dependsOn links form a cycle; the dependency graph must be acyclic.',
  },
  WORKFLOW_IMPORT_VERSION_MISMATCH: {
    severity: 'error',
    rule: "A workflow pins an imported type at a version other than the type's current one. It is an error, so a version bump must carry its pinned workflows in the same change.",
  },
  BREAKING_CHANGE_WITHOUT_VERSION_BUMP: {
    severity: 'error',
    rule: 'mutate(): a type, operation or routine with a breaking change does not carry a higher version.',
  },
  BREAKING_CHANGE_UNACKNOWLEDGED: {
    severity: 'error',
    rule: 'mutate(): an element with a breaking change is not listed in acknowledgeBreaking.',
  },
  PATCH_TARGET_NOT_FOUND: {
    severity: 'error',
    rule: 'mutate(): a patch names a type, property, operation, routine, mutation, workflow, workflow import or record that does not exist; the whole batch is refused.',
  },
  PATCH_INVALID: {
    severity: 'error',
    rule: "mutate(): a patch is malformed (not an object, an unknown op, a 'set' that is not an object or names a field the op may not set, an unknown version target or collection) or the batch is empty; the whole batch is refused.",
  },
};
