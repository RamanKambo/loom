# Modeling responsibilities, data and behavior

## Allocate the system

A component is an owner of a responsibility; a deployment unit is an execution/release boundary; a host is the runtime capability supplying that boundary. Several components may share a process. A repository is a source-control boundary. None of these relationships implies the others.

| Component question | Record the answer |
|---|---|
| Purpose | Outcome and requirement references it serves |
| Authority | Decisions, state and external effects it may own |
| Interface | Provided and consumed contracts, including return/error paths |
| Enforcement | Authorization, validation, transaction and invariant checks |
| Failure | Independent failure, retry/recovery owner and loss of state |
| Placement | Host/deployment unit, identity, configuration and constraints |
| Exclusion | Responsibilities allocated elsewhere that this component must not duplicate |

Choose the smallest boundaries that explain the required outcomes and failure/trust scopes. Do not manufacture layers or services to satisfy a named pattern. If all work depends on one global object, challenge accidental coupling before declaring it the system's centre.

For each deployment unit model process/container/library boundary, co-hosting, identity, ingress/egress, trigger, timeout, scaling, statefulness, shutdown/drain and release coupling. Record which capabilities the platform supplies and which remain application responsibilities. A second container does not automatically confer privilege isolation.

## Walk complete workflows

For each accepted outcome, record the actor, trigger, prerequisites, trusted inputs, ordered interactions, authoritative commit, observable outcome and cleanup. At every step ask what happens if execution stops, a response is lost, a duplicate arrives, a credential is revoked or another actor changes the state.

| Workflow case | Required decision |
|---|---|
| Invalid or unauthorized request | Rejection owner, safe error and any durable receipt/audit |
| Duplicate intent | Identity/equivalence scope, retention and duplicate response |
| Competing mutation | Concurrency token, winning rule and losing outcome |
| Partial external effect | What is committed, unknown or compensatable; recovery authority |
| Cancellation | Acknowledgement, safe-stop point, in-flight effect and truthful final state |
| Delayed or reordered message | Current-state/fence validation and stale handling |
| Configuration change | Bootstrap/runtime distinction and refresh/activation boundary |
| Deletion or restoration | Reference handling, derived stores, audit and future reappearance |
| Operator repair | Identity, reason, idempotency, guards and preserved evidence |

Place scenarios in Loom independently of generated samples. A happy-path operation list does not specify the workflow. A sequence ending at "call service" leaves its most important failure contract undefined.

## Establish types before representations

Extract concepts from workflow decisions and exchanged values. State what one instance represents, identity scope, relationships, lifecycle and authoritative owner. Separate request, domain, persisted, event and response representations when their meanings or visibility differ.

| Property | Decision required |
|---|---|
| Meaning | Business definition, units, timezone, encoding or precision |
| Shape | Logical type, requiredness, nullable/absent behavior, bounds, enum/union and unknown-field policy |
| Origin | Caller, trusted context, provider, stored authority or explicit derivation |
| Mutation | Authorized creator/writers, immutable boundaries, transition and concurrency rules |
| Validation | Structural, referential, semantic, temporal and ownership checks with enforcement layer |
| Exposure | Permitted consumers, classification, redaction/transformation and logging policy |
| Lifetime | Default/backfill behavior, revision, retention, deletion and recovery |
| Mapping | Exact conversion into storage, wire, event and language representations |

Do not accept caller-supplied owner, permission or completed status where the system owns it. A valid identifier shape does not prove the caller may access that identifier. A mutable field does not grant all components write authority.

Create `mappings` for conversions, including rejected values, precision loss, absent/null handling, normalization, field redaction and one-way transformations. Reuse a type only when meaning and authority agree. Similar property names do not establish equivalence.

## Specify mutations

Model each authoritative change with current state/version, trigger, actor, guards, changed properties, transaction, next state, emitted facts, external effects and observable postcondition. Distinguish the component deciding from the storage mechanism committing.

| Concern | Exact agreement needed |
|---|---|
| Concurrency | Token source, scope, comparison and losing response |
| Idempotency | Key owner, scope, payload equivalence, persistence, expiry and conflict result |
| Atomicity | Exact writes/events committed together and all effects outside that boundary |
| Retry | Which actor retries, eligible failures, budgets and behavior after lost response |
| Outbox/message | Publication intent, deduplication, settlement, visibility lease and recovery |
| Cancellation | Request state, interruption limits, commit race and remaining effects |
| Fencing | Protected resources, check timing and behavior of already-issued external work |
| Projection | Source of truth, freshness, rebuild and invalidation |

Do not claim that a transaction covers a remote service call or that a fence recalls an accepted external operation. Describe uncertainty where no mechanism can establish the effect. Preserve separate lifecycle, technical-effect and business-outcome concepts when those distinctions determine safe recovery.

## Close every interface

| Boundary | Model records and additional obligations |
|---|---|
| HTTP | `operations`, `types`, `securitySchemes`, `consumerBindings`; statuses, headers, authority, retries and effects |
| Library/module | Language/module binding, exports, calling conventions, nullability, serialization and error semantics |
| SQL | `storage`, `routines`, mutations and type mappings; grants, transactions, concurrency and result sets |
| PowerShell/CLI | `routines` and operation bindings; parameter sets, pipeline behavior, output objects, exit/error semantics |
| Queue/event | Producer and consumer records, payload types, trigger binding, ordering/delivery/settlement and replay |
| File/blob | Content type/encoding, immutable identity, integrity, publish/commit order, retention and access |
| Configuration | Schema, source hierarchy, defaults, validation, secret references, activation, refresh and recovery |
| External provider | Pinned contract/capability evidence, credentials, service limits, uncertain failures and qualification obligations |

An interface agreement answers who provides/consumes it, why, which version, what values cross, what authority crosses, when an effect occurs, what failure means and how conformance is demonstrated. Generate structural views from Loom; retain owned prose or executable assertions for semantics the model cannot evaluate.

Never hide an unsupported construct in an arbitrary string or omit it from a generated artifact. Record its impact in coverage. A pinned authored contract can remain authoritative while supported structural parts are modeled, but absent automated conformance remains an explicit obligation. An incomplete projection cannot be the advertised complete contract.

## Review the design against decisions

Try a normal request, a duplicate, a competing update, a lost response, a process restart, a policy/identity change, a restore and an operator repair. Use concrete representative values. Trace each scenario through actual owner records, representations and guards.

Find unallocated requirements, duplicate authority, lost properties, impossible host assumptions, unbounded retries, hidden store-to-store synchronization, accidental permission propagation and tests generated from the same wrong premise. Fix the owning record and rerun affected projections/checks.

After the second pass, derive local conventions from the accepted responsibilities: where validation lives, how errors map, how dependencies are injected, how retries are owned, what libraries provide and how evidence is recorded. Do not start with a list of coding slogans and force the design to fit them.
