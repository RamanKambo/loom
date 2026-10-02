// Contract generator. Inputs: schema/*.schema.json (authored once), schema/profiles/*.json and
// schema/icd/*.json. Outputs: schema/patch.schema.json (derived from the model schema) and
// src/generated/*. `--check` regenerates in memory and exits 1 on any difference, so CI fails on
// drift between the authored contract and everything derived from it.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(ROOT, 'schema');
const OUT_DIR = join(ROOT, 'src', 'generated');
const CHECK = process.argv.includes('--check');
const PATCH_FILE = 'patch.schema.json';
const BUNDLE_ID = 'urn:loom:schema';

// Every keyword the authored schemas may use. 'typed' keywords shape the generated TypeScript;
// 'runtime' keywords are enforced only by Ajv, because TypeScript cannot express them, so the
// generated declarations are never the validation authority; 'annotation' keywords carry no
// assertion. A keyword outside this table fails generation instead of being silently dropped.
const VOCABULARY = {
  typed: ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf', 'anyOf', 'allOf', '$ref', '$defs'],
  runtime: ['pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'minItems', 'maxItems', 'uniqueItems', 'format', 'propertyNames'],
  annotation: ['$schema', '$id', '$comment', 'description', 'x-loom-kind', 'x-loom-key', 'x-loom-ordered', 'x-loom-ref', 'x-loom-atomic'],
};
const KNOWN_KEYWORDS = new Set(Object.values(VOCABULARY).flat());
// Members whose value is a map of subschemas, so their own keys are names rather than keywords.
const SCHEMA_MAPS = new Set(['properties', '$defs']);

const raw = addFormatsModule;
const addFormats = typeof raw === 'function' ? raw : raw.default;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const pascal = (s) => s.replace(/(^|[^A-Za-z0-9])([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase());
const defName = (ref) => ref.slice(ref.lastIndexOf('/') + 1);

function fail(message) {
  console.error(`generate: ${message}`);
  process.exit(1);
}

// ---------- patch schema, derived from the model schema ----------

function keyOf(arraySchema) {
  const key = arraySchema['x-loom-key'];
  return key === undefined ? null : Array.isArray(key) ? key : [key];
}

// A reference into another file is opaque here: only model-local arrays can be patch item targets.
function resolveLocal(defs, schema) {
  if (!schema.$ref) return schema;
  return schema.$ref.startsWith('#') ? defs[defName(schema.$ref)] : {};
}

function derivePatchSchema(modelSchema) {
  const defs = modelSchema.$defs;
  const model = defs.Model;
  const out = {};
  const variants = [];
  const inlineItems = {};
  const ref = (name) => ({ $ref: `model.schema.json#/$defs/${name}` });
  const idOf = { type: 'string', minLength: 1, maxLength: 400, description: "Element id; a composite key is its values joined with '|'." };

  for (const [collection, arr] of Object.entries(model.properties)) {
    const key = keyOf(arr);
    if (!key) continue;
    const recordDef = defName(arr.items.$ref);
    const record = defs[recordDef];
    const name = pascal(collection);
    const optional = Object.keys(record.properties).filter((p) => !(record.required ?? []).includes(p) && !key.includes(p));
    const settable = Object.fromEntries(
      Object.entries(record.properties)
        .filter(([p]) => !key.includes(p))
        .map(([p, s]) => [p, rewriteModelRefs(s)]),
    );
    const base = (op) => ({ op: { const: op }, collection: { const: collection } });
    out[`PatchAdd${name}`] = obj({ ...base('add'), record: ref(recordDef) }, ['op', 'collection', 'record']);
    out[`PatchReplace${name}`] = obj({ ...base('replace'), id: idOf, record: ref(recordDef) }, ['op', 'collection', 'id', 'record']);
    out[`PatchRemove${name}`] = obj({ ...base('remove'), id: idOf }, ['op', 'collection', 'id']);
    out[`PatchUpdate${name}`] = obj(
      {
        ...base('update'),
        id: idOf,
        set: { type: 'object', additionalProperties: false, properties: settable },
        ...(optional.length ? { unset: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: optional } } } : {}),
      },
      ['op', 'collection', 'id'],
    );
    variants.push(['add', collection, null, `PatchAdd${name}`], ['replace', collection, null, `PatchReplace${name}`]);
    variants.push(['remove', collection, null, `PatchRemove${name}`], ['update', collection, null, `PatchUpdate${name}`]);
    if (key.length === 1 && key[0] === 'id') {
      out[`PatchRename${name}`] = obj(
        { ...base('rename'), id: idOf, to: { $ref: 'common.schema.json#/$defs/Id' } },
        ['op', 'collection', 'id', 'to'],
      );
      variants.push(['rename', collection, null, `PatchRename${name}`]);
    }

    for (const [field, fieldSchema] of Object.entries(record.properties)) {
      const nested = resolveLocal(defs, fieldSchema);
      if (nested.type !== 'array' || !keyOf(nested)) continue;
      const itemKey = keyOf(nested);
      let itemDef;
      if (nested.items.$ref) {
        itemDef = nested.items.$ref.startsWith('common') ? nested.items.$ref : `model.schema.json#/$defs/${defName(nested.items.$ref)}`;
      } else {
        const inlineName = `${recordDef}${pascal(field)}Item`;
        inlineItems[inlineName] = rewriteModelRefs(nested.items);
        itemDef = `#/$defs/${inlineName}`;
      }
      const itemSchema = nested.items.$ref ? (nested.items.$ref.startsWith('common') ? null : defs[defName(nested.items.$ref)]) : nested.items;
      const nestedName = `${name}${pascal(field)}`;
      const fieldBase = (op) => ({ ...base(op), id: idOf, field: { const: field } });
      const keyProp = { type: 'string', minLength: 1, maxLength: 400 };
      out[`PatchAddItem${nestedName}`] = obj(
        { ...fieldBase('addItem'), item: { $ref: itemDef }, index: { type: 'integer', minimum: 0 } },
        ['op', 'collection', 'id', 'field', 'item'],
      );
      out[`PatchReplaceItem${nestedName}`] = obj({ ...fieldBase('replaceItem'), key: keyProp, item: { $ref: itemDef } }, ['op', 'collection', 'id', 'field', 'key', 'item']);
      out[`PatchRemoveItem${nestedName}`] = obj({ ...fieldBase('removeItem'), key: keyProp }, ['op', 'collection', 'id', 'field', 'key']);
      out[`PatchMoveItem${nestedName}`] = obj(
        { ...fieldBase('moveItem'), key: keyProp, index: { type: 'integer', minimum: 0 } },
        ['op', 'collection', 'id', 'field', 'key', 'index'],
      );
      variants.push(
        ['addItem', collection, field, `PatchAddItem${nestedName}`],
        ['replaceItem', collection, field, `PatchReplaceItem${nestedName}`],
        ['removeItem', collection, field, `PatchRemoveItem${nestedName}`],
        ['moveItem', collection, field, `PatchMoveItem${nestedName}`],
      );
      if (itemSchema && itemSchema.properties) {
        const itemOptional = Object.keys(itemSchema.properties).filter((p) => !(itemSchema.required ?? []).includes(p) && !itemKey.includes(p));
        const itemSettable = Object.fromEntries(
          Object.entries(itemSchema.properties)
            .filter(([p]) => !itemKey.includes(p))
            .map(([p, s]) => [p, rewriteModelRefs(s)]),
        );
        out[`PatchUpdateItem${nestedName}`] = obj(
          {
            ...fieldBase('updateItem'),
            key: keyProp,
            set: { type: 'object', additionalProperties: false, properties: itemSettable },
            ...(itemOptional.length ? { unset: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: itemOptional } } } : {}),
          },
          ['op', 'collection', 'id', 'field', 'key'],
        );
        variants.push(['updateItem', collection, field, `PatchUpdateItem${nestedName}`]);
      }
    }
  }
  out.PatchSetSystemProfile = obj({ op: { const: 'setSystemProfile' }, profile: ref('SystemProfile') }, ['op', 'profile']);
  out.PatchClearSystemProfile = obj({ op: { const: 'clearSystemProfile' } }, ['op']);
  variants.push(['setSystemProfile', null, null, 'PatchSetSystemProfile'], ['clearSystemProfile', null, null, 'PatchClearSystemProfile']);
  Object.assign(out, inlineItems);

  const variantNames = variants.map((v) => v[3]);
  return {
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $comment: 'Generated from model.schema.json by scripts/generate.mjs. Do not edit; edit the model schema and regenerate.',
      $defs: {
        Patch: {
          description: "One atomic model edit. A variant is selected by 'op', 'collection' and, for item operations, 'field'.",
          oneOf: variantNames.map((n) => ({ $ref: `#/$defs/${n}` })),
        },
        ...out,
      },
    },
    variants,
  };

  function obj(properties, required) {
    return { type: 'object', additionalProperties: false, required, properties };
  }
  function rewriteModelRefs(schema) {
    return JSON.parse(
      JSON.stringify(schema).replace(/"\$ref":"#\/\$defs\//g, '"$ref":"model.schema.json#/$defs/'),
    );
  }
}

