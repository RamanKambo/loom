import type { ItemShape, Model, Property, TypeDef } from '../generated/types.js';
import { indexModel } from '../records.js';
import { SLASH_NOTICE, toText } from './notice.js';
import { sampleObject } from './samples.js';
import { pascal, type RenderContext } from './context.js';

export const TYPESCRIPT_TESTS_FILE = 'contract.test.ts';

/** The module specifier of a component's typescript implementation. */
export function typescriptModule(model: Model, component: string): string | undefined {
  return model.components.find((c) => c.id === component)?.implementations?.find((i) => i.language === 'typescript')?.module;
}

type Shape = Pick<Property, 'kind' | 'enumValues' | 'ref' | 'items'>;

/** The TypeScript type of a value shape, or null when the profile cannot express it. */
function tsType(shape: Shape, refs: Set<string>): string | null {
  switch (shape.kind) {
    case 'string':
    case 'date':
    case 'datetime':
    case 'uuid':
    case 'decimal':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return (shape.enumValues ?? []).map((v) => JSON.stringify(v)).join(' | ') || 'never';
    case 'ref': {
      const name = pascal(shape.ref ?? '');
      refs.add(name);
      return name;
    }
    case 'array': {
      const item = shape.items as ItemShape | undefined;
      const inner = item ? tsType(item, refs) : null;
      return inner === null ? null : `Array<${inner}>`;
    }
    default:
      return null;
  }
}

function typeBlock(t: TypeDef, sample: Record<string, unknown>, refs: Set<string>, ctx: RenderContext): string[] {
  const name = pascal(t.id);
  const declared = `Loom${name}`;
  const members: string[] = [];
  for (const p of t.properties) {
    const type = tsType(p, refs);
    if (type === null) {
      ctx.unsupported('type.union', { kind: 'type', id: t.id }, `property '${t.id}.${p.name}' is a union, which this profile does not express`);
      continue;
    }
    members.push(`  ${p.immutable ? 'readonly ' : ''}${JSON.stringify(p.name)}${p.required ? '' : '?'}: ${type}${p.nullable ? ' | null' : ''};`);
    ctx.covered({ kind: 'property', id: `${t.id}.${p.name}` }, TYPESCRIPT_TESTS_FILE, `${p.immutable ? 'readonly ' : ''}${JSON.stringify(p.name)}${p.required ? '' : '?'}: `);
  }
  ctx.covered({ kind: 'type', id: t.id }, TYPESCRIPT_TESTS_FILE, `interface ${declared} {`);
  const key = JSON.stringify(t.id);
  const sampleName = `${name.charAt(0).toLowerCase()}${name.slice(1)}Sample`;
  const L: string[] = [
    '',
    `// Type '${t.id}' (${t.representation}, version ${t.version}) as the contract declares it.`,
    `interface ${declared} {`,
    ...members,
    '}',
    `export type ${name}ShapeIsExact = Assert<Equal<${name}, ${declared}>>;`,
    `export type ${name}ParseReturnsTheType = Assert<Equal<ReturnType<(typeof codecs)[${key}]['parse']>, ${name}>>;`,
    `const ${sampleName}: Record<string, unknown> = ${JSON.stringify(sample)};`,
    '',
    `test(${JSON.stringify(`${t.id}: a conforming payload round-trips through parse and serialize`)}, () => {`,
    `  const codec = codecs[${key}];`,
    `  assert.deepStrictEqual(codec.serialize(codec.parse(structuredClone(${sampleName}))), ${sampleName});`,
    '});',
  ];
  for (const p of t.properties) {
    if (p.required) {
      L.push(
        '',
        `test(${JSON.stringify(`${t.id}: a payload without ${p.name} is rejected`)}, () => {`,
        `  const payload = structuredClone(${sampleName});`,
        `  delete payload[${JSON.stringify(p.name)}];`,
        `  assert.throws(() => codecs[${key}].parse(payload));`,
        '});',
      );
    }
    if (p.kind === 'enum' && p.unknownEnumPolicy === 'reject') {
      L.push(
        '',
        `test(${JSON.stringify(`${t.id}: ${p.name} outside its value set is rejected`)}, () => {`,
        `  const payload = { ...structuredClone(${sampleName}), ${JSON.stringify(p.name)}: 'loom-value-outside-the-set' };`,
        `  assert.throws(() => codecs[${key}].parse(payload));`,
        '});',
      );
    }
  }
  return L;
}

/**
 * node:test conformance tests for one component's typescript implementation.
 * The compiler checks each exported type against the declared shape (keys,
 * optionality, readonly, member types); the runner checks the module's own
 * parse and serialize on generated conforming payloads. The import specifier
 * is the module name only: the qualification run maps it to the
 * implementation, so the file names no path.
 */
export function projectTypescriptContractTests(model: Model, ctx: RenderContext): Record<string, string> {
  const component = ctx.component as string;
  const module = typescriptModule(model, component) as string;
  const index = indexModel(model);
  const types = model.types.filter((t) => t.owner === component);
  const refs = new Set<string>();
  const blocks = types.flatMap((t) => typeBlock(t, sampleObject(index, t), refs, ctx));
  const imported = [...new Set([...types.map((t) => pascal(t.id)), ...refs])].sort();
  const lines = [
    SLASH_NOTICE,
    `// Conformance tests of component '${component}' against module '${module}': compile-time shape`,
    '// equality of each exported type and run-time serialization through its codecs. Business behavior',
    '// is never generated or asserted.',
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import { codecs } from ${JSON.stringify(module)};`,
    `import type { ${imported.join(', ')} } from ${JSON.stringify(module)};`,
    '',
    '// True only when A and B are the same type, including optional and readonly members.',
    'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;',
    'type Assert<T extends true> = T;',
    ...blocks,
  ];
  return { [TYPESCRIPT_TESTS_FILE]: toText(lines) };
}
