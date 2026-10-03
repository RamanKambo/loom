---
name: loom-engineering
description: "Engineer or reconcile a solution through Loom: establish evidence and requirements, model workflows and contracts, order dependent work, and qualify implementation across components or repositories. Use for solution design, contract changes and governed implementation; scale to the requested scope rather than applying a full lifecycle to ordinary edits."
---

# Loom engineering

Use Loom as the executable engineering record for the authorized task. Turn uncertain intent into explicit outcomes, owners, workflows, types, mutations and interface agreements; use Loom to expose missing prerequisites, propagate changes and bind proof to the implementation. A valid model cannot guarantee correct requirements or eliminate every defect.

This skill targets the complete Loom initial-release interface: explicit workspace handles, composed models, bounded guidance/context, revision-checked changes, connected Angular views, generated diagrams and native qualification. Discover the installed contract before issuing calls. A missing capability is a concrete prerequisite, not permission to invent a tool or report a simulated success.

## Start with the task

Read applicable repository instructions and the user's accepted decisions. Determine whether this is new design, reconciliation, a contract change, implementation against an accepted contract, or production investigation. Identify the smallest owning workspace and the parent agreements the task consumes. Do not reopen the entire architecture for a local conforming fix.

Use `loom.describe` in summary mode, then `loom.workspace` inspection/opening. Get `loom.context` for the task or resume target and inspect its completeness, revisions, trust and readiness. Read the detailed schemas only for the records/actions being used. Keep the returned workspace handle explicit on every stored-state call.

Read [the Loom workflow](references/loom-workflow.md) for the decision-to-tool sequence and request/result handling. Its evidence and action rules apply to every mode.

## Select the needed guidance

| Situation | Read before dependent work |
|---|---|
| Outcomes are unclear; new system or substantial redesign | [Loom workflow](references/loom-workflow.md), then [modeling and contracts](references/modeling-and-contracts.md) |
| More than one owner, repository, component or delivery increment | [Composition and delivery](references/composition-and-delivery.md) |
| SQL, HTTP, messaging, CLI or model-assisted behavior | The relevant section of [specialized boundaries](references/specialized-boundaries.md) |
| Implementing, testing, releasing, diagnosing or reconciling documents | [Qualification and operations](references/qualification-and-operations.md) |
| Need a concrete example of decisions becoming Loom records/actions | [Worked engineering cases](references/worked-engineering-cases.md) |

Load only the references that affect the current decision. The files are self-contained; no example application's checkout is required.

## Operating rules

| Rule | Action |
|---|---|
| Separate observation from intent | Record facts with source/revision/environment, requirements with authority, decisions with rationale, and unknowns with affected work |
| Preserve scope and stack | Reuse required technology and existing capabilities; evaluate alternatives only inside the user's permitted choices |
| Place each decision once | Assign the owner with the required knowledge and authority; clients, adapters and projections do not become competing authorities |
| Model behavior before committing interfaces | Walk success, failure, interruption, concurrency and recovery; then define values and mutations |
| Make prerequisites executable | Record exact dependency, needed maturity and evidence; call readiness for the actual task class |
| Change the owner | Preview model changes and cross-owner impact, then apply against current revisions; do not edit imported records or generated files |
| Treat freezes precisely | Protect accepted observable agreements; permit conforming fixes; route a demonstrated contract defect through narrow controlled change |
| Preserve independent proof | Test real implementation with scenario-derived expectations; generated fixtures and mocks establish only their stated claims |
| Keep authorization distinct | A ready task or suggested next action is not production, publication or spending authorization; honor authorization already given |
| Make omissions visible | Required unavailable or truncated context/checks remain incomplete; never reinterpret them as success |
| Keep language descriptive | Omit historical-generation wording and internal specification/task markers from comments, docstrings and explanatory documents |

Do not treat "best practice", "clean code", a design-pattern name or popularity as a reason. Record the requirement served, actual constraint, alternatives considered, evidence and maintenance consequence. Use primary vendor documentation for decisive version/tier/host claims and experiments for empirical uncertainty. Record an unavailable answer instead of assigning a plausible value.

## Working loop

1. Retrieve current context and exact owning revisions; frame the bounded result and missing evidence.
2. Inspect sources and fill the relevant records; resolve blocking semantics before freezing their consumers.
3. Preview the proposed change and impact; check task prerequisites and policy; apply authorized owner-local changes.
4. Generate the required views, contracts and diagrams; examine coverage and unsupported constructs.
5. Implement only the ready scope, or finish the requested design if implementation was not requested.
6. Qualify the real affected participants; update evidence and pins; reconcile generated and narrative documentation.
7. Report the outcome, changed ownership/contracts, proof obtained and remaining limits. Provide the workspace browser link and scoped tool-generated diagrams where useful.

Ordinary reversible work within accepted scope proceeds without repetitive permission questions. A genuinely missing decision is presented with its consequence and a supported option, while independent work continues. Never convert an agent recommendation into trusted acceptance.

## Documentation mechanics

Loom owns schema validation, semantic rules, dependency checks, generated-artifact drift and engineering evidence. This skill does not introduce another model or readiness engine.

For the skill's own Markdown, run `node scripts/check-docs.mjs` from this folder. The helper checks inline local links/anchors, fenced JSON, code fences and selected wording. Use `--root <repository> --file <relative-document>` for bounded document checks; repeat `--file` for several files. `--self-test` exercises positive and negative cases. It does not check remote links, reference-style links, Loom records or engineering correctness.

Source and trust rules, schemas and live tool metadata win over illustrative payloads. If documentation and tool contracts disagree, record the specific discrepancy and correct the owning source; do not privately invent another interface.
