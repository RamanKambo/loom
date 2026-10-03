# SQL, HTTP, asynchronous work and model-assisted boundaries

Read only the sections present in the requested scope. Use the same canonical records and qualification system throughout; specialized work does not create an unrelated engineering model.

## SQL database work

### Order and Loom records

| Prerequisite order | Design decision | Loom representation/proof |
|---|---|---|
| Outcome and workload | Required state, queries, writes, rate, size, concurrency, retention and recovery | Requirements, workloads and scenarios with source/confidence |
| Conceptual model | Grain, identity, authority, relationships and history | Types, properties, owner components and lifecycle |
| Logical relations | Candidate keys, dependencies, cardinality and anomalies | Relationships, storage mappings and explicit invariants |
| Physical representation | Types, lengths, precision, collation, keys, nullability, defaults and indexes | Storage/routine records bound to actual target platform |
| Transactions | Atomic write set, locking/isolation, winner/loser, external effects and recovery | Mutations, routine transaction contract and multi-session scenarios |
| Access | Actors, granted surface and forbidden paths | Authority bindings and permission tests |
| Optimization | Access paths, plans, contention and lifecycle cost | Measurements against declared workload; justified index/schema decisions |
| Schema delivery | Existing data, ordering, transformation, interruption and recovery | Migration/delivery records, target state and authored data assertions |
| Qualification | Actual implementation plus representative fixtures | Syntax/build/catalog/behavior/permission/concurrency evidence |
| Operations | Restore, retention, capacity, monitoring and repair | Operational scenarios and environment-bound evidence |

Do not normalize by slogan. Establish candidate keys and functional dependencies, show the anomaly avoided and justify any denormalized projection by its source, refresh/rebuild rule and workload benefit. A surrogate key does not remove business uniqueness requirements. A foreign key does not alone enforce a one-to-one relation, acyclic hierarchy or owner equality.

Preserve exact values across SQL, JSON and language mappings. Examine integer range, decimal precision, text byte/code-unit limits, collation equality, null semantics and timestamp meaning. Treat database-generated concurrency tokens as opaque where appropriate. Test invalid rows and cross-owner relationships directly against the engine, not just through application validation.

Name the actual authoritative schema or migration source before generation. Generated SQL may be the implementation for a design-first project; an existing authored database may retain its executable source while Loom models and checks its contract. Do not replace procedural logic with generated stubs and call it equivalent.

### Native qualification

Use `loom.qualify` with the exact workspace revision vector, check selection, target platform, implementation input hashes and trusted disposable execution policy. Discover the installed engine/provider and actual PowerShell edition where scripts depend on it. Do not substitute a different engine, runtime or generated fixture without changing the claim.

LocalDB is suitable only for the declared capability subset; a dedicated Developer edition provider is selected when required features justify it. Both are provisioned resources started for qualification, with bounded concurrency and cleanup. A missing installation or incompatible version is unavailable evidence, not permission to install or start an arbitrary service.

The run must validate its endpoint against the disposable provider, use run-owned databases and files, execute actual schema/procedures, collect results and verify teardown. Report test and cleanup outcomes separately. Cancellation completes only after work settles. Never pass an arbitrary production connection string or delete live database files. Use the tool's owned-resource journal/recovery path after a crash.

Author tests for foreign keys, defaults, grants, stored procedures, transaction rollback, duplicate requests, concurrent state changes, isolation anomalies and schema transformations when those claims matter. Expected business results come from scenarios, not from the same generator being tested. Permission or identity substitutions used locally remain excluded from target-environment claims.

A destructive reset that is valid for a disposable fixture does not authorize a reset of retained application data. Local qualification is evidence for a separately authorized deployment process, not that authorization itself.

## OpenAPI and HTTP interfaces

Specify consumer outcomes/workload → resource and effect model → representations → operations → authorization → timing/failure semantics → qualified OpenAPI/tool profile → implementation and gateway bindings → real conformance → operations. A table does not automatically become a REST resource, and a route does not determine a database schema.

| Contract area | Questions to resolve |
|---|---|
| Representation | Null versus absence, exact numbers, dates, Unicode, enums, unions, binary/streaming and unknown fields |
| Request | Method/path, parameters, headers, content type, body, limits, defaults and validation owner |
| Response | Success/accepted/error status, body, headers, pagination/ETag and consistency |
| Effect | State mutation, atomic boundary, duplicate behavior and uncertain outcome after timeout |
| Security | Resource audience, caller identity, scopes/roles, object ownership, gateway/backend enforcement |
| Retry | Key scope, payload equivalence, persistence/expiry, restart/replica behavior and retry owner |
| Async resource | Admission, job identity, progress/status, completion, result retention and cancellation |
| Consumer | Actual serializer/client/gateway versions and exact contract pin |

Use separate records for public and backend representations when a gateway transforms identity, handles or payloads. A shared application registration does not imply shared permissions, shared credentials or unrestricted cross-API access. Model both request and response trust boundaries.

