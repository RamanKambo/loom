# Loom open items

Unresolved questions about Loom, each with what would close it. A decision lands in the code, the
README or a commit message, and its item is then deleted. Identifiers are never reused.

## OI-2 Should Loom model the phases that move a live table safely through a breaking change?

A breaking change to a table-backed type is accepted when the model's end state is consistent, as
`order.id` changing from string to integer is in the README Walkthrough. A database that already
holds rows cannot make that jump in one statement, and old and new consumers run side by side while
the change rolls out. The usual safe sequence has five phases:

| Phase | `order.id` example |
| --- | --- |
| Expand | Add `id_v2 BIGINT NULL` beside the existing `id`, and `orderId_v2 BIGINT NULL` beside `fulfillment.shipments.orderId`; current readers are unaffected. |
| Backfill | Convert existing rows into `id_v2` and `orderId_v2`; rows that cannot convert are reported. |
| Validate | Prove every row converted and every constraint holds, including that each `orderId_v2` matches an `id_v2`. |
| Switch | Deploy `ordering.sp_place_order` v2 and `fulfillment.rb_dispatch` v2 against `id_v2` and `orderId_v2`. |
| Contract | Drop `FK_shipments_orderId` first, because SQL Server refuses to drop a key a foreign key references; drop the old columns, make `id_v2` the `NOT NULL` key, rename both new columns to their old names, and re-create the foreign key. |

Loom would add a migration record per breaking change to a table-backed property. Rules would
refuse the change without one, enforce phase order (switch never before validate), and schedule
each consumer's version bump into the switch phase. A projection would emit the per-phase DDL
skeleton and checks.

**What would close:** the owner's decision; if accepted, a design for the migration record and its
rules in `packages/core/src/types.ts` and `meta-schema.ts`.

**Cost of leaving open:** a breaking column change passes Loom and then fails, or loses data, on the
first database that holds rows.

## OI-3 Should Loom track which requirements and contracts are proven, and by what?

Every mutation already traces to a requirement and a scenario (`MUTATION_TRACEABILITY_UNCOVERED`).
Nothing records whether a scenario or a routine contract has actually been proven. An evidence record
would name what it proves, the check that proves it, such as a generated SQL or Pester contract test,
and the version it proved. A rule would require evidence for every scenario and routine contract, and
evidence would turn stale when the element it proves changes version. The observed status (passed,
failed, unknown) comes from pipeline runs, so it belongs in a generated artifact; the deterministic
model holds only the required evidence.

**What would close:** the owner's decision; if accepted, the evidence record shape and where pipeline
results are read from.

**Cost of leaving open:** after a change, nobody can list what is still unproven. The `order.id`
change made the conforming runbook fail its contract test, and only a manual test run showed it.

## OI-4 Should Loom record a maturity level for each delivery slice?

A delivery slice is a workflow with its operations, mutations and routines. Workflows carry only
`planned` or `active` today. Levels such as planned, specified, built, verified and released would
come with rules: a slice is verified only when all of its evidence passed (needs OI-3), and released
only when every slice it depends on is released.

**What would close:** the owner's decision after OI-3, because the verified level depends on
evidence records.

**Cost of leaving open:** the model cannot say which parts of the system are ready, and a slice can be
promoted ahead of the slices it depends on.
