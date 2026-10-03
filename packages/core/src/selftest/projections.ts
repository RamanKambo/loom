import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { CoverageManifest, Model, ProjectedFile, ProjectionTarget, RecordRef } from '../generated/types.js';
import { SCHEMA_BUNDLE } from '../generated/schemas.js';
import { canonicalStringify, deepEqual } from '../canonical.js';
import { modelRevision } from '../hash.js';
import { importModel } from '../exportModel.js';
import { LoomInvalidModelError } from '../errors.js';
import { schemaErrors } from '../schema-runtime.js';
import { projectTool, projectAllTool } from '../envelope.js';
import {
  PROJECTION_FILES,
  PROJECTION_TARGETS,
  artifactProfile,
  enabledTargets,
  filesOf,
  instancesOf,
  project,
  projectToFiles,
  projectedPath,
  renderAll,
  renderTarget,
  renderWithSpec,
  unsupportedConstructs,
  type TargetSpec,
} from '../project.js';
import { pascal } from '../projections/context.js';
import { sampleModel } from '../sample.js';
import { assert, assertThrows, codesOf, fresh, observe, pick, type Tally } from './harness.js';

interface Section {
  name: string;
  run(t: Tally): void;
}

type FormatsPlugin = (ajv: unknown, opts?: unknown) => unknown;
const rawFormats = addFormatsModule as unknown as FormatsPlugin | { default: FormatsPlugin };
const addFormats: FormatsPlugin = typeof rawFormats === 'function' ? rawFormats : rawFormats.default;

const tick = (s: string): string => `\`${s}\``;
const key = (r: RecordRef): string => `${r.kind}:${r.id}`;
const filesFor = (files: readonly ProjectedFile[], component: string | undefined, file: string): string[] =>
  files.filter((f) => f.file === file && f.component === component).map((f) => f.content);

/**
 * The records an independent reader finds in a target's rendered files. Each
 * reader parses or searches the output itself and never consults the
 * renderer's coverage manifest, so the manifest is checked against an oracle
 * the renderer cannot influence.
 */