// ---------- bundling and vocabulary ----------

function bundle(files) {
  const defs = {};
  const origin = {};
  for (const [file, schema] of files) {
    for (const [name, def] of Object.entries(schema.$defs ?? {})) {
      if (defs[name]) fail(`definition '${name}' is declared in both ${origin[name]} and ${file}; definition names must be unique across the contract`);
      origin[name] = file;
      defs[name] = rewriteRefs(def, file);
    }
  }
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: BUNDLE_ID, $defs: defs };

  function rewriteRefs(node, file) {
    if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, file));
    if (node && typeof node === 'object') {
      const outNode = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref') {
          const m = /^(?:([a-z]+\.schema\.json))?#\/\$defs\/([A-Za-z0-9_]+)$/.exec(v);
          if (!m) fail(`${file}: unsupported $ref '${v}'`);
          outNode[k] = `#/$defs/${m[2]}`;
        } else outNode[k] = rewriteRefs(v, file);
      }
      return outNode;
    }
    return node;
  }
}

function qualifyVocabulary(schema, where) {
  const used = new Set();
  walk(schema, where);
  return [...used].sort();

  function walk(node, at) {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}/${i}`));
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (!KNOWN_KEYWORDS.has(k)) fail(`${at}: keyword '${k}' is outside the qualified vocabulary`);
      used.add(k);
      if (SCHEMA_MAPS.has(k)) for (const [name, sub] of Object.entries(v)) walk(sub, `${at}/${k}/${name}`);
      else if (k === 'enum' || k === 'const' || k === 'required' || k === 'x-loom-key') continue;
      else if (typeof v === 'object') walk(v, `${at}/${k}`);
    }
  }
}

function makeAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
  addFormats(ajv);
  for (const keyword of VOCABULARY.annotation.filter((k) => k.startsWith('x-loom-'))) ajv.addKeyword({ keyword });
  return ajv;
}

// ---------- registries derived from the model schema ----------

function registries(bundled) {
  const defs = bundled.$defs;
  const model = defs.Model;
  const collections = [];
  const fieldPaths = [];
  const references = [];
  const keyedArrays = [];
  const orderedArrays = [];

  for (const [collection, arr] of Object.entries(model.properties)) {
    if (collection === 'version') continue;
    if (arr.type !== 'array') {
      walkField(collection, arr, [], collection);
      continue;
    }
    const def = defName(arr.items.$ref);
    collections.push({ collection, kind: arr['x-loom-kind'], definition: `model.schema.json#/$defs/${def}`, key: keyOf(arr) });
    keyedArrays.push({ path: `${collection}[]`, key: keyOf(arr) });
    walkDef(`${collection}[]`, def, [def]);
  }

  return { collections, fieldPaths: dedupe(fieldPaths), references: dedupe(references), keyedArrays: dedupe(keyedArrays), orderedArrays: dedupe(orderedArrays) };

  function dedupe(list) {
    const seen = new Set();
    return list.filter((x) => {
      const k = canonical(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function walkDef(path, def, stack) {
    const schema = defs[def];
    if (schema['x-loom-atomic'] || !schema.properties) {
      fieldPaths.push({ path, leaf: true });
      return;
    }
    for (const [prop, sub] of Object.entries(schema.properties)) walkField(`${path}.${prop}`, sub, stack);
  }

  function walkField(path, sub, stack) {
    if (sub['x-loom-ref']) references.push({ path, target: sub['x-loom-ref'] });
    if (sub.$ref) {
      const def = defName(sub.$ref);
      if (def === 'RecordRef') {
        references.push({ path, target: 'record' });
        fieldPaths.push({ path, leaf: true });
        return;
      }
      const target = defs[def];
      if (stack.includes(def) || target['x-loom-atomic'] || !target.properties) {
        if (target['x-loom-ref']) references.push({ path, target: target['x-loom-ref'] });
        fieldPaths.push({ path, leaf: true });
        return;
      }
      walkDef(path, def, [...stack, def]);
      return;
    }
    if (sub.type === 'array') {
      if (sub['x-loom-key']) keyedArrays.push({ path: `${path}[]`, key: keyOf(sub) });
      if (sub['x-loom-ordered']) orderedArrays.push({ path: `${path}[]` });
      const items = sub.items;
      if (items['x-loom-ref']) references.push({ path: `${path}[]`, target: items['x-loom-ref'] });
      if (items.$ref || (items.type === 'object' && items.properties)) {
        walkField(`${path}[]`, items, stack);
        return;
      }
      fieldPaths.push({ path: `${path}[]`, leaf: true });
      return;
    }
    if (sub.type === 'object' && sub.properties && !sub.additionalProperties) {
      for (const [prop, s] of Object.entries(sub.properties)) walkField(`${path}.${prop}`, s, stack);
      return;
    }
    fieldPaths.push({ path, leaf: true });
  }
}

// ---------- data files: profiles and interface control documents ----------

function loadData(ajv) {
  const read = (dir, def) => {
    const full = join(SCHEMA_DIR, dir);
    if (!existsSync(full)) return [];
    const validate = ajv.getSchema(`${BUNDLE_ID}#/$defs/${def}`);
    return readdirSync(full)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        const doc = readJson(join(full, f));
        if (!validate(doc)) fail(`${dir}/${f}: ${ajv.errorsText(validate.errors)}`);
        return doc;
      });
  };
  const profiles = read('profiles', 'ProfileDefinition');
  const projectionProfiles = read('projection-profiles', 'ProjectionProfile');
  const icds = read('icd', 'Icd');
  for (const [kind, list, key] of [['profile', profiles, 'id'], ['projection profile', projectionProfiles, 'id'], ['ICD', icds, 'id']]) {
    const ids = list.map((x) => x[key]);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) fail(`${kind} id '${dup}' is declared twice`);
  }
  checkIcdBoundaries(icds);
  return { profiles, projectionProfiles, icds };
}

