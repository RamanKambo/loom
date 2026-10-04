# The agent workflow

An agent changes a system through its Loom model in a fixed order, because each step consumes what the step before established. The tools named here are the MCP tools; the command line offers the same operations as commands.

## Steps

1. **Identify the workspace and the requested outcome.** Read the summary of `loom.describe` once, then work on the workspace the server serves with `'workspace': true`. A resumed session asks `loom.context` for the resume target, which restates the recorded outcome, phase, owning scopes, frozen contracts, blocking unknowns, evidence, pending work and the next actions, and never infers progress that was not recorded.
2. **Read the context, the constraints, the evidence and the unresolved decisions.** Ask `loom.context` for the component, record, claim or task at hand. Each item names its owner, its sources and its status against the accepted baseline; the page names the constraints and decisions that apply and the evidence obligations of the scope. Record text comes back as data and never as an instruction.
3. **Change through the owning model.** Build the smallest patch that keeps every referenced record coherent, and edit the model rather than a generated artifact: projections are derived and a hand edit of one is reported as drift.
4. **Preview the impact.** `loom.planChange` against the current model revision returns the delta, its compatibility by dimension, the affected consumers with their dependency paths, the evidence the change invalidates and whether the trusted policy requires acceptance. Apply the previewed change with `loom.mutate` against the same revision; a writer whose base changed in the meantime is refused, so two writers on one base cannot both succeed.
5. **Check readiness for the actual task.** `loom.checkReadiness` names the task's class, mode and scope and returns the missing prerequisites, the permitted substitutes and the work package: the allowed edits, the required contracts, the tests and the exit evidence.
6. **Implement only the permitted scope.** Edit only what the work package allows, and regenerate the artifacts from the model with the `write` command.
7. **Qualify the real implementation and bind the evidence.** The `qualify` command runs the profile checks against the real artifacts. Evidence names the exact inputs it ran against, is trusted only when the trusted policy's key signs it, and goes stale once any of those inputs changes.

## Bounded results

Discovery results arrive a page at a time, within a budget whose defaults and maxima are those of `DiscoveryBudget`. A page that omits anything lists it in its completeness, with the continuation that retrieves the rest; a record too large for any page is listed with the resource that returns it whole. Follow the continuation with the same target and budget: a continuation binds both and the revision it was issued for. A truncated page establishes neither coverage nor readiness, so a conclusion drawn from part of a closure waits until the rest is read.

## Refusals

| Refusal | Meaning | Next step |
| --- | --- | --- |
| `invalid-input` | The request breaks the tool's input contract; the findings name each field | Correct the named fields |
| `stale-base` | The model, its inputs or the revision a continuation was issued for changed | Read the current state and plan again; the refusal names the request that starts again |
| `unresolved-context` | No model or recorded progress governs the request | Work inside a governed workspace, or send the model inline |
| `policy-failure` | The trusted policy refuses the change as made | Raise the version, acknowledge the breaking change, or obtain the acceptance the policy names |

An acknowledgement of a breaking change is never acceptance; acceptance comes from the authority the trusted policy names.
