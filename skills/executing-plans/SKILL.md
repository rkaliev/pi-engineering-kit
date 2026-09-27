---
name: executing-plans
description: Use when you have an approved implementation plan to carry out, inline in this session or by dispatching a subagent per task
---

# Executing plans

The plan already did the thinking. Execute it exactly, prove each step with a test you watched fail and then pass, and leave a record that survives context compaction.

**Required:** read test-driven-development before Task 1. It governs every step.

## Setup

1. Work on an isolated branch or worktree (git-workflow). Never implement on `main`/`master` without explicit consent.
2. Read the plan and its spec once. **The spec is the authority**; conflicts inside the plan resolve against it. Set the plan's `Status: in progress`.
3. **Ledger:** create `docs/plans/<plan-name>.progress.md` (or the project's equivalent), first line `# Ledger — plan: <path>`. If it already exists and names this plan, tasks marked complete are **done**. Resume at the first incomplete one, and trust the ledger and `git log` over your memory.
4. **Pre-flight:** for every task that consumes another task's output, compare the Interfaces blocks. Record conflicts and your rulings in the ledger.
5. Run the verification commands once to record the baseline. Existing failures are noted in the ledger, not silently inherited.

## Per task

1. Re-read the task text (not your memory of it). Note `BASE=$(git rev-parse HEAD)`.
2. Work the steps in order. For every command, compare the output with the plan's `Expected`:
   - **Matches:** next step.
   - **The code is wrong:** use systematic-debugging. Never patch the symptom to match.
   - **The plan is wrong:** choose the smallest change that satisfies the spec, log `Ruling: <what> — <why> — <cost if wrong>`, and continue.
3. Commit as the plan says.
4. **Completion contract**, with evidence from this session:
   - every named test exists and ran;
   - the full suite is green;
   - every `Expected` was compared;
   - every deviation has a ruling.
   Then log `Task N: complete (BASE..HEAD, <command> → <result>)` and tick the checkbox.

**Rulings, not stalls.** Don't pause between tasks to ask "should I continue?". Stop and ask only for:
- an irreversible or destructive action;
- a security-sensitive action;
- a side effect outside this worktree (push to a shared branch, publish, deploy, a migration on a shared database, a real payment);
- a plan so broken that every way forward is a guess.

Keep long command output out of context: redirect it to a file and read the tail.

## With a subagent tool (when the user chose "subagent per task")

For each task:
1. Dispatch an implementer (`worker` in pi-subagents) with only what it needs: the task text verbatim, the Interfaces it consumes, the global constraints, the verification commands, and the instruction "follow TDD; report DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT or BLOCKED with the commands you ran".
2. Don't trust the report. Check `git diff BASE..HEAD` and run the tests yourself.
3. Dispatch a fresh reviewer (`reviewer`) using `../requesting-code-review/reviewer-prompt.md` on `BASE..HEAD`.
4. Have the implementer fix Critical and Important findings, then re-review. After 3 rounds without convergence, stop and ask the user.

Run implementers **sequentially**, one at a time on the same tree. For independent read-only work, see dispatching-parallel-agents.

## Finish

1. Run the whole-branch review with requesting-code-review (range `$(git merge-base <base> HEAD)..HEAD`). Include the plan's Review focus and a pointer to the ledger's rulings.
2. Fix Critical and Important findings in one pass, each with RED→GREEN plus a green full suite. Log Minor findings.
3. **Docs:** do the plan's Post-implementation block, plus anything else the diff made stale (writing-documentation), in this branch.
4. Set the plan's `Status: done` and the spec's `Status: implemented (YYYY-MM-DD)` with a link to its topic chapter, and tick the piece in the roadmap if there is one.
5. Apply verification-before-completion, then use the finishing section of git-workflow.
