---
name: executing-plans
description: Use when you have an approved implementation plan to carry out, inline in this session or by dispatching a subagent per task
---

# Executing plans

The plan already did the thinking. Execute it exactly, prove each step with a test you watched fail and then pass, and leave a record that survives context compaction.

**Required:** read test-driven-development before Task 1. It governs every step.

## Setup

1. Work on an isolated branch or worktree (git-workflow). Never implement on `main`/`master` without explicit consent.
2. Read the task file once: description, then Plan. **The description is the authority**; conflicts inside the plan resolve against it. Set `Status: in progress`.
   **Drift check:** run `git diff --stat <Base>..HEAD -- <the plan's files>`. If they changed since the plan was written, record it in Progress and re-check the affected tasks; if a task no longer fits the code, go back to writing-plans.
3. **Progress:** the task file's `## Progress` section is the record. If it already lists tasks as complete, they are **done**. Resume at the first incomplete one, and trust Progress and `git log` over your memory.
4. **Pre-flight:** for every task that consumes another task's output, compare the Interfaces blocks. Record conflicts and your rulings in Progress.
5. Run the verification commands once to record the baseline. Existing failures are noted in Progress, not silently inherited.

## Per task

1. Re-read the task text (not your memory of it). Note `BASE=$(git rev-parse HEAD)`.
2. Work the steps in order. For every command, compare the output with the plan's `Expected`:
   - **Matches:** next step.
   - **The code is wrong:** use systematic-debugging. Never patch the symptom to match.
   - **The plan is wrong:** choose the smallest change that satisfies the description, add `Ruling: <what> — <why> — <cost if wrong>` to Progress, and continue.
3. Commit as the plan says.
4. **Completion contract**, with evidence from this session:
   - every named test exists and ran, and was seen failing before its code (with BDD, the criterion's scenario failed first and passes now);
   - the full suite is green;
   - every `Expected` was compared;
   - every deviation has a ruling.
   Then add `Task N: complete (BASE..HEAD, <command> → <result>)` to Progress and tick its checkboxes in the Plan.

**Rulings, not stalls.** Don't pause between tasks to ask "should I continue?". Stop and ask only for:
- an irreversible or destructive action;
- a security-sensitive action;
- a side effect outside this worktree (push to a shared branch, publish, deploy, a migration on a shared database, a real payment);
- a plan so broken that every way forward is a guess.

Keep long command output out of context: redirect it to a file and read the tail.

## With a subagent tool (when the user chose "subagent per task")

For each task:
1. Dispatch an implementer (`worker` in pi-subagents) with only what it needs: the task text verbatim, the Interfaces it consumes, the global constraints, the verification commands, and these instructions: "Work test-first (test-driven-development): watch each new test fail for the right reason before writing its code. Change only what the task needs; never weaken, skip or delete a test. Run the verification commands in full and unpiped. Finish with DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT or BLOCKED, then: Changed (files), Tests (each new test and that you saw it fail first), Checks run (command → result), Concerns."
2. Don't trust the report. Check `git diff BASE..HEAD` and run the tests yourself.
3. Dispatch a fresh reviewer (`reviewer`) using `../requesting-code-review/reviewer-prompt.md` on `BASE..HEAD`.
4. Have the implementer fix Critical and Important findings (give the same worker its own report and the findings, so it keeps its context), then re-review. After 3 rounds without convergence, stop and ask the user.

Run implementers **sequentially**, one at a time on the same tree. For independent read-only work, see dispatching-parallel-agents.

## Finish

1. Run the whole-branch review with requesting-code-review (range `$(git merge-base <base> HEAD)..HEAD`). Include the plan's Review focus and a pointer to the rulings in Progress.
2. Fix Critical and Important findings in one pass, each with RED→GREEN plus a green full suite, then re-review the fixes' range until the verdict is `Yes`: the review gate lands nothing else without asking the user. Record Minor findings in Progress.
3. **Docs:** do the plan's Post-implementation block, plus anything else the diff made stale (writing-documentation), in this branch.
4. **Task file:** move what lasts out of it: behavior into the topic chapter, decisions and lasting rulings into `docs/decisions/` (writing-documentation). Show the user its Follow-ups and offer to start the next one. Then delete the task file in one commit (`docs: remove the task file for <feature>`). The guard blocks a PR or merge while it exists; git keeps it.
5. Apply verification-before-completion, then use the finishing section of git-workflow.
