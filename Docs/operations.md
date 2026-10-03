<!-- Generated from the Loom contract. Do not edit; edit the authored contract and regenerate. -->
# Loom operations

Source: the operation catalogue `packages/core/schema/operations.json`, whose shape is `OperationCatalogue` in `packages/core/schema/tools.schema.json`. `npm run generate` renders this reference, the MCP tool descriptions, the CLI usage text and the tools and examples of `loom.describe` from it, and `npm run build` fails when any of them differs from a fresh rendering.

## Command line

The CLI is run by path, as `node packages/cli/dist/index.js <command>`, and `--help` prints its usage text, `Usage: loom <command> [options]   (every command takes --json to print the result envelope)`.

Common options: `--model <path>` selects a document (the governing workspace still applies), `--boundary <dir>`, `--trusted-ref <ref>`, `--as-of <date>`.

Exit status: 0 ok, 1 refusal or error finding, 2 usage error.

## MCP server

The server lists these tools in this order, each with the description generated from its operation and the input and output schemas generated from the contract bundle:

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

### validate

Validate a model, inline or the workspace model under its verified baseline, acceptance, evidence and policy, against every structural and semantic rule, each finding carrying a stable code, a path, its impact and a fix while the four result states stay independent.

- Prerequisites: an inline model document, or a governed workspace for 'workspace': true.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the request breaks the tool input contract or the model breaks the structural contract; `unresolved-context` when 'workspace': true finds no workspace model governing the server directory.
- Next action: preview the change that clears a finding, through [planChange](#planchange).
- MCP tool: `loom.validate`, input `ValidateInput`, result data `ValidateData`.
- Command: none.
- Not exposed: The command line validates inside check, together with ownership, the baseline comparison and the installed outputs.

Presence rules of `loom.validate`, checked before anything runs:

- Send 'model' without 'workspace', or send 'workspace' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.validate`:

> Validate a model, inline or the workspace model under its verified baseline, acceptance, evidence and policy, against every structural and semantic rule, each finding carrying a stable code, a path, its impact and a fix while the four result states stay independent. Prerequisites: an inline model document, or a governed workspace for 'workspace': true. Effects: persists nothing. Refused as invalid-input when the request breaks the tool input contract or the model breaks the structural contract; as unresolved-context when 'workspace': true finds no workspace model governing the server directory. Send 'model' without 'workspace', or send 'workspace' without 'model'. Next: preview the change that clears a finding with loom.planChange.

### init

Scaffold .loom with model.json, loom.json, state.json and .gitignore at a repository root, never staging or committing them.

- Prerequisites: the root of a Git repository whose path no ancestor's or descendant's descriptor claims.
- Effects: `writes`, can persist changes.
- Refusals: `invalid-input` when the directory is not a repository root, already holds a .loom or yields a scaffold that fails validation; `policy-failure` when an ancestor's or a descendant's descriptor claims the path or cannot be read; `unmet-prerequisite` when with --force, an authority file of the existing .loom needs repair by its owner.
- Next action: declare the components and their roots in the scope of loom.json, then check the workspace, through [check](#check).
- MCP tool: none.
- Command: `init [--force]`.
- Not exposed: The MCP server serves a workspace that already exists; initializing one is a command-line step.

Examples:

- Scaffold .loom at the root of the current repository.

  ```sh
  node packages/cli/dist/index.js init
  ```

### check

Check one model in order, its ownership and configuration, its validity, its comparison with the trusted accepted baseline and its installed outputs and manifest, or with --out a directory of projections, without writing.

- Prerequisites: a governed workspace, or a model document named with --model, which outside a workspace is checked in validation-only mode.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `unresolved-context` when no model applies because neither --model nor a governing workspace names one.
- Next action: install current outputs once the model is corrected, through [write](#write).
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

- Prerequisites: one patch or a batch of patches; for a persistent change, a governed workspace and the revision the change was prepared against, as 'expectedRevision' or --expected; a version bump and an acknowledgement for a breaking change, an acknowledgement never being acceptance.
- Effects: `writes`, can persist changes.
- Refusals: `invalid-input` when a patch or the resulting model is invalid, and the model is unchanged; `policy-failure` when a breaking or unclassified change lacks its version bump or acknowledgement; `stale-base` when the workspace model changed since the expected revision, and nothing is written; `unresolved-context` when no governed workspace serves a persistent change.
- Next action: check readiness for the task the change serves, through [checkReadiness](#checkreadiness).
- MCP tool: `loom.mutate`, input `MutateInput`, result data `MutateData`.
- Command: `mutate --patch <file> --expected <revision> [--ack id,...] [--dry-run]`.

Presence rules of `loom.mutate`, checked before anything runs:

- Send 'model' without 'workspace', or send 'workspace' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.
- Send 'patch' without 'patches', or send 'patches' without 'patch'. A request matching no combination is refused with `PATCH_AMBIGUOUS` at `(root)`.
- Send 'expectedRevision', or omit 'workspace'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `expectedRevision`.

Description of `loom.mutate`:

> Apply one patch or an atomic batch to a model, inline as a pure calculation or to the workspace model, which persists only onto the expected revision so two writers on one base cannot both succeed, while a dry run previews without writing. Prerequisites: one patch or a batch of patches; for a persistent change, a governed workspace and the revision the change was prepared against, as 'expectedRevision' or --expected; a version bump and an acknowledgement for a breaking change, an acknowledgement never being acceptance. Effects: can persist changes. Refused as invalid-input when a patch or the resulting model is invalid, and the model is unchanged; as policy-failure when a breaking or unclassified change lacks its version bump or acknowledgement; as stale-base when the workspace model changed since the expected revision, and nothing is written; as unresolved-context when no governed workspace serves a persistent change. Send 'model' without 'workspace', or send 'workspace' without 'model'. Send 'patch' without 'patches', or send 'patches' without 'patch'. Send 'expectedRevision', or omit 'workspace'. Next: check readiness for the task the change serves with loom.checkReadiness.

Examples:

- Preview changing a mutation guard in the workspace model; nothing persists on a dry run.

  ```json
  {
    "workspace": true,
    "expectedRevision": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
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

- Preview patch.json against the revision it was prepared against, as revisions.model of a check result reports it, without writing.

  ```sh
  node packages/cli/dist/index.js mutate --patch patch.json --expected sha256:0000000000000000000000000000000000000000000000000000000000000000 --dry-run
  ```

### diff

Compare two models, or a candidate against the trusted accepted baseline, giving every change its kind, compatibility dimension, rule and affected consumers and marking a comparison with an invalid side provisional.

- Prerequisites: two inline models, or a trusted accepted baseline at the trusted ref and a candidate, inline or the workspace model.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the request or a model breaks its contract; `unresolved-context` when no trusted accepted baseline is available, or 'workspace': true finds no workspace model.
- Next action: preview a repair of a breaking change, through [planChange](#planchange).
- MCP tool: `loom.diff`, input `DiffInput`, result data `DiffData`.
- Command: none.
- Not exposed: The command line compares the model with the trusted accepted baseline inside check.

Presence rules of `loom.diff`, checked before anything runs:

- Send 'before' and 'after' without 'againstBaseline', or send 'againstBaseline' and 'after' without 'workspace' or 'before', or send 'againstBaseline' and 'workspace' without 'after' or 'before'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.diff`:

> Compare two models, or a candidate against the trusted accepted baseline, giving every change its kind, compatibility dimension, rule and affected consumers and marking a comparison with an invalid side provisional. Prerequisites: two inline models, or a trusted accepted baseline at the trusted ref and a candidate, inline or the workspace model. Effects: persists nothing. Refused as invalid-input when the request or a model breaks its contract; as unresolved-context when no trusted accepted baseline is available, or 'workspace': true finds no workspace model. Send 'before' and 'after' without 'againstBaseline', or send 'againstBaseline' and 'after' without 'workspace' or 'before', or send 'againstBaseline' and 'workspace' without 'after' or 'before'. Next: preview a repair of a breaking change with loom.planChange.

### project

Project a model to one target with its source-to-output coverage manifest, running no external validator and failing closed on error findings, while a draft renders an explicitly incomplete artifact that never qualifies.

- Prerequisites: a model, inline or the workspace model.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the request breaks its contract or the model has error findings; `policy-failure` when outside a draft, the model uses a construct the target's profile does not support.
- Next action: qualify the projected artifacts with their profile checks, through [qualify](#qualify).
- MCP tool: `loom.project`, input `ProjectInput`, result data `ProjectData`.
- Command: none.
- Not exposed: The command line writes projections into files with write --out.

Presence rules of `loom.project`, checked before anything runs:

- Send 'model' without 'workspace', or send 'workspace' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.project`:

> Project a model to one target with its source-to-output coverage manifest, running no external validator and failing closed on error findings, while a draft renders an explicitly incomplete artifact that never qualifies. Prerequisites: a model, inline or the workspace model. Effects: persists nothing. Refused as invalid-input when the request breaks its contract or the model has error findings; as policy-failure when outside a draft, the model uses a construct the target's profile does not support. Send 'model' without 'workspace', or send 'workspace' without 'model'. Next: qualify the projected artifacts with their profile checks with the command 'qualify'.

### projectAll

Project a model to every target, with per-component artifact instances and coverage manifests, failing closed as project does.

- Prerequisites: a model, inline or the workspace model.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the request breaks its contract or the model has error findings; `policy-failure` when outside a draft, the model uses a construct a target's profile does not support.
- Next action: qualify the projected artifacts with their profile checks, through [qualify](#qualify).
- MCP tool: `loom.projectAll`, input `ProjectAllInput`, result data `ProjectData`.
- Command: none.
- Not exposed: The command line writes every projection into a directory with write --out, or installs the enabled ones with write.

Presence rules of `loom.projectAll`, checked before anything runs:

- Send 'model' without 'workspace', or send 'workspace' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.projectAll`:

> Project a model to every target, with per-component artifact instances and coverage manifests, failing closed as project does. Prerequisites: a model, inline or the workspace model. Effects: persists nothing. Refused as invalid-input when the request breaks its contract or the model has error findings; as policy-failure when outside a draft, the model uses a construct a target's profile does not support. Send 'model' without 'workspace', or send 'workspace' without 'model'. Next: qualify the projected artifacts with their profile checks with the command 'qualify'.

### export

Serialize a model to canonical JSON or YAML, failing closed on an invalid model.

- Prerequisites: an inline model document.
- Effects: `none`, persists nothing.
- Refusals: `invalid-input` when the model breaks its structural contract or has error findings.
- Next action: store the canonical text as the model document.
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

Describe what this build supports: record kinds, patch operations, finding codes, comparison rules, projection targets, profiles with their proof limits, tools, examples and unavailable features.

- Prerequisites: none.
- Effects: `none`, persists nothing.
- Refusals: none.
- Next action: read the required context of the component or task at hand, through [context](#context).
- MCP tool: `loom.describe`, input `DescribeInput`, result data `DescribeData`.
- Command: `describe [--sections a,b] [--profile <id>]`.

Description of `loom.describe`:

> Describe what this build supports: record kinds, patch operations, finding codes, comparison rules, projection targets, profiles with their proof limits, tools, examples and unavailable features. Prerequisites: none. Effects: persists nothing. Next: read the required context of the component or task at hand with loom.context.

Examples:

- List the patch operations only.

  ```json
  {
    "sections": [
      "patches"
    ]
  }
  ```

- List the patch operations only.

  ```sh
  node packages/cli/dist/index.js describe --sections patches
  ```

### context

Retrieve the required context of a component, record, claim or task within a declared budget, nearest first, with sources, owners, baseline status, constraints, decisions and evidence, record text coming back as data and never as an instruction.

- Prerequisites: a model, inline or the workspace model; a target and a budget.
- Effects: `reads`, reads persisted state and persists nothing.
- Refusals: `invalid-input` when the request names no target or budget, or breaks its contract; `stale-base` when a continuation or modelRevision belongs to another model revision; `unresolved-context` when 'workspace': true finds no workspace model.
- Next action: follow the continuation while completeness lists omissions, then check readiness for the task, through [checkReadiness](#checkreadiness).
- MCP tool: `loom.context`, input `ContextInput`, result data `ContextData`.
- Command: `context --kind component|record|claim|task --id <id> [--record-kind <kind>] [--max-records n] [--max-bytes n] [--continuation <token>]`.

Presence rules of `loom.context`, checked before anything runs:

- Send 'model' without 'workspace', or send 'workspace' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.context`:

> Retrieve the required context of a component, record, claim or task within a declared budget, nearest first, with sources, owners, baseline status, constraints, decisions and evidence, record text coming back as data and never as an instruction. Prerequisites: a model, inline or the workspace model; a target and a budget. Effects: reads persisted state and persists nothing. Refused as invalid-input when the request names no target or budget, or breaks its contract; as stale-base when a continuation or modelRevision belongs to another model revision; as unresolved-context when 'workspace': true finds no workspace model. Send 'model' without 'workspace', or send 'workspace' without 'model'. Next: follow the continuation while completeness lists omissions, then check readiness for the task with loom.checkReadiness.

Examples:

- The required context of one component within 50 records.

  ```json
  {
    "workspace": true,
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
- MCP tool: `loom.checkReadiness`, input `CheckReadinessInput`, result data `ReadinessData`.
- Command: `readiness --class <class> [--mode component|slice] [--components a,b] [--requirements r,...]` or `readiness --task <file>`.

Presence rules of `loom.checkReadiness`, checked before anything runs:

- Send 'model' without 'workspace', or send 'workspace' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.

Description of `loom.checkReadiness`:

> Evaluate whether a task is ready, blocked or unresolved, with the exact missing prerequisites, permitted substitutes, allowed next work and its work package. Prerequisites: a model, inline or the workspace model; the class, mode and scope of the task. Effects: reads persisted state and persists nothing. Refused as invalid-input when the request names no task or breaks its contract; as stale-base when the model is not at the requested candidateRevision; as unresolved-context when 'workspace': true finds no workspace model. Send 'model' without 'workspace', or send 'workspace' without 'model'. Next: read the context of a missing prerequisite, or start the allowed next work with loom.context.

Examples:

- Is the billing component ready for implementation?

  ```json
  {
    "workspace": true,
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
- MCP tool: `loom.planChange`, input `PlanChangeInput`, result data `PlanChangeData`.
- Command: `plan --patch <file> [--base <revision>] [--ack id,...]`.

Presence rules of `loom.planChange`, checked before anything runs:

- Send 'model' without 'workspace', or send 'workspace' without 'model'. A request matching no combination is refused with `STRUCTURAL_INVALID` at `(root)`.
- Send 'patch' without 'patches', or send 'patches' without 'patch'. A request matching no combination is refused with `PATCH_AMBIGUOUS` at `(root)`.

Description of `loom.planChange`:

> Preview a change against a base revision without persisting it: the delta, compatibility by dimension, affected consumers with dependency paths, invalidated evidence, repair alternatives, obligations and whether policy requires acceptance. Prerequisites: a model, inline or the workspace model; one patch or a batch, planned against the current model revision as 'baseRevision' or --base, which the command line defaults to the current revision. Effects: persists nothing. Refused as stale-base when the model is not at the base revision; as invalid-input when a patch or the resulting model is invalid; as policy-failure when a breaking or unclassified change lacks its version bump or acknowledgement. Send 'model' without 'workspace', or send 'workspace' without 'model'. Send 'patch' without 'patches', or send 'patches' without 'patch'. Next: apply the change against the same revision with loom.mutate.

Examples:

- Preview adding an optional property against a base revision.

  ```json
  {
    "workspace": true,
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