// Every consumed interface must be provided by the named component, and every provided interface
// must have a consumer, so each boundary has a producer and a consumer bound to one digest.
function checkIcdBoundaries(icds) {
  const provided = new Map();
  for (const icd of icds) for (const p of icd.provides) provided.set(`${icd.id}:${p.name}`, false);
  for (const icd of icds) {
    for (const c of icd.consumes) {
      const k = `${c.component}:${c.interface}`;
      if (!provided.has(k)) fail(`ICD ${icd.id} consumes '${k}', which no ICD provides`);
      provided.set(k, true);
    }
  }
  const orphan = [...provided].filter(([, used]) => !used).map(([k]) => k);
  if (icds.length && orphan.length) fail(`provided interfaces without a consumer: ${orphan.join(', ')}`);
}

// A combinator whose branches only state which members must be present ("exactly one of patch or
// patches") constrains presence, not shape. json-schema-to-typescript would turn it into an index
// signature that erases the declared members, so it is removed from the TypeScript input only; the
// runtime bundle keeps and enforces it.
function stripPresenceCombinators(node) {
  if (Array.isArray(node)) return node.map(stripPresenceCombinators);
  if (!node || typeof node !== 'object') return node;
  const presenceOnly = (branch) =>
    branch && typeof branch === 'object' && Object.keys(branch).every((k) => k === 'required' || ((k === 'oneOf' || k === 'anyOf') && branch[k].every(presenceOnly)));
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'oneOf' || k === 'anyOf' || k === 'allOf') && Array.isArray(v) && v.every(presenceOnly)) continue;
    out[k] = stripPresenceCombinators(v);
  }
  return out;
}

