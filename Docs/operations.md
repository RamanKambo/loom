<!-- Generated from the Loom contract. Do not edit; edit the authored contract and regenerate. -->
# Loom operations

Source: the operation catalogue `packages/core/schema/operations.json`, whose shape is `OperationCatalogue` in `packages/core/schema/tools.schema.json`. `npm run generate` renders this reference, the MCP tool descriptions, the CLI usage text, the tools, entry points, proof limits and examples of `loom.describe` and the capabilities guide from it, and `npm run build` fails when any of them differs from a fresh rendering.

## Command line

The CLI is run by path, as `node packages/cli/dist/index.js <command>`, and `--help` prints its usage text, `Usage: loom <command> [options]   (every command takes --json to print the result envelope)`.

Common options: `--model <path>` selects a document (the governing workspace still applies), `--boundary <dir>`, `--trusted-ref <ref>`, `--as-of <date>`.

Exit status: 0 ok, 1 refusal or error finding, 2 usage error.

## MCP server

The server lists these tools in this order, each with the description generated from its operation:

1. `loom.validate`, operation [validate](#validate)
2. `loom.mutate`, operation [mutate](#mutate)
3. `loom.diff`, operation [diff](#diff)
4. `loom.project`, operation [project](#project)
5. `loom.projectAll`, operation [projectAll](#projectall)
6. `loom.export`, operation [export](#export)
7. `loom.import`, operation [import](#import)
8. `loom.selftest`, operation [selftest](#selftest)
9. `loom.describe`, operation [describe](#describe)
10. `loom.context`, operation [context](#context)
11. `loom.checkReadiness`, operation [checkReadiness](#checkreadiness)
12. `loom.planChange`, operation [planChange](#planchange)
13. `loom.workspace`, operation [workspaceInspect](#workspaceinspect)
14. `loom.federation`, operation [federationInspect](#federationinspect)
15. `loom.diagram`, operation [diagram](#diagram)
16. `loom.qualify`, operation [qualifyStart](#qualifystart)

Each tool advertises compact input and output schemas derived from the contract bundle. A compact schema keeps the top-level members, their requirements and their simple types, and replaces deeper content with a value whose description names the `loom://schema/<Definition>` resource holding its full contract; the server serves those resources and validates every call against the full contract. One tool's advertised definition takes at most 8192 bytes, and the orientation instructions the server returns at initialization take at most 2400 UTF-8 bytes. The orientation is authored in `Docs/guides/orientation.md`, takes 1907 of those bytes, and opens the summary of `loom.describe`.

## Workflow

The summary of `loom.describe` lists these steps of the agent workflow as its entry points, each with the interfaces that perform it:

1. Orient on what this build supports and what each kind of proof establishes: `loom.describe`.
2. Identify the workspace and the requested outcome, and read the context, constraints, evidence and unresolved decisions of the task: `loom.context`.
3. Preview a change through the owning model, then apply it against the same revision: `loom.planChange`, `loom.mutate`.
4. Check readiness for the actual task and implement only the scope its work package permits: `loom.checkReadiness`.
5. Regenerate the artifacts from the model and check them for drift: `loom.projectAll`, the command 'check'.
6. Qualify the real implementation and bind its evidence to the exact inputs: the command 'qualify', the command 'evidence'.

## Proof limits

Each limit states what the results of its operations do not establish. `loom.describe` with `operation` returns the limits of that operation, deduplicated, and a full page of its `limits` section returns every limit of this build once; the tool descriptions repeat none of them.

| Limit | Text | Operations |
| --- | --- | --- |
| `validation-scope` | Model validation establishes conformance to the declared rule set; it does not establish that the requirements are correct or complete. | [validate](#validate), [mutate](#mutate), [diff](#diff), [planChange](#planchange), [checkReadiness](#checkreadiness), [check](#check), [checkAll](#checkall), [federationCheck](#federationcheck) |
| `generated-equality` | Generated-file equality establishes that artifacts match their inputs, not that an implementation conforms. | [project](#project), [projectAll](#projectall), [write](#write), [docs](#docs), [docsCheck](#docscheck), [check](#check), [checkAll](#checkall) |
| `supplied-records` | Readiness, acceptance and qualification are evaluated only over the baseline, acceptance, evidence and policy records supplied; their provenance is verified by the adapter. | [diff](#diff), [planChange](#planchange), [checkReadiness](#checkreadiness), [context](#context), [check](#check), [checkAll](#checkall), [qualify](#qualify), [evidence](#evidence), [federationCheck](#federationcheck), [qualifyStart](#qualifystart) |
| `predicates` | A prose predicate is never evaluated; an expression predicate is type-checked, never run against live data. | [validate](#validate), [mutate](#mutate), [planChange](#planchange), [check](#check), [checkAll](#checkall) |

Every profile's own proof limits, stated in `packages/core/schema/profiles`, apply to the operations that depend on profiles: [check](#check), [checkAll](#checkall), [write](#write), [docs](#docs), [project](#project), [projectAll](#projectall), [qualify](#qualify), [diagram](#diagram), [qualifyStart](#qualifystart).

## Resources

Besides the schema resources, the catalogue defines these resources. A `session` resource is readable only by the session that holds the workspace handle.

| Resource | Returns | Scope | Listed | Purpose |
| --- | --- | --- | --- | --- |
| `loom://guide/engineering` | `GuideResource` | server | yes | The engineering method the model encodes: the outcome first, responsibilities and workflows before interfaces, types, mutations and failure behavior before implementation, and evidence bound to its exact inputs. |
| `loom://guide/workflow` | `GuideResource` | server | yes | The order of work an agent follows: identify the workspace and the outcome, read the context, preview and apply changes through the owning model, check readiness and qualify the implementation. |
| `loom://guide/capabilities` | `GuideResource` | server | yes | What this build supports and what each kind of proof does not establish. |
| `loom://workspaces/{workspaceId}/status` | `WorkspaceStatus` | session | yes | The status of one open workspace, for the session that holds its handle. |
| `loom://workspaces/{workspaceId}/records/{kind}/{id}` | `RecordResource` | session | yes | One record of an open workspace at the model revision the result names, which a context or describe page points to when the record is too large for the page. |
| `loom://workspaces/{workspaceId}/diagrams/{diagramId}` | `DiagramResource` | session | no | One diagram of an open workspace, structured and as Mermaid text, which a render result points to when the diagram is too large to carry inline. |

Not listed:

- `loom://workspaces/{workspaceId}/diagrams/{diagramId}`: Catalogued before it is listed; the server rebuild serves it.

The guides, each returned with the digest of its text and the contract digest:

- `loom://guide/engineering`: authored in `Docs/guides/engineering.md`
- `loom://guide/workflow`: authored in `Docs/guides/workflow.md`
- `loom://guide/capabilities`: generated from the operation catalogue and the profiles

## Rendering budget

A diagram request takes the default for each budget member it leaves out, and schema validation of the request refuses a member below its minimum or above its maximum. The numbers are the `default`, `minimum` and `maximum` keywords of `RenderingBudget` in `packages/core/schema/diagram.schema.json`, chosen rather than measured.

| Member | Minimum | Default | Maximum |
| --- | --- | --- | --- |
| `maxNodes` | 1 | 200 | 2000 |
| `maxBytes` | 1024 | 16384 | 65536 |
| `maxWidth` | 40 | 120 | 400 |
| `maxDurationMs` | 100 | 10000 | 60000 |
| `maxMemoryBytes` | 1048576 | 268435456 | 1073741824 |

## Operations

| Operation | MCP tool | Command | Effects |
| --- | --- | --- | --- |
| [validate](#validate) | `loom.validate` | none | `none` |
| [init](#init) | none | `init` | `writes` |
| [check](#check) | none | `check` | `reads` |
| [checkAll](#checkall) | none | `check --all` | `reads` |
| [write](#write) | none | `write` | `writes` |
| [docs](#docs) | none | `docs` | `writes` |
| [docsCheck](#docscheck) | none | `docs --check` | `reads` |
| [docsCheckSelf](#docscheckself) | none | `docs --check --self` | `reads` |
| [owner](#owner) | none | `owner` | `reads` |
| [migrate](#migrate) | none | `migrate` | `writes` |
| [baselineCreate](#baselinecreate) | none | `baseline create` | `writes` |
| [accept](#accept) | none | `accept` | `writes` |
| [mutate](#mutate) | `loom.mutate` | `mutate` | `writes` |
| [diff](#diff) | `loom.diff` | none | `none` |
| [project](#project) | `loom.project` | none | `none` |
| [projectAll](#projectall) | `loom.projectAll` | none | `none` |
| [export](#export) | `loom.export` | none | `none` |
| [import](#import) | `loom.import` | none | `none` |
| [qualify](#qualify) | none | `qualify` | `writes` |
| [evidence](#evidence) | none | `evidence` | `reads` |
| [coverage](#coverage) | none | `coverage` | `reads` |
| [selftest](#selftest) | `loom.selftest` | `--self-test` | `none` |
| [describe](#describe) | `loom.describe` | `describe` | `none` |
| [context](#context) | `loom.context` | `context` | `reads` |
| [checkReadiness](#checkreadiness) | `loom.checkReadiness` | `readiness` | `reads` |
| [planChange](#planchange) | `loom.planChange` | `plan` | `none` |
| [workspaceInspect](#workspaceinspect) | `loom.workspace` | `workspace inspect` | `reads` |
| [workspaceInitialize](#workspaceinitialize) | `loom.workspace` | none | `writes` |
| [workspaceOpen](#workspaceopen) | `loom.workspace` | none | `reads` |
| [workspaceStatus](#workspacestatus) | `loom.workspace` | `workspace status` | `reads` |
| [workspaceClose](#workspaceclose) | `loom.workspace` | none | `writes` |
| [federationInspect](#federationinspect) | `loom.federation` | `federation inspect` | `reads` |
| [federationPlan](#federationplan) | `loom.federation` | `federation plan` | `reads` |
| [federationApply](#federationapply) | `loom.federation` | `federation apply` | `writes` |
| [federationCheck](#federationcheck) | `loom.federation` | `federation check` | `reads` |
| [federationPublish](#federationpublish) | `loom.federation` | `federation publish` | `writes` |
| [diagram](#diagram) | `loom.diagram` | `diagram` | `reads` |
| [qualifyStart](#qualifystart) | `loom.qualify` | `qualify start` | `writes` |
| [qualifyStatus](#qualifystatus) | `loom.qualify` | `qualify status` | `reads` |
| [qualifyCancel](#qualifycancel) | `loom.qualify` | `qualify cancel` | `writes` |

### validate

Validate a model, inline or the workspace model under its verified baseline, acceptance, evidence and policy, against every structural and semantic rule, each finding carrying a stable code, a path, its impact and a fix while the four result states stay independent.

- Prerequisites: an inline model document, or a governed workspace for 'workspace': true.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the request breaks the tool input contract or the model breaks the structural contract; `unresolved-context` when 'workspace': true finds no workspace model governing the server directory.
- Next action: preview the change that clears a finding, through [planChange](#planchange).
- Proof limits: `validation-scope`, `predicates`.
- MCP tool: `loom.validate`, input `ValidateInput`, result data `ValidateData`.
- Command: none.
- Not exposed: The command line validates inside check, together with ownership, the baseline comparison and the installed outputs.

Presence rules of `loom.validate`, checked before anything runs:

- Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.validate`:

> Validate a model, inline or the workspace model under its verified baseline, acceptance, evidence and policy, against every structural and semantic rule, each finding carrying a stable code, a path, its impact and a fix while the four result states stay independent. Prerequisites: an inline model document, or a governed workspace for 'workspace': true. Effects: persists nothing. Refused as invalid-input when the request breaks the tool input contract or the model breaks the structural contract; as unresolved-context when 'workspace': true finds no workspace model governing the server directory. Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. Next: preview the change that clears a finding with loom.planChange.

### init

Scaffold .loom with model.json, loom.json, state.json and .gitignore at a repository root, never staging or committing them.

- Prerequisites: the root of a Git repository whose path no ancestor's or descendant's descriptor claims.
- Effects: `writes`, can persist changes.
- Refusals: `invalid-input` when the directory is not a repository root, already holds a .loom or yields a scaffold that fails validation; `policy-failure` when an ancestor's or a descendant's descriptor claims the path or cannot be read; `unmet-prerequisite` when with --force, an authority file of the existing .loom needs repair by its owner.
- Next action: declare the components and their roots in the scope of loom.json, then check the workspace, through [check](#check).
- Proof limits: none.
- MCP tool: none.
- Command: `init --model-id <id> --model-kind <composition|implementation|mixed> --dry-run` or `init --declaration <file> --apply --expected-inspection <digest>`.
- Not exposed: The MCP server serves a workspace that already exists; initializing one is a command-line step.

Examples:

- Scaffold .loom at the root of the current repository.

  ```sh
  node packages/cli/dist/index.js init --model-id payments --model-kind implementation
  ```

### check

Check one model in order, its ownership and configuration, its validity, its comparison with the trusted accepted baseline and its installed outputs and manifest, or with --out a directory of projections, without writing.

- Prerequisites: a governed workspace, or a model document named with --model, which outside a workspace is checked in validation-only mode.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `unresolved-context` when no model applies because neither --model nor a governing workspace names one.
- Next action: install current outputs once the model is corrected, through [write](#write).
- Proof limits: `validation-scope`, `generated-equality`, `supplied-records`, `predicates`, every profile's proof limits.
- MCP tool: none.
- Command: `check [--model <path>] [--out <dir>]`.
- Not exposed: Agents validate with loom.validate and compare with loom.diff; the installed outputs and their manifest are checked on the command line.

Examples:

- Check the workspace model and its installed outputs.

  ```sh
  node packages/cli/dist/index.js check
  ```

- Check a directory of projections against a model document.

  ```sh
  node packages/cli/dist/index.js check --model model.json --out projection
  ```

### checkAll

Check every descriptor under the boundary, the global disjointness of their claims and whether the walk covered the whole boundary.

- Prerequisites: a boundary to walk, named with --boundary or found from the working directory.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: none.
- Next action: check a reported descriptor on its own from its repository root, through [check](#check).
- Proof limits: `validation-scope`, `generated-equality`, `supplied-records`, `predicates`, every profile's proof limits.
- MCP tool: none.
- Command: `check --all [--boundary <dir>]`.
- Not exposed: Discovery across every descriptor of a boundary is a repository walk the command line performs; the MCP server serves one workspace.

Examples:

- Check every descriptor under the current directory.

  ```sh
  node packages/cli/dist/index.js check --all --boundary .
  ```

### write

Install every artifact the workspace's projection profile enables, with the readiness, coverage and evidence views evaluated under the verified inputs, or with --out write every projection into a directory.

- Prerequisites: a governed workspace, or a model document and --out <dir>.
- Effects: `writes`, can persist changes.
- Refusals: `unresolved-context` when no model applies, or no workspace governs an installation without --out; `invalid-input` when the model has error findings while projecting into a directory; `policy-failure` when the bundle fails its checks, for example an output collision or a protected target, and nothing is written.
- Next action: confirm that the installed outputs are current, through [check](#check).
- Proof limits: `generated-equality`, every profile's proof limits.
- MCP tool: none.
- Command: `write [--out <dir>] [--draft]`.
- Not exposed: loom.project and loom.projectAll return projections as data; installing them into the repository is a command-line step.

Examples:

- Install the enabled artifacts of the workspace.

  ```sh
  node packages/cli/dist/index.js write
  ```

- Write every projection of a model document into a directory.

  ```sh
  node packages/cli/dist/index.js write --model model.json --out projection
  ```

### docs

Install the documentation bundle, every enabled artifact with the readiness, coverage and evidence views evaluated, exactly as write installs it.

- Prerequisites: a governed workspace, or a model document and --out <dir>.
- Effects: `writes`, can persist changes.
- Refusals: `unresolved-context` when no model applies, or no workspace governs an installation without --out; `invalid-input` when the model has error findings while projecting into a directory; `policy-failure` when the bundle fails its checks, for example an output collision or a protected target, and nothing is written.
- Next action: check the documents, their links and the installed views, through [docsCheck](#docscheck).
- Proof limits: `generated-equality`, every profile's proof limits.
- MCP tool: none.
- Command: `docs [--out <dir>] [--draft]`.
- Not exposed: loom.project and loom.projectAll return projections as data; installing them into the repository is a command-line step.

Examples:

- Install the documentation bundle of the workspace.

  ```sh
  node packages/cli/dist/index.js docs
  ```

### docsCheck

Check the README, the Docs documents and the package source comments for broken links, anchors and record references, narrated history and hand-authored copies of generated registers, and inside a workspace the installed views and the interfaces the accepted baseline holds.

- Prerequisites: a repository, where a governing workspace adds the record, view and accepted-interface checks.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: none.
- Next action: regenerate the views from the model rather than editing them, through [docs](#docs).
- Proof limits: `generated-equality`.
- MCP tool: none.
- Command: `docs --check`.
- Not exposed: The documentation checks walk the repository's files on the command line; the MCP server returns projections as data.

Examples:

- Check the documents of the current repository.

  ```sh
  node packages/cli/dist/index.js docs --check
  ```

### docsCheckSelf

Run the documentation checks over this Loom installation's own repository and add its release wording: no requirement, task or phase label, release-iteration label or product-generation term in a document, comment or JSON description.

- Prerequisites: none.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: none.
- Next action: name each reported capability descriptively, as the current release states it.
- Proof limits: none.
- MCP tool: none.
- Command: `docs --check --self`.
- Not exposed: The documentation checks walk the repository's files on the command line; the MCP server returns projections as data.

Examples:

- Hold this Loom installation's own repository to its release wording.

  ```sh
  node packages/cli/dist/index.js docs --check --self
  ```

### owner

Name the model and component that claim a path by whole segments, or report the path as unclaimed, claimed twice or unresolved.

- Prerequisites: none.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: none.
- Next action: check the owning model from its repository root, through [check](#check).
- Proof limits: none.
- MCP tool: none.
- Command: `owner [<path>]`.
- Not exposed: Path ownership is resolved across every descriptor on the command line; the MCP server serves one workspace.

Examples:

- Name the model that owns the ordering directory.

  ```sh
  node packages/cli/dist/index.js owner ordering
  ```

### migrate

Migrate a model document to the current model format, writing the result only to a new file named with --to and never replacing its source.

- Prerequisites: a model document named with --model, or the governing descriptor's model at the repository root.
- Effects: `writes`, can persist changes.
- Refusals: `invalid-input` when no registered migration leads from the document's format to the current one.
- Next action: check the migrated document before it replaces the model, through [check](#check).
- Proof limits: none.
- MCP tool: none.
- Command: `migrate [--model <path>] [--to <file>]`.
- Not exposed: A migration reads and writes model documents as files on the command line; the MCP tools take and return models as data.

Examples:

- Migrate a model document into a new file.

  ```sh
  node packages/cli/dist/index.js migrate --model model.json --to migrated.json
  ```

### baselineCreate

Record a baseline of the workspace model at its current revision, accepted by a named acceptance record and optionally frozen.

- Prerequisites: a governed workspace; an acceptance of the baseline, recorded with accept.
- Effects: `writes`, can persist changes.
- Refusals: `unresolved-context` when no workspace governs the directory; `invalid-input` when the acceptance record is missing or the baseline cannot be recorded.
- Next action: commit the baseline to the trusted ref through review, then check the workspace against it, through [check](#check).
- Proof limits: none.
- MCP tool: none.
- Command: `baseline create --id <id> --acceptance <id> [--predecessor <id>] [--frozen]`.
- Not exposed: The MCP tools never record a baseline or an acceptance; both are recorded on the command line and trusted once they reach the trusted ref through review or carry a signature the policy lists.

Examples:

- Record baseline bl-1 under the acceptance acc-1.

  ```sh
  node packages/cli/dist/index.js baseline create --id bl-1 --acceptance acc-1
  ```

### accept

Record an acceptance of the current model revision, as a baseline or a change, by a named authority under the workspace policy, optionally signed.

- Prerequisites: a governed workspace with a policy, the trusted one or the one gates.policyRef names in loom.json.
- Effects: `writes`, can persist changes.
- Refusals: `unresolved-context` when no workspace governs the directory; `unmet-prerequisite` when no policy is named; `invalid-input` when the acceptance record cannot be stored.
- Next action: commit the acceptance to the trusted ref through review, then record the baseline it accepts, through [baselineCreate](#baselinecreate).
- Proof limits: none.
- MCP tool: none.
- Command: `accept --id <id> --authority <alias> [--subject baseline|change] [--baseline <id>] [--scope kind:id,...] [--classes ...]`.
- Not exposed: The MCP tools never record a baseline or an acceptance; both are recorded on the command line and trusted once they reach the trusted ref through review or carry a signature the policy lists.

Examples:

- Accept the current revision as baseline bl-1 for the architecture team.

  ```sh
  node packages/cli/dist/index.js accept --id acc-1 --authority team-architecture --subject baseline --baseline bl-1
  ```

### mutate

Apply one patch or an atomic batch to a model, inline as a pure calculation or to the workspace model, which persists only onto the expected revision so two writers on one base cannot both succeed, while a dry run previews without writing.

- Prerequisites: one patch or a batch of patches; for a persistent change, a governed workspace and the MutationExpectation the change was prepared against, as 'expectation' or the --expected-* flags; a version bump and an acknowledgement for a breaking change, an acknowledgement never being acceptance.
- Effects: `writes`, can persist changes.
- Refusals: `invalid-input` when a patch or the resulting model is invalid, and the model is unchanged; `policy-failure` when a breaking or unclassified change lacks its version bump or acknowledgement; `stale-base` when the model, configuration, policy or import pins changed since the expectation, and nothing is written; `unresolved-context` when no governed workspace serves a persistent change.
- Next action: check readiness for the task the change serves, through [checkReadiness](#checkreadiness).
- Proof limits: `validation-scope`, `predicates`.
- MCP tool: `loom.mutate`, input `MutateInput`, result data `MutateData`.
- Command: `mutate --patch <file> --expected-model <hash> --expected-config <hash> --expected-policy <hash|none> --expected-imports <hash> [--ack id,...] [--dry-run]`.

Presence rules of `loom.mutate`, checked before anything runs:

- Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.
- Send 'patch' without 'patches', or send 'patches' without 'patch'. A request matching no combination is refused with `PATCH_AMBIGUOUS` at `(root)`.
- Send 'expectation', or omit 'workspaceId'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `expectation`.

Description of `loom.mutate`:

> Apply one patch or an atomic batch to a model, inline as a pure calculation or to the workspace model, which persists only onto the expected revision so two writers on one base cannot both succeed, while a dry run previews without writing. Prerequisites: one patch or a batch of patches; for a persistent change, a governed workspace and the MutationExpectation the change was prepared against, as 'expectation' or the --expected-* flags; a version bump and an acknowledgement for a breaking change, an acknowledgement never being acceptance. Effects: can persist changes. Refused as invalid-input when a patch or the resulting model is invalid, and the model is unchanged; as policy-failure when a breaking or unclassified change lacks its version bump or acknowledgement; as stale-base when the model, configuration, policy or import pins changed since the expectation, and nothing is written; as unresolved-context when no governed workspace serves a persistent change. Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. Send 'patch' without 'patches', or send 'patches' without 'patch'. Send 'expectation', or omit 'workspaceId'. Next: check readiness for the task the change serves with loom.checkReadiness.

Examples:

- Preview changing a mutation guard in the workspace model; nothing persists on a dry run.

  ```json
  {
    "workspaceId": "ws_example",
    "expectation": {
      "model": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "config": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "policy": null,
      "imports": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    "patch": {
      "op": "update",
      "collection": "mutations",
      "id": "order.pay",
      "set": {
        "guard": {
          "form": "prose",
          "text": "Payment for the order total has been captured."
        }
      }
    },
    "dryRun": true
  }
  ```

- Preview patch.json against the model, config, policy and imports hashes it was prepared against, as revisions reports them, without writing.

  ```sh
  node packages/cli/dist/index.js mutate --patch patch.json --expected-model sha256:0000000000000000000000000000000000000000000000000000000000000000 --expected-config sha256:0000000000000000000000000000000000000000000000000000000000000000 --expected-policy none --expected-imports sha256:0000000000000000000000000000000000000000000000000000000000000000 --dry-run
  ```

### diff

Compare two models, or a candidate against the trusted accepted baseline, giving every change its kind, compatibility dimension, rule and affected consumers and marking a comparison with an invalid side provisional.

- Prerequisites: two inline models, or a trusted accepted baseline at the trusted ref and a candidate, inline or the workspace model.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the request or a model breaks its contract; `unresolved-context` when no trusted accepted baseline is available, or 'workspace': true finds no workspace model.
- Next action: preview a repair of a breaking change, through [planChange](#planchange).
- Proof limits: `validation-scope`, `supplied-records`.
- MCP tool: `loom.diff`, input `DiffInput`, result data `DiffData`.
- Command: none.
- Not exposed: The command line compares the model with the trusted accepted baseline inside check.

Presence rules of `loom.diff`, checked before anything runs:

- Send 'before' and 'after' without 'againstBaseline', or send 'againstBaseline' and 'after' without 'workspaceId' or 'before', or send 'againstBaseline' and 'workspaceId' without 'after' or 'before'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.diff`:

> Compare two models, or a candidate against the trusted accepted baseline, giving every change its kind, compatibility dimension, rule and affected consumers and marking a comparison with an invalid side provisional. Prerequisites: two inline models, or a trusted accepted baseline at the trusted ref and a candidate, inline or the workspace model. Effects: persists nothing. Refused as invalid-input when the request or a model breaks its contract; as unresolved-context when no trusted accepted baseline is available, or 'workspace': true finds no workspace model. Send 'before' and 'after' without 'againstBaseline', or send 'againstBaseline' and 'after' without 'workspaceId' or 'before', or send 'againstBaseline' and 'workspaceId' without 'after' or 'before'. Next: preview a repair of a breaking change with loom.planChange.

### project

Project a model to one target with its source-to-output coverage manifest, running no external validator and failing closed on error findings, while a draft renders an explicitly incomplete artifact that never qualifies.

- Prerequisites: a model, inline or the workspace model.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the request breaks its contract or the model has error findings; `policy-failure` when outside a draft, the model uses a construct the target's profile does not support.
- Next action: qualify the projected artifacts with their profile checks, through [qualify](#qualify).
- Proof limits: `generated-equality`, every profile's proof limits.
- MCP tool: `loom.project`, input `ProjectInput`, result data `ProjectData`.
- Command: none.
- Not exposed: The command line writes projections into files with write --out.

Presence rules of `loom.project`, checked before anything runs:

- Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.project`:

> Project a model to one target with its source-to-output coverage manifest, running no external validator and failing closed on error findings, while a draft renders an explicitly incomplete artifact that never qualifies. Prerequisites: a model, inline or the workspace model. Effects: persists nothing. Refused as invalid-input when the request breaks its contract or the model has error findings; as policy-failure when outside a draft, the model uses a construct the target's profile does not support. Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. Next: qualify the projected artifacts with their profile checks with the command 'qualify'.

### projectAll

Project a model to every target, with per-component artifact instances and coverage manifests, failing closed as project does.

- Prerequisites: a model, inline or the workspace model.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the request breaks its contract or the model has error findings; `policy-failure` when outside a draft, the model uses a construct a target's profile does not support.
- Next action: qualify the projected artifacts with their profile checks, through [qualify](#qualify).
- Proof limits: `generated-equality`, every profile's proof limits.
- MCP tool: `loom.projectAll`, input `ProjectAllInput`, result data `ProjectData`.
- Command: none.
- Not exposed: The command line writes every projection into a directory with write --out, or installs the enabled ones with write.

Presence rules of `loom.projectAll`, checked before anything runs:

- Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.projectAll`:

> Project a model to every target, with per-component artifact instances and coverage manifests, failing closed as project does. Prerequisites: a model, inline or the workspace model. Effects: persists nothing. Refused as invalid-input when the request breaks its contract or the model has error findings; as policy-failure when outside a draft, the model uses a construct a target's profile does not support. Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. Next: qualify the projected artifacts with their profile checks with the command 'qualify'.

### export

Serialize a model to canonical JSON or YAML, failing closed on an invalid model.

- Prerequisites: an inline model document.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the model breaks its structural contract or has error findings.
- Next action: store the canonical text as the model document.
- Proof limits: none.
- MCP tool: `loom.export`, input `ExportInput`, result data `ExportData`.
- Command: none.
- Not exposed: The command line reads and writes model documents as files, and migrate writes the canonical form.

Description of `loom.export`:

> Serialize a model to canonical JSON or YAML, failing closed on an invalid model. Prerequisites: an inline model document. Effects: persists nothing. Refused as invalid-input when the model breaks its structural contract or has error findings. Next: store the canonical text as the model document.

### import

Parse a model from JSON or YAML text and check its structure, returning the model with its findings.

- Prerequisites: the text of a model document.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the text does not parse or breaks the structural contract.
- Next action: validate the imported model against every rule, through [validate](#validate).
- Proof limits: none.
- MCP tool: `loom.import`, input `ImportInput`, result data `ImportData`.
- Command: none.
- Not exposed: The command line reads model documents from files with --model.

Description of `loom.import`:

> Parse a model from JSON or YAML text and check its structure, returning the model with its findings. Prerequisites: the text of a model document. Effects: persists nothing. Refused as invalid-input when the text does not parse or breaks the structural contract. Next: validate the imported model against every rule with loom.validate.

### qualify

Run the native-tool checks of the profiles the workspace enables, or of named profiles or checks, against artifacts rendered from the model, judge their evidence under the trusted policy and optionally store and sign it, while --self runs every check against Loom's own fixtures.

- Prerequisites: a governed workspace, unless --self is given; the native tools the checks name, within their version policies, a missing one yielding UNKNOWN and never PASS.
- Effects: `writes`, can persist changes.
- Refusals: `unresolved-context` when no workspace governs the directory and --self is not given.
- Next action: inspect the evidence the run produced, through [evidence](#evidence).
- Proof limits: `supplied-records`, every profile's proof limits.
- MCP tool: none.
- Command: `qualify [--self] [--profile p,...] [--checks id,...] [--fixtures <file>] [--store] [--metrics [--compare <metrics.json>]] [--key-id <id> --key-env <var>]`.
- Not exposed: Native tools run only in the qualification adapter, whose interfaces the command line consumes and the MCP server does not.

Examples:

- Run one named check against the workspace.

  ```sh
  node packages/cli/dist/index.js qualify --checks documentation.yaml-roundtrip
  ```

- Qualify this Loom installation against its own fixtures and measure its outcome metrics.

  ```sh
  node packages/cli/dist/index.js qualify --self --metrics
  ```

### evidence

List the stored evidence with each record's trust under the trusted policy, or show one record.

- Prerequisites: a governed workspace.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `unresolved-context` when no workspace governs the directory, or the named record is not stored.
- Next action: run again a check whose evidence failed or went stale, through [qualify](#qualify).
- Proof limits: `supplied-records`.
- MCP tool: none.
- Command: `evidence list` or `evidence show <id>`.
- Not exposed: The evidence store is read on the command line; loom.context and loom.checkReadiness report the evidence obligations of their scope.

Examples:

- List the stored evidence.

  ```sh
  node packages/cli/dist/index.js evidence list
  ```

### coverage

Check the capability register qualification/capabilities.json, every code symbol, contract pointer and verification case resolving and a case counting only on a supplied passing result, or list the declared verification cases.

- Prerequisites: a repository holding qualification/capabilities.json; for --check, the node:test results or the qualification run that executed the cases.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: none.
- Next action: supply the results of every case reported without one.
- Proof limits: none.
- MCP tool: none.
- Command: `coverage --check [--register <file>] [--results <tap,...>] [--run <run.json>]` or `coverage --list-cases`.
- Not exposed: The capability register belongs to the repository that holds it and is checked on the command line.

Examples:

- List every declared verification case.

  ```sh
  node packages/cli/dist/index.js coverage --list-cases
  ```

### selftest

Run Loom's self-test, which qualifies Loom's own engine and never an adopting system: the MCP tool runs the engine battery, and the command adds the drift gate, the release wording and every profile check against Loom's fixtures.

- Prerequisites: for the command, the native tools of every profile check.
- Effects: `none`, persists nothing.
- Refusals: none.
- Next action: describe what this build supports, through [describe](#describe).
- Proof limits: none.
- MCP tool: `loom.selftest`, input `SelftestInput`, result data `SelftestData`.
- Command: `--self-test`.

Description of `loom.selftest`:

> Run Loom's self-test, which qualifies Loom's own engine and never an adopting system: the MCP tool runs the engine battery, and the command adds the drift gate, the release wording and every profile check against Loom's fixtures. Prerequisites: for the command, the native tools of every profile check. Effects: persists nothing. Next: describe what this build supports with loom.describe.

Examples:

- Run the whole self-test of this Loom installation.

  ```sh
  node packages/cli/dist/index.js --self-test
  ```

### describe

Describe what this build supports: by default an orientation summary with the workflow entry points, the tools, selected capability facts and the guide and resource links, with 'detail': 'full' the requested sections a page at a time within the discovery budget, and with 'operation' the proof limits of one operation.

- Prerequisites: none.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the request breaks its contract, names no catalogue operation, or sends a cursor issued for another request; `stale-base` when the cursor was issued by another build; the refusal names the request that starts again.
- Next action: read the required context of the component or task at hand, through [context](#context).
- Proof limits: none.
- MCP tool: `loom.describe`, input `DescribeInput`, result data `DescribeData`.
- Command: `describe [--detail summary|full] [--sections a,b] [--profile <id>] [--operation <id>] [--max-bytes n] [--max-records n] [--cursor <token>]`.

Presence rules of `loom.describe`, checked before anything runs:

- Send 'operation' without 'detail' or 'sections' or 'profile', or omit 'operation'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.
- Send 'detail', or omit 'sections' and 'profile'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.
- When 'detail' is 'summary', omit 'sections' and 'profile'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.describe`:

> Describe what this build supports: by default an orientation summary with the workflow entry points, the tools, selected capability facts and the guide and resource links, with 'detail': 'full' the requested sections a page at a time within the discovery budget, and with 'operation' the proof limits of one operation. Prerequisites: none. Effects: persists nothing. Refused as invalid-input when the request breaks its contract, names no catalogue operation, or sends a cursor issued for another request; as stale-base when the cursor was issued by another build; the refusal names the request that starts again. Send 'operation' without 'detail' or 'sections' or 'profile', or omit 'operation'. Send 'detail', or omit 'sections' and 'profile'. When 'detail' is 'summary', omit 'sections' and 'profile'. Next: read the required context of the component or task at hand with loom.context.

Examples:

- The orientation summary.

  ```json
  {}
  ```

- The first page of the patch operations.

  ```json
  {
    "detail": "full",
    "sections": [
      "patches"
    ]
  }
  ```

- What the result of a projection does not establish.

  ```json
  {
    "operation": "project"
  }
  ```

- The orientation summary.

  ```sh
  node packages/cli/dist/index.js describe
  ```

- The first page of the patch operations.

  ```sh
  node packages/cli/dist/index.js describe --detail full --sections patches
  ```

- What the result of a projection does not establish.

  ```sh
  node packages/cli/dist/index.js describe --operation project
  ```

### context

Retrieve the required context of a component, record, claim or task a page at a time within a discovery budget, nearest first, with sources, owners, baseline status, constraints, decisions and evidence, or for a resume target the recorded outcome, phase, owning scopes, frozen contracts, blocking unknowns, evidence, pending work and next actions, record text coming back as data and never as an instruction.

- Prerequisites: a model, inline or the workspace model; a target, with an optional budget whose members take their defaults.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `invalid-input` when the request names no target, breaks its contract, or sends a continuation issued for another target or budget; `stale-base` when a continuation or modelRevision belongs to another revision; the refusal names the request that starts again; `unresolved-context` when 'workspace': true finds no workspace model, or no recorded progress is supplied for a resume target.
- Next action: follow the continuation while completeness lists omissions, then check readiness for the task, through [checkReadiness](#checkreadiness).
- Proof limits: `supplied-records`.
- MCP tool: `loom.context`, input `ContextInput`, result data `ContextData`.
- Command: `context --kind component|record|claim|task --id <id> [--record-kind <kind>] [--max-records n] [--max-bytes n] [--continuation <token>]`.

Presence rules of `loom.context`, checked before anything runs:

- Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.context`:

> Retrieve the required context of a component, record, claim or task a page at a time within a discovery budget, nearest first, with sources, owners, baseline status, constraints, decisions and evidence, or for a resume target the recorded outcome, phase, owning scopes, frozen contracts, blocking unknowns, evidence, pending work and next actions, record text coming back as data and never as an instruction. Prerequisites: a model, inline or the workspace model; a target, with an optional budget whose members take their defaults. Effects: reads persisted state and persists nothing. Refused as invalid-input when the request names no target, breaks its contract, or sends a continuation issued for another target or budget; as stale-base when a continuation or modelRevision belongs to another revision; the refusal names the request that starts again; as unresolved-context when 'workspace': true finds no workspace model, or no recorded progress is supplied for a resume target. Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. Next: follow the continuation while completeness lists omissions, then check readiness for the task with loom.checkReadiness.

Examples:

- The required context of one component within 50 records.

  ```json
  {
    "workspaceId": "ws_example",
    "target": {
      "kind": "component",
      "ref": {
        "kind": "component",
        "id": "ordering"
      }
    },
    "budget": {
      "maxRecords": 50
    }
  }
  ```

- The required context of the ordering component within 50 records.

  ```sh
  node packages/cli/dist/index.js context --kind component --id ordering --max-records 50
  ```

### checkReadiness

Evaluate whether a task is ready, blocked or unresolved, with the exact missing prerequisites, permitted substitutes, allowed next work and its work package.

- Prerequisites: a model, inline or the workspace model; the class, mode and scope of the task.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `invalid-input` when the request names no task or breaks its contract; `stale-base` when the model is not at the requested candidateRevision; `unresolved-context` when 'workspace': true finds no workspace model.
- Next action: read the context of a missing prerequisite, or start the allowed next work, through [context](#context).
- Proof limits: `validation-scope`, `supplied-records`.
- MCP tool: `loom.checkReadiness`, input `CheckReadinessInput`, result data `ReadinessData`.
- Command: `readiness --class <class> [--mode component|slice] [--components a,b] [--requirements r,...]` or `readiness --task <file>`.

Presence rules of `loom.checkReadiness`, checked before anything runs:

- Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.checkReadiness`:

> Evaluate whether a task is ready, blocked or unresolved, with the exact missing prerequisites, permitted substitutes, allowed next work and its work package. Prerequisites: a model, inline or the workspace model; the class, mode and scope of the task. Effects: reads persisted state and persists nothing. Refused as invalid-input when the request names no task or breaks its contract; as stale-base when the model is not at the requested candidateRevision; as unresolved-context when 'workspace': true finds no workspace model. Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. Next: read the context of a missing prerequisite, or start the allowed next work with loom.context.

Examples:

- Is the billing component ready for implementation?

  ```json
  {
    "workspaceId": "ws_example",
    "task": {
      "class": "implementation",
      "mode": "component",
      "components": [
        "billing"
      ]
    }
  }
  ```

- Is the billing component ready for implementation?

  ```sh
  node packages/cli/dist/index.js readiness --class implementation --components billing
  ```

### planChange

Preview a change against a base revision without persisting it: the delta, compatibility by dimension, affected consumers with dependency paths, invalidated evidence, repair alternatives, obligations and whether policy requires acceptance.

- Prerequisites: a model, inline or the workspace model; one patch or a batch, planned against the current model revision as 'baseRevision' or --base, which the command line defaults to the current revision.
- Effects: `none`, persists nothing.
- Refusals: `stale-base` when the model is not at the base revision; `invalid-input` when a patch or the resulting model is invalid; `policy-failure` when a breaking or unclassified change lacks its version bump or acknowledgement.
- Next action: apply the change against the same revision, through [mutate](#mutate).
- Proof limits: `validation-scope`, `supplied-records`, `predicates`.
- MCP tool: `loom.planChange`, input `PlanChangeInput`, result data `PlanChangeData`.
- Command: `plan --patch <file> [--base <revision>] [--ack id,...]`.

Presence rules of `loom.planChange`, checked before anything runs:

- Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.
- Send 'patch' without 'patches', or send 'patches' without 'patch'. A request matching no combination is refused with `PATCH_AMBIGUOUS` at `(root)`.

Description of `loom.planChange`:

> Preview a change against a base revision without persisting it: the delta, compatibility by dimension, affected consumers with dependency paths, invalidated evidence, repair alternatives, obligations and whether policy requires acceptance. Prerequisites: a model, inline or the workspace model; one patch or a batch, planned against the current model revision as 'baseRevision' or --base, which the command line defaults to the current revision. Effects: persists nothing. Refused as stale-base when the model is not at the base revision; as invalid-input when a patch or the resulting model is invalid; as policy-failure when a breaking or unclassified change lacks its version bump or acknowledgement. Send 'model' without 'workspaceId', or send 'workspaceId' without 'model'. Send 'patch' without 'patches', or send 'patches' without 'patch'. Next: apply the change against the same revision with loom.mutate.

Examples:

- Preview adding an optional property against a base revision.

  ```json
  {
    "workspaceId": "ws_example",
    "baseRevision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "patch": {
      "op": "addItem",
      "collection": "types",
      "id": "order",
      "field": "properties",
      "item": {
        "name": "currency",
        "kind": "string",
        "required": false,
        "nullable": true,
        "immutable": false,
        "origin": "client"
      }
    }
  }
  ```

- Preview patch.json against the current revision.

  ```sh
  node packages/cli/dist/index.js plan --patch patch.json
  ```

### workspaceInspect

Inspect a local path: its repository, the descriptors that own or overlap it, the enclosing composition, the existing models, the direct submodules, the affected tracked and untracked paths, and suggested workspace placements with their reasons and an inspection digest.

- Prerequisites: a local path.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `invalid-input` when the path does not exist.
- Next action: initialize a workspace at a suggested placement, through [workspaceInitialize](#workspaceinitialize).
- Proof limits: none.
- MCP tool: `loom.workspace`, input `WorkspaceInput`, result data `WorkspaceData`.
- Command: `workspace inspect [<path>] [--boundary <dir>]`.

Presence rules of `loom.workspace`, checked before anything runs:

- When 'action' is 'inspect', send 'path' without 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view' or 'workspaceId'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.workspace`:

> Action 'inspect': Inspect a local path: its repository, the descriptors that own or overlap it, the enclosing composition, the existing models, the direct submodules, the affected tracked and untracked paths, and suggested workspace placements with their reasons and an inspection digest. Prerequisites: a local path. Effects: reads persisted state and persists nothing. Refused as invalid-input when the path does not exist. When 'action' is 'inspect', send 'path' without 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view' or 'workspaceId'. Next: initialize a workspace at a suggested placement with loom.workspace. Action 'initialize': Initialize a workspace from a declaration validated as persistent configuration: a dry run proposes the scaffold, and an apply writes only the scaffold and its journal. Prerequisites: the path's inspection digest; a declaration of the model id, kind, claims and members. Effects: can persist changes. Refused as invalid-input when the declaration breaks the configuration contract or the path is no repository root; as policy-failure when the declaration claims a path another descriptor owns; as stale-base when the inspection changed since 'expectedInspection', and nothing is written. When 'action' is 'initialize', send 'path' and 'declaration' and 'dryRun' without 'boundary' or 'access' or 'view' or 'workspaceId'. When 'action' is 'initialize' and 'dryRun' is false, send 'expectedInspection'. Next: open the created workspace with loom.workspace. Action 'open': Open a workspace for this session with read or edit access, returning its handle, a bounded summary and, unless declined, its browser view's loopback URL, without changing the model. Prerequisites: a governed workspace at the path. Effects: reads persisted state and persists nothing. Refused as access-denied when the path is outside the server's configured allowed roots; as unresolved-context when no workspace governs the path; inspect and initialize one. When 'action' is 'open', send 'path' and 'access' without 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'workspaceId'. Next: read the workspace status with loom.workspace. Action 'status': Report an open workspace's current revisions, the resources it serves, its pending runs and the next actions. Prerequisites: a handle this session opened. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; open the workspace again. When 'action' is 'status' or 'close', send 'workspaceId' without 'path' or 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view'. Next: follow a next action, or close the handle with loom.workspace. Action 'close': Close a handle: cancel or await its runs, detach its watchers, revoke its browser access and release it, reporting every cleanup failure. Prerequisites: a handle this session opened. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as cleanup-incomplete when an owned resource remains, which the result names with its recovery. Next: open the workspace again to continue with loom.workspace.

Examples:

- Inspect a checkout before placing a workspace in it.

  ```json
  {
    "action": "inspect",
    "path": "services/payments"
  }
  ```

- Read workspace inspect.

  ```sh
  node packages/cli/dist/index.js workspace inspect . --json
  ```

### workspaceInitialize

Initialize a workspace from a declaration validated as persistent configuration: a dry run proposes the scaffold, and an apply writes only the scaffold and its journal.

- Prerequisites: the path's inspection digest; a declaration of the model id, kind, claims and members.
- Effects: `writes`, can persist changes.
- Refusals: `invalid-input` when the declaration breaks the configuration contract or the path is no repository root; `policy-failure` when the declaration claims a path another descriptor owns; `stale-base` when the inspection changed since 'expectedInspection', and nothing is written.
- Next action: open the created workspace, through [workspaceOpen](#workspaceopen).
- Proof limits: none.
- MCP tool: `loom.workspace`, input `WorkspaceInput`, result data `WorkspaceData`.
- Command: none.
- Not exposed: Workspace handles belong to a server session; initialization is also available through init.

Presence rules of `loom.workspace`, checked before anything runs:

- When 'action' is 'initialize', send 'path' and 'declaration' and 'dryRun' without 'boundary' or 'access' or 'view' or 'workspaceId'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.
- When 'action' is 'initialize' and 'dryRun' is false, send 'expectedInspection'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `expectedInspection`.

Description of `loom.workspace`:

> Action 'inspect': Inspect a local path: its repository, the descriptors that own or overlap it, the enclosing composition, the existing models, the direct submodules, the affected tracked and untracked paths, and suggested workspace placements with their reasons and an inspection digest. Prerequisites: a local path. Effects: reads persisted state and persists nothing. Refused as invalid-input when the path does not exist. When 'action' is 'inspect', send 'path' without 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view' or 'workspaceId'. Next: initialize a workspace at a suggested placement with loom.workspace. Action 'initialize': Initialize a workspace from a declaration validated as persistent configuration: a dry run proposes the scaffold, and an apply writes only the scaffold and its journal. Prerequisites: the path's inspection digest; a declaration of the model id, kind, claims and members. Effects: can persist changes. Refused as invalid-input when the declaration breaks the configuration contract or the path is no repository root; as policy-failure when the declaration claims a path another descriptor owns; as stale-base when the inspection changed since 'expectedInspection', and nothing is written. When 'action' is 'initialize', send 'path' and 'declaration' and 'dryRun' without 'boundary' or 'access' or 'view' or 'workspaceId'. When 'action' is 'initialize' and 'dryRun' is false, send 'expectedInspection'. Next: open the created workspace with loom.workspace. Action 'open': Open a workspace for this session with read or edit access, returning its handle, a bounded summary and, unless declined, its browser view's loopback URL, without changing the model. Prerequisites: a governed workspace at the path. Effects: reads persisted state and persists nothing. Refused as access-denied when the path is outside the server's configured allowed roots; as unresolved-context when no workspace governs the path; inspect and initialize one. When 'action' is 'open', send 'path' and 'access' without 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'workspaceId'. Next: read the workspace status with loom.workspace. Action 'status': Report an open workspace's current revisions, the resources it serves, its pending runs and the next actions. Prerequisites: a handle this session opened. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; open the workspace again. When 'action' is 'status' or 'close', send 'workspaceId' without 'path' or 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view'. Next: follow a next action, or close the handle with loom.workspace. Action 'close': Close a handle: cancel or await its runs, detach its watchers, revoke its browser access and release it, reporting every cleanup failure. Prerequisites: a handle this session opened. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as cleanup-incomplete when an owned resource remains, which the result names with its recovery. Next: open the workspace again to continue with loom.workspace.

Examples:

- Propose the scaffold of an implementation workspace without writing it.

  ```json
  {
    "action": "initialize",
    "path": "services/payments",
    "declaration": {
      "configVersion": 1,
      "modelId": "payments",
      "modelKind": "implementation",
      "model": "model.json",
      "scope": {
        "payments": [
          "src"
        ]
      },
      "outputs": {},
      "gates": {}
    },
    "dryRun": true
  }
  ```

- Create it against the inspection it was prepared from.

  ```json
  {
    "action": "initialize",
    "path": "services/payments",
    "declaration": {
      "configVersion": 1,
      "modelId": "payments",
      "modelKind": "implementation",
      "model": "model.json",
      "scope": {
        "payments": [
          "src"
        ]
      },
      "outputs": {},
      "gates": {}
    },
    "dryRun": false,
    "expectedInspection": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }
  ```

### workspaceOpen

Open a workspace for this session with read or edit access, returning its handle, a bounded summary and, unless declined, its browser view's loopback URL, without changing the model.

- Prerequisites: a governed workspace at the path.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `access-denied` when the path is outside the server's configured allowed roots; `unresolved-context` when no workspace governs the path; inspect and initialize one.
- Next action: read the workspace status, through [workspaceStatus](#workspacestatus).
- Proof limits: none.
- MCP tool: `loom.workspace`, input `WorkspaceInput`, result data `WorkspaceData`.
- Command: none.
- Not exposed: Workspace handles belong to a server session; initialization is also available through init.

Presence rules of `loom.workspace`, checked before anything runs:

- When 'action' is 'open', send 'path' and 'access' without 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'workspaceId'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.workspace`:

> Action 'inspect': Inspect a local path: its repository, the descriptors that own or overlap it, the enclosing composition, the existing models, the direct submodules, the affected tracked and untracked paths, and suggested workspace placements with their reasons and an inspection digest. Prerequisites: a local path. Effects: reads persisted state and persists nothing. Refused as invalid-input when the path does not exist. When 'action' is 'inspect', send 'path' without 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view' or 'workspaceId'. Next: initialize a workspace at a suggested placement with loom.workspace. Action 'initialize': Initialize a workspace from a declaration validated as persistent configuration: a dry run proposes the scaffold, and an apply writes only the scaffold and its journal. Prerequisites: the path's inspection digest; a declaration of the model id, kind, claims and members. Effects: can persist changes. Refused as invalid-input when the declaration breaks the configuration contract or the path is no repository root; as policy-failure when the declaration claims a path another descriptor owns; as stale-base when the inspection changed since 'expectedInspection', and nothing is written. When 'action' is 'initialize', send 'path' and 'declaration' and 'dryRun' without 'boundary' or 'access' or 'view' or 'workspaceId'. When 'action' is 'initialize' and 'dryRun' is false, send 'expectedInspection'. Next: open the created workspace with loom.workspace. Action 'open': Open a workspace for this session with read or edit access, returning its handle, a bounded summary and, unless declined, its browser view's loopback URL, without changing the model. Prerequisites: a governed workspace at the path. Effects: reads persisted state and persists nothing. Refused as access-denied when the path is outside the server's configured allowed roots; as unresolved-context when no workspace governs the path; inspect and initialize one. When 'action' is 'open', send 'path' and 'access' without 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'workspaceId'. Next: read the workspace status with loom.workspace. Action 'status': Report an open workspace's current revisions, the resources it serves, its pending runs and the next actions. Prerequisites: a handle this session opened. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; open the workspace again. When 'action' is 'status' or 'close', send 'workspaceId' without 'path' or 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view'. Next: follow a next action, or close the handle with loom.workspace. Action 'close': Close a handle: cancel or await its runs, detach its watchers, revoke its browser access and release it, reporting every cleanup failure. Prerequisites: a handle this session opened. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as cleanup-incomplete when an owned resource remains, which the result names with its recovery. Next: open the workspace again to continue with loom.workspace.

Examples:

- Open a workspace to read it, with its browser view.

  ```json
  {
    "action": "open",
    "path": "services/payments",
    "access": "read"
  }
  ```

- Open it for editing without a browser view.

  ```json
  {
    "action": "open",
    "path": "services/payments",
    "access": "edit",
    "view": false
  }
  ```

### workspaceStatus

Report an open workspace's current revisions, the resources it serves, its pending runs and the next actions.

- Prerequisites: a handle this session opened.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `unknown-handle` when the workspaceId names no handle of this session; open the workspace again.
- Next action: follow a next action, or close the handle, through [workspaceClose](#workspaceclose).
- Proof limits: none.
- MCP tool: `loom.workspace`, input `WorkspaceInput`, result data `WorkspaceData`.
- Command: `workspace status [<path>] [--boundary <dir>]`.

Presence rules of `loom.workspace`, checked before anything runs:

- When 'action' is 'status' or 'close', send 'workspaceId' without 'path' or 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.workspace`:

> Action 'inspect': Inspect a local path: its repository, the descriptors that own or overlap it, the enclosing composition, the existing models, the direct submodules, the affected tracked and untracked paths, and suggested workspace placements with their reasons and an inspection digest. Prerequisites: a local path. Effects: reads persisted state and persists nothing. Refused as invalid-input when the path does not exist. When 'action' is 'inspect', send 'path' without 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view' or 'workspaceId'. Next: initialize a workspace at a suggested placement with loom.workspace. Action 'initialize': Initialize a workspace from a declaration validated as persistent configuration: a dry run proposes the scaffold, and an apply writes only the scaffold and its journal. Prerequisites: the path's inspection digest; a declaration of the model id, kind, claims and members. Effects: can persist changes. Refused as invalid-input when the declaration breaks the configuration contract or the path is no repository root; as policy-failure when the declaration claims a path another descriptor owns; as stale-base when the inspection changed since 'expectedInspection', and nothing is written. When 'action' is 'initialize', send 'path' and 'declaration' and 'dryRun' without 'boundary' or 'access' or 'view' or 'workspaceId'. When 'action' is 'initialize' and 'dryRun' is false, send 'expectedInspection'. Next: open the created workspace with loom.workspace. Action 'open': Open a workspace for this session with read or edit access, returning its handle, a bounded summary and, unless declined, its browser view's loopback URL, without changing the model. Prerequisites: a governed workspace at the path. Effects: reads persisted state and persists nothing. Refused as access-denied when the path is outside the server's configured allowed roots; as unresolved-context when no workspace governs the path; inspect and initialize one. When 'action' is 'open', send 'path' and 'access' without 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'workspaceId'. Next: read the workspace status with loom.workspace. Action 'status': Report an open workspace's current revisions, the resources it serves, its pending runs and the next actions. Prerequisites: a handle this session opened. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; open the workspace again. When 'action' is 'status' or 'close', send 'workspaceId' without 'path' or 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view'. Next: follow a next action, or close the handle with loom.workspace. Action 'close': Close a handle: cancel or await its runs, detach its watchers, revoke its browser access and release it, reporting every cleanup failure. Prerequisites: a handle this session opened. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as cleanup-incomplete when an owned resource remains, which the result names with its recovery. Next: open the workspace again to continue with loom.workspace.

Examples:

- Read the status of an open workspace.

  ```json
  {
    "action": "status",
    "workspaceId": "ws_3f9a1c7d"
  }
  ```

- Read workspace status.

  ```sh
  node packages/cli/dist/index.js workspace status . --json
  ```

### workspaceClose

Close a handle: cancel or await its runs, detach its watchers, revoke its browser access and release it, reporting every cleanup failure.

- Prerequisites: a handle this session opened.
- Effects: `writes`, can persist changes.
- Refusals: `unknown-handle` when the workspaceId names no handle of this session; `cleanup-incomplete` when an owned resource remains, which the result names with its recovery.
- Next action: open the workspace again to continue, through [workspaceOpen](#workspaceopen).
- Proof limits: none.
- MCP tool: `loom.workspace`, input `WorkspaceInput`, result data `WorkspaceData`.
- Command: none.
- Not exposed: Workspace handles belong to a server session; initialization is also available through init.

Presence rules of `loom.workspace`, checked before anything runs:

- When 'action' is 'status' or 'close', send 'workspaceId' without 'path' or 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.workspace`:

> Action 'inspect': Inspect a local path: its repository, the descriptors that own or overlap it, the enclosing composition, the existing models, the direct submodules, the affected tracked and untracked paths, and suggested workspace placements with their reasons and an inspection digest. Prerequisites: a local path. Effects: reads persisted state and persists nothing. Refused as invalid-input when the path does not exist. When 'action' is 'inspect', send 'path' without 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view' or 'workspaceId'. Next: initialize a workspace at a suggested placement with loom.workspace. Action 'initialize': Initialize a workspace from a declaration validated as persistent configuration: a dry run proposes the scaffold, and an apply writes only the scaffold and its journal. Prerequisites: the path's inspection digest; a declaration of the model id, kind, claims and members. Effects: can persist changes. Refused as invalid-input when the declaration breaks the configuration contract or the path is no repository root; as policy-failure when the declaration claims a path another descriptor owns; as stale-base when the inspection changed since 'expectedInspection', and nothing is written. When 'action' is 'initialize', send 'path' and 'declaration' and 'dryRun' without 'boundary' or 'access' or 'view' or 'workspaceId'. When 'action' is 'initialize' and 'dryRun' is false, send 'expectedInspection'. Next: open the created workspace with loom.workspace. Action 'open': Open a workspace for this session with read or edit access, returning its handle, a bounded summary and, unless declined, its browser view's loopback URL, without changing the model. Prerequisites: a governed workspace at the path. Effects: reads persisted state and persists nothing. Refused as access-denied when the path is outside the server's configured allowed roots; as unresolved-context when no workspace governs the path; inspect and initialize one. When 'action' is 'open', send 'path' and 'access' without 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'workspaceId'. Next: read the workspace status with loom.workspace. Action 'status': Report an open workspace's current revisions, the resources it serves, its pending runs and the next actions. Prerequisites: a handle this session opened. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; open the workspace again. When 'action' is 'status' or 'close', send 'workspaceId' without 'path' or 'boundary' or 'declaration' or 'dryRun' or 'expectedInspection' or 'access' or 'view'. Next: follow a next action, or close the handle with loom.workspace. Action 'close': Close a handle: cancel or await its runs, detach its watchers, revoke its browser access and release it, reporting every cleanup failure. Prerequisites: a handle this session opened. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as cleanup-incomplete when an owned resource remains, which the result names with its recovery. Next: open the workspace again to continue with loom.workspace.

Examples:

- Close a handle and release what it owns.

  ```json
  {
    "action": "close",
    "workspaceId": "ws_3f9a1c7d"
  }
  ```

### federationInspect

Inspect a composition: its direct members and pins, the roots each model claims, missing inputs and the dependency graph between models.

- Prerequisites: a handle on a composition or mixed workspace.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `unknown-handle` when the workspaceId names no handle of this session; `unmet-prerequisite` when the workspace declares no composition.
- Next action: plan a change to the composition, through [federationPlan](#federationplan).
- Proof limits: none.
- MCP tool: `loom.federation`, input `FederationInput`, result data `FederationData`.
- Command: `federation inspect [options]`.

Presence rules of `loom.federation`, checked before anything runs:

- When 'action' is 'inspect', omit 'changes' and 'expectedVector' and 'proposalId' and 'snapshotDigest' and 'export' and 'purpose'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.federation`:

> Action 'inspect': Inspect a composition: its direct members and pins, the roots each model claims, missing inputs and the dependency graph between models. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as unmet-prerequisite when the workspace declares no composition. When 'action' is 'inspect', omit 'changes' and 'expectedVector' and 'proposalId' and 'snapshotDigest' and 'export' and 'purpose'. Next: plan a change to the composition with loom.federation. Action 'plan': Plan typed changes to membership, agreements, export pins or output claims as an immutable proposal with its owner-local writes, impact, invalidated evidence and required acceptance, writing nothing. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as stale-base when an input changed since 'expectedVector'; the result names the current revisions; as policy-failure when a change claims a root another model owns or edits another owner's record. When 'action' is 'plan', send 'changes' and 'expectedVector' without 'proposalId' or 'snapshotDigest' or 'export' or 'purpose'. Next: apply the proposal against the same revision vector with loom.federation. Action 'apply': Apply a planned proposal as journaled owner-local writes in canonical repository order after the authorization and revision checks; an incomplete change stays visibly recoverable. Prerequisites: a proposal a plan returned; the acceptance the owners' trusted policies require. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle was opened with read access; as stale-base when an input changed since 'expectedVector', and nothing is written; as unmet-prerequisite when an owner's trusted policy requires an acceptance the proposal lacks; as recovery-required when a journal holds an incomplete change. When 'action' is 'apply', send 'proposalId' and 'expectedVector' without 'changes' or 'snapshotDigest' or 'export' or 'purpose'. Next: check the composed result with loom.federation. Action 'check': Resolve a composition snapshot's closure and evaluate its composed validation and readiness, manufacturing no acceptance. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as unresolved-context when 'snapshotDigest' names no snapshot of the composition. When 'action' is 'check', omit 'changes' and 'expectedVector' and 'proposalId' and 'export' and 'purpose'. Next: publish the export or the agreements with loom.federation. Action 'publish': Publish an immutable bundle, a member's export or a composition's agreements; a draft is never trusted as a release, and a release needs the configured acceptance and evidence. Prerequisites: a handle with the publish capability. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle lacks the publish capability; as stale-base when an input changed since 'expectedVector'; as unmet-prerequisite when a release lacks its configured acceptance or evidence; as policy-failure when the export omits a record of its required closure. When 'action' is 'publish', send 'export' and 'expectedVector' and 'purpose' without 'changes' or 'proposalId' or 'snapshotDigest'. Next: pin the published bundle in the consuming composition with loom.federation.

Examples:

- Inspect the members and pins of an open composition.

  ```json
  {
    "action": "inspect",
    "workspaceId": "ws_3f9a1c7d"
  }
  ```

### federationPlan

Plan typed changes to membership, agreements, export pins or output claims as an immutable proposal with its owner-local writes, impact, invalidated evidence and required acceptance, writing nothing.

- Prerequisites: a handle on a composition or mixed workspace.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `unknown-handle` when the workspaceId names no handle of this session; `stale-base` when an input changed since 'expectedVector'; the result names the current revisions; `policy-failure` when a change claims a root another model owns or edits another owner's record.
- Next action: apply the proposal against the same revision vector, through [federationApply](#federationapply).
- Proof limits: none.
- MCP tool: `loom.federation`, input `FederationInput`, result data `FederationData`.
- Command: `federation plan [options]`.

Presence rules of `loom.federation`, checked before anything runs:

- When 'action' is 'plan', send 'changes' and 'expectedVector' without 'proposalId' or 'snapshotDigest' or 'export' or 'purpose'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.federation`:

> Action 'inspect': Inspect a composition: its direct members and pins, the roots each model claims, missing inputs and the dependency graph between models. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as unmet-prerequisite when the workspace declares no composition. When 'action' is 'inspect', omit 'changes' and 'expectedVector' and 'proposalId' and 'snapshotDigest' and 'export' and 'purpose'. Next: plan a change to the composition with loom.federation. Action 'plan': Plan typed changes to membership, agreements, export pins or output claims as an immutable proposal with its owner-local writes, impact, invalidated evidence and required acceptance, writing nothing. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as stale-base when an input changed since 'expectedVector'; the result names the current revisions; as policy-failure when a change claims a root another model owns or edits another owner's record. When 'action' is 'plan', send 'changes' and 'expectedVector' without 'proposalId' or 'snapshotDigest' or 'export' or 'purpose'. Next: apply the proposal against the same revision vector with loom.federation. Action 'apply': Apply a planned proposal as journaled owner-local writes in canonical repository order after the authorization and revision checks; an incomplete change stays visibly recoverable. Prerequisites: a proposal a plan returned; the acceptance the owners' trusted policies require. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle was opened with read access; as stale-base when an input changed since 'expectedVector', and nothing is written; as unmet-prerequisite when an owner's trusted policy requires an acceptance the proposal lacks; as recovery-required when a journal holds an incomplete change. When 'action' is 'apply', send 'proposalId' and 'expectedVector' without 'changes' or 'snapshotDigest' or 'export' or 'purpose'. Next: check the composed result with loom.federation. Action 'check': Resolve a composition snapshot's closure and evaluate its composed validation and readiness, manufacturing no acceptance. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as unresolved-context when 'snapshotDigest' names no snapshot of the composition. When 'action' is 'check', omit 'changes' and 'expectedVector' and 'proposalId' and 'export' and 'purpose'. Next: publish the export or the agreements with loom.federation. Action 'publish': Publish an immutable bundle, a member's export or a composition's agreements; a draft is never trusted as a release, and a release needs the configured acceptance and evidence. Prerequisites: a handle with the publish capability. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle lacks the publish capability; as stale-base when an input changed since 'expectedVector'; as unmet-prerequisite when a release lacks its configured acceptance or evidence; as policy-failure when the export omits a record of its required closure. When 'action' is 'publish', send 'export' and 'expectedVector' and 'purpose' without 'changes' or 'proposalId' or 'snapshotDigest'. Next: pin the published bundle in the consuming composition with loom.federation.

Examples:

- Plan claiming the generated documentation root for the composition.

  ```json
  {
    "action": "plan",
    "workspaceId": "ws_3f9a1c7d",
    "changes": [
      {
        "change": "claimOutput",
        "path": "Docs/Loom"
      }
    ],
    "expectedVector": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }
  ```

### federationApply

Apply a planned proposal as journaled owner-local writes in canonical repository order after the authorization and revision checks; an incomplete change stays visibly recoverable.

- Prerequisites: a proposal a plan returned; the acceptance the owners' trusted policies require.
- Effects: `writes`, can persist changes.
- Refusals: `unknown-handle` when the workspaceId names no handle of this session; `access-denied` when the handle was opened with read access; `stale-base` when an input changed since 'expectedVector', and nothing is written; `unmet-prerequisite` when an owner's trusted policy requires an acceptance the proposal lacks; `recovery-required` when a journal holds an incomplete change.
- Next action: check the composed result, through [federationCheck](#federationcheck).
- Proof limits: none.
- MCP tool: `loom.federation`, input `FederationInput`, result data `FederationData`.
- Command: `federation apply [options]`.

Presence rules of `loom.federation`, checked before anything runs:

- When 'action' is 'apply', send 'proposalId' and 'expectedVector' without 'changes' or 'snapshotDigest' or 'export' or 'purpose'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.federation`:

> Action 'inspect': Inspect a composition: its direct members and pins, the roots each model claims, missing inputs and the dependency graph between models. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as unmet-prerequisite when the workspace declares no composition. When 'action' is 'inspect', omit 'changes' and 'expectedVector' and 'proposalId' and 'snapshotDigest' and 'export' and 'purpose'. Next: plan a change to the composition with loom.federation. Action 'plan': Plan typed changes to membership, agreements, export pins or output claims as an immutable proposal with its owner-local writes, impact, invalidated evidence and required acceptance, writing nothing. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as stale-base when an input changed since 'expectedVector'; the result names the current revisions; as policy-failure when a change claims a root another model owns or edits another owner's record. When 'action' is 'plan', send 'changes' and 'expectedVector' without 'proposalId' or 'snapshotDigest' or 'export' or 'purpose'. Next: apply the proposal against the same revision vector with loom.federation. Action 'apply': Apply a planned proposal as journaled owner-local writes in canonical repository order after the authorization and revision checks; an incomplete change stays visibly recoverable. Prerequisites: a proposal a plan returned; the acceptance the owners' trusted policies require. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle was opened with read access; as stale-base when an input changed since 'expectedVector', and nothing is written; as unmet-prerequisite when an owner's trusted policy requires an acceptance the proposal lacks; as recovery-required when a journal holds an incomplete change. When 'action' is 'apply', send 'proposalId' and 'expectedVector' without 'changes' or 'snapshotDigest' or 'export' or 'purpose'. Next: check the composed result with loom.federation. Action 'check': Resolve a composition snapshot's closure and evaluate its composed validation and readiness, manufacturing no acceptance. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as unresolved-context when 'snapshotDigest' names no snapshot of the composition. When 'action' is 'check', omit 'changes' and 'expectedVector' and 'proposalId' and 'export' and 'purpose'. Next: publish the export or the agreements with loom.federation. Action 'publish': Publish an immutable bundle, a member's export or a composition's agreements; a draft is never trusted as a release, and a release needs the configured acceptance and evidence. Prerequisites: a handle with the publish capability. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle lacks the publish capability; as stale-base when an input changed since 'expectedVector'; as unmet-prerequisite when a release lacks its configured acceptance or evidence; as policy-failure when the export omits a record of its required closure. When 'action' is 'publish', send 'export' and 'expectedVector' and 'purpose' without 'changes' or 'proposalId' or 'snapshotDigest'. Next: pin the published bundle in the consuming composition with loom.federation.

Examples:

- Apply a planned proposal against the vector it was planned on.

  ```json
  {
    "action": "apply",
    "workspaceId": "ws_3f9a1c7d",
    "proposalId": "prop-1",
    "expectedVector": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }
  ```

### federationCheck

Resolve a composition snapshot's closure and evaluate its composed validation and readiness, manufacturing no acceptance.

- Prerequisites: a handle on a composition or mixed workspace.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `unknown-handle` when the workspaceId names no handle of this session; `unresolved-context` when 'snapshotDigest' names no snapshot of the composition.
- Next action: publish the export or the agreements, through [federationPublish](#federationpublish).
- Proof limits: `validation-scope`, `supplied-records`.
- MCP tool: `loom.federation`, input `FederationInput`, result data `FederationData`.
- Command: `federation check [options]`.

Presence rules of `loom.federation`, checked before anything runs:

- When 'action' is 'check', omit 'changes' and 'expectedVector' and 'proposalId' and 'export' and 'purpose'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.federation`:

> Action 'inspect': Inspect a composition: its direct members and pins, the roots each model claims, missing inputs and the dependency graph between models. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as unmet-prerequisite when the workspace declares no composition. When 'action' is 'inspect', omit 'changes' and 'expectedVector' and 'proposalId' and 'snapshotDigest' and 'export' and 'purpose'. Next: plan a change to the composition with loom.federation. Action 'plan': Plan typed changes to membership, agreements, export pins or output claims as an immutable proposal with its owner-local writes, impact, invalidated evidence and required acceptance, writing nothing. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as stale-base when an input changed since 'expectedVector'; the result names the current revisions; as policy-failure when a change claims a root another model owns or edits another owner's record. When 'action' is 'plan', send 'changes' and 'expectedVector' without 'proposalId' or 'snapshotDigest' or 'export' or 'purpose'. Next: apply the proposal against the same revision vector with loom.federation. Action 'apply': Apply a planned proposal as journaled owner-local writes in canonical repository order after the authorization and revision checks; an incomplete change stays visibly recoverable. Prerequisites: a proposal a plan returned; the acceptance the owners' trusted policies require. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle was opened with read access; as stale-base when an input changed since 'expectedVector', and nothing is written; as unmet-prerequisite when an owner's trusted policy requires an acceptance the proposal lacks; as recovery-required when a journal holds an incomplete change. When 'action' is 'apply', send 'proposalId' and 'expectedVector' without 'changes' or 'snapshotDigest' or 'export' or 'purpose'. Next: check the composed result with loom.federation. Action 'check': Resolve a composition snapshot's closure and evaluate its composed validation and readiness, manufacturing no acceptance. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as unresolved-context when 'snapshotDigest' names no snapshot of the composition. When 'action' is 'check', omit 'changes' and 'expectedVector' and 'proposalId' and 'export' and 'purpose'. Next: publish the export or the agreements with loom.federation. Action 'publish': Publish an immutable bundle, a member's export or a composition's agreements; a draft is never trusted as a release, and a release needs the configured acceptance and evidence. Prerequisites: a handle with the publish capability. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle lacks the publish capability; as stale-base when an input changed since 'expectedVector'; as unmet-prerequisite when a release lacks its configured acceptance or evidence; as policy-failure when the export omits a record of its required closure. When 'action' is 'publish', send 'export' and 'expectedVector' and 'purpose' without 'changes' or 'proposalId' or 'snapshotDigest'. Next: pin the published bundle in the consuming composition with loom.federation.

Examples:

- Check the current composition snapshot.

  ```json
  {
    "action": "check",
    "workspaceId": "ws_3f9a1c7d"
  }
  ```

### federationPublish

Publish an immutable bundle, a member's export or a composition's agreements; a draft is never trusted as a release, and a release needs the configured acceptance and evidence.

- Prerequisites: a handle with the publish capability.
- Effects: `writes`, can persist changes.
- Refusals: `unknown-handle` when the workspaceId names no handle of this session; `access-denied` when the handle lacks the publish capability; `stale-base` when an input changed since 'expectedVector'; `unmet-prerequisite` when a release lacks its configured acceptance or evidence; `policy-failure` when the export omits a record of its required closure.
- Next action: pin the published bundle in the consuming composition, through [federationPlan](#federationplan).
- Proof limits: none.
- MCP tool: `loom.federation`, input `FederationInput`, result data `FederationData`.
- Command: `federation publish [options]`.

Presence rules of `loom.federation`, checked before anything runs:

- When 'action' is 'publish', send 'export' and 'expectedVector' and 'purpose' without 'changes' or 'proposalId' or 'snapshotDigest'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.federation`:

> Action 'inspect': Inspect a composition: its direct members and pins, the roots each model claims, missing inputs and the dependency graph between models. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as unmet-prerequisite when the workspace declares no composition. When 'action' is 'inspect', omit 'changes' and 'expectedVector' and 'proposalId' and 'snapshotDigest' and 'export' and 'purpose'. Next: plan a change to the composition with loom.federation. Action 'plan': Plan typed changes to membership, agreements, export pins or output claims as an immutable proposal with its owner-local writes, impact, invalidated evidence and required acceptance, writing nothing. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as stale-base when an input changed since 'expectedVector'; the result names the current revisions; as policy-failure when a change claims a root another model owns or edits another owner's record. When 'action' is 'plan', send 'changes' and 'expectedVector' without 'proposalId' or 'snapshotDigest' or 'export' or 'purpose'. Next: apply the proposal against the same revision vector with loom.federation. Action 'apply': Apply a planned proposal as journaled owner-local writes in canonical repository order after the authorization and revision checks; an incomplete change stays visibly recoverable. Prerequisites: a proposal a plan returned; the acceptance the owners' trusted policies require. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle was opened with read access; as stale-base when an input changed since 'expectedVector', and nothing is written; as unmet-prerequisite when an owner's trusted policy requires an acceptance the proposal lacks; as recovery-required when a journal holds an incomplete change. When 'action' is 'apply', send 'proposalId' and 'expectedVector' without 'changes' or 'snapshotDigest' or 'export' or 'purpose'. Next: check the composed result with loom.federation. Action 'check': Resolve a composition snapshot's closure and evaluate its composed validation and readiness, manufacturing no acceptance. Prerequisites: a handle on a composition or mixed workspace. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as unresolved-context when 'snapshotDigest' names no snapshot of the composition. When 'action' is 'check', omit 'changes' and 'expectedVector' and 'proposalId' and 'export' and 'purpose'. Next: publish the export or the agreements with loom.federation. Action 'publish': Publish an immutable bundle, a member's export or a composition's agreements; a draft is never trusted as a release, and a release needs the configured acceptance and evidence. Prerequisites: a handle with the publish capability. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle lacks the publish capability; as stale-base when an input changed since 'expectedVector'; as unmet-prerequisite when a release lacks its configured acceptance or evidence; as policy-failure when the export omits a record of its required closure. When 'action' is 'publish', send 'export' and 'expectedVector' and 'purpose' without 'changes' or 'proposalId' or 'snapshotDigest'. Next: pin the published bundle in the consuming composition with loom.federation.

Examples:

- Publish a draft export of the payment capture operation.

  ```json
  {
    "action": "publish",
    "workspaceId": "ws_3f9a1c7d",
    "export": {
      "contract": "payments-export",
      "version": 1,
      "records": [
        {
          "kind": "operation",
          "id": "payment.capture"
        }
      ]
    },
    "expectedVector": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "purpose": "draft"
  }
  ```

### diagram

Draw a diagram of one record or the whole workspace as the structured graph, Mermaid text or terminal text within a rendering budget, with the source vector it was drawn from.

- Prerequisites: a handle this session opened; for a terminal format, a renderer provisioned in trusted configuration.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `unknown-handle` when the workspaceId names no handle of this session; `invalid-input` when the target names no record of the model or the request breaks the tool input contract; `unmet-prerequisite` when a terminal format is requested and no provisioned renderer is available.
- Next action: read the context of a record the diagram shows, through [context](#context).
- Proof limits: every profile's proof limits.
- MCP tool: `loom.diagram`, input `DiagramInput`, result data `DiagramData`.
- Command: `diagram [options]`.

Description of `loom.diagram`:

> Draw a diagram of one record or the whole workspace as the structured graph, Mermaid text or terminal text within a rendering budget, with the source vector it was drawn from. Prerequisites: a handle this session opened; for a terminal format, a renderer provisioned in trusted configuration. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId names no handle of this session; as invalid-input when the target names no record of the model or the request breaks the tool input contract; as unmet-prerequisite when a terminal format is requested and no provisioned renderer is available. Next: read the context of a record the diagram shows with loom.context.

Examples:

- Draw the dependencies of the ordering component as Mermaid text.

  ```json
  {
    "workspaceId": "ws_3f9a1c7d",
    "target": {
      "kind": "record",
      "ref": {
        "kind": "component",
        "id": "ordering"
      }
    },
    "scope": {
      "kind": "component-dependency",
      "depth": 1
    },
    "formats": [
      "mermaid"
    ],
    "budget": {
      "maxNodes": 50,
      "maxBytes": 8192
    }
  }
  ```

### qualifyStart

Start a qualification run of named profile checks against one record or the whole workspace under a provisioned execution policy, returning its handle after preflight and starting only the checks the trusted policy authorizes.

- Prerequisites: a handle with the qualify capability; the revision vector the run must qualify, as 'expectedVector'; an execution policy naming a runner identity provisioned in trusted local configuration.
- Effects: `writes`, can persist changes.
- Refusals: `unknown-handle` when the workspaceId names no handle of this session; `access-denied` when the handle lacks the qualify capability; `stale-base` when an input changed since 'expectedVector'; `policy-failure` when the trusted policy does not authorize a check, or the execution policy names no provisioned identity; `unmet-prerequisite` when a check's native tool or runner is not provisioned, so qualification is not established.
- Next action: follow the run's progress, through [qualifyStatus](#qualifystatus).
- Proof limits: `supplied-records`, every profile's proof limits.
- MCP tool: `loom.qualify`, input `QualifyInput`, result data `QualifyData`.
- Command: `qualify start [options]`.

Presence rules of `loom.qualify`, checked before anything runs:

- When 'action' is 'start', send 'checks' and 'target' and 'expectedVector' and 'executionPolicy' without 'runId' or 'cursor'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.qualify`:

> Action 'start': Start a qualification run of named profile checks against one record or the whole workspace under a provisioned execution policy, returning its handle after preflight and starting only the checks the trusted policy authorizes. Prerequisites: a handle with the qualify capability; the revision vector the run must qualify, as 'expectedVector'; an execution policy naming a runner identity provisioned in trusted local configuration. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle lacks the qualify capability; as stale-base when an input changed since 'expectedVector'; as policy-failure when the trusted policy does not authorize a check, or the execution policy names no provisioned identity; as unmet-prerequisite when a check's native tool or runner is not provisioned, so qualification is not established. When 'action' is 'start', send 'checks' and 'target' and 'expectedVector' and 'executionPolicy' without 'runId' or 'cursor'. Next: follow the run's progress with loom.qualify. Action 'status': Report a run's phase, a bounded page of its progress, the evidence it recorded and its cleanup. Prerequisites: a run this session started. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId or runId names no handle or run of this session; as invalid-input when the cursor was not issued for this run. When 'action' is 'status', send 'runId' without 'checks' or 'target' or 'expectedVector' or 'executionPolicy'. Next: inspect the evidence the run recorded with the command 'evidence'. Action 'cancel': Request the cancellation of a run, idempotently, and report it completed only once its processes and resources have settled. Prerequisites: a run this session started. Effects: can persist changes. Refused as unknown-handle when the workspaceId or runId names no handle or run of this session; as cleanup-incomplete when the run left an owned resource, which the result names with its recovery. When 'action' is 'cancel', send 'runId' without 'checks' or 'target' or 'expectedVector' or 'executionPolicy' or 'cursor'. Next: read the run's final status with loom.qualify.

Examples:

- Run the SQL behavior check against the workspace under the CI runner identity.

  ```json
  {
    "action": "start",
    "workspaceId": "ws_3f9a1c7d",
    "checks": [
      "sql.behavior"
    ],
    "target": {
      "kind": "workspace"
    },
    "expectedVector": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "executionPolicy": "ci-runner"
  }
  ```

### qualifyStatus

Report a run's phase, a bounded page of its progress, the evidence it recorded and its cleanup.

- Prerequisites: a run this session started.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `unknown-handle` when the workspaceId or runId names no handle or run of this session; `invalid-input` when the cursor was not issued for this run.
- Next action: inspect the evidence the run recorded, through [evidence](#evidence).
- Proof limits: none.
- MCP tool: `loom.qualify`, input `QualifyInput`, result data `QualifyData`.
- Command: `qualify status [options]`.

Presence rules of `loom.qualify`, checked before anything runs:

- When 'action' is 'status', send 'runId' without 'checks' or 'target' or 'expectedVector' or 'executionPolicy'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.qualify`:

> Action 'start': Start a qualification run of named profile checks against one record or the whole workspace under a provisioned execution policy, returning its handle after preflight and starting only the checks the trusted policy authorizes. Prerequisites: a handle with the qualify capability; the revision vector the run must qualify, as 'expectedVector'; an execution policy naming a runner identity provisioned in trusted local configuration. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle lacks the qualify capability; as stale-base when an input changed since 'expectedVector'; as policy-failure when the trusted policy does not authorize a check, or the execution policy names no provisioned identity; as unmet-prerequisite when a check's native tool or runner is not provisioned, so qualification is not established. When 'action' is 'start', send 'checks' and 'target' and 'expectedVector' and 'executionPolicy' without 'runId' or 'cursor'. Next: follow the run's progress with loom.qualify. Action 'status': Report a run's phase, a bounded page of its progress, the evidence it recorded and its cleanup. Prerequisites: a run this session started. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId or runId names no handle or run of this session; as invalid-input when the cursor was not issued for this run. When 'action' is 'status', send 'runId' without 'checks' or 'target' or 'expectedVector' or 'executionPolicy'. Next: inspect the evidence the run recorded with the command 'evidence'. Action 'cancel': Request the cancellation of a run, idempotently, and report it completed only once its processes and resources have settled. Prerequisites: a run this session started. Effects: can persist changes. Refused as unknown-handle when the workspaceId or runId names no handle or run of this session; as cleanup-incomplete when the run left an owned resource, which the result names with its recovery. When 'action' is 'cancel', send 'runId' without 'checks' or 'target' or 'expectedVector' or 'executionPolicy' or 'cursor'. Next: read the run's final status with loom.qualify.

Examples:

- Read the progress of a run.

  ```json
  {
    "action": "status",
    "workspaceId": "ws_3f9a1c7d",
    "runId": "run-1"
  }
  ```

### qualifyCancel

Request the cancellation of a run, idempotently, and report it completed only once its processes and resources have settled.

- Prerequisites: a run this session started.
- Effects: `writes`, can persist changes.
- Refusals: `unknown-handle` when the workspaceId or runId names no handle or run of this session; `cleanup-incomplete` when the run left an owned resource, which the result names with its recovery.
- Next action: read the run's final status, through [qualifyStatus](#qualifystatus).
- Proof limits: none.
- MCP tool: `loom.qualify`, input `QualifyInput`, result data `QualifyData`.
- Command: `qualify cancel [options]`.

Presence rules of `loom.qualify`, checked before anything runs:

- When 'action' is 'cancel', send 'runId' without 'checks' or 'target' or 'expectedVector' or 'executionPolicy' or 'cursor'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.qualify`:

> Action 'start': Start a qualification run of named profile checks against one record or the whole workspace under a provisioned execution policy, returning its handle after preflight and starting only the checks the trusted policy authorizes. Prerequisites: a handle with the qualify capability; the revision vector the run must qualify, as 'expectedVector'; an execution policy naming a runner identity provisioned in trusted local configuration. Effects: can persist changes. Refused as unknown-handle when the workspaceId names no handle of this session; as access-denied when the handle lacks the qualify capability; as stale-base when an input changed since 'expectedVector'; as policy-failure when the trusted policy does not authorize a check, or the execution policy names no provisioned identity; as unmet-prerequisite when a check's native tool or runner is not provisioned, so qualification is not established. When 'action' is 'start', send 'checks' and 'target' and 'expectedVector' and 'executionPolicy' without 'runId' or 'cursor'. Next: follow the run's progress with loom.qualify. Action 'status': Report a run's phase, a bounded page of its progress, the evidence it recorded and its cleanup. Prerequisites: a run this session started. Effects: reads persisted state and persists nothing. Refused as unknown-handle when the workspaceId or runId names no handle or run of this session; as invalid-input when the cursor was not issued for this run. When 'action' is 'status', send 'runId' without 'checks' or 'target' or 'expectedVector' or 'executionPolicy'. Next: inspect the evidence the run recorded with the command 'evidence'. Action 'cancel': Request the cancellation of a run, idempotently, and report it completed only once its processes and resources have settled. Prerequisites: a run this session started. Effects: can persist changes. Refused as unknown-handle when the workspaceId or runId names no handle or run of this session; as cleanup-incomplete when the run left an owned resource, which the result names with its recovery. When 'action' is 'cancel', send 'runId' without 'checks' or 'target' or 'expectedVector' or 'executionPolicy' or 'cursor'. Next: read the run's final status with loom.qualify.

Examples:

- Cancel a run.

  ```json
  {
    "action": "cancel",
    "workspaceId": "ws_3f9a1c7d",
    "runId": "run-1"
  }
  ```
