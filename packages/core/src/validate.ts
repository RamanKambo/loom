import type { Model, Finding, Scenario, Kind, TypeDef, Bounds, Property } from './types.js';
import { ABSENT_STATE } from './types.js';
import { FINDING } from './codes.js';
import { makeConsumerResolver, allElementIds } from './reachability.js';
import { resolveBinding, tableOwner, qualifyTable } from './refs.js';
import { structuralFindings } from './load.js';
import {
  keyColumnBytes,
  sqlColumnType,
  NVARCHAR_MAX_LENGTH,
  PRIMARY_KEY_MAX_BYTES,
  PRIMARY_KEY_MAX_COLUMNS,
} from './sql-types.js';

export { FINDING } from './codes.js';

/** The bounds a property of `kind` may not carry: length bounds belong to strings, numeric bounds to integers and numbers. */
function misplacedBounds(kind: Kind, b: Bounds | undefined): string[] {
  if (!b) return [];
  const out: string[] = [];
  if (kind !== 'string') {
    if (b.minLength !== undefined) out.push('minLength');
    if (b.maxLength !== undefined) out.push('maxLength');
  }
  if (kind !== 'integer' && kind !== 'number') {
    if (b.min !== undefined) out.push('min');
    if (b.max !== undefined) out.push('max');
  }
  return out;
}

/**
 * The edit that makes a referencing property project to the same SQL column
 * type as the key it references; with equal kinds only string lengths and
 * enum value lengths can differ.
 */
function sqlTypeFix(p: Property, key: Property, keyRef: string, keyType: string): string {
  const length = /^NVARCHAR\((\d+)\)$/.exec(keyType)?.[1];
  if (p.kind === 'string' && length !== undefined) return `set property '${p.name}' maxLength to ${length}`;
  if (p.kind === 'string') return `set the same maxLength, at most ${NVARCHAR_MAX_LENGTH}, on property '${p.name}' and on '${keyRef}'`;
  if (p.kind === 'enum') return `set property '${p.name}' enumValues to those of '${keyRef}' (${(key.enumValues ?? []).join(', ')})`;
  return `make property '${p.name}' project to ${keyType}`;
}

function detectWorkflowCycles(model: Model): string[][] {
  const ids = new Set(model.workflows.map((w) => w.id));
  const adj = new Map<string, string[]>();
  for (const w of model.workflows) {
    adj.set(
      w.id,
      w.dependsOn.filter((d) => ids.has(d)),
    );
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cyclesByKey = new Map<string, string[]>();

  const visit = (u: string): void => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === WHITE) {
        visit(v);
      } else if (c === GRAY) {
        const idx = stack.indexOf(v);
        const cycle = stack.slice(idx).concat(v);
        const key = [...cycle].sort().join('|');
        if (!cyclesByKey.has(key)) cyclesByKey.set(key, cycle);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };

  for (const w of model.workflows) {
    if ((color.get(w.id) ?? WHITE) === WHITE) visit(w.id);
  }
  return [...cyclesByKey.values()];
}

const nullability = (nullable: boolean): string => (nullable ? 'nullable' : 'non-nullable');

/**
 * Run every rule and return the findings. The structural meta-schema runs first;
 * if it fails, only those findings are returned, because the semantic passes
 * assume the documented shape. Pure and total: it never throws — unresolved ids
 * surface as findings. A model is valid iff no finding has severity 'error'.
 */
