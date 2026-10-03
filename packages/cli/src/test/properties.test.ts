import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  COLLECTIONS,
  KEYED_ARRAYS,
  LoomInvalidModelError,
  PATCH_VARIANTS,
  PROJECTION_TARGETS,
  REFERENCE_FIELDS,
  canonicalJson,
  collectReferences,
  deepClone,
  FIELD_POLICY,
  diff,
  exportModel,
  exportYaml,
  importModel,
  indexModel,
  keyOf,
  modelRevision,
  mutate,
  needsAcknowledgement,
  recordKey,
  renderTarget,
  resolveReference,
  sampleModel,
  validate,
} from '@loom/core';
import type { ChangeKind, CollectionName, Delta, DiffRuleId, Dimension, FieldPolicy, Model, Patch, ProjectionTarget, RecordRef } from '@loom/core';

/** A fixed seed, so every run explores the same inputs and a failure reproduces exactly. */
const SEED = 20261003;
const RUNS = 40;
const options = { seed: SEED, numRuns: RUNS };

type Rec = Record<string, unknown>;
const recordsOf = (m: Model, collection: string): Rec[] => (m as unknown as Record<string, Rec[] | undefined>)[collection] ?? [];
const idKeyed = new Set(COLLECTIONS.filter((c) => c.key.length === 1 && c.key[0] === 'id').map((c) => c.collection));
const referencePaths = new Set<string>(REFERENCE_FIELDS.map((f) => f.path));
const keyAt = (path: string): readonly string[] => KEYED_ARRAYS.find((k) => k.path === path)?.key ?? ['id'];
const errorsOf = (fs: ReturnType<typeof validate>): string[] => fs.filter((f) => f.severity === 'error').map((f) => f.code);

/** One generation step: the patch variant, the record and item it targets, a position and a suffix for new keys and text. */
interface Choice {
  variant: number;
  record: number;
  item: number;
  index: number;
  suffix: number;
}
const choiceArb: fc.Arbitrary<Choice> = fc.record({ variant: fc.nat(PATCH_VARIANTS.length - 1), record: fc.nat(40), item: fc.nat(40), index: fc.nat(12), suffix: fc.nat(999) });

/** A string member that is neither a key nor a reference, so editing it changes data and nothing it points to. */
function textMember(path: string, value: Rec, key: readonly string[], pick: number): string | undefined {
  const names = Object.keys(value)
    .filter((k) => typeof value[k] === 'string' && !key.includes(k) && !referencePaths.has(`${path}.${k}`))
    .sort();
  return names.length ? names[pick % names.length] : undefined;
}

/** A new key value for a copy; odd suffixes give dotted ids, which share the original id as a prefix. */
const freshKey = (old: unknown, suffix: number): string => `${String(old)}${suffix % 2 ? '.' : '-'}g${suffix}`;

