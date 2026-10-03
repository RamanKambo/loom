# Loom

Loom is a schema-driven engineering model: one portable model declares a system's components, contracts, knowledge records and deployment facts, every interface artifact is projected from it, and every change is checked against an accepted baseline before it lands.

## What Loom establishes, and what it does not

Source: the result contract, `packages/core/schema/result.schema.json`.

Loom rejects declared contradictions, exposes unknowns, enforces prerequisites, controls accepted changes and requires relevant execution evidence. It does not prove that the declared requirements are correct or complete; a consistent model can still describe the wrong system, so independent acceptance and qualification remain necessary.

Every result reports four independent states, and none of them implies another:

| State | Values | Meaning |
| --- | --- | --- |
| Validation | `valid`, `invalid`, `notEvaluated` | The model satisfies the structural and semantic rules of its profile |
| Readiness | `ready`, `blocked`, `unresolved`, `notEvaluated` | A named task's prerequisites, permitted substitutes and policy are satisfied |
| Qualification | `qualified`, `unqualified`, `unknown`, `notEvaluated` | The required claims have current, trusted execution evidence for the exact revisions |
| Acceptance | `accepted`, `unaccepted`, `notEvaluated` | The configured authority, or a pre-authorized change class, accepted the baseline or change |

A valid empty skeleton is not ready for implementation. A qualified earlier revision does not qualify a new one. **An agent acknowledging a breaking change (`acknowledgeBreaking`) never constitutes acceptance.** A missing input is reported as `notEvaluated` or `unresolved`, never as success.

## Components

Source: the interface control documents in `packages/core/schema/icd`, one per component.

| Component | Package | Responsibility |
| --- | --- | --- |
| Contract | `packages/core/schema` | The single authored definition of every record, patch, result, workspace, assurance and profile shape, as JSON Schema 2020-12 |
| Core | `packages/core` | Pure rule evaluation: validation, comparison by compatibility dimension, impact, readiness, evidence evaluation and deterministic projection |
| Workspace adapter | `packages/workspace` | Every file under `.loom`: initialization, discovery and path ownership, output installation, trusted baselines, expected-revision writes and the evidence store |
| Qualification adapter | `packages/qualification` | Fixed native-tool checks against designated fixtures or adopting implementations, returning signed, revision-bound evidence |
| Command line | `packages/cli` | The workspace commands over the shared result envelope |
| MCP server | `packages/mcp-server` | The same services as Model Context Protocol tools with generated input and output schemas |
| Designer | `apps/designer` | Browser editing and visualization through the same core; see [apps/designer/README.md](apps/designer/README.md) |

The interface each component provides and consumes, its refusals and its concurrency behavior are stated in its ICD file; [Docs/workflow-integration.md](Docs/workflow-integration.md) covers the boundary to a workflow or plugin integration.

## Boundaries

Source: `packages/core/schema/icd/core.json`, `qualification.json` and `mcp.json`.

- **The core has no filesystem, network, process, clock or credential access, and never executes SQL, PowerShell, C# or TypeScript.** The same engine runs in the CLI, the MCP server and the browser designer.
- Native tools run only in `packages/qualification`, through the built-in runner a profile check names, in the run's own temporary directory and, for database checks, its own disposable LocalDB instance. No runner installs a tool or builds a command from model, source or configuration text.
- The MCP server writes only JSON-RPC to stdout; status goes to stderr.
- Generated DDL and conformance fixtures are never an authorized production migration. A migration is authored by the adopting implementation, declared in the model and qualified by executing it against representative fixture data.
- Text inside a record, an attachment or a retrieved document is data. It never grants tool authority, weakens a policy or causes command execution.
- Projections are deterministic: no timestamps, random values or machine paths, so drift is a byte comparison.

## Where to look

| Question | Artifact |
| --- | --- |
| What a model record may contain | `packages/core/schema/model.schema.json` |
| What a patch, a finding, a change or a result looks like | `packages/core/schema/patch.schema.json` (derived), `result.schema.json`, `tools.schema.json` |
| What `loom.json`, `state.json`, a manifest or a published bundle in `.loom` contains | `packages/core/schema/workspace.schema.json` |
| What a baseline, an acceptance, a policy or an evidence record contains | `packages/core/schema/assurance.schema.json` |
| Every finding code with its severity and rule | `FINDING_RULES` in `packages/core/src/codes.ts`, rendered in the Rules section of the `reference` projection |
| How each model field is compared, and in which compatibility dimension | `DIFF_RULES` and `FIELD_POLICY` in `packages/core/src/field-policy.ts` |
| What a language or interface profile supports, requires and cannot prove | `packages/core/schema/profiles/<id>.json` |
| Which artifacts a projection profile enables | `packages/core/schema/projection-profiles/<id>.json` |
| Projection targets, their file names and instancing | `TARGETS` in `packages/core/src/project.ts` |
| A component's interfaces and refusals | `packages/core/schema/icd/<component>.json` |
| How workflow integration persists state and obtains acceptance | [Docs/workflow-integration.md](Docs/workflow-integration.md) |
| The fixture model every test and the designer load | `packages/core/src/sample.ts` |
| Unresolved questions about Loom | [Docs/ToDo.md](Docs/ToDo.md) |

