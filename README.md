# Loom

Loom is a free, schema-driven systems-engineering tool. One portable model is the single source
of truth; every artifact is projected from it; mutations cascade. Its purpose is to catch the
cross-cutting mutation errors that are easy to introduce when editing a system piecemeal — a
renamed field that a consumer still imports, a state transition to a state that no longer
exists, a routine that writes a table it does not own, a mutation that loses its traceability.
A bad mutation is rejected with a precise finding, and the model refuses to serialize or project
until it is valid again (fail-closed).

## Design

- **One model, many projections.** The model is plain data, authored as JSON or YAML. Schemas,
  APIs, DDL, conformance checks, diagrams and the reference are *projected* from it and are never
  edited by hand; the CLI's `--check` reports any projected file that has drifted.
- **Pure, isomorphic core.** `@loom/core` has no filesystem, network, or Node-only
  dependency, so the same engine runs in the CLI, the MCP server and the browser designer. File IO
  lives only in the CLI; process/stdio IO only in the MCP server.
- **Deterministic output.** Serialization is canonical (object keys sorted, array order
  preserved). The same model always produces byte-identical output — no timestamps, no
  random values, no machine paths. Every projection opens with a source notice in its own syntax.
- **Fail-closed.** `project()`, `projectToFiles()` and `exportModel()` throw if the model has any
  error finding, so an invalid model can never leak into a downstream artifact.