export function validate(model: Model): Finding[] {
  const structural = structuralFindings(model);
  if (structural.length > 0) return structural;

  const findings: Finding[] = [];
  const consumersOf = makeConsumerResolver(model);
  const error = (
    code: string,
    path: string,
    message: string,
    impactOf: string[],
    fix: string,
  ): void => {
    findings.push({ code, severity: 'error', path, message, impact: consumersOf(impactOf), fix });
  };
  const warning = (code: string, path: string, message: string, impactOf: string[], fix: string): void => {
    findings.push({ code, severity: 'warning', path, message, impact: consumersOf(impactOf), fix });
  };

  const componentIds = new Set(model.components.map((c) => c.id));
  const typeById = new Map(model.types.map((t) => [t.id, t]));
  const typeIds = model.types.map((t) => t.id);
  const operationIds = new Set(model.operations.map((o) => o.id));
  const mutationById = new Map(model.mutations.map((m) => [m.id, m]));
  const workflowIds = new Set(model.workflows.map((w) => w.id));
  const requirementIds = new Set(model.requirements.map((r) => r.id));
  const scenarioById = new Map<string, Scenario>(model.scenarios.map((s) => [s.id, s]));
  const everyId = allElementIds(model);

  // --- id uniqueness across all records ---
  const idPaths = new Map<string, string[]>();
  const register = (id: string, path: string): void => {
    const arr = idPaths.get(id);
    if (arr) arr.push(path);
    else idPaths.set(id, [path]);
  };
  model.components.forEach((c, i) => register(c.id, `components[${i}]`));
  model.types.forEach((t, i) => register(t.id, `types[${i}]`));
  model.operations.forEach((o, i) => register(o.id, `operations[${i}]`));
  model.routines.forEach((r, i) => register(r.id, `routines[${i}]`));
  model.mutations.forEach((m, i) => register(m.id, `mutations[${i}]`));
  model.workflows.forEach((w, i) => register(w.id, `workflows[${i}]`));
  model.requirements.forEach((r, i) => register(r.id, `requirements[${i}]`));
  model.scenarios.forEach((s, i) => register(s.id, `scenarios[${i}]`));
  for (const [id, paths] of idPaths) {
    if (paths.length > 1) {
      error(
        FINDING.DUPLICATE_ID,
        paths.join(', '),
        `id '${id}' is declared ${paths.length} times; ids must be unique across all records`,
        [id],
        `rename all but one of the records declaring '${id}'`,
      );
    }
  }

  // Length bounds belong to strings, numeric bounds to integers and numbers;
  // an enum must name its values.
  const checkBounds = (t: TypeDef): void => {
    for (const p of t.properties) {
      if (p.kind === 'enum' && (!p.enumValues || p.enumValues.length === 0)) {
        error(
          FINDING.ENUM_WITHOUT_VALUES,
          `types/${t.id}/properties/${p.name}/enumValues`,
          `enum property '${t.id}.${p.name}' declares no enumValues`,
          [t.id],
          `list the allowed values of '${t.id}.${p.name}' in its enumValues`,
        );
      }
      const misplaced = misplacedBounds(p.kind, p.bounds);
      if (misplaced.length) {
        error(
          FINDING.BOUNDS_KIND_MISMATCH,
          `types/${t.id}/properties/${p.name}/bounds`,
          `property '${t.id}.${p.name}' is '${p.kind}' but declares ${misplaced.join(', ')}`,
          [t.id],
          `remove ${misplaced.join(', ')} from the bounds of '${t.id}.${p.name}'`,
        );
      }
    }
  };

  // A key names existing required, non-nullable properties. A table-backed key
  // must also be creatable as a SQL Server primary key: no NVARCHAR(MAX)
  // column and at most 32 columns; over 900 declared bytes is legal but writes
  // whose key data exceeds 900 bytes fail, so it is a warning.
  const checkKey = (t: TypeDef): void => {
    const keyPath = `types/${t.id}/key`;
    if (t.table !== undefined && (!t.key || t.key.length === 0)) {
      const hasId = t.properties.some((p) => p.name === 'id');
      error(
        FINDING.TYPE_TABLE_WITHOUT_KEY,
        keyPath,
        `type '${t.id}' binds table '${t.table}' but declares no key`,
        [t.id],
        hasId
          ? `set type '${t.id}' key to ['id']`
          : `set type '${t.id}' key to the property names that identify a row`,
      );
    }
    const byName = new Map(t.properties.map((p) => [p.name, p]));
    const seen = new Set<string>();
    let bytes = 0;
    let indexable = true;
    for (const k of t.key ?? []) {
      const p = byName.get(k);
      if (seen.has(k)) {
        error(FINDING.TYPE_KEY_INVALID, keyPath, `type '${t.id}' key lists '${k}' twice`, [t.id], `remove the duplicate '${k}' from type '${t.id}' key`);
        continue;
      }
      seen.add(k);
      if (!p) {
        error(
          FINDING.TYPE_KEY_INVALID,
          keyPath,
          `type '${t.id}' key names '${k}', which is not a property of '${t.id}'`,
          [t.id],
          `remove '${k}' from type '${t.id}' key`,
        );
        indexable = false;
        continue;
      }
      if (!p.required || p.nullable) {
        error(
          FINDING.TYPE_KEY_INVALID,
          keyPath,
          `type '${t.id}' key property '${k}' must be required and non-nullable`,
          [t.id],
          `set '${t.id}.${k}' required to true and nullable to false`,
        );
      }
      if (t.table === undefined) continue;
      const width = keyColumnBytes(p);
      if (width === null) {
        indexable = false;
        error(
          FINDING.TYPE_KEY_INVALID,
          keyPath,
          `type '${t.id}' key property '${k}' projects to NVARCHAR(MAX), which cannot be a primary key column`,
          [t.id],
          `set a maxLength of at most ${NVARCHAR_MAX_LENGTH} on '${t.id}.${k}'`,
        );
      } else {
        bytes += width;
      }
    }
    if (t.table === undefined || !t.key) return;
    if (t.key.length > PRIMARY_KEY_MAX_COLUMNS) {
      error(
        FINDING.TYPE_KEY_INVALID,
        keyPath,
        `type '${t.id}' key has ${t.key.length} columns; a primary key allows at most ${PRIMARY_KEY_MAX_COLUMNS}`,
        [t.id],
        `reduce type '${t.id}' key to at most ${PRIMARY_KEY_MAX_COLUMNS} properties`,
      );
    }
    if (indexable && bytes > PRIMARY_KEY_MAX_BYTES) {
      warning(
        FINDING.TYPE_KEY_WIDE,
        keyPath,
        `type '${t.id}' key declares ${bytes} bytes; writes whose key data exceeds ${PRIMARY_KEY_MAX_BYTES} bytes fail`,
        [t.id],
        `lower the maxLength of the string properties in type '${t.id}' key to fit ${PRIMARY_KEY_MAX_BYTES} bytes`,
      );
    }
  };

  // --- types: owner, stateProperty, table ---
  for (const t of model.types) {
    if (!componentIds.has(t.owner)) {
      error(
        FINDING.DANGLING_REF,
        `types/${t.id}/owner`,
        `type '${t.id}' owner '${t.owner}' is not a known component`,
        [t.id],
        `set type '${t.id}' owner to an existing component id`,
      );
    }
    if (t.stateProperty !== undefined) {
      const sp = t.properties.find((p) => p.name === t.stateProperty);
      if (!sp || sp.kind !== 'enum' || !sp.enumValues || sp.enumValues.length === 0) {
        error(
          FINDING.TYPE_STATE_PROPERTY_INVALID,
          `types/${t.id}/stateProperty`,
          `type '${t.id}' stateProperty '${t.stateProperty}' must name an enum property with at least one enumValue`,
          [t.id],
          `point stateProperty at an enum property of '${t.id}' that declares its states`,
        );
      }
    }
    if (t.table !== undefined) {
      const own = tableOwner(t.table, componentIds);
      if (own && !own.known) {
        error(
          FINDING.TABLE_COMPONENT_UNKNOWN,
          `types/${t.id}/table`,
          `type '${t.id}' table '${t.table}' is qualified by unknown component '${own.owner}'`,
          [t.id],
          `set type '${t.id}' table to '${t.owner}.${own.bare}'`,
        );
      } else if (own && own.owner !== t.owner) {
        error(
          FINDING.TYPE_TABLE_NONOWNER,
          `types/${t.id}/table`,
          `type '${t.id}' (owner '${t.owner}') binds table '${t.table}' owned by '${own.owner}'`,
          [t.id],
          `set type '${t.id}' table to '${t.owner}.${own.bare}'`,
        );
      }
    }
    checkBounds(t);
    checkKey(t);
  }

  // --- tables: one type per table ---
  const typeByTable = new Map<string, TypeDef>();
  for (const t of model.types) {
    if (t.table === undefined) continue;
    const qualified = qualifyTable(t.table, t.owner);
    const first = typeByTable.get(qualified);
    if (first) {
      error(
        FINDING.TYPE_TABLE_DUPLICATE,
        `types/${t.id}/table`,
        `type '${t.id}' binds table '${qualified}', which type '${first.id}' already binds`,
        [t.id, first.id],
        `give type '${t.id}' a table of its own`,
      );
    } else {
      typeByTable.set(qualified, t);
    }
  }

  // --- property bindings: a property references the whole single-property key
  // of a type, possibly its own (a foreign key). The kind must match exactly;
  // when both types are table-backed, so must the projected SQL column type,
  // because SQL Server refuses a foreign key whose columns differ in data type
  // (Msg 1778) or in length (Msg 1753). A nullable property is an optional reference.
  for (const t of model.types) {
    for (const p of t.properties) {
      if (p.binds === undefined) continue;
      const path = `types/${t.id}/properties/${p.name}/binds`;
      const label = `property '${t.id}.${p.name}'`;
      const consumerStep = `bump type '${t.id}' version and list '${t.id}' in acknowledgeBreaking`;
      const ref = resolveBinding(p.binds, typeIds);
      const target = ref ? typeById.get(ref.typeId) : undefined;
      if (!ref || !target) {
        error(
          FINDING.DANGLING_REF,
          path,
          `${label} binds '${p.binds}', which names no known type`,
          [t.id],
          `bind property '${p.name}' to the key of an existing type ('typeId.propertyName')`,
        );
        continue;
      }
      const key = target.key ?? [];
      const keyName = key.length === 1 ? key[0] : undefined;
      const rebind =
        keyName !== undefined
          ? `bind property '${p.name}' to '${target.id}.${keyName}', the key of '${target.id}'`
          : `remove binds from property '${p.name}', or give type '${target.id}' a single-property key and bind that`;
      const keyProperty = target.properties.find((x) => x.name === ref.property);
      if (!keyProperty) {
        error(
          FINDING.DANGLING_REF,
          path,
          `${label} binds '${p.binds}', but type '${target.id}' has no property '${ref.property}'`,
          [t.id],
          rebind,
        );
        continue;
      }
      if (keyName !== keyProperty.name) {
        let why: string;
        if (key.length === 0) why = `type '${target.id}' declares no key`;
        else if (key.length > 1) why = `the key of '${target.id}' is composite (${key.join(', ')})`;
        else why = `'${keyProperty.name}' is not the key of '${target.id}' (key: ${keyName ?? ''})`;
        error(
          FINDING.BINDING_NOT_KEY,
          path,
          `${label} binds '${p.binds}', but ${why}; a property is one column, so it may reference only a single-property key`,
          [t.id],
          rebind,
        );
        continue;
      }
      if (keyProperty.kind !== p.kind) {
        const drop = misplacedBounds(keyProperty.kind, p.bounds);
        const alsoDrop = drop.length ? ` and remove ${drop.join(', ')} from its bounds` : '';
        error(
          FINDING.BINDING_KIND_MISMATCH,
          path,
          `${label} is '${p.kind}' but binds '${p.binds}', which is '${keyProperty.kind}'`,
          [t.id],
          `set property '${p.name}' kind to '${keyProperty.kind}'${alsoDrop}, then ${consumerStep}`,
        );
        continue;
      }
      if (t.table === undefined || target.table === undefined) continue;
      const column = sqlColumnType(p);
      const keyColumn = sqlColumnType(keyProperty);
      if (column !== keyColumn) {
        error(
          FINDING.BINDING_SQL_TYPE_MISMATCH,
          path,
          `${label} projects to ${column} but binds '${p.binds}', which projects to ${keyColumn}; a foreign key's columns must have the same SQL type and length`,
          [t.id],
          `${sqlTypeFix(p, keyProperty, p.binds, keyColumn)}, then ${consumerStep}`,
        );
      }
    }
  }

  // --- operations: owner + request/response/result ---
  for (const o of model.operations) {
    if (!componentIds.has(o.owner)) {
      error(
        FINDING.DANGLING_REF,
        `operations/${o.id}/owner`,
        `operation '${o.id}' owner '${o.owner}' is not a known component`,
        [o.id],
        `set operation '${o.id}' owner to an existing component id`,
      );
    }
    for (const [field, ref] of [
      ['request', o.request],
      ['response', o.response],
      ['result', o.result],
    ] as const) {
      if (ref !== undefined && !typeById.has(ref)) {
        error(
          FINDING.DANGLING_REF,
          `operations/${o.id}/${field}`,
          `operation '${o.id}' ${field} references unknown type '${ref}'`,
          [o.id],
          `set operation '${o.id}' ${field} to an existing type id`,
        );
      }
    }
  }

  // --- routines ---
  const checkBinding = (
    routineId: string,
    role: 'param' | 'result column',
    name: string,
    kind: Kind,
    nullable: boolean,
    binds: string | undefined,
    path: string,
  ): void => {
    if (binds === undefined) {
      // An enum slot's values are known only through the enum property it binds.
      if (kind === 'enum') {
        error(
          FINDING.ENUM_PARAM_UNBOUND,
          path,
          `routine '${routineId}' ${role} '${name}' is an enum but binds no enum property, so its values are unknown`,
          [routineId],
          `set binds on ${role} '${name}' to the enum property ('typeId.propertyName') whose values it carries`,
        );
      }
      return;
    }
    const ref = resolveBinding(binds, typeIds);
    const t = ref ? typeById.get(ref.typeId) : undefined;
    if (!ref || !t) {
      error(
        FINDING.DANGLING_REF,
        path,
        `routine '${routineId}' ${role} '${name}' binds '${binds}', which names no known type`,
        [routineId],
        `bind ${role} '${name}' to an existing 'typeId.propertyName'`,
      );
      return;
    }
    const p = t.properties.find((x) => x.name === ref.property);
    if (!p) {
      error(
        FINDING.DANGLING_REF,
        path,
        `routine '${routineId}' ${role} '${name}' binds '${binds}', but type '${t.id}' has no property '${ref.property}'`,
        [routineId],
        `bind ${role} '${name}' to an existing property of '${t.id}': ${t.properties.map((x) => x.name).join(', ')}`,
      );
      return;
    }
    const consumerStep = `bump routine '${routineId}' version and list '${routineId}' in acknowledgeBreaking`;
    if (p.kind !== kind) {
      error(
        FINDING.BINDING_KIND_MISMATCH,
        path,
        `routine '${routineId}' ${role} '${name}' is '${kind}' but binds '${binds}', which is '${p.kind}'`,
        [routineId],
        `set ${role} '${name}' kind to '${p.kind}', then ${consumerStep}`,
      );
    }
    if (p.nullable !== nullable) {
      error(
        FINDING.BINDING_NULLABILITY_MISMATCH,
        path,
        `routine '${routineId}' ${role} '${name}' is ${nullability(nullable)} but binds '${binds}', which is ${nullability(p.nullable)}`,
        [routineId],
        `set ${role} '${name}' nullable to ${String(p.nullable)}, then ${consumerStep}`,
      );
    }
  };

  for (const r of model.routines) {
    if (!componentIds.has(r.owner)) {
      error(
        FINDING.DANGLING_REF,
        `routines/${r.id}/owner`,
        `routine '${r.id}' owner '${r.owner}' is not a known component`,
        [r.id],
        `set routine '${r.id}' owner to an existing component id`,
      );
    }
    if (r.resultSet.length === 0) {
      error(
        FINDING.ROUTINE_EMPTY_RESULTSET,
        `routines/${r.id}/resultSet`,
        `routine '${r.id}' has an empty resultSet`,
        [r.id],
        `declare at least one result column on routine '${r.id}'`,
      );
    }
    const seenCols = new Set<string>();
    for (const col of r.resultSet) {
      if (seenCols.has(col.name)) {
        error(
          FINDING.ROUTINE_DUPLICATE_COLUMN,
          `routines/${r.id}/resultSet/${col.name}`,
          `routine '${r.id}' resultSet has a duplicate column '${col.name}'`,
          [r.id],
          `rename or remove the duplicate column '${col.name}'`,
        );
      }
      seenCols.add(col.name);
    }
    for (const mid of r.performsMutations) {
      const mu = mutationById.get(mid);
      if (!mu) {
        error(
          FINDING.DANGLING_REF,
          `routines/${r.id}/performsMutations`,
          `routine '${r.id}' performsMutations references unknown mutation '${mid}'`,
          [r.id],
          `remove '${mid}' from routine '${r.id}' performsMutations or add the mutation`,
        );
      } else if (mu.owner !== r.owner) {
        error(
          FINDING.ROUTINE_MUTATION_OWNER_MISMATCH,
          `routines/${r.id}/performsMutations`,
          `routine '${r.id}' (owner '${r.owner}') performs mutation '${mid}' owned by '${mu.owner}'`,
          [r.id],
          `remove '${mid}' from routine '${r.id}' performsMutations and invoke a routine owned by '${mu.owner}'`,
        );
      }
    }
    // Table ownership: '<component>.<table>' is owned by <component>; an
    // unqualified name is owned by the routine's owner.
    for (const tbl of r.writesTables ?? []) {
      const own = tableOwner(tbl, componentIds);
      if (!own) continue;
      if (!own.known) {
        error(
          FINDING.TABLE_COMPONENT_UNKNOWN,
          `routines/${r.id}/writesTables`,
          `routine '${r.id}' writes table '${tbl}' whose owning component '${own.owner}' does not exist`,
          [r.id],
          `qualify table '${own.bare}' with an existing component id`,
        );
      } else if (own.owner !== r.owner) {
        error(
          FINDING.ROUTINE_NONOWNER_TABLE_WRITE,
          `routines/${r.id}/writesTables`,
          `routine '${r.id}' (owner '${r.owner}') writes table '${tbl}' owned by '${own.owner}'`,
          [r.id],
          `remove '${tbl}' from routine '${r.id}' writesTables and invoke a routine owned by '${own.owner}'`,
        );
      }
    }
    // Write-set completeness: performing a mutation on a table-backed type
    // writes that table, so it must be declared.
    const written = new Set((r.writesTables ?? []).map((t) => qualifyTable(t, r.owner)));
    const reported = new Set<string>();
    for (const mid of r.performsMutations) {
      const mu = mutationById.get(mid);
      const t = mu ? typeById.get(mu.type) : undefined;
      if (!mu || !t || t.table === undefined) continue;
      const need = qualifyTable(t.table, t.owner);
      if (written.has(need) || reported.has(need)) continue;
      reported.add(need);
      error(
        FINDING.ROUTINE_WRITE_SET_INCOMPLETE,
        `routines/${r.id}/writesTables`,
        `routine '${r.id}' performs mutation '${mid}' on type '${t.id}' (table '${need}') but does not list that table in writesTables`,
        [r.id],
        `add '${need}' to routine '${r.id}' writesTables`,
      );
    }

    // writesColumns entries are '<table>.<column>'. The table resolves by the
    // longest known table name (a type's table or one of this routine's
    // writesTables; an own-component table may be written unqualified).
    const candidates = new Map<string, string>();
    const addCandidate = (qualified: string): void => {
      candidates.set(qualified, qualified);
      const own = tableOwner(qualified, componentIds);
      if (own && own.owner === r.owner && !candidates.has(own.bare)) candidates.set(own.bare, qualified);
    };
    for (const qualified of typeByTable.keys()) addCandidate(qualified);
    for (const qualified of written) addCandidate(qualified);
    for (const entry of r.writesColumns ?? []) {
      let prefix: string | null = null;
      for (const c of candidates.keys()) {
        if (entry.length > c.length + 1 && entry.startsWith(`${c}.`) && (prefix === null || c.length > prefix.length)) {
          prefix = c;
        }
      }
      const path = `routines/${r.id}/writesColumns`;
      if (prefix === null) {
        error(
          FINDING.ROUTINE_WRITES_UNKNOWN_COLUMN,
          path,
          `routine '${r.id}' writes column '${entry}', which names no known table`,
          [r.id],
          `write '${entry}' as '<table>.<column>' with a table in routine '${r.id}' writesTables`,
        );
        continue;
      }
      const table = candidates.get(prefix) as string;
      const column = entry.slice(prefix.length + 1);
      const bound = typeByTable.get(table);
      if (!written.has(table)) {
        error(
          FINDING.ROUTINE_WRITES_UNKNOWN_COLUMN,
          path,
          `routine '${r.id}' writes column '${entry}', but table '${table}' is not in its writesTables`,
          [r.id],
          `add '${table}' to routine '${r.id}' writesTables`,
        );
      } else if (!bound) {
        error(
          FINDING.ROUTINE_WRITES_UNKNOWN_COLUMN,
          path,
          `routine '${r.id}' writes column '${entry}', but no type is bound to table '${table}'`,
          [r.id],
          `remove '${entry}' from routine '${r.id}' writesColumns`,
        );
      } else if (!bound.properties.some((p) => p.name === column)) {
        error(
          FINDING.ROUTINE_WRITES_UNKNOWN_COLUMN,
          path,
          `routine '${r.id}' writes column '${entry}', but type '${bound.id}' (table '${table}') has no property '${column}'`,
          [r.id],
          `write a column of '${bound.id}': ${bound.properties.map((p) => p.name).join(', ')}`,
        );
      }
    }

    if (r.source !== undefined && (/^[\\/]/.test(r.source) || r.source.includes(':'))) {
      const base = r.source.split(/[\\/]/).pop() ?? r.source;
      error(
        FINDING.ROUTINE_SOURCE_NOT_RELATIVE,
        `routines/${r.id}/source`,
        `routine '${r.id}' source '${r.source}' is absolute or carries a drive letter`,
        [r.id],
        `set routine '${r.id}' source to a repository-relative path such as '${r.owner}/${base}'`,
      );
    }

    for (const p of r.params) {
      checkBinding(r.id, 'param', p.name, p.kind, p.nullable, p.binds, `routines/${r.id}/params/${p.name}/binds`);
    }
    for (const c of r.resultSet) {
      checkBinding(r.id, 'result column', c.name, c.kind, c.nullable, c.binds, `routines/${r.id}/resultSet/${c.name}/binds`);
    }
  }

  // --- mutations: owner, states, writes, traceability ---
  for (const m of model.mutations) {
    const t = typeById.get(m.type);
    if (!t) {
      error(
        FINDING.DANGLING_REF,
        `mutations/${m.id}/type`,
        `mutation '${m.id}' references unknown type '${m.type}'`,
        [m.id],
        `set mutation '${m.id}' type to an existing type id`,
      );
    }
    if (!componentIds.has(m.owner)) {
      error(
        FINDING.DANGLING_REF,
        `mutations/${m.id}/owner`,
        `mutation '${m.id}' owner '${m.owner}' is not a known component`,
        [m.id],
        t ? `set mutation '${m.id}' owner to '${t.owner}'` : `set mutation '${m.id}' owner to an existing component id`,
      );
    }
    if (t && componentIds.has(m.owner) && m.owner !== t.owner) {
      error(
        FINDING.MUTATION_NONOWNER,
        `mutations/${m.id}/owner`,
        `mutation '${m.id}' owner '${m.owner}' must equal the owner of type '${t.id}' ('${t.owner}')`,
        [m.id],
        `move mutation '${m.id}' to component '${t.owner}' (set owner to '${t.owner}')`,
      );
    }

    if (t) {
      const byName = new Map(t.properties.map((p) => [p.name, p]));
      const isCreation = m.from.includes(ABSENT_STATE);

      if (t.stateProperty === undefined) {
        error(
          FINDING.MUTATION_NO_STATE_PROPERTY,
          `mutations/${m.id}`,
          `mutation '${m.id}' targets type '${t.id}', which declares no stateProperty`,
          [m.id],
          `declare a stateProperty on type '${t.id}'`,
        );
      } else {
        const sp = byName.get(t.stateProperty);
        const legal = sp && sp.kind === 'enum' && sp.enumValues ? sp.enumValues : [];
        const states = new Set(legal);
        const legalList = legal.join(', ');
        for (const f of m.from) {
          if (f === ABSENT_STATE) continue;
          if (!states.has(f)) {
            error(
              FINDING.MUTATION_ILLEGAL_STATE,
              `mutations/${m.id}/from`,
              `mutation '${m.id}' from-state '${f}' is not a legal state of '${t.id}.${t.stateProperty}'`,
              [m.id],
              `use a legal from-state (${legalList}) or add '${f}' to '${t.id}.${t.stateProperty}' enumValues`,
            );
          }
        }
        if (!states.has(m.to)) {
          error(
            FINDING.MUTATION_ILLEGAL_STATE,
            `mutations/${m.id}/to`,
            `mutation '${m.id}' to-state '${m.to}' is not a legal state of '${t.id}.${t.stateProperty}'`,
            [m.id],
            `use a legal to-state (${legalList}) or add '${m.to}' to '${t.id}.${t.stateProperty}' enumValues`,
          );
        }
      }

      for (const w of m.writes) {
        const p = byName.get(w);
        if (!p) {
          error(
            FINDING.MUTATION_WRITE_UNKNOWN_PROPERTY,
            `mutations/${m.id}/writes`,
            `mutation '${m.id}' writes unknown property '${w}' on type '${t.id}'`,
            [m.id],
            `remove '${w}' from mutation '${m.id}' writes`,
          );
        } else if (p.immutable && !isCreation) {
          error(
            FINDING.MUTATION_IMMUTABLE_WRITE,
            `mutations/${m.id}/writes`,
            `mutation '${m.id}' writes immutable property '${w}' outside creation (from does not include '${ABSENT_STATE}')`,
            [m.id],
            `remove '${w}' from mutation '${m.id}' writes; immutable properties are written only at creation`,
          );
        }
      }

      if (isCreation) {
        const missing = t.properties
          .filter((p) => p.required && !m.writes.includes(p.name))
          .map((p) => p.name);
        if (missing.length) {
          error(
            FINDING.MUTATION_CREATION_MISSING_REQUIRED,
            `mutations/${m.id}/writes`,
            `creation mutation '${m.id}' must write every required property of '${t.id}'; missing: ${missing.join(', ')}`,
            [m.id],
            `add ${missing.map((x) => `'${x}'`).join(', ')} to mutation '${m.id}' writes`,
          );
        }
      }
    }

    for (const rid of m.requirements) {
      if (!requirementIds.has(rid)) {
        error(
          FINDING.DANGLING_REF,
          `mutations/${m.id}/requirements`,
          `mutation '${m.id}' references unknown requirement '${rid}'`,
          [m.id],
          `remove '${rid}' from mutation '${m.id}' requirements or add the requirement`,
        );
      }
    }
    for (const sid of m.scenarios) {
      if (!scenarioById.has(sid)) {
        error(
          FINDING.DANGLING_REF,
          `mutations/${m.id}/scenarios`,
          `mutation '${m.id}' references unknown scenario '${sid}'`,
          [m.id],
          `remove '${sid}' from mutation '${m.id}' scenarios or add the scenario`,
        );
      }
    }
    if (m.requirements.length === 0) {
      error(
        FINDING.MUTATION_NO_REQUIREMENT,
        `mutations/${m.id}/requirements`,
        `mutation '${m.id}' has no requirement`,
        [m.id],
        `add the requirement mutation '${m.id}' fulfils to its requirements`,
      );
    }
    if (m.scenarios.length === 0) {
      error(
        FINDING.MUTATION_NO_SCENARIO,
        `mutations/${m.id}/scenarios`,
        `mutation '${m.id}' has no scenario`,
        [m.id],
        `add a scenario that exercises mutation '${m.id}' to its scenarios`,
      );
    }
    if (m.requirements.length > 0 && m.scenarios.length > 0) {
      const covered = m.scenarios.some((sid) => {
        const s = scenarioById.get(sid);
        return s ? s.requirements.some((r) => m.requirements.includes(r)) : false;
      });
      if (!covered) {
        error(
          FINDING.MUTATION_TRACEABILITY_UNCOVERED,
          `mutations/${m.id}`,
          `mutation '${m.id}' has requirements and scenarios, but no scenario covers any of its requirements`,
          [m.id],
          `list one of ${m.requirements.map((x) => `'${x}'`).join(', ')} on a scenario of mutation '${m.id}'`,
        );
      }
    }
  }

  // --- scenarios: requirement references ---
  for (const s of model.scenarios) {
    for (const rid of s.requirements) {
      if (!requirementIds.has(rid)) {
        error(
          FINDING.DANGLING_REF,
          `scenarios/${s.id}/requirements`,
          `scenario '${s.id}' references unknown requirement '${rid}'`,
          [s.id],
          `remove '${rid}' from scenario '${s.id}' requirements or add the requirement`,
        );
      }
    }
  }

  // --- workflows: references, import versions, dependency cycles ---
  for (const w of model.workflows) {
    for (const d of w.dependsOn) {
      if (!workflowIds.has(d)) {
        error(
          FINDING.DANGLING_REF,
          `workflows/${w.id}/dependsOn`,
          `workflow '${w.id}' depends on unknown workflow '${d}'`,
          [w.id],
          `remove '${d}' from workflow '${w.id}' dependsOn or add the workflow`,
        );
      }
    }
    for (const im of w.imports) {
      const t = typeById.get(im.typeId);
      if (!t) {
        error(
          FINDING.DANGLING_REF,
          `workflows/${w.id}/imports`,
          `workflow '${w.id}' imports unknown type '${im.typeId}'`,
          [w.id],
          `remove the import of '${im.typeId}' from workflow '${w.id}' or add the type`,
        );
      } else if (t.version !== im.version) {
        // An error, not a warning: a version bump must carry its pinned
        // consumers in the same change.
        error(
          FINDING.WORKFLOW_IMPORT_VERSION_MISMATCH,
          `workflows/${w.id}/imports/${im.typeId}`,
          `workflow '${w.id}' pins type '${im.typeId}' at version ${im.version}, but the type is at version ${t.version}`,
          [w.id],
          `set workflow '${w.id}' import of '${im.typeId}' to version ${t.version} in the same change`,
        );
      }
    }
    for (const op of w.operations ?? []) {
      if (!operationIds.has(op)) {
        error(
          FINDING.DANGLING_REF,
          `workflows/${w.id}/operations`,
          `workflow '${w.id}' references unknown operation '${op}'`,
          [w.id],
          `remove '${op}' from workflow '${w.id}' operations or add the operation`,
        );
      }
    }
    for (const mu of w.mutations ?? []) {
      if (!mutationById.has(mu)) {
        error(
          FINDING.DANGLING_REF,
          `workflows/${w.id}/mutations`,
          `workflow '${w.id}' references unknown mutation '${mu}'`,
          [w.id],
          `remove '${mu}' from workflow '${w.id}' mutations or add the mutation`,
        );
      }
    }
    for (const rid of w.requirements) {
      if (!requirementIds.has(rid)) {
        error(
          FINDING.DANGLING_REF,
          `workflows/${w.id}/requirements`,
          `workflow '${w.id}' references unknown requirement '${rid}'`,
          [w.id],
          `remove '${rid}' from workflow '${w.id}' requirements or add the requirement`,
        );
      }
    }
  }
  for (const cycle of detectWorkflowCycles(model)) {
    error(
      FINDING.WORKFLOW_DEPENDENCY_CYCLE,
      `workflows: ${cycle.join(' -> ')}`,
      `workflow dependency cycle detected: ${cycle.join(' -> ')}`,
      cycle,
      `remove one dependsOn link in ${cycle.join(' -> ')} to break the cycle`,
    );
  }

  // --- edges: endpoints must resolve to real elements ---
  model.edges.forEach((e, i) => {
    if (!everyId.has(e.from)) {
      error(
        FINDING.DANGLING_REF,
        `edges[${i}]/from`,
        `edge from '${e.from}' does not resolve to any element`,
        [],
        `point edges[${i}] from at an existing element id or remove the edge`,
      );
    }
    if (!everyId.has(e.to)) {
      error(
        FINDING.DANGLING_REF,
        `edges[${i}]/to`,
        `edge to '${e.to}' does not resolve to any element`,
        [],
        `point edges[${i}] to at an existing element id or remove the edge`,
      );
    }
  });

  return findings;
}