// Qualifies json-schema-to-typescript on every 'typed' keyword: a hand-authored schema and the
// declaration each keyword must produce. A generator release that maps a keyword differently fails
// here rather than silently weakening the generated declarations.
const VOCABULARY_FIXTURE = {
  $defs: {
    Fixture: {
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: {
        a: { type: 'string' },
        b: { enum: ['x', 'y'] },
        c: { const: 1 },
        d: { type: 'array', items: { $ref: '#/$defs/Leaf' } },
        e: { oneOf: [{ $ref: '#/$defs/Leaf' }, { type: 'integer' }] },
        f: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        g: { allOf: [{ $ref: '#/$defs/Leaf' }] },
        h: { type: 'object', additionalProperties: { type: 'number' } },
      },
    },
    Leaf: { type: 'object', additionalProperties: false, required: ['n'], properties: { n: { type: 'string' } } },
  },
};
const VOCABULARY_EXPECTED = [
  /a: string;/,
  /b\?: 'x' \| 'y';/,
  /c\?: 1;/,
  /d\?: Leaf\[\];/,
  /e\?: Leaf \| number;/,
  /f\?: boolean \| null;/,
  /g\?: Leaf;/,
  /h\?: \{\s*\[k: string\]: number( \| undefined)?;\s*\};/,
  /export interface Leaf \{\s*n: string;\s*\}/,
];

