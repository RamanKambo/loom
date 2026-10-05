# Cost

Cost is dominated by input, not output. A long answer is paid once; a document read into a context that is
then re-sent every turn is paid on every turn after it. So the expensive decisions are about what enters a
context and how long it stays, not about how much is typed.

## 1. The rules that save the most

Ordered by what they save.

| Rule | What it saves |
|---|---|
| Read once, reuse. Resume a knowledge-holding agent rather than respawning it | A full corpus read per question |
| Accumulate findings per file, then make one edit pass per file | The re-read is paid per round; the edit is paid once |
| Order the task list by dependency and batch by area before starting | Re-opening an area you already left is re-read every round |
| Confirm the reading of an ambiguous request before producing a long answer | A whole wasted turn plus the correction turn |
| Measure before fixing | Repeated corrections to one rule, each discovered by doing the work |
| Reasoning into the change description, not into a report | A report is re-read on every subsequent round; a change description is read once |
| Never ask a worker to quote text you will read anyway | Those tokens three times: its output, the next round's input, and the file read that verifies it |
| Targeted search before reading | A file read to answer a question a search answers |
| Refuse to re-derive what is already written down | The whole derivation, every time |

## 2. Context is the asset, and it decays

**A resumed agent's context grows monotonically.** Each round appends that round's report to its history, so
early rounds are cheap and late rounds carry the whole conversation.

**There is a crossover around eight rounds.** Below it, resuming wins — it keeps the corpus knowledge and reads
the prompt cache the first run warmed. Beyond it, a fresh agent with a tight, self-contained brief may be
cheaper. The failure to avoid is respawning with a brief that assumes the old context: a fresh agent holds none
of its predecessor's passages, and it will fill the gap by inventing.

**Editing an agent's definition discards its prompt cache**, because the definition is the system prompt. Make
definition edits before the work starts, never mid-run.

**Compaction is a scheduling event, not an accident.** It ends delegated work and forces the corpus read to be
paid again. Finish what is in flight, write the durable state, then compact. It is also a correctness hazard,
because a summary of a claim reads exactly like the claim once the evidence is gone.

## 3. Delegate or do it yourself

| Do it inline | Delegate |
|---|---|
| The target is known: one file, one symbol, one command | The search is open-ended and its output is noisy |
| The result is small and needed immediately | The raw output is large and only the conclusion is needed |
| It is one step | It is many steps against a stable, writable brief |
| Verifying it costs as much as doing it | It can be checked cheaply from its return contract |

The point of delegating a noisy investigation is that the noise never enters the orchestrator's context — only
the findings do. Delegating a task whose full output must then be read back into the orchestrator saves
nothing and costs a spawn.

**Never delegate to save thinking.** A task that cannot be stated precisely is not understood, and the
delegation produces work nobody can check — which is then paid for twice.

**Do not over-delegate.** The two wasted spawns: a trivial lookup, where the overhead exceeds the answer; and an
elaborate rediscovery you will not reuse, where a fresh agent re-derives context you already hold and hands back
a summary you must re-verify (§2). Delegate when the output is noisy and large and only the conclusion returns —
otherwise do it inline.

## 4. Do not mint tokens

Each of these produces volume with no deliverable behind it.

- **No artifact nobody asked for.** No extra document, no summary of a summary, no companion file.
- **No proposal outside the stated scope.** An unrequested option costs the reading, the discussion and the
  refusal.
- **No re-derivation.** If it is written down, cite it. If it is in a cache you hold, query the cache.
- **No re-reading a file already read** unless the passage can no longer be quoted, or something changed it.
- **No narration of intent in place of the work.**
- **No polling.** Waiting on a completion notification costs nothing; asking whether it has arrived costs a
  round trip each time.
- **No status paragraph in a durable artifact.** It is wrong within hours and then has to be corrected, which
  is a second cost on top of the first.

**Length is a symptom.** A long answer usually means analysis was substituted for the deliverable, and the
analysis will be paid for again by everyone who reads it.

## 5. The generation-versus-verification asymmetry

| | Generation | Verification |
|---|---|---|
| Parallelism | High — a whole set at once | None — statement by statement |
| Cost per statement | Near zero | Minutes to hours |
| Skill required | Low | Domain knowledge plus tool access |
| Delegable | Yes | Only with the evidence attached |

This is why labelling matters economically and not just intellectually. Labelled invention costs nothing to
clean: delete it, or promote items as evidence arrives. Unlabelled invention costs a full audit of everything
around it, because the reader cannot tell which statements need checking.

**A cheap check beats an expensive reasoning chain.** When a claim can be settled by a command, running the
command is almost always cheaper than the tokens spent reasoning toward it — and the reasoning does not
establish anything.

## 6. Where the cost actually went, historically

These are the patterns that consume budget without producing progress. Each is preventable at near-zero cost.

| Pattern | Prevention |
|---|---|
| An instrument built, then corrected three times as its definition was discovered by using it | Define the measurement before the work |
| A check redesigned after its first draft passed, because the corpus had a property nobody stated | Establish the artifact's mechanical properties before writing the matcher |
| Acting on a negative premise before checking it, once per premise, each costing a delegated round | Run the refuting search first. The search is seconds; the round is not |
| A record appended because a fact was reported absent, then re-homed when it was found present | Same as above |
| A diagnosis inverted because the symptom resembled the usual culprit | Read the requirement before diagnosing |
| The same file edited in many rounds, each re-reading it | One edit pass per file |
| A read-only measurer idle while the writer was the bottleneck | Run measurement in parallel throughout |

## 7. The one thing not to economise on

**Verification of a claim you are about to rely on.** Skipping it is the only saving that reliably costs more
than it saves: a wrong premise propagates into every artifact built on it, and unwinding that costs the whole
chain rather than one command.

The same applies to the knowledge-holding agent. Discarding it to save tokens throws away the most expensive
thing in the session, and everything it knew gets paid for again.