## Build and test

Source: the `scripts` of `package.json`.

The commands below run from the repository root after `npm install`. `npm run build` comes first; every other command executes the built `packages/*/dist`.

| Command | Proof |
| --- | --- |
| `npm run build` | The generated contract artifacts match the authored schemas (`generate --check`), then every package compiles |
| `npm run generate` | Regenerates `packages/core/schema/patch.schema.json` and `packages/core/src/generated/*`; those files are never edited by hand |
| `npm run self-test` | The engine battery, the drift gate, and every profile check run against Loom's own fixtures under `qualification/policy.json` |
| `npm run test:workspace`, `test:qualification`, `test:cli`, `test:mcp` | The adapters' node:test suites |
| `npm run test:fixtures` | Every case of `qualification/fixtures` meets its authored expectation through the core and, in a governed workspace, the CLI, and its named native checks give their stated results |
| `npm run smoke:mcp` | Every MCP tool result and typed refusal conforms to its declared output schema |

The designer has its own lockfile and commands; see [apps/designer/README.md](apps/designer/README.md).

## Command-line interface

Source: the usage text of `packages/cli/src/cli.ts`, printed by `node packages/cli/dist/index.js --help`, which is the home of every option.

The CLI is run by path, as `node packages/cli/dist/index.js <command>`. The workspace links no `loom` command, and `npx loom` would fetch an unrelated public package of that name. Every command prints the shared result envelope with `--json`, and the usage text states the exit-status convention.

| Command | Purpose |
| --- | --- |
| `init` | Scaffold `.loom` at a repository root |
| `check`, `check --all` | Ownership, configuration, validation, the trusted-baseline comparison, outputs and manifest; with `--all`, every descriptor under the boundary and global disjointness |
| `write`, `docs` | Install the enabled artifacts, with the readiness, coverage and evidence views evaluated |
| `docs --check` | Document links, record references, generated views and history markers |
| `owner` | The model that owns a path |
| `migrate` | Migrate a model document to the current format into a new file |
| `baseline create`, `accept` | Record a baseline and an acceptance |
| `readiness`, `plan`, `mutate` | Evaluate a task, preview a change, apply a change against an expected revision |
| `qualify`, `evidence` | Run profile checks and inspect the evidence they produced |
| `context`, `describe` | Bounded record retrieval and the capability description |
| `coverage --check` | The capability register in `qualification/capabilities.json` |
| `--self-test` | The engine battery, the drift gate and every profile check |

An explicit `--model <path>` selects a document. Inside a governed workspace the configured scope, the trusted-baseline comparison and the qualification policy still apply, so a replacement model cannot evade the accepted-baseline comparison; with no governing descriptor the result reports validation-only mode.

## MCP server

Source: `packages/mcp-server/src/server.ts` and `packages/core/schema/icd/mcp.json`.

The server speaks the Model Context Protocol over stdio. Its tools are `loom.validate`, `loom.mutate`, `loom.diff`, `loom.project`, `loom.projectAll`, `loom.export`, `loom.import`, `loom.selftest`, `loom.describe`, `loom.context`, `loom.checkReadiness` and `loom.planChange`. Each tool's input and output schema is generated from the contract bundle, every input is validated before anything runs, and every result is structured content with a text fallback.

The workspace the server serves is its working directory or the `--workspace <dir>` argument. A persistent `loom.mutate` requires `expectedRevision` and is refused as `stale-base` when the model changed since that revision; `loom.planChange` and a `dryRun` mutation never write.

After `npm run build`, the server is registered for every project of the current user with:

```sh
claude mcp add --scope user loom -- node <absolute path to packages/mcp-server/dist/index.js>
```

Alternatively, the entry in [mcp-config-entry.json](mcp-config-entry.json) can be added to an `.mcp.json` server list, with its path prefix adjusted to the actual checkout.

