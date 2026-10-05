# Workflow integration interface contract

This contract is the agreement between Loom's workspace adapter and a workflow or plugin integration that selects work, obtains acceptance and persists workflow state. Its authorities are `packages/core/schema/icd/workflow-integration.json` and `packages/core/schema/icd/workspace.json`; where this document and an ICD file disagree, the ICD file is authoritative and this document is corrected.

## Responsibilities on each side

Source: `packages/core/schema/icd/workflow-integration.json`, `responsibility`, `owns` and `boundary`.

The integration selects and dispatches work packages, obtains acceptance under the configured policy, and writes `state.json` and acceptance records. The workspace adapter reads those files, verifies their provenance and passes the verified records to the core, which evaluates readiness, acceptance and qualification by rule.

The integration cannot declare a model valid, a task ready or a revision qualified; those states come only from the core's rules over verified inputs. **A tool recommendation is never recorded as acceptance:** an acceptance record names its authority, a team alias or a delegated policy, never the agent that proposed the change.

## Shape

Source: `packages/core/schema/workspace.schema.json` and `packages/core/schema/assurance.schema.json`.

Each file lives in the adopting repository's `.loom` directory; a record file is named by its id.

| File in `.loom` | Definition | Written by | Meaning |
| --- | --- | --- | --- |
| `state.json` | `WorkflowState` | Integration | Transient execution state: phase, the outcome a resumed session restates with its exclusions and hard constraints, the model revision last written against, and per work package its status, input hashes and evidence ids |
| `<id>.json` in the `acceptance` directory | `Acceptance` | Integration, through `accept` | One acceptance or rejection of a baseline or of an exact change, with authority, policy revision, scope and change classes |
| `<id>.json` in the `baselines` directory, plus its snapshot | `Baseline` | `baseline create` | The accepted state: model, configuration, policy, generator, contract and artifact hashes, frozen components, source revisions and commitments |
| `<id>.json` in the `policies` directory | `Policy` | Repository owners | Trust, change classes, readiness gates, substitutes, required checks, designated environments, and the SQL providers and run budgets qualification executes under |
| `<id>.json` in the `evidence` directory | `EvidenceRecord` | Qualification runs | A check result bound to its claims, inputs, revisions, environment, tool version and run |

`state.json` holds no decision, acceptance or evidence content, only evidence ids; the schema rejects any other member. Its `sealed` member is a derived view of acceptance for the current revision: a `sealed: true` without a trusted acceptance of that revision has no authority and is reported as `SEALED_FLAG_UNBACKED`.

## Trust model

Source: `packages/workspace/src/trust.ts`.

Policy, baselines and acceptance records are read from the trusted Git ref, never from the working tree, because the candidate under review lives in the working tree. The trusted ref is the `--trusted-ref` argument, else the default branch of the `origin` remote, else the local `main` branch. It must name the branch in the `trust.ref` of the policy read from it, or that branch's remote-tracking copy.

An acceptance record is trusted when it is present at the trusted ref (policy `acceptanceVia` of `trusted-ref` or `either`), or when its signature verifies under a key in the policy's `trust.acceptanceKeys` (`signature` or `either`). An evidence record is trusted only when its signature verifies under a key in `trust.evidenceKeys`. A signature is Ed25519 over the canonical JSON of the record with its `signature` member removed; a public key is a base64 DER SubjectPublicKeyInfo.

A change that a policy change class does not pre-authorize needs a trusted acceptance whose subject names the exact candidate revision and whose scope covers the changed element. Acknowledging a breaking change in a patch request satisfies the version gate only and never counts as that acceptance.

## Expected-revision protocol

Source: `packages/workspace/src/write.ts` and `packages/core/schema/icd/workspace.json`, interfaces `writeModel` and `writeState`.

Every result envelope carries the model revision in `revisions.model`: the SHA-256 of the model's canonical JSON. A persistent single-workspace change names every input that affects how the model is interpreted, not only the model file, as a `MutationExpectation`: the model revision, the configuration hash, the trusted policy hash or `null`, and the hash of the workspace's canonical import pins. The command line supplies the four as `mutate --expected-model <hash> --expected-config <hash> --expected-policy <hash|none> --expected-imports <hash>`, and the `loom.mutate` tool as `expectation`. The adapter takes an exclusive lock, recomputes all four inputs and writes only while every one still equals its expectation. A mismatch is refused `stale-base`, naming each changed input, with the current revisions in the envelope and a `Refusal.nextActions` entry that re-plans the same change against the current model revision. A `loom.json` that cannot be read, or a lock another writer still holds when the wait ends, is refused with cause `unresolved-context` and writes nothing. State writes follow the same compare-and-swap against the state revision.

## Error vocabulary

Source: `FINDING_RULES` in `packages/core/src/codes.ts` and the refusal causes in `packages/core/schema/result.schema.json`.

| Code | Reported as | When | Retry safe? |
| --- | --- | --- | --- |
| `STALE_BASE_REVISION` | Refusal, cause `stale-base` | The model or state changed since the expected revision; nothing was written | Only after re-reading the current revision and re-planning the change |
| `PATCH_INVALID`, `PATCH_AMBIGUOUS`, `STRUCTURAL_INVALID` | Refusal, cause `invalid-input` | The request or the resulting document is malformed | No; the request must be corrected |
| `CHANGE_UNACCEPTED` | Error finding of `check`; acceptance state `unaccepted` | A change that needs acceptance has no trusted acceptance of the exact candidate revision | After a trusted acceptance of that revision exists |
| `CHANGE_PROHIBITED` | Error finding of `check` | The policy prohibits the change class | No |
| `ACCEPTANCE_UNTRUSTED` | Error finding of `check` | The acceptance is neither at the trusted ref nor validly signed | After it is merged to the trusted ref or signed by a listed key |
| `POLICY_UNRESOLVED`, `POLICY_UNTRUSTED` | Error finding of `check` | The policy is absent at the trusted ref, or its `trust.ref` names another branch | After the policy is committed to the trusted ref |
| `EVIDENCE_UNTRUSTED` | Obligation status `untrusted`; qualification not established | The evidence is unsigned or not signed by a listed runner key | After a trusted runner produces the evidence |
| `SEALED_FLAG_UNBACKED` | Warning finding | `state.json` claims `sealed: true` without a trusted acceptance of the current revision | Not applicable; the flag is ignored |

## Ordering and idempotency

Source: `packages/workspace/src/records.ts` and `packages/workspace/src/evidence.ts`.

Acceptance records, baselines and evidence records are append-only: an existing id is never rewritten, and a second write of one id with different content is refused. A persistent change is a compare-and-swap on the expected revision, so a replayed request after a successful write is refused as stale rather than applied twice, and of two writers planned against one revision exactly one succeeds.

## Who retries

The integration retries. Loom never retries, merges or rebases a refused change: on `stale-base` the integration re-reads the model, re-plans with `plan` or `loom.planChange`, and submits the new change against the new revision.
