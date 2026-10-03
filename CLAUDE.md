# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It loads on top of `~/.claude/CLAUDE.md` and the superproject's `../../CLAUDE.md` and carries only
what is specific to Loom. The designer's conventions are in `apps/designer/CLAUDE.md`. `README.md`
is the entry point and routes to the contract, the components and their boundaries;
`Docs/workflow-integration.md` is the workflow-integration interface contract and `Docs/ToDo.md`
the open-items register. Workspace scripts: @package.json

## Commands

- Run from `Tools/loom`. `npm run build` comes first: it checks the generated contract artifacts
  for drift, then compiles. The CLI, the MCP server and the designer all execute the built
  `packages/*/dist`, never the sources.
- `npm run generate` regenerates `packages/core/schema/patch.schema.json`,
  `packages/core/src/generated/*` and `Docs/operations.md` from the authored schemas and the
  operation catalogue; never edit those files by hand.
- `npm run self-test` is the whole proof: the engine battery, the CLI's drift check, the release
  wording of Loom's own documents, comments and JSON descriptions (`docs --check --self` reports
  it with the other documentation checks), then every profile check run by
  `packages/qualification` against Loom's own fixtures under `qualification/policy.json`. The core has no per-test runner; `selfTest()` throws on the first
  failed assertion and names it. `npm run test:workspace`, `npm run test:qualification`,
  `npm run test:cli` and `npm run test:mcp` run the adapters' node:test suites,
  `npm run test:fixtures` runs every case of `qualification/fixtures` against its authored
  expectation, and `npm run smoke:mcp` checks every MCP result against the full contract and
  its advertised output schema, the schema resources the tools name, and the tool budget.
- A check reports `PASS` or `FAIL` only when its tool ran. `UNKNOWN` means the tool was absent,
  outside its profile's version policy, unreadable, crashed or timed out, or its database refused
  the connection or login, and is never a pass; a required `UNKNOWN` fails the self-test.
- Running `packages/cli/dist/index.js` with node and no arguments prints the CLI usage. Its
  `check` command is the drift gate: it compares the installed outputs and the manifest with a
  fresh projection, and with `--out <dir>` a directory of projections, and never writes.
- Never run `npx loom` or install `loom` from the registry. The workspace links no `loom` command,
  so npx fetches the unrelated public package of that name. Run the CLI by path.
- After a core change, also build and test `apps/designer`, because it executes the built core
  directly.

## Architecture

- `packages/core/schema` holds the contract, authored once as JSON Schema 2020-12: the model,
  patches (derived), results, tool inputs, workspace and assurance records, profiles, interface
  control documents, the operation catalogue and hand-authored fixtures. `packages/core/scripts/generate.mjs` emits the TypeScript types,
  the embedded schema bundle, the registries, the contract digest and the operation views (tool
  descriptions, CLI usage and dispatch words) into `src/generated`, and the operation reference
  `Docs/operations.md`.
- `packages/core` is pure: no Node or browser-only API. The same engine runs in the CLI, the MCP
  server and the browser designer; file IO lives only in the adapters (`packages/workspace`,
  `packages/qualification`, `packages/cli`), stdio only in `packages/mcp-server`.
- One pipeline, every step in `packages/core/src`:
  - `importModel` reads JSON or YAML; `loadModel` checks the structure against the generated
    bundle with Ajv 2020-12 and refuses another model format version.
  - `validate` runs the rule passes in `src/rules`. Every finding carries a stable code, a path,
    its impact (consumers with their dependency paths, `packages/core/src/graph.ts`) and a one-line `fix`.
  - `mutate` applies one patch or an atomic batch to a clone, re-validates and compares. It
    refuses a breaking or unclassified change that lacks a version bump or an
    `acknowledgeBreaking` entry. A refusal returns `model: null`.
  - `diff` walks both models along the schema and classifies every field-level delta through
    `FIELD_POLICY`; a delta without a policy is `requiresReview`.
  - `project` and `projectToFiles` dispatch to the emitters in `src/projections`. `exportModel`
    writes canonical JSON. Both fail closed on any error finding.
- References are declared by the schema's `x-loom-ref` annotations and resolved generically in
  `packages/core/src/refs.ts`. A `binds` names '<typeId>.<propertyName>' and resolves by the longest known type id
  prefix (`resolveProperty` in `packages/core/src/records.ts`); ids may contain dots and property names may not.
  Physical tables belong to storage records, owned by the component that owns the stored type.
