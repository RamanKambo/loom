# Resume the Loom 1.0.0 job: task 10, then milestone a

Owner steps, in the parent session ("loom refinements implementation"):

1. Run `/goal clear`.
2. Send the message in section A.
3. When that turn has printed `node $L next`, run `/goal` followed by the condition in section B.

## A. Resume message

This message is the owner's resume authorization for task 10 and the rest of milestone a (tasks 10, 14, 21, 22).

Changed while you were paused, each verified:

- `Codebase/.claude/agents/loom-worker.md` sets `model: sonnet` and `effort: high` (superproject `f62cb17`). Your earlier workers inherited Opus 5.5 and re-read 510-560K tokens per message.
- The instruction Stop hook reads only transcript lines appended since its last successful check (Context-Engineering `f2d323c`, superproject `5631a75`).
- agentmemory LLM compression is off (`Tools/memory-server/Store/.env`), which took host CPU from 100 % to about 70 %; its weekday schedule is not registered yet.
- The job ledger replaces `evidence.mjs`: `C:/Users/nnbfdh8/.claude/jobs/8058984e/tmp/ledger/ledger.mjs`, configured by `ledger.config.json` beside it; its header lists every verb. Evidence is produced only by `ledger run` into `~/.claude/jobs/8058984e/evidence/<task>/`. `ledger check` refuses a missing, failing, stale or tree-mismatched suite, a log whose expectation is unmet, and a task without one matching rerun. `ledger commit` requires `HEAD^{tree}` to equal the accepted tree.

Do, in order:

1. In your console: `$env:LEDGER_SESSION = '8058984e-22ea-4252-bd8e-5551551a62b9'`, `$L = 'C:/Users/nnbfdh8/.claude/jobs/8058984e/tmp/ledger/ledger.mjs'`, then `node $L acquire`, `node $L init --tasks C:\Users\nnbfdh8\.claude\tasks\8058984e-22ea-4252-bd8e-5551551a62b9`, `node $L next`.
2. Task 10: keep the uncommitted changes in `Tools/loom` at `930bde4` (no reset, stash or checkout). Settle its two open contract decisions against the accepted requirements in `Tools/Context-Engineering/loomrefinements.md`; a demonstrated contract defect goes through the spec's impact-and-acceptance process, not a redesign; ask the owner only when the spec and the accepted decisions do not settle it. Finish every document the change makes wrong before any evidence run.
3. Brief a fresh `loom-worker` (the previous worker's context exceeds the ledger's 200K limit): `node $L brief 10 --agent <id> --model sonnet --effort high --suites C:/Users/nnbfdh8/.claude/jobs/8058984e/tmp/ledger/suites/task-10.json`. Save its Builder report and record it with `node $L report 10 <file>`.
4. Evidence: `node $L run 10 <suite>` for every declared suite (the designer suite is heavy, so the ledger waits while CPU is at or above 70 %), one `node $L run 10 <suite> --rerun`, then `node $L check 10` showing `findings 0`, `node $L accept 10`, and `node $L commit 10 -m "<message>"` with the documents in the same commit. Advance the superproject's `Tools/loom` pointer by pathspec and push.
5. Run the plan gate after each commit: `node C:/Users/nnbfdh8/.claude/jobs/8058984e/tmp/plan-gate.mjs --tasks C:\Users\nnbfdh8\.claude\tasks\8058984e-22ea-4252-bd8e-5551551a62b9 --crosswalk C:/Users/nnbfdh8/.claude/jobs/8058984e/tmp/loom-refinements-crosswalk.json --spec C:/Users/nnbfdh8/Codebase/Tools/Context-Engineering/loomrefinements.md`.
6. Continue milestone a in `ledger next` order (14, 21, 22), one task at a time. Reuse one worker while its recorded context stays under the limit; brief the next task while the last one's evidence runs. An Opus dispatch needs `node $L escalate <task> --reason <text>` first.
7. End every turn with `node $L next`, and after a commit with `node $L verify`. When the owner pauses the job, run `node $L pause --reason "<owner's words>"` and stop.

Unchanged constraints: the spec is read-only and the only source of requirements, and its SHA-256 stays `8139f60d0b132405ebe02124e5553cb3085a5113edb6b1d87ef096e4f199f50e`; no commit from this session touches `Tools/Context-Engineering`; the spec's wording rule governs Loom's text; versions stay 1.0.0 and format numbers 1, with no compatibility shims; documents change in the same commit as their code; commit after each accepted task, then push; ask only about scope changes, production changes or unapproved destructive actions.

## B. Goal condition

Milestone a of Loom 1.0.0 (tasks 10, 14, 21, 22) is delivered under the job ledger as Tools/Context-Engineering/loomrefinements.md specifies, which is read-only and the only source of requirements. Judge only from command output printed in this conversation since the latest resume. The condition is met when the most recent output shows all of: (1) `node C:/Users/nnbfdh8/.claude/jobs/8058984e/tmp/ledger/ledger.mjs next` printing `MILESTONE a COMPLETE`; (2) the same ledger's `verify` printing `findings 0`; (3) the plan gate (`node C:/Users/nnbfdh8/.claude/jobs/8058984e/tmp/plan-gate.mjs` with its --tasks, --crosswalk and --spec arguments) printing `findings 0`; (4) `git -C C:/Users/nnbfdh8/Codebase/Tools/loom status --porcelain` printing nothing and `git -C C:/Users/nnbfdh8/Codebase/Tools/loom rev-list --left-right --count origin/main...HEAD` printing `0 0`; (5) the superproject `git log -1` showing the Tools/loom pointer advanced to the last milestone-a commit and pushed; (6) `Get-FileHash -Algorithm SHA256` of the spec printing 8139f60d0b132405ebe02124e5553cb3085a5113edb6b1d87ef096e4f199f50e. The condition is also met, ending the loop, when the most recent `ledger next` output's first line is `LEDGER PAUSED`, or a task is in state `decision` awaiting the owner, or a command reports `HOST_BUSY` after its wait limit; in those cases the turn must state what it is waiting for. Every turn ends by printing `ledger next`. A worker's prose, a passing subset of suites or a summary written by the agent is not evidence for any clause.