/** The patch a choice makes of the generated patch variants against the current model, or null when it has no target there. */
function patchFor(m: Model, c: Choice): Patch | null {
  const v = PATCH_VARIANTS[c.variant]!;
  if (v.op === 'clearSystemProfile') return { op: 'clearSystemProfile' } as Patch;
  if (v.op === 'setSystemProfile') {
    const kinds = ['library', 'cli', 'powershell-tool', 'application', 'service', 'distributed-system'] as const;
    return { op: 'setSystemProfile', profile: { kind: kinds[c.index % kinds.length]!, traits: [...(m.systemProfile?.traits ?? [])] } } as Patch;
  }
  const collection = v.collection as CollectionName;
  const list = recordsOf(m, collection);
  if (!list.length) return null;
  const r = list[c.record % list.length]!;
  const key = COLLECTIONS.find((x) => x.collection === collection)!.key;
  const id = recordKey(collection, r);
  const path = `${collection}[]`;
  const text = (value: Rec, at: string, k: readonly string[]): Rec | null => {
    const member = textMember(at, value, k, c.index);
    return member ? { [member]: `${String(value[member])} g${c.suffix}` } : null;
  };
  switch (v.op) {
    case 'add':
      return idKeyed.has(collection) ? ({ op: 'add', collection, record: { ...deepClone(r), id: freshKey(r['id'], c.suffix) } } as unknown as Patch) : null;
    case 'replace': {
      const record = deepClone(r);
      Object.assign(record, text(record, path, key) ?? {});
      return { op: 'replace', collection, id, record } as unknown as Patch;
    }
    case 'remove':
      return { op: 'remove', collection, id } as unknown as Patch;
    case 'update': {
      const set = text(r, path, key);
      return set ? ({ op: 'update', collection, id, set } as unknown as Patch) : null;
    }
    case 'rename':
      return idKeyed.has(collection) ? ({ op: 'rename', collection, id, to: freshKey(id, c.suffix) } as unknown as Patch) : null;
    default:
      break;
  }
  const field = v.field as string;
  const itemPath = `${collection}[].${field}[]`;
  const itemKey = keyAt(itemPath);
  const items = (r[field] as Rec[] | undefined) ?? [];
  if (!items.length || typeof items[0] !== 'object') return null;
  const item = items[c.item % items.length]!;
  const k = keyOf(item, itemKey);
  switch (v.op) {
    case 'addItem': {
      if (itemKey.length !== 1 || typeof item[itemKey[0]!] !== 'string') return null;
      return { op: 'addItem', collection, id, field, item: { ...deepClone(item), [itemKey[0]!]: freshKey(item[itemKey[0]!], c.suffix) } } as unknown as Patch;
    }
    case 'replaceItem': {
      const next = deepClone(item);
      Object.assign(next, text(next, itemPath, itemKey) ?? {});
      return { op: 'replaceItem', collection, id, field, key: k, item: next } as unknown as Patch;
    }
    case 'removeItem':
      return { op: 'removeItem', collection, id, field, key: k } as unknown as Patch;
    case 'moveItem':
      return { op: 'moveItem', collection, id, field, key: k, index: c.index % items.length } as unknown as Patch;
    case 'updateItem': {
      const set = text(item, itemPath, itemKey);
      return set ? ({ op: 'updateItem', collection, id, field, key: k, set } as unknown as Patch) : null;
    }
    default:
      return null;
  }
}

/** A record addition that refers to a property of some type, so renames have property references to follow. */
function unknownNaming(m: Model, pick: number, suffix: number): Patch | null {
  const types = m.types.filter((t) => t.properties.length > 0);
  if (!types.length || !m.components.length) return null;
  const t = types[pick % types.length]!;
  const p = t.properties[suffix % t.properties.length]!;
  return {
    op: 'add',
    collection: 'unknowns',
    record: {
      id: `unk.generated-${suffix}`,
      question: `What does ${p.name} hold?`,
      affects: [{ kind: 'property', id: `${t.id}.${p.name}` }],
      blocks: ['release'],
      owner: 'team-generated',
      evidenceNeeded: 'A decision on what the property holds.',
      recommendedAction: { action: 'Keep the property as it is declared.', reversible: true },
      resolution: 'A decision.',
      status: 'open',
    },
  } as unknown as Patch;
}

/**
 * Apply a patch as an intended change: breaking deltas are acknowledged and
 * every versioned record it breaks gets its version raised. A patch the model
 * still refuses leaves the model as it was.
 */
function applyIntended(m: Model, patch: Patch): Model {
  const first = mutate(m, patch);
  if (first.model) return first.model;
  const ack = [...new Set(first.changes.filter(needsAcknowledgement).map((c) => c.element))];
  const bumps = first.findings
    .filter((f) => f.code === 'BREAKING_CHANGE_WITHOUT_VERSION_BUMP')
    .map((f) => /^(types|operations|routines)\/(.+)\/version$/.exec(f.path))
    .filter((x): x is RegExpExecArray => x !== null)
    .map(([, collection, id]) => {
      const current = (recordsOf(m, collection!).find((x) => x['id'] === id)?.['version'] as number | undefined) ?? 1;
      return { op: 'update', collection, id, set: { version: current + 1 } } as unknown as Patch;
    });
  if (!ack.length && !bumps.length) return m;
  return mutate(m, [patch, ...bumps], { acknowledgeBreaking: ack }).model ?? m;
}

/** Valid models reached from the sample by a sequence of generated patches and record additions. */
const modelArb: fc.Arbitrary<Model> = fc
  .array(fc.oneof({ weight: 4, arbitrary: choiceArb.map((c) => ({ kind: 'patch' as const, c })) }, { weight: 1, arbitrary: fc.record({ pick: fc.nat(40), suffix: fc.nat(999) }).map((a) => ({ kind: 'unknown' as const, ...a })) }), { maxLength: 4 })
  .map((steps) =>
    steps.reduce((m, s) => {
      const p = s.kind === 'patch' ? patchFor(m, s.c) : unknownNaming(m, s.pick, s.suffix);
      return p ? applyIntended(m, p) : m;
    }, deepClone(sampleModel())),
  );

