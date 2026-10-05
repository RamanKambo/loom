# Native qualification implementation status

Implemented in the continuation branch:

- Run-scoped cancellation reaches sqlcmd, PowerShell, dotnet and Node subprocesses. Deadline/cancellation waits for child exit before capturing evidence or releasing resources.
- Policy total/command/engine/cleanup budgets, measured disk/engine working set, explicit lack of an OS hard memory guarantee, and bounded SQL file growth with configured memory/MAXDOP.
- Atomic cross-process user lease, durable allocation intent outside disposable directories, process creation identity, one cleanup claim, temporary guardian, and explicit/pre-allocation recovery.
- Durable evidence capture before native teardown; database-drop/file absence, instance-stop/process absence, instance deletion/directory absence checks; lifecycle success requires PASS and clean cleanup.
- Provisioned provider IDs; dedicated Developer service refusal without mutation for wrong edition/name, absent permissions, running service and unauthorized Disabled mode; authorized startup restoration. No SQL service was installed or elevated.
- Session-owned RunRegistry with policy/check/grant/source-vector guards, start/status/cancel/wait/close/recover. MCP adapter and durable CLI worker/control files implement workspace start/status/cancel/recover.
- Windows PowerShell Desktop 5.1 runner uses that exact executable and discovers Pester in that process rather than substituting Core.

Verification actually executed:

- TypeScript build of CLI and MCP packages: passed.
- Qualification framework: 24 tests passed, no failures.
- Lifecycle controls: 13 tests passed, no failures (repeat of final source is recorded in the controller handoff).
- Real LocalDB: catalog precision negative control and concurrent SQL request serialization passed; the native assertion verifies no loom-* instance remains after those runs.

Remaining required work; these capabilities are not declared fully qualified:

1. Full real LocalDB fault matrix: partial create, command/total/cleanup/file/memory budgets, owner-process death with guardian, injected stop failure, residual files, repeated recovery and competing independent processes. Current lease contention tests and the real concurrent SQL check are not that entire matrix.
2. Complete real SQL behavior/transaction/migration/operations regression after lifecycle changes. Existing runners were retained; only the focused catalog/serialization checks were rerun here.
3. Dedicated Developer service needs provisioned native evidence. Machine-lock directory ACL provisioning, cross-user stale-lock recovery and startup restoration after actual owner death need qualification; Windows inspection currently conservatively recognizes elevated administrators for control authority and refuses other delegated accounts.
4. Record-scoped MCP qualification is explicitly refused. It must gain exact record scope/evidence/input-digest binding and fixture selection before accepting record targets; silently running a whole workspace would widen the request.
5. Windows PowerShell 5.1 requires an authored profile and real Pester/runtime evidence, including negative cases. The runner alone is not native qualification of that profile.
6. Historical orphan cleanup: 203 loom-* directories were observed in the host's Instances directory. They predate this allocation journal. Their individual ownership could not be proven, so none was deleted. Task 27 needs an auditable ownership inventory and explicit appropriate cleanup authorization.
7. Input hashes for explicitly declared implementation/fixture/assertion files are pinned, but complete automatic discovery of PowerShell/C#/TypeScript implementation closures and expected assertions remains to be implemented. The adapter must supply real adopting implementation fixtures; empty fixtures cannot prove adoption.
8. Retained debug directories remain residual cleanup requiring recovery; an expiry/cost retention policy is not implemented. Default retention is off.
9. Harden overall cleanup/recovery deadlines and reported enforcement across all service and recovery branches; these paths need the fault tests above. Exceeding configured server memory is monitored rather than an OS hard cap; the result records processMemory as unenforced.

Do not mark tasks 16, 17, 18, 19, 27, 32 or 37 complete from these focused checks alone. Do not waive a missing native environment to finish release.
