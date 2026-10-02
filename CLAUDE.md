# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It loads on top of `~/.claude/CLAUDE.md` and the superproject's `../../CLAUDE.md` and carries only
what is specific to Loom. The designer's conventions are in `apps/designer/CLAUDE.md`. `README.md`
routes to the model contract, the projections and the conformance-check boundary. Workspace
scripts: @package.json

## Commands

- Run from `Tools/loom`. `npm run build` comes first: it checks the generated contract artifacts
  for drift, then compiles. The CLI, the MCP server and the designer all execute the built
  `packages/*/dist`, never the sources.
- `npm run generate` regenerates `packages/core/schema/patch.schema.json` and
  `packages/core/src/generated/*` from the authored schemas; never edit those files by hand.
- `npm run self-test` is the whole proof: the engine battery, then the CLI's drift check and probes.
  The core has no per-test runner; `selfTest()` throws on the first failed assertion and names it.
- A probe reports `PASS` or `FAIL` only when its tool ran. `UNKNOWN` means the tool was absent or
  unreadable and is never a pass.
- Running `packages/cli/dist/index.js` with node and no arguments prints the CLI usage. Its
  `--check <model> <dir>` mode is the drift gate: it compares committed projections with a fresh
  projection and never writes.
- Never run `npx loom` or install `loom` from the registry. The workspace links no `loom` command,
  so npx fetches the unrelated public package of that name. Run the CLI by path.
- After a core change, also build and test `apps/designer`, because it executes the built core
  directly.

## Architecture

- `packages/core/schema` holds the contract, authored once as JSON Schema 2020-12: the model,
  patches (derived), results, tool inputs, workspace and assurance records, profiles, interface
  control documents and hand-authored fixtures. `packages/core/scripts/generate.mjs` emits the TypeScript types,
  the embedded schema bundle, the registries and the contract digest into `src/generated`.
- `packages/core` is pure: no Node or browser-only API. The same engine runs in the CLI, the MCP
  server and the browser designer; file IO lives only in `packages/cli`, stdio only in
  `packages/mcp-server`.
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
  | The finding-code vocabulary | `FindingCode` in `packages/core/schema/result.schema.json` |
  | Each code's severity and one-line rule | `FINDING_RULES` in `packages/core/src/codes.ts` |
  | Change rules and the comparison decision for every model field | `DIFF_RULES` and `FIELD_POLICY` in `packages/core/src/field-policy.ts` |
  | The human-readable rule list | the Rules section of the `reference` projection, rendered from both tables |
  | Logical kind to SQL Server type families and physical limits | `packages/core/src/sql-types.ts` |
  | Source-notice text | `packages/core/src/projections/notice.ts` |
  | Projection targets and their file names | `RENDERERS` and `PROJECTION_FILES` in `packages/core/src/project.ts`; the MCP tool enum and the designer read them |
  | The fixture model every test and the designer load | `packages/core/src/sample.ts` |

## Rules

- **Edit the model, never a projection.** Every projected file opens with a source notice, and
  `--check <model> <dir>` reports a hand edit as drift.
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
- **A new projection target** is added to the contract's `ProjectionTarget`, to `RENDERERS` and to
  `PROJECTION_FILES`. The self-test's determinism and fail-closed loops then cover it.
- **The engine checks declared contracts; it never executes them.** `packages/core` never executes
  SQL or PowerShell and never calls a live service. Routine contracts become generated conformance
  tests, the `sql-contract-tests` and `pester-contract-tests` targets, which the adopting pipeline
  runs against its own real artifacts. Do not add execution to the engine — the CLI self-test's
  probe (f) (`packages/cli/src/probes.ts`) proves `sql-contract-tests` against a disposable LocalDB
  database it creates and drops itself, but that stays in `packages/cli`, never the engine.
- **The MCP server writes only JSON-RPC to stdout.** Any other output corrupts the protocol, so
  status goes to stderr.
- **Keep the fixtures' roles.** `examples/conforming` must pass and `examples/violating` must fail
  both the generated Pester file (probe (b), on `examples/conforming/fulfillment/rb_dispatch.ps1`
  and its violating copy) and the generated `contract-tests.sql` run against a real database
  (probe (f), on `examples/conforming/ordering/sp_place_order.sql` and its violating copy). The
  violating SQL fixture must break exactly the one contract named by its header comment and the
  `EXPECTED_VIOLATION_CODE` in `packages/cli/src/probes.ts`.