const resolvedCount = (m: Model): number => {
  const index = indexModel(m);
  return collectReferences(m).filter((r) => ['resolved', 'external'].includes(resolveReference(index, r).status)).length;
};

test('generated models stay valid, so every property below is checked on models the engine accepts', () => {
  fc.assert(
    fc.property(modelArb, (m) => {
      assert.deepEqual(errorsOf(validate(m)), []);
    }),
    options,
  );
});

test('a refused mutation leaves its input unchanged and returns no model, and an accepted one never edits its input', () => {
  let refused = 0;
  let accepted = 0;
  fc.assert(
    fc.property(modelArb, fc.array(choiceArb, { minLength: 1, maxLength: 3 }), (m, choices) => {
      const patches = choices.map((c) => patchFor(m, c)).filter((p): p is Patch => p !== null);
      fc.pre(patches.length > 0);
      const before = canonicalJson(m);
      const r = mutate(m, patches);
      assert.equal(canonicalJson(m), before, 'the input model is unchanged');
      if (r.model === null) {
        refused++;
        assert.ok(r.findings.some((f) => f.severity === 'error'), 'a refusal names an error');
      } else accepted++;
    }),
    options,
  );
  assert.ok(refused > 0 && accepted > 0, `both outcomes were exercised: ${refused} refused, ${accepted} accepted`);
});

test('export and import round-trip every generated model through JSON and YAML', () => {
  fc.assert(
    fc.property(modelArb, (m) => {
      const json = exportModel(m);
      assert.equal(canonicalJson(importModel(json)), canonicalJson(m));
      assert.equal(canonicalJson(importModel(exportYaml(m))), canonicalJson(m));
      assert.equal(exportModel(importModel(json)), json, 'a second export is byte-identical');
    }),
    options,
  );
});

/** A deterministic shuffle of every object's member order, driven by the generated seed. */
function shuffled(v: unknown, next: () => number): unknown {
  if (Array.isArray(v)) return v.map((x) => shuffled(x, next));
  if (v === null || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
  }
  return Object.fromEntries(keys.map((k) => [k, shuffled((v as Rec)[k], next)]));
}

const sortedKeys = (v: unknown): boolean =>
  Array.isArray(v) ? v.every(sortedKeys) : v === null || typeof v !== 'object' ? true : Object.keys(v).every((k, i, ks) => i === 0 || ks[i - 1]! < k) && Object.values(v).every(sortedKeys);

test('canonical JSON orders members the same way whatever order they were written in', () => {
  fc.assert(
    fc.property(modelArb, fc.nat(), (m, seed) => {
      let state = seed;
      const next = (): number => (state = (state * 1103515245 + 12345) % 2147483648);
      const permuted = shuffled(m, next) as Model;
      assert.equal(canonicalJson(permuted), canonicalJson(m));
      assert.equal(modelRevision(permuted), modelRevision(m));
      assert.equal(exportModel(permuted), exportModel(m));
      assert.ok(sortedKeys(JSON.parse(canonicalJson(m))), 'every object of the canonical form has sorted members');
    }),
    options,
  );
});

test('every reference that resolved before a rename still resolves after it', () => {
  const collections = [...idKeyed].sort();
  fc.assert(
    fc.property(modelArb, fc.constantFrom(...collections), fc.nat(40), fc.nat(999), (m, collection, pick, suffix) => {
      const list = recordsOf(m, collection);
      fc.pre(list.length > 0);
      const from = String(list[pick % list.length]!['id']);
      const to = freshKey(from, suffix);
      const r = mutate(m, { op: 'rename', collection, id: from, to } as unknown as Patch, { acknowledgeBreaking: [from, to] });
      const broken = r.findings.filter((f) => f.code === 'DANGLING_REF' || f.code === 'REFERENCE_KIND_MISMATCH').map((f) => `${f.code} ${f.path}`);
      assert.deepEqual(broken, [], `renaming ${collection} '${from}' to '${to}' leaves every reference resolvable`);
      if (r.model) assert.equal(resolvedCount(r.model), resolvedCount(m), 'the rename resolves as many references as before');
    }),
    options,
  );
});