async function qualifyTypeGenerator() {
  const out = await compile(
    { ...VOCABULARY_FIXTURE, type: 'object', additionalProperties: false, properties: { fixture: { $ref: '#/$defs/Fixture' } } },
    'VocabularyRoot',
    { bannerComment: '', additionalProperties: false, unreachableDefinitions: true, strictIndexSignatures: true, ignoreMinAndMaxItems: true, format: true, style: { singleQuote: true } },
  );
  const missing = VOCABULARY_EXPECTED.filter((re) => !re.test(out));
  if (missing.length) fail(`json-schema-to-typescript maps typed keywords differently than qualified: ${missing.map(String).join(', ')}\n${out}`);
}

// ---------- contract fixtures ----------

// Independent positive and negative instances per definition, authored by hand in
// schema/fixtures. A negative instance names the keyword and instance path it must fail on, so
// a schema that rejects it for an unrelated reason does not count as a pass.
function runFixtures(ajv) {
  const dir = join(SCHEMA_DIR, 'fixtures');
  if (!existsSync(dir)) fail('schema/fixtures is missing; every document definition needs positive and negative fixtures');
  let cases = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const fx = readJson(join(dir, file));
    const validate = ajv.getSchema(`${BUNDLE_ID}#/$defs/${fx.definition}`);
    if (!validate) fail(`fixtures/${file}: unknown definition '${fx.definition}'`);
    if (!fx.valid?.length || !fx.invalid?.length) fail(`fixtures/${file}: needs at least one valid and one invalid instance`);
    fx.valid.forEach((instance, i) => {
      cases++;
      if (!validate(instance)) fail(`fixtures/${file}: valid[${i}] is rejected: ${ajv.errorsText(validate.errors)}`);
    });
    fx.invalid.forEach((c, i) => {
      cases++;
      if (validate(c.instance)) fail(`fixtures/${file}: invalid[${i}] (${c.because}) is accepted`);
      const hit = (validate.errors ?? []).some((e) => e.keyword === c.keyword && e.instancePath === c.path);
      if (!hit) fail(`fixtures/${file}: invalid[${i}] (${c.because}) fails, but not on ${c.keyword} at '${c.path}': ${ajv.errorsText(validate.errors)}`);
    });
  }
  return cases;
}

// ---------- emit ----------

const BANNER = '// Generated by packages/core/scripts/generate.mjs from packages/core/schema. Do not edit.\n';

