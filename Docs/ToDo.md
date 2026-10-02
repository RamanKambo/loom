# Loom open items

Unresolved questions about Loom, each with what would close it. A decision lands in the code, the
README or a commit message, and its item is then deleted.

## OI-1 Should Loom keep a dormant local SQL Server that it wakes only for database checks?

`contract-tests.sql` proves that real procedures and tables match the model only when it runs
against a SQL Server (see the README, Conformance checks). On AMC-D-PF3XTNPM, SQL Server 2022
Express LocalDB 16.0.1000.6 was installed on 2026-10-02 for that check; it takes about 281 MB on
disk and runs no Windows service.

**Constraint:** the engine never executes SQL or calls a live service. Any start, stop or
purge scripting belongs in the CLI or a separate script, never in `packages/core`, and the database
holds nothing that outlives one check.

| Option | One check | Idle footprint | Open points |
| --- | --- | --- | --- |
| A. Keep LocalDB | `SqlLocalDB start`, create a throwaway database, run the checks, drop it, `SqlLocalDB stop` | Disk only: LocalDB uses no services and starts on demand (Microsoft Learn, *SQL Server Express LocalDB instance APIs*) | Whether an idle instance stops by itself is unknown. Express edition limits apply (Microsoft Learn, *SQL Server Express LocalDB*, Install LocalDB). |
| B. Developer edition, dormant | Enable and start the service, drop and recreate the database, run the checks, then stop and disable the service | Disk only while disabled | Whether scripts can change the service's startup type and start it without elevation is unknown. Larger install. Which checks it enables that LocalDB cannot is unknown. |
| C. Install per check | Install LocalDB, run the checks, uninstall | None | Slowest; needs the installer media and elevation every time. |

**What would close:** a measured comparison on the office laptop. It covers disk use, memory while
running and while stopped, start time, and the privilege each step needs. It also lists any check
or tool that options A and B enable beyond the other. The owner then decides, with the reason in the
commit.

**Blocked by:** the owner's decision; option B also needs a scripted enable, start, stop and disable
test.

**Cost of leaving open:** LocalDB stays installed on AMC-D-PF3XTNPM, and the SQL contract checks
are proven only on that machine.
