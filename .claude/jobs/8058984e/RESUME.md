# Resuming the Loom 1.0.0 delivery job (snapshot of 2026-10-05)

This folder is a snapshot of the delivery job's state, committed with the work it describes. The live job folder is `%USERPROFILE%\.claude\jobs\8058984e` on AMC-D-PF3XTNPM; where both exist, the live folder is newer. This snapshot's ledger journal ends at the task 14 report, before the commit that carries it, the `adopt` of that commit and the `pause`.

## State at this commit

- Milestone a (tasks 10, 14, 21, 22): task 10 is committed (Loom `e56e730`). Task 14 is implemented and committed in this commit; the ledger's own evidence run for it is still owed. Tasks 21 and 22 are next.
- The ledger was paused on the owner's instruction after this commit.

## Where the state lives

| What | Where in this folder |
| --- | --- |
| Task list: protocol and owner rules (task 1), decision register (task 2), every task's scope, grounding and status | `tasks/*.json` (task 1 metadata: `ownerRuleNoAgents`, `resumeImprovements`; task 2 metadata: `decision31`; task 14 metadata: `wrapUp`) |
| Ledger configuration, check declarations and journal | `tmp/ledger/ledger.config.json`, `tmp/ledger/suites/`, `tmp/ledger/state/` |
| Spec-to-task crosswalk and its tools | `tmp/loom-refinements-crosswalk.json`, `tmp/crosswalk.mjs`, `tmp/plan-gate.mjs` |
| Commit-message wording check | `tmp/check-message.mjs` |
| Task 14 brief | `tmp/brief-14.md` |
| Ledger evidence of task 10 | `evidence/10/` |

## To resume

1. On another machine, copy this folder to `%USERPROFILE%\.claude\jobs\8058984e`; the ledger configuration names absolute paths. The task files belong in `%USERPROFILE%\.claude\tasks\<session id>\`.
2. Set `LEDGER_SESSION` to the resuming session's id, then run `node %USERPROFILE%\.claude\jobs\8058984e\tmp\ledger\ledger.mjs acquire --takeover` and `resume`.
3. If `verify` lists this commit as `UNLEDGERED_COMMIT`, record it with `adopt <sha> --task 14 --reason "<why>"`.
4. Finish task 14: `run 14 <check>` for each check in `tmp/ledger/suites/task-14.json`, one `--rerun`, `check 14`, `accept 14` and `commit 14`, which records the commit that already holds the accepted tree. Then record the crosswalk evidence of its 45 statements and run the plan gate and `verify`.
5. Tasks 21 and 22 follow, implemented by the orchestrating session itself (task 1 metadata `ownerRuleNoAgents`).