async function generate() {
  const authored = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.schema.json') && f !== PATCH_FILE)
    .sort()
    .map((f) => [f, readJson(join(SCHEMA_DIR, f))]);
  const modelSchema = authored.find(([f]) => f === 'model.schema.json')[1];
  const patch = derivePatchSchema(modelSchema);
  const files = [...authored, [PATCH_FILE, patch.schema]].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [file, schema] of files) qualifyVocabulary(schema, file);
  const bundled = bundle(files);
  const vocabulary = qualifyVocabulary(bundled, 'bundle');

  const ajv = makeAjv();
  try {
    ajv.addSchema(bundled);
    for (const name of Object.keys(bundled.$defs)) ajv.getSchema(`${BUNDLE_ID}#/$defs/${name}`);
  } catch (err) {
    fail(`bundle does not compile under JSON Schema 2020-12: ${err.message}`);
  }
  const data = loadData(ajv);
  const fixtureCases = runFixtures(ajv);
  await qualifyTypeGenerator();
  const reg = registries(bundled);
  const digest = sha256(canonical({ schema: bundled, ...data }));

  const tsInput = { ...stripPresenceCombinators(bundled), type: 'object', additionalProperties: false, properties: {} };
  delete tsInput.$id;
  let types = await compile(tsInput, 'LoomContractRoot', {
    bannerComment: '',
    additionalProperties: false,
    unreachableDefinitions: true,
    declareExternallyReferenced: true,
    strictIndexSignatures: true,
    ignoreMinAndMaxItems: true,
    format: true,
    style: { singleQuote: true, printWidth: 120 },
  });
  const provenance = String.raw` \* This (?:interface|type) was referenced by \x60LoomContractRoot\x60's JSON-Schema\n \* via the \x60definition\x60 "[A-Za-z0-9_]+"\.\n`;
  types = types
    .replace(/export interface LoomContractRoot \{\}\n\n?/, '')
    .replace(new RegExp(String.raw`/\*\*\n${provenance} \*/\n`, 'g'), '')
    .replace(new RegExp(String.raw` \*\n${provenance}`, 'g'), '');

  const json = (v) => JSON.stringify(v, null, 2);
  const outputs = new Map([
    [join(SCHEMA_DIR, PATCH_FILE), `${json(patch.schema)}\n`],
    [join(OUT_DIR, 'types.ts'), `${BANNER}/* eslint-disable */\n${types}`],
    [
      join(OUT_DIR, 'schemas.ts'),
      `${BANNER}\nexport const SCHEMA_BUNDLE_ID = ${JSON.stringify(BUNDLE_ID)};\n\nexport const SCHEMA_BUNDLE = ${JSON.stringify(bundled)} as const;\n`,
    ],
    [
      join(OUT_DIR, 'digest.ts'),
      `${BANNER}\n/** SHA-256 of the canonical JSON of the schema bundle, profiles, projection profiles and ICDs. */\nexport const CONTRACT_DIGEST = ${JSON.stringify(digest)};\n\nexport const SCHEMA_VOCABULARY = ${json(vocabulary)} as const;\n`,
    ],
    [
      join(OUT_DIR, 'registry.ts'),
      [
        BANNER,
        `export const COLLECTIONS = ${json(reg.collections)} as const;\n`,
        `export const FIELD_PATHS = ${json(reg.fieldPaths.map((f) => f.path))} as const;\n`,
        `export const REFERENCE_FIELDS = ${json(reg.references)} as const;\n`,
        `export const KEYED_ARRAYS = ${json(reg.keyedArrays)} as const;\n`,
        `export const ORDERED_ARRAYS = ${json(reg.orderedArrays.map((o) => o.path))} as const;\n`,
        `export const PATCH_VARIANTS = ${json(patch.variants.map(([op, collection, field, definition]) => ({ op, collection, field, definition })))} as const;\n`,
      ].join('\n'),
    ],
    [
      join(OUT_DIR, 'contracts.ts'),
      [
        BANNER,
        "import type { ProfileDefinition, ProjectionProfile, Icd } from './types.js';\n",
        `export const PROFILES: readonly ProfileDefinition[] = ${json(data.profiles)};\n`,
        `export const PROJECTION_PROFILES: readonly ProjectionProfile[] = ${json(data.projectionProfiles)};\n`,
        `export const ICDS: readonly Icd[] = ${json(data.icds)};\n`,
      ].join('\n'),
    ],
  ]);

  if (CHECK) {
    const drifted = [...outputs].filter(([path, text]) => !existsSync(path) || readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== text);
    if (drifted.length) fail(`generated contract artifacts are stale: ${drifted.map(([p]) => basename(p)).join(', ')}; run npm run generate`);
    console.log(`generate --check: ${outputs.size} artifacts current, ${fixtureCases} fixture cases passed, digest ${digest}`);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [path, text] of outputs) writeFileSync(path, text);
  console.log(`generate: ${outputs.size} artifacts written, ${fixtureCases} fixture cases passed, digest ${digest}`);
}

await generate();
