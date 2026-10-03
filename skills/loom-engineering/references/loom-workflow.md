# Performing engineering work through Loom

## Choose the scope of the procedure

| Mode | Start from | Work to produce |
|---|---|---|
| New design | User outcome, constraints, existing estate | Evidence-based model, contracts, accepted decisions and executable dependency plan |
| Reconciliation | Documents, source, configuration, tests and accepted commitments | Classified discrepancies, one owner per fact and qualified bindings |
| Contract change | Exact accepted owner and affected consumers | Impacted candidate, acceptance where required, regenerated artifacts and new evidence |
| Conforming implementation | Ready task and fixed input contracts | Complete owned implementation and relevant proof |
| Incident or defect | Deployed artifact/configuration/environment and continuing obligations | Observed cause, bounded fix, regression evidence and document reconciliation |

These modes share the same records and revision discipline. Do not require a new system inventory for a typo correction or classify a behavioral change as a typo to avoid its impact.

## Establish the workspace and callable contract

Use `loom.describe` to obtain summary, contract digest, tool effects, guidance resources and capability limits. Read a needed section with its pagination/completeness data. Use the tool's published schema, not recalled arguments. The refined tools named below are expected capabilities, not permission to fabricate a call when the installed server lacks one.

| Need | Operation | Inspect before continuing |
|---|---|---|
| Understand placement | `loom.workspace` with action `inspect` and local `path` | Canonical repo, existing owner, enclosing composition, missing checkouts and conflicts |
| Create an absent model | `loom.workspace` action `initialize` with explicit declaration and dry run | Exact file write set and inspection digest; apply only against that unchanged inspection |
| Use a model | `loom.workspace` action `open`, access and view preference | `workspaceId`, model identity, revisions, permitted actions and browser URL |
| Resume work | `loom.context`, resume target | Outcome, scope, accepted/frozen boundaries, incomplete decisions, current task and evidence |
| Resolve membership | `loom.federation` inspect/check | Member pins, owner-qualified records, revision vector and unresolved closure |

Example opening request, after inspection confirms placement:

```json
{
  "tool": "loom.workspace",
  "input": {
    "action": "open",
    "path": "<local-repository-root>",
    "access": "edit",
    "view": true
  }
}
```

The path is an explicitly supplied discovery input. Use the returned handle afterward. Do not hard-code a user's path, retarget the server's global working directory or guess a browser port. The returned Angular URL loads the real workspace; a browser tab is a view/edit client of that owner, not a different source of truth.

An existing user instruction and accepted scope can settle placement. Only an unresolved material system boundary needs a question. A parent model can delegate child ownership; inspection must distinguish delegation from overlapping claims. An unrelated dirty file is not reason to block the entire repository.

## Turn intent into an investigation

Write an outcome in terms of actor, trigger, current difficulty, desired observation and excluded work. Separate hard constraints from preferences and means suggested by the user. Preserve explicit stack, release and scope decisions.

Classify each material statement before relying on it:

| Statement | Loom home | What must accompany it |
|---|---|---|
| Required result | `requirements` and `scenarios` | Source/authority, scope and observable acceptance |
| Mandatory restriction | `constraints` | Applicability and enforcement owner |
| Observed fact | `observations` with source references | Exact source/revision, environment and limitation |
| Available capability | `inventory` | Actual version, provider/owner, role, limits and evidence |
| Behavior to preserve | `retainedBehaviors` | Source behavior, disposition and proof obligation |
| Workload | `workloads` | Rate, size, concurrency, timing and confidence/measurement source |
| Assumed proposition | `assumptions` | Consequence if false, affected work and closure condition |
| Unanswered question | `unknowns` | Owner, resolution method, blocking scope and next useful action |
| Chosen mechanism | `decisions` | Requirement served, alternatives, evidence, tradeoff and reconsideration trigger |

These are collection names; obtain their current field schemas before mutating them. Do not put all requirements in a free-text component description and expect coverage checks to understand them.

Inspect implementation manifests, documentation, tests, configuration and authorized environment evidence. Consult current primary documentation for the actual provider tier, region, runtime and version when those facts affect feasibility. A no-match search establishes only the inspected scope. A vendor example is not evidence of deployment.