function presentRecords(model: Model, target: ProjectionTarget, files: readonly ProjectedFile[]): Set<string> {
  const found = new Set<string>();
  const add = (kind: RecordRef['kind'], id: string): void => void found.add(`${kind}:${id}`);
  const one = (file: string): string => filesFor(files, undefined, file)[0] ?? '';
  switch (target) {
    case 'json-schema': {
      const defs = (JSON.parse(one('schema.json')) as { $defs: Record<string, { properties?: Record<string, unknown> }> }).$defs;
      for (const [id, d] of Object.entries(defs)) {
        add('type', id);
        for (const p of Object.keys(d.properties ?? {})) add('property', `${id}.${p}`);
      }
      break;
    }
    case 'openapi': {
      const doc = JSON.parse(one('openapi.json')) as { paths: Record<string, Record<string, { operationId: string }>>; components: { schemas: Record<string, { properties?: Record<string, unknown> }>; securitySchemes?: Record<string, unknown> } };
      for (const [id, s] of Object.entries(doc.components.schemas)) {
        add('type', id);
        for (const p of Object.keys(s.properties ?? {})) add('property', `${id}.${p}`);
      }
      for (const item of Object.values(doc.paths)) for (const op of Object.values(item)) add('operation', op.operationId.replace(/\.\d+$/, ''));
      for (const id of Object.keys(doc.components.securitySchemes ?? {})) add('securityScheme', id);
      break;
    }
    case 'yaml': {
      const back = importModel(one('model.yaml'));
      if (deepEqual(back, model)) for (const r of renderTarget(model, 'yaml').coverage.items) found.add(key(r.ref));
      break;
    }
    case 'sql':
      for (const s of model.storage) {
        const text = filesFor(files, s.owner, 'schema.sql').join('\n');
        const table = new RegExp(`CREATE TABLE \\[${s.schema}\\]\\.\\[${s.table}\\] \\(([\\s\\S]*?)\\n\\);`).exec(text);
        if (table && s.columns.every((c) => table[1]!.includes(`[${c.name}] `))) add('storage', s.id);
      }
      break;
    case 'sql-contract-tests':
      for (const s of model.storage) if (filesFor(files, s.owner, 'contract-tests.sql').some((x) => x.includes(`Loom contract: table [${s.schema}].[${s.table}] does not exist`))) add('storage', s.id);
      for (const r of model.routines) if (filesFor(files, r.owner, 'contract-tests.sql').some((x) => x.includes(`-- routine ${r.id} (`))) add('routine', r.id);
      break;
    case 'pester-contract-tests':
      for (const r of model.routines) if (filesFor(files, r.owner, 'Routines.Contract.Tests.ps1').some((x) => x.includes(`Describe 'Routine ${r.id} (`))) add('routine', r.id);
      break;
    case 'csharp-contract-tests':
      for (const t of model.types) {
        const text = filesFor(files, t.owner, 'ContractTests.cs').join('\n');
        const cls = new RegExp(`public sealed class ${pascal(t.id)}Contract\\n\\{([\\s\\S]*?)\\n\\}`).exec(text);
        if (!cls) continue;
        add('type', t.id);
        for (const p of t.properties) if (cls[1]!.includes(`Loom.Property(T, "${pascal(p.name)}")`)) add('property', `${t.id}.${p.name}`);
      }
      break;
    case 'typescript-contract-tests':
      for (const t of model.types) {
        const text = filesFor(files, t.owner, 'contract.test.ts').join('\n');
        const decl = new RegExp(`interface Loom${pascal(t.id)} \\{\\n([\\s\\S]*?)\\n\\}`).exec(text);
        if (!decl) continue;
        add('type', t.id);
        for (const p of t.properties) if (decl[1]!.includes(`${JSON.stringify(p.name)}${p.required ? '' : '?'}: `)) add('property', `${t.id}.${p.name}`);
      }
      break;
    case 'workflow': {
      const text = one('workflows.md');
      for (const t of model.types) if (text.includes(`Type ${tick(t.id)} (`) && t.stateProperty) add('type', t.id);
      for (const w of model.workflows) if (text.includes(`${w.id} (${w.status})`)) add('workflow', w.id);
      break;
    }
    case 'icd':
      for (const c of model.components) {
        const text = filesFor(files, c.id, 'icd.md').join('\n');
        if (!text.includes(`component ${tick(c.id)}`)) continue;
        add('component', c.id);
        for (const [kind, list] of [['operation', model.operations], ['routine', model.routines], ['type', model.types], ['storage', model.storage], ['mutation', model.mutations]] as const) {
          for (const r of list as ReadonlyArray<{ id: string; owner: string }>) if (r.owner === c.id && text.includes(`| ${tick(r.id)} |`)) add(kind, r.id);
        }
      }
      break;
    default: {
      // Markdown views name each record in a code span; the reader searches for every candidate record id.
      const text = files.map((f) => f.content).join('\n');
      const candidates: Array<[RecordRef['kind'], string]> = [
        ...model.components.map((c) => ['component', c.id] as [RecordRef['kind'], string]),
        ...model.types.map((x) => ['type', x.id] as [RecordRef['kind'], string]),
        ...model.storage.map((x) => ['storage', x.id] as [RecordRef['kind'], string]),
        ...model.operations.map((x) => ['operation', x.id] as [RecordRef['kind'], string]),
        ...model.routines.map((x) => ['routine', x.id] as [RecordRef['kind'], string]),
        ...model.mutations.map((x) => ['mutation', x.id] as [RecordRef['kind'], string]),
        ...model.workflows.map((x) => ['workflow', x.id] as [RecordRef['kind'], string]),
        ...model.requirements.map((x) => ['requirement', x.id] as [RecordRef['kind'], string]),
        ...model.requirements.flatMap((r) => r.criteria.map((x) => ['criterion', x.id] as [RecordRef['kind'], string])),
        ...model.scenarios.map((x) => ['scenario', x.id] as [RecordRef['kind'], string]),
        ...model.decisions.map((x) => ['decision', x.id] as [RecordRef['kind'], string]),
        ...model.unknowns.map((x) => ['unknown', x.id] as [RecordRef['kind'], string]),
        ...model.assumptions.map((x) => ['assumption', x.id] as [RecordRef['kind'], string]),
        ...model.constraints.map((x) => ['constraint', x.id] as [RecordRef['kind'], string]),
        ...model.migrations.map((x) => ['migration', x.id] as [RecordRef['kind'], string]),
        ...model.retainedBehaviors.map((x) => ['retainedBehavior', x.id] as [RecordRef['kind'], string]),
        ...model.deploymentUnits.map((x) => ['deploymentUnit', x.id] as [RecordRef['kind'], string]),
        ...model.hosts.map((x) => ['host', x.id] as [RecordRef['kind'], string]),
        ...model.trustBoundaries.map((x) => ['trustBoundary', x.id] as [RecordRef['kind'], string]),
      ];
      for (const [kind, id] of candidates) if (text.includes(`${tick(id)} |`) || text.includes(`${tick(id)}\n`) || text.includes(`${tick(id)} (`)) add(kind, id);
      for (const e of model.edges) if (text.includes(`| ${tick(e.from)} | ${tick(e.to)} | ${e.kind} |`)) add('edge', `${e.from}|${e.to}|${e.kind}`);
    }
  }
  return found;
}

