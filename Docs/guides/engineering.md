# The engineering method

A Loom model records engineering decisions in the order they constrain each other. A later decision rests on the earlier ones, so each stage starts only when its required input exists and ends only when its exit evidence is recorded. A stage whose input is missing waits, and the gap becomes an owned unknown rather than a guess.

## Engineering order

| Stage | Required input | Exit evidence |
| --- | --- | --- |
| Establish the outcome | The user's request, evidence of the current system and the scope | Measurable outcomes, exclusions, hard constraints and owned unknowns |
| Take inventory | The repository or environment boundary and the sources the user authorized | The stack, the existing services and libraries, workloads, consumers, hosts, limitations and where each fact came from |
| Assign responsibilities | Workloads and constraints | The owner of each decision, each kind of data and each effect; deployment units; the alternatives considered, with their reasons |
| Model workflows | Responsibilities and the success and failure scenarios | Ordered interactions; retry, cancellation and recovery paths; trust crossings and transaction boundaries |
| Define types and mutations | The inputs, outputs and state of the workflows | Properties with identity, units, presence, bounds, source, mutator, invariant, lifetime and representations |
| Establish contracts | Types, effects, consumers and host constraints | Operations, errors, security, persistence, transport and behavioral agreements |
| Review the whole design | The complete dependency closure | Correct layer ownership, feasible hosts, no contradictory cycles and every missing piece of evidence named |
| Establish implementation rules | Accepted responsibilities and contract decisions | Justified conventions, component plans, tests and frozen boundaries |
| Implement and qualify | A ready task and pinned accepted inputs | The component implementation, real tests, integration evidence and controlled defect fixes |
| Release and operate | Complete composition evidence | A release manifest, operational checks and reconciled documentation |

The order exists because a change to an early stage invalidates what was built on it. Settling responsibilities before interfaces, and types, mutations and failure behavior before implementation, keeps the expensive rework at the stage where it is still cheap.

## Unknowns

An unknown value is recorded as an unknown, never filled in. Each unknown carries:

| Field | What it states |
| --- | --- |
| `owner` | The team alias accountable for answering it |
| `evidenceNeeded` | The evidence that would answer the question |
| `affects` | The records whose scope the answer changes |
| `recommendedAction` | The action to take while it is open, and whether that action can be reversed once the answer arrives |
| `blocks` | The task classes it blocks while open, so readiness can tell whether it blocks the next task |

Readiness reports a task that depends on an open blocking unknown as blocked. **Never fabricate a missing value to obtain a green readiness result**: a ready result built on an invented value certifies the invention, and every consumer then trusts it.

## Design patterns

Adopt a design pattern only when a workload, a constraint or a measured benefit justifies it, and link the decision that adopts it to that workload, constraint or measurement through the decision's `basedOn`. A pattern without that link adds a cost every later change pays, with nothing to weigh it against.

## Delivery modes

Use component-complete work when the contracts can be established independently: each component's contracts are settled and accepted first, and implementation proceeds against them in parallel, with a permitted substitute such as a test double standing in for a dependency that is not built yet. Use vertical delivery in an adopting application when uncertainty across layers requires it: a slice task takes one requirement through every layer it touches.

In either mode, freeze the accepted boundaries in a baseline, and record the impact with `loom.planChange` before a change crosses a frozen boundary. A defect fix that conforms to the frozen contract stays possible; a change to the frozen contract itself goes through the change process the trusted policy configures, which names the acceptance it needs.

## Planned work and incidents

During planned work, the accepted models and the frozen component contracts govern the intended behavior. During an incident, the observed code, the deployed artifacts, the configuration and the environment establish what happened, while the accepted contracts still establish what should happen. Record each discrepancy, fix the owner that is wrong, and reconcile the documentation with the outcome. A deployed defect does not become a requirement merely because it exists.

## Gates

Tool descriptions and guidance cannot make an agent call a tool. Repository policy makes the engineering checks mandatory for governed changes through a build or local release gate: the `check` command refuses missing required context, an invalid model, a stale pin and unqualified implementation whatever an agent wrote, so the workflow gate enforces the method independently of agent prose.