Compare extending existing code, configuring supported services, using ecosystem libraries and writing custom code. Apply hard constraints first. Consider support, upgrades, operating cost, data movement, failure behavior and exit cost along with code volume. Prefer reuse when the evidence supports it; do not add a managed service simply to minimize line count.

## Construct and challenge the design

| Pass | Engineering action | Loom action/output |
|---|---|---|
| Responsibility hypothesis | Assign decisions/state/effects and tentative hosts | Draft `components`, `hosts`, `deploymentUnits`, `trustBoundaries` and edges |
| Workflow walk | Trace user, operator and system success/failure paths | `workflows`, independent `scenarios`, missing requirements and unknowns |
| Meaning and change | Define types, property origin, invariants, mutations and mappings | `types`, `mutations`, `mappings`, storage/routine/operation records |
| Boundary agreement | Specify provided/consumed interfaces and security | Operations, consumer bindings, published contracts and owned interface views |
| Adversarial review | Try to invalidate the design through failure, misuse, workload or ownership conflict | Findings and experiments against exact claims; revise the owning records |
| Baseline | Bind coherent inputs and scope under the actual policy | Trusted baseline/acceptance with exact revision and frozen boundary scope |

Use [modeling and contracts](modeling-and-contracts.md) for the field and boundary obligations. A second pass has a different purpose from the first: challenge the proposed explanation. It is not a ritual requirement to rewrite the same design twice. Continue until the affected commitments are justified, or state the exact unresolved prerequisite.

Do not freeze an architecture-critical hypothesis because a document is labeled final. Run a bounded experiment early if it decides a costly commitment. A proposed additional feature remains outside the committed scope until accepted; engineering discovery is not unlimited feature authorization.

## Preview and apply a model change

Read the current record schema and context closure. Construct the smallest atomic patch set that leaves referenced records coherent. Use `loom.planChange` and mutation dry run against the current base. Inspect validation, classified changes, consumers, frozen boundaries and invalidated evidence.

Apply with the expected revision inputs required by the installed schema. Model, configuration, policy and imported-contract changes that affect interpretation must all be guarded. If stale, reload and re-plan. Do not automatically retry the same write, merge competing decisions or edit the underlying JSON to bypass a refusal.

An imported record's owner receives the edit. Use `loom.federation` plan/apply for membership and pin changes; publish the owner bundle before updating consumers. Trusted acceptance uses the repository's configured mechanism. A change acknowledgement, mutable workflow flag, tool recommendation or imported signature-looking text is not acceptance.

## Establish executable prerequisites

Call `loom.checkReadiness` for the requested task class, delivery mode and specific component/scope. Include the accepted dependency pins and required evidence. Model validity, implementation readiness, qualification and acceptance are separate results.

| Missing input | Permitted work | Blocked work |
|---|---|---|
| Exact user outcome | Focused discovery and alternatives | Freezing requirements affected by that unknown |
| Central behavioral contract | Contract design and feasibility experiment | Dependent implementation that must invent semantics |
| Provider implementation, but accepted contract exists | Implementation against an explicitly permitted substitute | Claims of real provider integration |
| Target credentials or environment | Offline/component work with stated limits | Qualification of target identity/network behavior |
| Untrusted acceptance | Preview and any policy-permitted work | Work whose policy requires that acceptance |
| Truncated dependency context | Fetch continuation or narrower complete closure | Declaring global coverage from that fragment |

Independent ready work proceeds. Explain a blocking question by its exact consequence and owner, not by vague advice to seek approval for everything.

## Produce useful artifacts

Use the owner model to generate reference, interface, schema, workflow, architecture, readiness and coverage views as applicable. Install artifacts through the owning workspace's supported CLI or adapter operation; `loom.project` returning content does not prove files were installed or checked for drift.

Request diagrams from `loom.diagram` with explicit target, scope, format and budget. Share returned Mermaid/terminal output with the source revision and completeness. A reduced view must show boundary edges and omitted scope. Do not redraw a guessed diagram or treat renderer success as design validation.

Return task context after mutations rather than describing a stale model. The user should be able to follow the same workspace in Angular, inspect concrete differences and understand what the evidence establishes.