Select a supported OpenAPI/schema profile and qualify the actual toolchain. Preserve unsupported authored constructs as explicit pinned obligations; do not silently delete webhooks, streaming, unions or media types from an advertised complete interface. Projection validity proves document validity, not running-service conformance.

Generate schema/operation/reference views from their owning records. Validate example payloads and actual provider/client serialization. Test wrong audience/role/owner, spoofed gateway headers, direct backend access, error mapping, throttling, pagination boundaries and idempotency races where applicable. Gateway import success is not authorization proof.

## Asynchronous execution and synchronous dependencies

Model acceptance, dispatch, claim, execution, completion and retrieval as distinct observable events. Assign durable state, routing, capacity, retries, liveness and result authority explicitly. The selected architecture may allocate those responsibilities differently; do not universalize database-centred orchestration from one example.

| Gap between effects | Required agreement |
|---|---|
| Database commit and broker send | Committed publication intent, duplicate handling and recovery |
| Broker receive and executor start | Claim identity, stale/duplicate handling, settlement and start uncertainty |
| External command and response | Operation-specific idempotency or reconciliation; unknown effect remains unknown |
| Blob upload and result commit | Immutable artifact identity, authoritative publication and orphan cleanup |
| Cancellation request and stopped process | Safe checkpoints, in-flight effect, final status and reconciliation |
| Configuration publication and runtime activation | Exact active version, validation, rollout/refresh and failure retention |

A durable job id, an attempt id, an idempotency key, a fence and a correlation id serve different purposes. Model their scopes and lifetimes. A retry may need the same logical effect key across attempts; do not automatically key downstream deduplication by the new attempt.

Budget the complete path: broker delay, startup, API queue, backend call, client/gateway timeout, retries, lease/heartbeat and job lifetime. Identify who may repeat a mutation at each layer. Prevent compounded retries from turning one request into uncontrolled repeated effects.

## CLI, PowerShell and browser clients

Model clients as consumers of accepted operations, with their own interaction contract. For CLI/PowerShell, specify parameter names/sets, requiredness, pipeline semantics where supported, structured output, human display, exit codes, errors, cancellation and noninteractive behavior. Shell quoting and executable edition are part of the adapter, not domain semantics.

For a browser or UI, inventory every retained workflow and its observable result. Model loading, empty/error states, authorization, concurrent edits, asynchronous progress, accessibility and recovery as required by scope. A UI form's convenience validation does not replace the authoritative service rule. Preserve the user's selected frontend framework.

Generate clients or contract tests only for a qualified language/serializer profile. A generated command signature proves neither business behavior nor a usable operator workflow. Test the real client against its intended provider at the appropriate qualification layer.

## Model-assisted applications

Apply this section when a system retrieves context, invokes models, transforms sensitive data or gives a model access to actions. The presence of a model does not replace ordinary ownership, transaction and evidence requirements.

| Boundary | Engineering obligation |
|---|---|
| Ingestion | Source authorization, classification, provenance, parsing limits and deletion obligations |
| Canonical storage | Authoritative owner, tenant/user isolation, revision, retention and lawful permitted data |
| Search/index | Derived-state ownership, freshness, filtering before retrieval, rebuild and deletion propagation |
| Context assembly | Source citations, trust separation, token budget and treatment of retrieved text as data |
| Model access | One authorized routing boundary where required; both request and response paths, including streaming, retry and tool exchanges |
| Guardrails | Required controls, policy mode, failure behavior, exact coverage and evidence of enforcement |
| Reversible transformation | Mapping owner, scope, encryption/access, expiry, authorized reidentification and handling of partial streams |
| Model output | Validation, labeling, allowed consumers, action approval/authorization and data-return boundary |
| Model tools/actions | Per-action authority, bounded inputs/effects, execution identity, audit and injection defense |
| Evaluation/operations | Authored task/safety/failure datasets, provider/model versions, budgets, telemetry, cancellation and incident behavior |

Reversible replacement of identifiers does not prove that data is free of personal information. Treat classification and reidentification authority explicitly. Do not infer that one prompt scanner satisfies residency, tenant isolation, audit, human review or every other applicable control. A control that fails the requirement is an unresolved obligation, not a box checked by its product name.

If all model traffic must traverse a designated mediation component, enumerate every ingress and egress path: prompts, retrieved context, embeddings, tool exchanges, responses, streaming chunks and retry calls. Decide where transformation occurs, where protected mappings live and who may restore values. Enforce the route through identity/network/configuration controls and test attempted bypasses. Do not assume a prompt instruction enforces a network boundary.

Preserve relational transactions and source metadata independently from retrieval indexes, caches and model-generated summaries. Model deletion through all derived stores and logs. Evaluate behavior with independent expected outcomes; schema-valid output and a successful model call do not establish correct or safe task completion.
