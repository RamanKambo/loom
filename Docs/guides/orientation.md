# Loom orientation

Loom keeps an explicit engineering model of a system and checks the consequences of every declared decision. Each result reports four independent states: validation, readiness, qualification and acceptance.

Work in this order:

1. Identify the workspace and the outcome the user asked for.
2. Read the context of the task: its constraints, its evidence and the decisions still open (`loom.context`; a resume target restates the recorded progress).
3. Settle responsibilities and workflows before detailed interfaces, and types, mutations and failure behavior before implementation.
4. Change a contract only through its owning model: preview the impact with `loom.planChange`, apply it with `loom.mutate`, then check readiness for the actual task with `loom.checkReadiness`.
5. Keep generated artifacts derived from their owners: edit the model, never a projection.
6. Implement only the scope readiness permits, qualify the real implementation, and bind each piece of evidence to the exact inputs it ran against.

A valid model, a rendered diagram and a passing example each prove something different, and none stands in for another. Report missing evidence as missing, and never invent a value to make a result pass. The user's existing authorization and the repository's trusted policy decide which changes need acceptance; an agent's acknowledgement is never acceptance.

Results are bounded. A page that omits anything lists it in its completeness with the continuation that retrieves the rest, and a truncated page establishes neither coverage nor readiness. `loom.describe` returns this summary, `detail: "full"` pages through every section, and `operation` returns the proof limits of one operation. The guides `loom://guide/engineering`, `loom://guide/workflow` and `loom://guide/capabilities` hold the method, the order of work and what each kind of proof does not establish.
