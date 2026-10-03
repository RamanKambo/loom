# Worked engineering cases

These cases illustrate decisions and tool use without prescribing a product architecture. Names identify fictional responsibilities. Placeholder handles and paths must be replaced with values returned by the actual tools. Model-record tables explain required meaning; use the installed schema for exact fields.

## Asynchronous service calling synchronous providers

Request: "Let callers submit work, schedule it, follow progress and retrieve results. Some work runs in a cloud process and some on a private worker. Both call an existing synchronous API."

### Establish the unknowns before the design

| Statement | Record and next action |
|---|---|
| Caller submits work | Requirement and acceptance scenario; establish what durable acceptance promises |
| Two execution environments | Inventory each host's identity, reachability, startup, time and concurrency limits |
| Schedules | Workflow/unknowns for time zones, overlap, missed occurrences, edits and retirement |
| Synchronous dependency | Pinned provider operation contract; determine effect and duplicate/timeout behavior |
| Results | Requirement for content, access, integrity, retention and no-result outcome |
| Workload unspecified | Workload unknown with measurement/owner; no invented throughput or timeout target |

Inspect the system and child repositories. If the service is governed across multiple owners, initialize a composition parent and delegated implementation children. If it is a small single repository, keep one model with explicit components. The architectural responsibilities do not depend on the number of folders.

Open the owner, read its returned handle and retrieve context for the executor component:

```json
{
  "tool": "loom.context",
  "input": {
    "workspaceId": "<returned-workspace-handle>",
    "target": {
      "kind": "component",
      "ref": { "kind": "component", "id": "executor" }
    },
    "budget": { "maxRecords": 50 }
  }
}
```

If completeness indicates omitted dependencies, fetch the continuation or narrow the scope. Fifty records is a request budget for this example, not permission to ignore the fifty-first prerequisite.

### Construct the model

Assign one durable lifecycle owner and one provider for each operation. Walk admission, dispatch, execution, external effect, result publication and retrieval. Stop the scenario after every externally visible effect and decide how progress is recovered.

| Concept | Type/mutation decision | Consumer consequence |
|---|---|---|
| Work identity | Stable resource identity selected at admission | Poll/cancel/result refer to the same resource |
| Attempt identity | New identity for each execution attempt | Execution evidence is not confused with the logical job |
| Effect key | Scoped to the operation that must not repeat | May survive attempts; cannot be blindly derived from attempt identity |
| Expected revision | Current authoritative concurrency value | Cancellation and completion have a defined winner/loser |
| Result descriptor | Immutable content identity, digest, size and retention | Blob presence alone does not establish publication |
| Execution outcome | Completed, repeatable failure or uncertain effect | Retry is permitted only when the operation's semantics support it |

These decisions produce owned types, operations, mutations, mappings and scenarios. The parent workflow references the provider exports. It does not embed another copy of their property definitions.

Specify lifecycle/effect contracts before the consumer API and executor depend on them. A SQL design is central only if SQL is chosen to enforce those authoritative decisions. Qualify the actual transactional mechanism and external-call reconciliation separately.

### Preview, qualify and freeze

Preview the owner patch with `loom.planChange`, inspect consumer impact and apply against the current expected revision. Publish the provider candidate and bind the dependent component to the exact digest. Then check the implementation task:

```json
{
  "tool": "loom.checkReadiness",
  "input": {
    "workspaceId": "<returned-workspace-handle>",
    "task": {
      "class": "implementation",
      "mode": "component",
      "components": ["executor"]
    }
  }
}
```

A missing provider implementation may permit adapter work against an accepted substitute if policy allows it. An unknown repeatability rule blocks the dependent retry implementation. A test that always returns success cannot settle that unknown.

Implement and qualify the component, including response loss after an external mutation, duplicate delivery, host death, cancellation race and result upload followed by failed publication. Freeze its qualified interface. Run the complete real path through both execution environments before qualifying the declared system scope.

## Search and model-assisted response service

Request: "Combine document search and persistent user context. Keep users isolated, reuse supported services, and mediate all model requests and responses through the designated control component."

Establish outcomes for ingestion, retrieval, response generation, correction, export, deletion and investigation. Preserve any required frontend/hosting choices. Inventory actual parsers, stores, search indexes, SDKs, model routes and existing controls before selecting replacements.

| Owner | Contract decision |
|---|---|
| Canonical record service | User/tenant identity, revision, classification, retention and authoritative deletion |
| Search projection | Index input, ownership filters, freshness, rebuild and deletion acknowledgement |
| Retrieval coordinator | Authorization before retrieval, context source references and token limits |
| Model mediation | Request/response transformation, allowed model/region, policy failure, streaming and retries |
| Transformation mapping store | Protected mapping scope, expiry and who may restore values |
| Consumer API/UI | Request types, labeled output, citations, partial/error states and permitted actions |

Keep these logical roles separate even if several are co-hosted. Decide deployment separation from trust, scale, lifecycle and maintenance requirements. Do not create a service per row without that justification.

Model canonical data and derived search content separately. A deletion request must cover indexed chunks, embeddings, caches, summaries and retained mappings according to policy. A revoked user cannot regain access through a stale search index or a background task with copied authorization.

Trace model-bound and model-returned data through embeddings, prompts, tool exchanges, streaming chunks and retry paths. A reversible transformation still has sensitive mappings and requires explicit classification. A scanner's presence does not prove residency, tenant isolation or all required guardrails.

Use Loom projections for types, interface agreements, data-flow and hosting views; keep required policy controls as constraints bound to enforcement owners and test scenarios. Qualify attempted bypasses and unauthorized retrieval with independent fixtures. A fluent model response is not an oracle for correctness.

The decisive first contracts are likely identity/ownership, canonical-versus-derived data, deletion propagation and model mediation. Do not implement the visible chat screen first if it must invent those contracts. An independent static UI task can proceed when its actual prerequisites are already met.

## A small change to a frozen component

Request: "The status endpoint formats a documented timestamp incorrectly; fix it."

Open the status component, retrieve the timestamp's canonical representation and the implementation artifact. Establish whether the format requirement is accepted and which clients consume it. If the implementation violates that requirement, plan a conforming fix with targeted serialization and endpoint evidence. Keep unrelated state, hosting and API ownership frozen.

If callers depend on a different released contract, record the conflict and affected versions before changing the promise. Do not silently rewrite the requirement to match the defect or redesign the whole system to solve one formatting error. Reconcile generated/narrative references and close only the proved scope.
