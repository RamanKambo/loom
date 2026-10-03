# Composed systems, dependency order and delivery

## Place models by authority

Choose a composition model for cross-component outcomes, agreements and integration scenarios. Choose implementation models for source ownership, concrete exported contracts and component evidence. A small application may use one model. A repository containing independently owned submodules may use a parent plus children. Do not create that hierarchy merely because folders are nested.

| Rule | Tool consequence |
|---|---|
| One implementation owner per path | Inspect claims before initialization or membership changes |
| Parent owns agreements, not copied child definitions | Store owned requirements/workflows; reference provider exports |
| Child owns exact concrete contract | Publish from that owner; imports are read-only |
| Cross-system reference is pinned | Bind publisher, contract, version, digest and source identity |
| Output destination has an owner | Install only through the workspace authorized for that output |
| Deployment boundary is separate | Model hosting independently from repository placement |

Composition-only workspaces can have empty source claims. A parent may not claim every descendant through `.` while a child also claims its implementation. Explicitly narrow or delegate claims through a planned change; never initialize by overwriting an ancestor descriptor.

Missing submodules, `.git` indirection, worktrees, symlinks and unreadable descriptors affect discovery. `loom.workspace inspect` provides the resolved ownership facts. A missing required checkout is unresolved context, not an empty implementation. An independent provider can supply a published contract without a local checkout or child relationship when policy permits.

## Establish finite agreement and export relationships

First publish parent-owned boundary agreements. These contain only parent-owned constraints, shared semantics and required outcomes. Provider children pin those agreements and publish their own concrete types/operations/behavior. Consumers bind to those exports. The parent aggregate then pins the selected child exports and their evidence.

Do not make a child hash the final aggregate that recursively hashes that child. Keep downward agreement publication distinct from upward implementation publication. Runtime call cycles can be valid; unresolved artifact-reference and task-prerequisite cycles cannot be released.

Use `loom.federation inspect` to see members and current pins, `plan` to calculate a proposed change, `apply` to install authorized revision-checked ownership/pin changes, `publish` to emit immutable owner contracts, and `check` to resolve and evaluate the aggregate. The exact inputs come from the installed catalogue. Draft exports remain proposals; they cannot stand in for required accepted release inputs.

Parent readiness is the conjunction of its own obligations, the required child promises and cross-owner agreement satisfaction. Neither a passing child nor a passing parent can conceal failure in the other. Context traversal must retain qualified ownership, so an agent can find where to fix a defect.

## Determine what comes first

Separate investigation, specification, implementation, integration and deployment order. Record a dependency as "dependent requires prerequisite", with the exact claim and required maturity. Do not reduce it to "component uses database".

| Dependency | Required before the dependent task |
|---|---|
| Semantic | Accepted meaning, state/effect rule or authorization decision |
| Structural | Exact type/operation/routine contract and consumer binding |
| Feasibility | Evidence that the proposed mechanism can satisfy its decisive constraint |
| Build | Identified package/artifact and supported toolchain |
| Runtime | Available capability in the chosen execution environment |
| Integration | Real participants with the appropriate identities/configuration |
| Deployment | Required target schema/configuration/network/artifact state |
| Operations | Monitoring, diagnosis, recovery and accountable support |

A provider's accepted contract may permit dependent implementation against a declared substitute. It does not permit a claim of real integration. A mock cannot settle an unknown business rule, service limit or deployment permission.

Rank unresolved decisions using consequences if wrong, uncertainty, downstream reach, semantic complexity, cost of reversal, external lead time and feedback value. State the rationale as decision → affected work → cheapest adequate evidence → next permitted commitment. Avoid arbitrary numerical rankings presented as engineering facts.

The central decision may be tenancy, identity, state/effect semantics, a database transaction, a model gateway or a host limit. Do not automatically design SQL first or finish the largest service before testing its feasibility. A short targeted probe may unlock the entire system more effectively.

For cyclic design dependencies, establish a jointly reviewed bounded agreement. For build cycles, reconsider shared abstraction ownership or co-location. For deployment cycles, redesign the transition until the prerequisites can actually be satisfied. Do not invent a generic interface with unspecified semantics just to make a graph acyclic.

## Make independent component work possible

Before assigning a component, its package must identify outcome/scope, provided/consumed contracts, exact upstream pins, type mappings, mutations, hosting, configuration, evidence obligations and allowed substitutions. Generate its interface and context view, then check readiness for that component.

| Ready input | Implementer can decide | Implementer cannot privately change |
|---|---|---|
| Accepted observable behavior | Internal algorithms and structure within constraints | State, error or authorization semantics exposed to consumers |
| Exact provider contract | Adapter implementation and tests | Provider property meaning or transaction outcome |
| Host contract | Dependency wiring and supported runtime integration | Required identity, timeout or scale assumptions |
| Authored scenarios | Test implementation and fixtures | Expected business result merely to pass code |

A component skeleton follows from those agreements: ports, typed inputs/outputs, orchestration boundaries and test obligations. It must not contain pretend successful implementations or invented defaults for unresolved domain decisions. Parallel work is permitted only for ready scopes; this skill does not itself authorize spawning agents or changing another writer's files.

## Choose and maintain delivery structure

Respect an explicit user choice of complete component delivery or vertical delivery. Where the choice is open, decide from uncertainty and coupling rather than application size alone.

| Structure | Useful when | Required coherence control |
|---|---|---|
| Complete components | Shared behavior/contracts can be established and component evidence is informative | Full component obligations, pinned substitutes and early real integration as participants become available |
| Vertical outcomes | Important uncertainty crosses layers and a usable outcome supplies decisive feedback | Shared semantic baseline, cumulative type/contract model and explicit scope/evidence per outcome |

For vertical work, keep one authoritative type and mutation model across all increments. Every work package names its included requirements, owner records, contract revisions, expected consumers, tests and remaining incomplete capabilities. Do not create a separate incompatible DTO or schema copy per increment.

Preview changes against the cumulative baseline, regenerate all affected consumer views, and rerun evidence invalidated by the changed fields or behavior. A component can be ready for one bounded task while incomplete for another. Keep those scopes explicit rather than labeling the whole system done or blocked.

## Freeze the right agreement

| Freeze | Meaning | Permitted continuation |
|---|---|---|
| Outcome baseline | Accepted scope and observable result | Investigate and design within it |
| Shared contract baseline | Exact consumer/provider semantics accepted | Implement both sides independently against it |
| Qualified component | Owned implementation meets its declared obligations | Conforming defect repair and integration qualification |
| Qualified release | Named composition meets all required release obligations | Authorized release and operating handover |

Freeze prevents discretionary redesign of accepted boundaries. It does not prevent correcting a demonstrated defect. If a fix changes a contract, identify the owner, consumers, data implications and invalidated evidence; obtain only the acceptance required for that exact change. Never repair one component by silently changing another's promise.

## Coordinate repository changes

Plan against a complete revision vector. Loom journals owner-local writes and exposes incomplete composition; it does not provide an atomic Git transaction across repositories. Inspect recovery status after interruption and do not overwrite intervening changes. Imported bundle digests and source pins are updated only when their owner artifacts exist.

Publishing contracts does not stage, commit, push, merge, move gitlinks or deploy resources. Use the repository's authorized source-control and release workflow for those actions. Record dirty source hashes for exploratory evidence; release evidence must identify the exact accepted source/artifact set required by policy.