/** A type whose id extends another type's id with a dot, and an unknown naming a property of each. */
function withDottedSibling(m: Model, pick: number, suffix: number, prop: number): { model: Model; base: string; sibling: string; name: string } | null {
  const types = m.types.filter((t) => t.properties.length > 0 && !m.types.some((o) => o.id.startsWith(`${t.id}.`)));
  if (!types.length) return null;
  const base = types[pick % types.length]!;
  const sibling = `${base.id}.part${suffix}`;
  const { stateProperty: _state, ...shape } = deepClone(base);
  let next = applyIntended(m, { op: 'add', collection: 'types', record: { ...shape, id: sibling } } as unknown as Patch);
  const name = base.properties[prop % base.properties.length]!.name;
  next = applyIntended(next, {
    op: 'add',
    collection: 'unknowns',
    record: { id: `unk.sibling-${suffix}`, question: `What does ${name} hold?`, affects: [{ kind: 'property', id: `${base.id}.${name}` }, { kind: 'property', id: `${sibling}.${name}` }], blocks: ['release'], owner: 'team-generated', evidenceNeeded: 'A decision on what the property holds.', recommendedAction: { action: 'Keep the property as it is declared.', reversible: true }, resolution: 'A decision.', status: 'open' },
  } as unknown as Patch);
  return next.unknowns.some((u) => u.id === `unk.sibling-${suffix}`) ? { model: next, base: base.id, sibling, name } : null;
}

test('renaming a type follows only the references to its own properties, never those of a type whose id extends it', () => {
  fc.assert(
    fc.property(modelArb, fc.nat(40), fc.nat(999), fc.nat(40), (m, pick, suffix, prop) => {
      const s = withDottedSibling(m, pick, suffix, prop);
      fc.pre(s !== null);
      const to = `${s!.base}-renamed`;
      const r = mutate(s!.model, { op: 'rename', collection: 'types', id: s!.base, to } as unknown as Patch, { acknowledgeBreaking: [s!.base, to] });
      assert.deepEqual(r.findings.filter((f) => f.code === 'DANGLING_REF').map((f) => f.path), []);
      const renamed = applyIntended(s!.model, { op: 'rename', collection: 'types', id: s!.base, to } as unknown as Patch);
      if (renamed !== s!.model) {
        const affects = renamed.unknowns.find((u) => u.id === `unk.sibling-${suffix}`)!.affects.map((a) => a.id);
        assert.deepEqual(affects, [`${to}.${s!.name}`, `${s!.sibling}.${s!.name}`]);
      }
    }),
    options,
  );
});

test('regression: renaming order keeps the reference to property note of order.part0', () => {
  const s = withDottedSibling(deepClone(sampleModel()), 0, 0, 3);
  assert.ok(s, 'the sample takes a dotted sibling of order');
  assert.equal(s.base, 'order');
  const r = mutate(s.model, { op: 'rename', collection: 'types', id: 'order', to: 'order-renamed' } as unknown as Patch, { acknowledgeBreaking: ['order', 'order-renamed'] });
  assert.deepEqual(r.findings.filter((f) => f.code === 'DANGLING_REF').map((f) => f.path), []);
});

/** Every scalar in the model, with its path. */
function leaves(v: unknown, path: Array<string | number> = []): Array<{ path: Array<string | number>; value: string | number | boolean }> {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return [{ path, value: v }];
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...path, i]));
  if (v !== null && typeof v === 'object') return Object.keys(v).flatMap((k) => leaves((v as Rec)[k], [...path, k]));
  return [];
}

/**
 * The comparison table with every decision observed: each field delta the
 * walk reaches is recorded with whether its decision is semantic. Descriptive
 * text and version numbers are compared and deliberately not reported.
 */
function observedPolicy(seen: Array<{ key: string; semantic: boolean }>): Record<string, FieldPolicy> {
  return Object.fromEntries(
    Object.entries(FIELD_POLICY).map(([key, p]) => [
      key,
      {
        classify: (d: Delta): { rule: DiffRuleId; kind: ChangeKind; dimension: Dimension } => {
          if ('nonSemantic' in p) {
            seen.push({ key, semantic: false });
            return { rule: 'RECORD_ADDED', kind: 'nonSemantic', dimension: 'none' };
          }
          const v = p.classify(d);
          seen.push({ key, semantic: v.kind !== 'nonSemantic' });
          return v;
        },
      },
    ]),
  );
}