- **Declared contracts only.** Loom never executes SQL or PowerShell and never calls a live
  service. Routine contracts project to conformance checks that a pipeline runs against the real
  artifacts (see [Conformance checks](#conformance-checks)).

## Layout

An npm-workspaces monorepo:

| Package | Role |
| --- | --- |
| `packages/core` | Pure engine: load, validate, mutate, diff, project, export. Deps: `ajv`, `ajv-formats`, `yaml`. |
| `packages/cli` | File IO front end (`--self-test`, `--check`, `--write`): drift check and the standard-tool probes. Also validates the OpenAPI projection with `@apidevtools/swagger-parser` and every projected Mermaid diagram with `mermaid` (`jsdom` supplies the `document` it needs). |
| `packages/mcp-server` | Model Context Protocol server (stdio) exposing the engine as tools. Dep: `@modelcontextprotocol/sdk`. |
| `apps/designer` | Angular 22 designer, a thin projection of the core; it consumes `@loom/core` through a `file:` link to `packages/core` and has its own `package.json` and lockfile (see [Designer](#designer)). |
| `examples/` | Test fixtures for the generated Pester file: `conforming/` and `violating/` copies of the sample runbook. |

## Build and test

```sh
npm install          # install workspace dependencies
npm run build        # tsc -b across all packages
npm run self-test    # engine self-test, drift check and standard-tool probes via the CLI
npm run smoke:mcp    # in-memory MCP smoke test (enumerate + call tools)
```

The engine self-test (`packages/core/src/selftest.ts`) passes the sample model, then breaks it
on purpose: every validate rule and every breaking-diff rule has a deliberate contradiction that
must yield its finding code, at its path, with a fix. It also proves the mutation gate (refused
without a version bump, without acknowledgment, or with a stale bound consumer; accepted as the
complete batch), determinism and fail-closed refusal for every projection target, and lossless
JSON and YAML round-trips.

The CLI self-test then proves the drift check and validates the OpenAPI projection with
`swagger-parser`, and runs the standard-tool probes. A probe reports `PASS` or `FAIL` only when its
tool ran; an absent tool, a load failure or an unreadable result is `UNKNOWN`, never a pass.
Probes (a)-(c) use external tools that nothing in this repository installs. Probes (d) and (e) use
declared dependencies, `yaml` through `importModel` and `mermaid` with `jsdom`; (e) is `UNKNOWN`
only if `mermaid` or `jsdom` fails to load.

| Probe | Proof | Tool |
| --- | --- | --- |
| (a) | `Routines.Contract.Tests.ps1` parses with zero errors | `pwsh` and `[System.Management.Automation.Language.Parser]::ParseFile` |
| (b) | The generated tests pass on `examples/conforming` and fail on `examples/violating` | Pester, the newest installed release of each major from 5, one process per release |
| (c) | `schema.sql` and `contract-tests.sql` parse with zero errors | `Microsoft.SqlServer.TransactSql.ScriptDom`, the newest `TSqlNNNParser`, from `PSModulePath` or a NuGet, DacFx, SSMS, Visual Studio or Azure Data Studio install |
| (d) | `model.yaml` parses back to the identical canonical model | `importModel` (the `yaml` package) |
| (e) | Every `stateDiagram-v2` and `flowchart` Mermaid block in `workflows.md` and `reference.md` parses, and a deliberately malformed diagram is rejected | `mermaid.parse()`, with `jsdom` supplying the `document` it needs |

## CLI

The CLI is `packages/cli/dist/index.js`, run with `node`. Its usage text calls it `loom`, but run
it by path: the workspace does not link a `loom` command, and `npx loom` resolves the unscoped name
on the public npm registry, where `loom` is an unrelated package.

```sh
node packages/cli/dist/index.js --self-test              # engine self-test, drift check and probes
node packages/cli/dist/index.js --check <model> [dir]    # validate; with <dir>, also check every projected file for drift
node packages/cli/dist/index.js --write <model> <dir>    # write every projection into <dir>
```

`<model>` is a JSON or YAML model file. `--check` prints each finding with its fix and the finding
count, and exits non-zero on any error finding. With `<dir>` it compares each expected file
byte-for-byte with the file on disk, reading CRLF as LF. It prints `DRIFT <file>: missing` or
`DRIFT <file>: stale` per drifted file, warns on files that are not projections, never writes,
and exits non-zero on any drift. Committing the `--write` output and running `--check <model> <dir>`
in CI therefore fails the build whenever a projected file and the model disagree.

## Walkthrough

The sample model shows the loop end to end. Shell commands run under the repository root after
`npm install` and `npm run build`; `loom.*` steps are MCP tool calls.

1. Write and validate the sample model.

   ```sh
   node --input-type=module -e "import { writeFileSync } from 'node:fs'; import { exportModel, sampleModel } from '@loom/core'; writeFileSync('model.json', exportModel(sampleModel()) + '\n')"
   node packages/cli/dist/index.js --check model.json
   # loom check: 0 finding(s) - 0 error, 0 warning.
   ```

2. Attempt `order.id` from string to integer as a single patch. `loom.mutate` with
   `{ "model": <model.json>, "patch": { "op": "changeProperty", "typeId": "order", "propertyName": "id", "set": { "kind": "integer" } } }`
   returns `"refused": true` and these error findings, which name both bound consumers:

   | Code | Fix |
   | --- | --- |
   | `BOUNDS_KIND_MISMATCH` | remove maxLength from the bounds of 'order.id' |
   | `BINDING_KIND_MISMATCH` | set result column 'order_id' kind to 'integer', then bump routine 'ordering.sp_place_order' version and list 'ordering.sp_place_order' in acknowledgeBreaking |
   | `BINDING_KIND_MISMATCH` | set param 'OrderId' kind to 'integer', then bump routine 'fulfillment.rb_dispatch' version and list 'fulfillment.rb_dispatch' in acknowledgeBreaking |
   | `BREAKING_CHANGE_WITHOUT_VERSION_BUMP` | bump type 'order' version above 1 and list 'order' in acknowledgeBreaking |
   | `BREAKING_CHANGE_UNACKNOWLEDGED` | list 'order' in acknowledgeBreaking to confirm the breaking change is intended |

3. Apply the fixes as one atomic batch. Bumping `order` to version 2 also makes the two workflow
   pins of `order` stale (`WORKFLOW_IMPORT_VERSION_MISMATCH`), so the batch moves them too.
   `loom.mutate` with `model` plus:

   ```json
   {
     "patches": [
       { "op": "setVersion", "target": "type", "id": "order", "version": 2 },
       { "op": "changeProperty", "typeId": "order", "propertyName": "id", "set": { "kind": "integer", "bounds": null } },
       { "op": "changeRoutine", "routineId": "ordering.sp_place_order", "set": { "version": 2, "resultSet": [
         { "name": "order_id", "kind": "integer", "nullable": false, "binds": "order.id" },
         { "name": "status", "kind": "enum", "nullable": false, "binds": "order.status" } ] } },
       { "op": "changeRoutine", "routineId": "fulfillment.rb_dispatch", "set": { "version": 2, "params": [
         { "name": "OrderId", "kind": "integer", "required": true, "nullable": false, "binds": "order.id" },
         { "name": "InitialState", "kind": "enum", "required": false, "nullable": false, "binds": "shipment.state" },
         { "name": "Notify", "kind": "boolean", "required": false, "nullable": false } ] } },
       { "op": "changeWorkflowImport", "workflowId": "wf.checkout", "typeId": "order", "version": 2 },
       { "op": "changeWorkflowImport", "workflowId": "wf.reporting", "typeId": "order", "version": 2 }
     ],
     "acknowledgeBreaking": ["order", "ordering.sp_place_order", "fulfillment.rb_dispatch"]
   }
   ```

   The result is `"refused": false` with three breaking changes, one per acknowledged element.
   Write the returned `model` back to `model.json` (`loom.export` renders it as canonical JSON).

4. Project every artifact: `loom.projectAll` returns the file map, and the CLI writes it.

   ```sh
   node packages/cli/dist/index.js --write model.json generated
   # writes one file per entry in PROJECTION_FILES into generated/
   ```

5. Gate drift. A fresh projection checks clean; a hand edit to a projected file fails the check.

   ```sh
   node packages/cli/dist/index.js --check model.json generated
   # every projected file matches the model                                     (exit 0)
   # after editing generated/schema.sql:
   # DRIFT schema.sql: stale                                                     (exit 1)
   ```

6. Run the conformance checks in the pipeline, against the real scripts and a database the
   pipeline owns; Loom itself connects to neither.

   ```powershell
   Invoke-Pester -Container (New-PesterContainer -Path ./generated/Routines.Contract.Tests.ps1 -Data @{ RoutineRoot = '<repository root>' })
   Invoke-Sqlcmd -ServerInstance '<server>' -Database '<database>' -InputFile ./generated/contract-tests.sql -AbortOnError
   ```

   ```sh
   sqlcmd -b -S <server> -d <database> -i generated/contract-tests.sql
   ```

   `sqlcmd -b` exits with `ERRORLEVEL` 1 on an error above severity 10, and a contract `THROW`
   raises severity 16 (Microsoft Learn, *sqlcmd utility*, `-b`; *THROW*). After step 3 the unchanged
   `examples/conforming` runbook, which still declares `[string] $OrderId`, fails
   `parameter OrderId is typed for kind integer` (9 passed, 1 failed) until the script declares
   `[long]`.

## The model

A model is a single object with: `version`, `components`, `types`, `operations`, `routines`,
`mutations`, `workflows`, `edges`, `requirements`, `scenarios`. Types, operations and routines
are versioned contracts: each carries a required `version`. A type may name its backing `table`
and must then name the `key` properties that identify a row. A routine may name its `source` file
(repository-relative), list the `writesColumns` it writes as `<table>.<column>`, and declare on a
param or result column `binds: 'typeId.propertyName'`, the producer property it expects. Ids may
contain dots, so bindings, table qualifiers and written columns resolve by the longest known id or
table prefix.

Each model is first checked against a structural meta-schema (via Ajv), then against the
semantic rules:

- id uniqueness across all records; reference integrity for every id, including bindings;
- `mutation.owner` must equal the owner of its type; `from`/`to` must be legal states of the
  type's `stateProperty` enum; an immutable property may be written only during creation
  (`from` includes `$absent`), which must write every required property;
- length bounds (`minLength`, `maxLength`) apply only to strings and numeric bounds (`min`,
  `max`) only to integers and numbers; an enum property must list at least one value in
  `enumValues`;
- tables are schema-qualified `<component>.<table>` (an unqualified name is owned by the
  declaring element's owner): a type's `table` must be owned by the type's owner, no two types may
  bind the same table, and a routine may only write tables its owner owns;
- a table-backed type needs a `key`; every key property must exist and be required and
  non-nullable. A table-backed key must also be a valid SQL Server primary key: a string key
  property needs a `maxLength` of at most 4,000, because an `NVARCHAR(MAX)` column cannot be an index
  key column, and a key holds at most 32 columns. A key declaring more than 900 bytes is a warning:
  SQL Server accepts it but rejects writes whose key data exceeds 900 bytes (Microsoft Learn,
  *Maximum capacity specifications for SQL Server*, Database Engine objects);
- a routine may only perform mutations it owns, and must list in `writesTables` the table of
  every table-backed type it mutates; each `writesColumns` entry must name a table in its
  `writesTables` and a property of the type bound to that table; its `source` must be
  repository-relative (no leading slash or drive letter); its result set must be non-empty with
  uniquely-named columns;
- a bound param or column must match its producer property's kind and nullability exactly, and a
  param or column of kind `enum` must bind an enum property, which supplies its values;
- a workflow's import must pin the imported type's current version (an error, so a version
  bump must carry its pinned consumers in the same change); dependency graphs must be acyclic;
- every mutation must trace to at least one requirement and one scenario, and a scenario must
  cover one of its requirements.

Every finding names the offending element, the rule, its impact set, and a one-line `fix`.

`diff()` classifies each change as breaking or compatible and attributes it to the element
that changed. Breaking, with consumers listed by reverse-reachability:

- types: the `owner`, `stateProperty`, `table` or `key` changed;
- type properties: removed; kind changed; nullability changed (either direction); became
  required; became optional; became immutable; an enum value removed; a bound tightened (added,
  `min`/`minLength` raised, `max`/`maxLength` lowered); a new required property;
- routines: the `owner` or `host` changed; params removed, retyped, nullability changed,
  optional to required, or a required param added; result columns removed, retyped, reordered or
  with nullability changed; any `binds` change;
- operations: the `owner` or kind changed; request/response/result type changed; an HTTP
  binding removed or its method/path changed;
- an authority permission changed or a scope added/changed, on an operation or routine;
- a type, operation, routine, mutation or workflow removed.

Loosened bounds, optional additions, added enum values, appended result columns, added
bindings, a removed authority scope and a moved routine `source` are compatible.

## Projections

Every target is a pure function of a valid model. `projectToFiles()` and `loom --write` emit them
all under these file names.

| Target | File | Content |
| --- | --- | --- |
| `json-schema` | `schema.json` | JSON Schema 2020-12, one `$defs` entry per type. |
| `openapi` | `openapi.json` | OpenAPI 3.1 paths from the operations' HTTP bindings, with the types as component schemas. |
| `sql` | `schema.sql` | T-SQL DDL: one `CREATE SCHEMA` per component that owns a table (`dbo` excepted) and one `CREATE TABLE` per table-backed type, with `PRIMARY KEY` from `key` and a `CHECK` per enum. Procedure bodies are outside the model. |
| `sql-contract-tests` | `contract-tests.sql` | T-SQL conformance checks, one batch per `sql-procedure` routine and per table-backed type. |
| `pester-contract-tests` | `Routines.Contract.Tests.ps1` | One Pester 5 test file for the `runbook` and `function` routines that declare a `source`; it also runs under Pester 6. |
| `yaml` | `model.yaml` | The canonical model as YAML 1.2, keys sorted. `importModel()` reads it back losslessly. |
| `workflow` | `workflows.md` | Mermaid: a `stateDiagram-v2` per stateful type (transitions from its mutations, `[*]` for `$absent`) and a flowchart of workflows with their dependencies, operations and mutations. |
| `reference` | `reference.md` | Markdown reference by component (types, operations, routines, mutations), then workflows, a consumers index by reverse reachability, and the workflow diagrams. |

The SQL kind mapping is: string → `NVARCHAR(maxLength)`, or `NVARCHAR(MAX)` when there is no
`maxLength` or it exceeds 4,000; integer → `BIGINT`; number → `FLOAT`; boolean → `BIT`; enum →
`NVARCHAR(longest value)` plus a `CHECK (col IN (...))`. `NULL` / `NOT NULL` follows `nullable`.
A table's schema is its owning component (`ordering.orders` → `[ordering].[orders]`). A procedure's
SQL name is `[owner].[routine id without its "<owner>." prefix]` (`ordering.sp_place_order` →
`[ordering].[sp_place_order]`).

## Conformance checks

Loom models declared contracts; the two contract-test projections let a pipeline prove that the
real procedures, tables and scripts still match them. Both are read-only and idempotent:
`contract-tests.sql` holds only `SELECT` (inside `IF` predicates) and `THROW`, and the Pester file
parses each script without executing it. Each `.sql` block is one batch, so run the file with
`sqlcmd -b` to fail the pipeline on the first broken contract.

| Contract | Checked by | Failure |
| --- | --- | --- |
| The procedure exists | `OBJECT_ID(..., N'P')` | `THROW 50001` |
| Parameter names, order and count | `sys.parameters` against the contract list | `THROW 50002` |
| Each parameter's type family | `TYPE_NAME(system_type_id)` | `THROW 50003` |
| The first result set can be described | `sys.dm_exec_describe_first_result_set_for_object` | `THROW 50004` |
| Result column names, order and count | same DMF, `column_ordinal` and `name` | `THROW 50005` |
| Each result column's nullability | same DMF, `is_nullable` | `THROW 50006` |
| Each result column's type family | same DMF, `TYPE_NAME(system_type_id)` | `THROW 50007` |
| The table exists | `OBJECT_ID(..., N'U')` | `THROW 50011` |
| Each property column exists | `INFORMATION_SCHEMA.COLUMNS` | `THROW 50012` |
| Each column's nullability | `INFORMATION_SCHEMA.COLUMNS.IS_NULLABLE` | `THROW 50013` |
| Each column's type family | `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` | `THROW 50014` |
| Script parameter names and order | `ParamBlock.Parameters` of the parsed script | failed `It` |
| Script parameter `Mandatory` equals `required` | the `[Parameter(Mandatory)]` attribute | failed `It` |
| Script parameter type fits the kind | the type constraint's resolved .NET type | failed `It` |
| An enum param bound to an enum property allows exactly its values | the `[ValidateSet(...)]` attribute | failed `It` |

Type families: string → `char`, `varchar`, `nchar`, `nvarchar`, `text`, `ntext`,
`uniqueidentifier`; integer → `tinyint`, `smallint`, `int`, `bigint`; number → `decimal`, `numeric`,
`float`, `real`, `money`, `smallmoney`; boolean → `bit`; enum → `char`, `varchar`, `nchar`,
`nvarchar`. PowerShell types: string and enum → `[string]`; integer → `[int]` or `[long]`; number →
`[double]`, `[decimal]` or `[single]`; boolean → `[bool]` or `[switch]`. The Pester file takes the
script root as `-Data @{ RoutineRoot = '<repository root>' }` (default: the current directory) and
resolves each script as `Join-Path $RoutineRoot <source>`.

Not verified, by design or by limit of the platform:

| Not checked | Reason |
| --- | --- |
| A runbook's or function's output shape | It exists only at run time; a static parse cannot see it, so no test is emitted for it. |
| Whether a SQL parameter is required or nullable | `sys.parameters.has_default_value` is `0` for Transact-SQL objects and `is_nullable` applies to natively compiled procedures only (Microsoft Learn, *sys.parameters*). |
| Procedure and script bodies: what they read, write or compute | The body is outside the model; `writesTables` and `writesColumns` are declarations. |
| Result sets after the first | `sys.dm_exec_describe_first_result_set_for_object` describes the first result set only. |
| Live table keys and constraints, and columns the model does not declare | The table checks cover the declared property columns only. |
| Live HTTP services | The OpenAPI projection is validated as a document, never against a running service. |

## Engine API (`@loom/core`)

The exported functions and types are `packages/core/src/index.ts`. `mutate(model, patchOrPatches,
{ acknowledgeBreaking })` applies one patch or an atomic batch to a copy, re-validates and diffs
against the input; it returns `model: null` (refused) when any patch misses its target, the result
has an error finding, or a breaking change fails the gate below. `project()`, `projectToFiles()`
and `exportModel()` throw on an invalid model.

### The breaking-change gate

A breaking change cannot land silently. For every element with a breaking change, `mutate()`
requires that a still-present type, operation or routine carries a higher `version`
(`BREAKING_CHANGE_WITHOUT_VERSION_BUMP`), and that the element is listed in
`acknowledgeBreaking` (`BREAKING_CHANGE_UNACKNOWLEDGED`). Because every intermediate state of a
correct breaking change is invalid, it must be submitted as one batch: bump the version, change
the contract, update every bound consumer (itself a breaking change on the consumer, so bump and
acknowledge it too) and every pinned workflow import, then acknowledge each broken element.

The patch operations and the fields each `change*` op may set are the `Patch` union in
`packages/core/src/mutate.ts`. A `change*` op rejects any other field, and a `null` value removes
an optional field.

## MCP server

The server speaks the Model Context Protocol over stdio; its tools, each wrapping the core, are
`loom.validate`, `loom.mutate`, `loom.diff`, `loom.project`, `loom.projectAll`, `loom.export`,
`loom.import` and `loom.selftest`. `loom.mutate` takes `model` plus exactly one of
`patch` (an object) or `patches` (an atomic batch), and an optional `acknowledgeBreaking` list of
element ids; it returns `refused`, `findings`, `impact`, `changes` and the new `model`.
`loom.project` accepts any target in `PROJECTION_TARGETS` and returns text targets verbatim;
`loom.projectAll` returns the `projectToFiles` map.

### Registering with a Claude Code client

After `npm run build`, register the server for every project of the current user:

```sh
claude mcp add --scope user loom -- node <absolute path to packages/mcp-server/dist/index.js>
```

Options such as `--scope` precede the server name, and everything after `--` is the command that
starts the server. Alternatively, add the entry in [`mcp-config-entry.json`](./mcp-config-entry.json)
to an `.mcp.json` or `~/.claude.json` server list. Claude Code expands its `${USERPROFILE}` in
`command` and `args` (Claude Code docs, *MCP*, "Environment variable expansion in `.mcp.json`"); the
entry assumes the repository is checked out at `${USERPROFILE}/Codebase`, so adjust that prefix to
the actual checkout.

Then restart the client (or reload its MCP configuration) so it launches the server and the
`loom.*` tools appear.

The server writes only JSON-RPC to stdout; status messages go to stderr. A non-interactive
smoke test (`npm run smoke:mcp`) constructs the server, enumerates its tools over an in-memory
transport, runs the self-test, calls `loom.mutate` with a breaking patch (refused) and a complete
acknowledged batch (accepted), and calls `loom.projectAll` and `loom.project`, so the integration
can be verified without a live client.

## Designer

`apps/designer` is an Angular 22 designer, a thin projection of the core. Its build, run and test
commands and its behaviour are in [`apps/designer/README.md`](./apps/designer/README.md). Build the
core first: the designer links `@loom/core` from `packages/core`. Because `@loom/core` declares
`"sideEffects": false`, the designer's production build leaves out the core modules it does not
import, such as the self-test.

## License

MIT. Direct runtime dependencies are MIT or ISC: `ajv`, `ajv-formats`,
`@apidevtools/swagger-parser`, `mermaid`, `jsdom`, `@modelcontextprotocol/sdk` (MIT) and `yaml`
(ISC). Through `mermaid`, the transitive tree also includes `elkjs` (EPL-2.0) and `dompurify`
(MPL-2.0 OR Apache-2.0).