- Single homes:

  | Fact | Home |
  | --- | --- |
  | Every record, patch, result and workspace shape | `packages/core/schema/*.schema.json` |
  | Every operation: purpose, prerequisites, effects, refusals, next action, presence rules, examples and its MCP tool and CLI command | `packages/core/schema/operations.json`; the MCP tool list and descriptions, the tools and examples of `loom.describe`, the CLI usage and dispatch words and `Docs/operations.md` are generated from it, and the adapters' handler tables are checked against it |
  | The size budget of one advertised MCP tool definition | `mcp.toolBudget` in `packages/core/schema/operations.json`; the smoke test holds every tool and tools/list to it |
  | How an advertised tool schema is compacted and which schema resources the server lists | `inputSchemaOf`, `outputSchemaOf` and `advertisedDefinitions` in `packages/mcp-server/src/tools.ts` |
  | The finding-code vocabulary | `FindingCode` in `packages/core/schema/result.schema.json` |
  | Each code's severity and one-line rule | `FINDING_RULES` in `packages/core/src/codes.ts` |
  | Change rules and the comparison decision for every model field | `DIFF_RULES` and `FIELD_POLICY` in `packages/core/src/field-policy.ts` |
  | The human-readable rule list | the Rules section of the `reference` projection, rendered from both tables |
  | Logical kind to SQL Server type families and physical limits | `packages/core/src/sql-types.ts` |
  | Source-notice text | `packages/core/src/projections/notice.ts` |
  | Projection targets: their files, renderer and in-scope records | `TARGETS` in `packages/core/src/project.ts`; `PROJECTION_TARGETS` and `PROJECTION_FILES` derive from it, and the MCP tool enum and the designer read those |
  | Whether a target is singleton or per-component, and the language a component must declare for it | the `artifacts` of the profiles in `packages/core/schema/profiles` |
  | The fixture model every test and the designer load | `packages/core/src/sample.ts` |

## Rules

- **Edit the model, never a projection.** Every projected file opens with a source notice, and
  `check` reports a hand edit as drift.
- **Keep projection output deterministic:** no timestamps, random values or machine paths. Drift
  detection compares bytes, and `selfTest()` renders every target twice and compares.
- **A new semantic rule** adds its code to `FindingCode` in `packages/core/schema/result.schema.json`
  (then `npm run generate`), its severity and one-line rule to `FINDING_RULES`, and returns a
  finding with `path`, `impact` and an imperative `fix`. It also needs a `CONTRADICTIONS` entry in
  `packages/core/src/selftest/contradictions.ts`: the self-test asserts that each entry yields its
  code with a fix, and its code accounting fails on any code nothing raises unless
  `RAISED_ELSEWHERE` in `packages/core/src/selftest/index.ts` names the part that raises it.
- **A new comparison rule** adds its description to `DIFF_RULES` and is named by a `FIELD_POLICY`
  entry, with a case in `packages/core/src/selftest/diffs.ts`; the self-test fails on a rule no
  case emits.
- **A model-format change** edits `packages/core/schema/model.schema.json`, regenerates, adds a
  `FIELD_POLICY` entry for every new field and keeps `packages/core/src/sample.ts` valid. The
  self-test fails on a field the comparison walk reaches without a policy, so a new field cannot
  bypass comparison.
- **A new projection target** is added to the contract's `ProjectionTarget`, to a profile's
  `artifacts` and to `TARGETS` with its files, renderer and scope. The renderer reports every
  in-scope record through `ctx.covered` or `ctx.unsupported`; a record it drops fails the projection
  with `PROJECTION_COVERAGE_LOSS`. Every construct it can report as unsupported is listed in its
  profile's `unsupported`. The self-test's determinism, fail-closed and independent-coverage loops
  then cover it.
- **The engine checks declared contracts; it never executes them.** `packages/core` never executes
  SQL or PowerShell and never calls a live service. Routine contracts become generated conformance
  tests, the `sql-contract-tests` and `pester-contract-tests` targets, which the adopting pipeline
  runs against its own real artifacts. Do not add execution to the engine: native tools run only in
  `packages/qualification`, through the built-in runner a profile check names, in the run's own
  temporary directory and, for database checks, its own LocalDB instance.
- **The MCP server writes only JSON-RPC to stdout.** Any other output corrupts the protocol, so
  status goes to stderr.
- **Keep the fixtures' roles.** `examples/conforming` must pass and `examples/violating` must fail
  every conformance check that runs them: the Pester checks, `sql.behavior`, `csharp.conformance`
  and `typescript.conformance` (`selfFixtures` in `packages/qualification/src/selfqualify.ts`
  wires them). The violating SQL fixture must break exactly the one contract named by its header
  comment and the `negativeControl.reason` of `sql.behavior` in
  `packages/core/schema/profiles/sql.json`.
