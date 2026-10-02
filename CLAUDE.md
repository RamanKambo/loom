# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It loads on top of `~/.claude/CLAUDE.md` and the superproject's `../../CLAUDE.md` and carries only
what is specific to Loom. The designer's conventions are in `apps/designer/CLAUDE.md`. `README.md`
routes to the model contract, the projections and the conformance-check boundary. Workspace
scripts: @package.json

## Commands

- Run from `Tools/loom`. `npm run build` comes first: the CLI, the MCP server and the designer all
  execute the built `packages/*/dist`, never the sources.
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

- `packages/core` is pure: no Node or browser-only API. The same engine runs in the CLI, the MCP
  server and the browser designer; file IO lives only in `packages/cli`, stdio only in
  `packages/mcp-server`.
- One pipeline, every step in `packages/core/src`:
  - `importModel` reads JSON or YAML and checks the structure against
    `packages/core/src/meta-schema.ts`, via Ajv.
  - `validate` applies the semantic rules. Every finding carries a stable code, a path, its impact
    set (reverse reachability, `packages/core/src/reachability.ts`) and a one-line `fix`.
  - `mutate` applies one patch or an atomic batch to a clone, re-validates and diffs. It refuses a
    breaking change that lacks a version bump or an `acknowledgeBreaking` entry. A refusal returns
    `model: null`.
  - `project` and `projectToFiles` dispatch to the emitters in `packages/core/src/projections`.
    `exportModel` writes canonical JSON. Both fail closed on any error finding.
- Consumers declare what they expect. A routine param or result column `binds` a
  `typeId.propertyName`, and so does a property that references another type's key (a foreign key,
  which makes its type a consumer in `packages/core/src/reachability.ts`). Each resolves by the
  longest known id prefix in `packages/core/src/refs.ts`; ids may contain dots and property names
  may not. A table name is `<component>.<table>`, and the prefix owns the table.
- Single homes:

  | Fact | Home |
  | --- | --- |
  | Finding codes | `packages/core/src/codes.ts` |
  | Kind to T-SQL mapping and type families | `packages/core/src/sql-types.ts` |
  | Source-notice text | `packages/core/src/projections/notice.ts` |
  | Projection targets and their file names | `PROJECTION_TARGETS` and `PROJECTION_FILES` in `packages/core/src/project.ts`; the MCP tool enum and the designer read them |
  | The fixture model every test and the designer load | `packages/core/src/sample.ts` |

## Rules

- **Edit the model, never a projection.** Every projected file opens with a source notice, and
  `--check <model> <dir>` reports a hand edit as drift.
- **Keep projection output deterministic:** no timestamps, random values or machine paths. Drift
  detection compares bytes, and `selfTest()` renders every target twice and compares.
- **A new semantic rule** adds its code to `packages/core/src/codes.ts` and returns a finding with
  `path`, `impact` and an imperative `fix`. It also needs a `CONTRADICTIONS` entry in
  `packages/core/src/selftest.ts`: the self-test asserts that each entry yields its code with a fix,
  which is the proof that the rule can fire.
- **A new breaking-change rule** goes in `packages/core/src/diff.ts`, with a `BREAKING_DIFFS` entry
  in the same self-test.
- **A model-format change** edits `packages/core/src/types.ts` and `packages/core/src/meta-schema.ts`
  together, and keeps `packages/core/src/sample.ts` valid. The meta-schema runs before every semantic
  rule, so a field it lacks is rejected on import.
- **A new projection target** is added to both `PROJECTION_TARGETS` and `PROJECTION_FILES`. The
  self-test's determinism and fail-closed loops then cover it with no further change.
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