/** Every record the manifest calls projected is found by the independent reader, and no in-scope record is unaccounted for. */
function verifyManifest(t: Tally, model: Model, target: ProjectionTarget, files: readonly ProjectedFile[], manifest: CoverageManifest): void {
  assert(t, schemaErrors('CoverageManifest', manifest).length === 0, `${target}: the coverage manifest satisfies its contract`);
  const present = presentRecords(model, target, files);
  const projected = manifest.items.filter((i) => i.status === 'projected');
  const absent = projected.filter((i) => !present.has(key(i.ref))).map((i) => key(i.ref));
  assert(t, absent.length === 0, `${target}: every record the manifest calls projected is in the output, by an independent reading; not found: ${absent.join(', ')}`);
  assert(t, projected.length > 0 || manifest.items.length === 0, `${target}: the manifest names what it projected`);
}

export const PROJECTION_SECTIONS: readonly Section[] = [
  {
    name: 'projections',
    run: (t) => {
      const targets = SCHEMA_BUNDLE.$defs.ProjectionTarget.enum as readonly ProjectionTarget[];
      assert(t, targets.every((x) => PROJECTION_TARGETS.includes(x)) && PROJECTION_TARGETS.length === targets.length, 'every contract projection target has a renderer');
      const source = canonicalStringify(sampleModel());
      for (const target of PROJECTION_TARGETS) {
        const a = canonicalStringify(project(sampleModel(), target));
        const b = canonicalStringify(project(sampleModel(), target));
        assert(t, a === b, `${target} renders deterministically`);
        const invented = (a.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[^"\\\s|]*/g) ?? []).filter((x) => !source.includes(x) && x !== '2026-01-31T12:30:00+00:00');
        assert(t, invented.length === 0 && !/[A-Z]:\\\\|\/home\/|\/Users\//.test(a), `${target} introduces no time and no machine path: ${invented.join(', ')}`);
      }
      const bundle = renderAll(sampleModel());
      const expected = PROJECTION_TARGETS.flatMap((target) => instancesOf(sampleModel(), target).flatMap((c) => filesOf(target).map((f) => (c ? `${c}/${f}` : f)))).sort();
      assert(t, deepEqual(bundle.files.map(projectedPath), expected), `every target writes one file per instance and file: ${bundle.files.map(projectedPath).join(', ')}`);
      assert(t, deepEqual(Object.keys(projectToFiles(sampleModel())).sort(), expected), 'projectToFiles keys each file by its instance path');
      for (const m of bundle.coverage) verifyManifest(t, sampleModel(), m.target, bundle.files.filter((f) => PROJECTION_FILES[f.file] === m.target), m);
      for (const f of bundle.files) {
        if (!f.file.endsWith('.md') || ['workflows.md', 'reference.md'].includes(f.file)) continue;
        assert(t, f.content.includes(modelRevision(sampleModel())), `${projectedPath(f)} names the model revision it was rendered from`);
      }

      const broken = fresh();
      pick(broken.mutations, 'order.pay').to = 'refunded';
      for (const target of PROJECTION_TARGETS) {
        assertThrows(t, () => project(broken, target), `${target} refuses an invalid model`, (e) => e instanceof LoomInvalidModelError);
      }

      const ajv = new Ajv2020({ strict: true, allErrors: true });
      addFormats(ajv);
      const schema = project(sampleModel(), 'json-schema') as Record<string, unknown>;
      ajv.addSchema(schema);
      const validOrder = ajv.getSchema('urn:loom:projection:json-schema#/$defs/order');
      assert(t, validOrder !== undefined, 'the projected JSON Schema compiles under Ajv 2020-12 strict mode');
      assert(t, validOrder!({ id: 'o-1', status: 'placed', total: '12.50', note: null }) === true, `a conforming order validates: ${ajv.errorsText(validOrder!.errors)}`);
      assert(t, validOrder!({ id: 'o-1', status: 'placed' }) === false, 'an order without its total is rejected');
      assert(t, validOrder!({ id: 'o-1', status: 'placed', total: 12.5 }) === false, 'a floating-point total is rejected');
    },
  },
  {
    name: 'projection instances',
    run: (t) => {
      const m = sampleModel();
      assert(t, deepEqual(instancesOf(m, 'sql'), ['ordering', 'fulfillment', 'billing']), `SQL instances follow foreign-key order: ${instancesOf(m, 'sql').join(', ')}`);
      const sql = renderTarget(m, 'sql');
      const ids = sql.files.map((f) => f.instance);
      assert(t, new Set(ids).size === ids.length && ids.includes('schema.sql#ordering') && ids.includes('schema.sql#billing'), `two SQL components receive distinct instances: ${ids.join(', ')}`);
      assert(t, deepEqual(instancesOf(m, 'csharp-contract-tests'), ['ordering']) && deepEqual(instancesOf(m, 'typescript-contract-tests'), ['fulfillment']), 'language artifacts go only to components that declare the language');
      const cs = renderTarget(m, 'csharp-contract-tests');
      assert(t, cs.files.map((f) => f.instance).join(',') === 'ContractTests.cs#ordering,ContractTests.csproj#ordering', 'a two-file artifact keeps one instance per file');
      const invoice = cs.coverage.items.find((i) => i.ref.kind === 'type' && i.ref.id === 'invoice');
      assert(t, invoice?.status === 'out-of-scope' && /billing.*csharp/.test(invoice.reason ?? ''), `a record of a component without the language is out of scope with the reason: ${JSON.stringify(invoice)}`);
      assert(t, artifactProfile('openapi').instancing === 'singleton' && artifactProfile('icd').instancing === 'per-component' && artifactProfile('pester-contract-tests').language === 'powershell', 'instancing and language come from the profile definitions');
      assert(t, deepEqual(instancesOf(m, 'icd'), m.components.map((c) => c.id)), 'every component receives an interface control view');
      assert(t, enabledTargets('none').length === 0 && enabledTargets('complete').length === PROJECTION_TARGETS.length && enabledTargets('unknown-profile').length === 0, 'projection profiles select targets');
      const env = projectAllTool({ model: m });
      assert(t, schemaErrors('ResultEnvelope', env).length === 0 && (env.data as { coverage: CoverageManifest[] }).coverage.length === PROJECTION_TARGETS.length, 'projectAll returns one coverage manifest per target');
      const one = projectTool({ model: m, target: 'openapi' });
      assert(t, one.states.qualification.state !== 'qualified' && (one.data as { coverage: CoverageManifest[] }).coverage[0]!.target === 'openapi', 'a direct projection carries its manifest and claims no external validation');
      const views = renderAll(m, { targets: ['readiness-report', 'evidence-index'], inputs: {} });
      const again = renderAll(m, { targets: ['readiness-report', 'evidence-index'], inputs: {} });
      assert(t, deepEqual(views.files, again.files) && views.files.every((f) => f.content.includes('Evaluation inputs: no baseline')), 'views rendered with inputs are deterministic and name the inputs');
      const bare = renderTarget(m, 'readiness-report').files[0]!.content;
      assert(t, bare.includes('Readiness is not evaluated: no evaluation inputs were supplied.') && !bare.includes('| ready |'), 'without inputs the readiness view says nothing was evaluated');
    },
  },
  {
    name: 'unsupported constructs',
    run: (t) => {
      const prose = fresh();
      pick(prose.storage, 'ordering.orders').checks = [{ name: 'reasonable', predicate: { form: 'prose', text: 'The total is reasonable.' } }];
      const refused = assertThrows(t, () => project(prose, 'sql'), 'a prose check cannot be rendered as a constraint', (e) => e instanceof LoomInvalidModelError) as LoomInvalidModelError;
      observe(t, refused.findings);
      assert(t, codesOf(refused.findings).includes('PROFILE_UNSUPPORTED_CONSTRUCT'), 'the refusal names the unsupported construct');
      const draft = renderTarget(prose, 'sql', { draft: true });
      observe(t, draft.findings);
      const orders = draft.files.find((f) => f.component === 'ordering')!;
      assert(t, draft.draft && orders.content.split('\n')[1]!.startsWith('-- DRAFT') && !draft.files.find((f) => f.component === 'billing')!.content.includes('DRAFT'), 'a draft marks exactly the incomplete instance');
      assert(t, !draft.coverage.complete && draft.coverage.items.some((i) => i.status === 'unsupported' && i.ref.id === 'ordering.orders'), 'the draft manifest reports the unsupported record and is not complete');
      const env = projectTool({ model: prose, target: 'sql' });
      assert(t, env.outcome === 'refused' && env.refusal?.cause === 'policy-failure', 'the project tool refuses an unsupported construct outside draft mode');
      const draftEnv = projectTool({ model: prose, target: 'sql', draft: true });
      assert(t, draftEnv.outcome === 'ok' && draftEnv.states.qualification.state === 'unqualified', 'a draft is never qualified');

      const union = fresh();
      pick(union.types, 'order-response').properties.push({ name: 'payment', kind: 'union', required: false, nullable: true, immutable: false, origin: 'system', variants: ['order', 'invoice'], discriminator: 'kind' });
      for (const target of ['csharp-contract-tests'] as const) {
        const e = assertThrows(t, () => renderTarget(union, target, { draft: true }), `${target} refuses a union even as a draft, because its profile says fail`, (x) => x instanceof LoomInvalidModelError) as LoomInvalidModelError;
        observe(t, e.findings);
        assert(t, e.findings.every((f) => f.code === 'PROFILE_UNSUPPORTED_CONSTRUCT'), `${target}: the refusal is the unsupported construct`);
      }
      const multipart = fresh();
      pick(multipart.operations, 'order.place').bindings![0]!.requestMediaType = 'multipart/form-data';
      assertThrows(t, () => renderTarget(multipart, 'openapi', { draft: true }), 'a multipart body is refused, never drafted', (x) => x instanceof LoomInvalidModelError && x.findings.some((f) => f.code === 'PROFILE_UNSUPPORTED_CONSTRUCT'));
      for (const [target, construct] of [['sql', 'check.prose'], ['csharp-contract-tests', 'type.union'], ['typescript-contract-tests', 'type.union'], ['openapi', 'http.multipart'], ['openapi', 'type.decimalRange'], ['json-schema', 'type.externalSchema']] as const) {
        assert(t, unsupportedConstructs(target).includes(construct), `${target}'s profile declares ${construct}, which its renderer can report`);
      }
    },
  },
  {
    name: 'coverage guard',
    run: (t) => {
      const m = sampleModel();
      const dropping: TargetSpec = {
        files: ['schema.json'],
        render: (model, ctx) => {
          for (const x of model.types.slice(1)) ctx.covered({ kind: 'type', id: x.id }, 'schema.json', `/$defs/${x.id}`);
          return { 'schema.json': { $defs: Object.fromEntries(model.types.slice(1).map((x) => [x.id, {}])) } };
        },
        scope: (model) => model.types.map((x) => ({ kind: 'type', id: x.id })),
      };
      const lost = assertThrows(t, () => renderWithSpec(m, 'json-schema', dropping), 'a renderer that drops an in-scope record is refused', (e) => e instanceof LoomInvalidModelError) as LoomInvalidModelError;
      observe(t, lost.findings);
      assert(t, lost.findings.length === 1 && lost.findings[0]!.code === 'PROJECTION_COVERAGE_LOSS' && lost.findings[0]!.refs?.[0]?.id === m.types[0]!.id, 'the loss names the dropped record');
      const lying: TargetSpec = {
        ...dropping,
        render: (model, ctx) => {
          for (const x of model.types) ctx.covered({ kind: 'type', id: x.id }, 'schema.json', `/$defs/${x.id}`);
          return { 'schema.json': { $defs: Object.fromEntries(model.types.slice(1).map((x) => [x.id, {}])) } };
        },
      };
      const claimed = assertThrows(t, () => renderWithSpec(m, 'json-schema', lying), 'a coverage location the output does not hold is refused', (e) => e instanceof LoomInvalidModelError) as LoomInvalidModelError;
      assert(t, codesOf(observe(t, claimed.findings)).every((c) => c === 'PROJECTION_COVERAGE_LOSS'), 'a false location is a coverage loss');
      const honest = renderWithSpec(m, 'json-schema', { ...dropping, scope: (model) => model.types.slice(1).map((x) => ({ kind: 'type', id: x.id })) });
      assert(t, honest.coverage.complete && honest.coverage.items.length === m.types.length - 1, 'a renderer that covers its scope passes the guard');
    },
  },
];