test('every changed field value reaches the comparison, and every semantic delta yields a change, never an empty comparison', () => {
  let semantic = 0;
  fc.assert(
    fc.property(modelArb, fc.nat(), (m, pick) => {
      const all = leaves(m);
      const leaf = all[pick % all.length]!;
      const after = deepClone(m);
      let holder = after as unknown as Rec;
      for (const seg of leaf.path.slice(0, -1)) holder = holder[seg as string] as Rec;
      const last = leaf.path[leaf.path.length - 1] as string;
      holder[last] = typeof leaf.value === 'string' ? `${leaf.value}x` : typeof leaf.value === 'number' ? leaf.value + 1 : !leaf.value;
      const seen: Array<{ key: string; semantic: boolean }> = [];
      const probed = diff(m, after, { policy: observedPolicy(seen) });
      const where = leaf.path.join('.');
      assert.ok(seen.length > 0 || probed.some((c) => c.rule === 'CHANGE_REQUIRES_REVIEW'), `the comparison reaches the change of ${where}`);
      if (seen.some((x) => x.semantic)) {
        semantic++;
        assert.ok(diff(m, after).length > 0, `the semantic change of ${where} (${seen.map((x) => x.key).join(', ')}) is reported`);
      }
    }),
    { ...options, numRuns: 200 },
  );
  assert.ok(semantic > 0, 'semantic deltas were exercised');
});

const ref = (kind: RecordRef['kind'], id: string): RecordRef => ({ kind, id });
const typesAndProperties = (m: Model): RecordRef[] => m.types.flatMap((t) => [ref('type', t.id), ...t.properties.map((p) => ref('property', `${t.id}.${p.name}`))]);

/** The records each manifest must account for, stated from the target's purpose rather than read from its renderer. */
const MUST_ACCOUNT: Partial<Record<ProjectionTarget, (m: Model) => RecordRef[]>> = {
  'json-schema': typesAndProperties,
  openapi: (m) => [...typesAndProperties(m), ...m.securitySchemes.map((s) => ref('securityScheme', s.id))],
  yaml: (m) => COLLECTIONS.flatMap((c) => recordsOf(m, c.collection).map((r) => ref(c.kind as RecordRef['kind'], recordKey(c.collection as CollectionName, r)))),
  reference: (m) => [...m.components.map((c) => ref('component', c.id)), ...m.types.map((t) => ref('type', t.id)), ...m.operations.map((o) => ref('operation', o.id)), ...m.requirements.map((r) => ref('requirement', r.id))],
  sql: (m) => m.storage.map((s) => ref('storage', s.id)),
  'csharp-contract-tests': typesAndProperties,
  'typescript-contract-tests': typesAndProperties,
  registers: (m) => [...m.decisions.map((d) => ref('decision', d.id)), ...m.unknowns.map((u) => ref('unknown', u.id)), ...m.assumptions.map((a) => ref('assumption', a.id)), ...m.agreements.map((a) => ref('agreement', a.id))],
  'coverage-matrix': (m) => [...m.requirements.map((r) => ref('requirement', r.id)), ...m.scenarios.map((s) => ref('scenario', s.id))],
  architecture: (m) => [...m.components.map((c) => ref('component', c.id)), ...m.deploymentUnits.map((u) => ref('deploymentUnit', u.id)), ...m.agreements.map((a) => ref('agreement', a.id))],
};

test('every record a target is responsible for appears in its coverage manifest, and no target drops a record silently', () => {
  fc.assert(
    fc.property(modelArb, (m) => {
      for (const target of PROJECTION_TARGETS) {
        let items: Array<{ ref: RecordRef; status: string }>;
        try {
          items = renderTarget(m, target, { draft: true }).coverage.items;
        } catch (e) {
          assert.ok(e instanceof LoomInvalidModelError, `${target} fails only through a refusal`);
          assert.deepEqual([...new Set(e.findings.map((f) => f.code))], ['PROFILE_UNSUPPORTED_CONSTRUCT'], `${target} refuses only a construct its profile cannot express`);
          continue;
        }
        const listed = new Set(items.map((i) => `${i.ref.kind}:${i.ref.id}`));
        const missing = (MUST_ACCOUNT[target]?.(m) ?? []).map((r) => `${r.kind}:${r.id}`).filter((k) => !listed.has(k));
        assert.deepEqual(missing, [], `${target} accounts for every record it is responsible for`);
      }
    }),
    { ...options, numRuns: 20 },
  );
});