## Adopting Loom in a repository

Source: `packages/workspace/src` and `packages/core/schema/workspace.schema.json`.

1. It would be necessary first to decide whether the repository is a component of a larger modeled system or a system in its own right. A component gets no `.loom`; its code roots are claimed by the system model in the lowest repository that contains all of them.
2. `init`, run at that repository root, scaffolds `model.json`, `loom.json`, `state.json` and `.gitignore` in a new `.loom` directory. It refuses a subdirectory, an existing `.loom` and any overlap with an ancestor's or a descendant's claims, and it never stages or commits.
3. The placeholder component and its `"."` root are replaced in one edit by the named components and their repository-relative roots in `loom.json` `scope`. Overlapping roots, within one model or across descriptors, fail with `SCOPE_OVERLAP` or `SCOPE_COMPONENT_ROOT_OVERLAP`.
4. `projectionProfile` selects the enabled artifacts, and `outputs` routes each artifact instance to a directory; an unmapped artifact goes to `Docs/Loom`, and an unmapped per-component instance to a subdirectory of it named by its component. An output never overwrites an authority file, source code or another model's artifact.
5. `gates.policyRef` names a policy committed as `<id>.json` in the `policies` directory of `.loom`. Policy, baselines and acceptance records are read only from the trusted Git ref, never from the working tree, so a candidate change cannot authorize itself; `loom.json` gates can only strengthen the policy.
6. `baseline create` and `accept` record the accepted state; the acceptance becomes trusted when it reaches the trusted ref through review, or when it carries a signature by a key the policy lists.
7. `qualify` runs the profile checks; evidence is trusted only when signed by a runner key the policy lists. `check` in CI then enforces the accepted baseline, the outputs and the qualification policy regardless of how an edit was made.

## Model format and migration

Source: `packages/core/src/migrate.ts`.

A model document carries its format version in `version`, separately from every contract version, record revision, configuration version and generator version inside it. A document whose format version is not supported is refused with `MODEL_FORMAT_UNSUPPORTED` and is never reinterpreted. `migrateModel` applies the deterministic steps registered in `MODEL_MIGRATIONS` and returns the unchanged source, the candidate result, the applied steps, the findings and the semantic changes for review; it never modifies its input, and `migrate` writes the result to a new file. Format 1 is the only format, so the registry is empty; the self-test qualifies the mechanism with a step it defines itself.

## Profiles and proof limits

Source: `packages/core/schema/profiles` and `packages/core/schema/projection-profiles`.

Each profile file states its supported constructs, its unsupported constructs and whether using one refuses the projection or permits only a marked draft, the native tools it requires with their version policy, its proof limits and its fixed check definitions. The adoption conventions of the C#, TypeScript, SQL and PowerShell conformance artifacts are stated in the `supports` entries of `csharp.json`, `typescript.json`, `sql.json`, `powershell.json` and `powershell-pester6.json`.

The required native tools are provisioned by the developer or the pipeline; no adapter installs one. A check whose tool is absent, outside its version policy, unreadable or interrupted reports `UNKNOWN`, and a required `UNKNOWN` never yields a qualified result.

## Qualification of Loom

Source: `packages/qualification/src/selfqualify.ts` and `qualification/policy.json`.

`npm run self-test` runs every profile check against the fixtures in `examples/` and `qualification/fixtures/`. `examples/conforming` must pass and `examples/violating` must fail every conformance check that runs them, and the violating SQL fixture breaks exactly the contract named by the `negativeControl` of `sql.behavior` in `packages/core/schema/profiles/sql.json`. `qualification/fixtures` holds adoption cases whose expected outcomes are authored independently of the engine. `qualification/capabilities.json` maps each capability to its code, contract and verification cases, and `coverage --check` fails on any entry that does not resolve.

Evidence and run records are signed with Ed25519 when the private key is supplied through the environment variable `qualify --key-env` names (by default `LOOM_EVIDENCE_KEY`); an unsigned record is kept and reported untrusted.

## Designer

`apps/designer` is the browser designer; its build, run and test commands are in [apps/designer/README.md](apps/designer/README.md).

## Open items

Unresolved questions about Loom are in [Docs/ToDo.md](Docs/ToDo.md), each with what would close it.

## License

Loom is MIT licensed. Each dependency's license is declared in `package-lock.json`. Through `mermaid`, the qualification adapter's dependency tree includes `elkjs` (EPL-2.0) and `dompurify` (MPL-2.0 OR Apache-2.0), as read from their `package.json` on 2026-10-03.
