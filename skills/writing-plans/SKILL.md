---
name: writing-plans
description: Use when you have an approved design in a task file, or clear requirements, for a multi-step change, before touching code
---

# Writing plans

A plan is the set of decisions the implementer cannot make alone: which files, which names and signatures, which values from the description, which tests prove each task. Write for a capable engineer who has never seen this codebase or conversation. **A plan longer than the code it describes has written the code instead.**

Write the plan into the `## Plan` section of the task file (`docs/tasks/YYYY-MM-DD-<topic>.md`, from brainstorming), replacing "None yet", and set its `Base:` to `git rev-parse HEAD`. The file must say `Status: design approved`; if it is still a draft, ask the user to approve the description first, never approve it yourself. With clear requirements and no task file, create one from `../../templates/task.md` and get its description approved. The task file lives only on the work branch: it is deleted when the work is finished, and the guard blocks a PR or merge while it exists.

## Header

```markdown
## Plan

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** one sentence
**Architecture:** 2–3 sentences
**Stack / constraints:** versions, dependency limits, platform floors, naming and copy rules. Exact values, copied from the description or the repo.
**Verification:** the project's commands (from AGENTS.md or `.pi/verify.json`)

### Review focus
Up to five inputs or failure modes the description implies but no test yet covers, most likely first
(empty input, concurrency, retries, offline, locale, large data…). Each gets a test in the task that owns it.

### Post-implementation
Docs this change makes stale (README, docs/, decision record, CHANGELOG, agent manifest, API reference),
each with what to update, or "none: <why>". Name the topic chapter that describes this feature;
a new feature gets a new `docs/NN-<feature>.md`. Done in the same branch, before finishing.
What outlives this task file: behavior → that chapter; decisions and lasting rulings → `docs/decisions/`.
```

## Map files first

List the files to create or modify and each one's single responsibility, before defining tasks. Split by responsibility, not by layer. In existing code, follow its structure.

## Tasks

A task is the smallest unit that has its own test cycle and could be rejected by a reviewer independently of its neighbours. Fold setup, config and docs into the task that needs them.

````markdown
### Task N: <component>

**Files:** Create `path/a.ts` · Modify `path/b.ts` · Test `path/a.test.ts`
**Interfaces:** Consumes `fnX(a: A): B` from Task 2 · Produces `fnY(c: C): D`

- [ ] Write failing test `rejects empty email` asserting `{ error: "Email required" }`; add a stub `fnY` that returns `{}`
- [ ] Run `npm test -- a.test.ts` → expect FAIL: expected `{ error: "Email required" }`, received `{}`
- [ ] Implement `fnY(c: C): D` in `path/a.ts` (one line on approach only if the test leaves a choice)
- [ ] Run `npm test -- a.test.ts` → expect PASS, then the full suite
- [ ] Commit `feat(scope): add fnY`
````

What each step contains:
- **Test step:** the test name and its assertions, with the description's exact values (quote the criterion). The expected FAIL is an assertion failure, never "not defined" or "cannot find module" (that is an error: add a stub). Each numbered criterion names how it is verified, by the rules in `../test-driven-development/references/test-standard.md` ("Criteria and levels").
- **With BDD, outside-in:** the task for a user-visible criterion starts with `Write scenario @C3 … → run → expect FAIL at step "<step>"`, has its unit-test steps in between, and ends with `Run scenario @C3 → expect PASS`.
- **Code step:** the signature, the file, and any pinned values. Include a body only for an algorithm the tests don't determine.
- **Run step:** the command and the expected output.

Lines that decide nothing ("handle edge cases", "add validation", "TBD") are gaps. Fix them.

## Self-review before handing off

1. **Coverage:** every success criterion maps to a task.
2. **Steps:** each step allows exactly one reasonable implementation.
3. **Consistency:** names and types match across tasks.
4. **Review focus:** each line has a test in its owning task.
5. **Proportion:** if code blocks dominate, replace them with signatures and assertions. Every step ends in something checkable: a command with its expected output, or an observable behavior.
6. **Docs:** Post-implementation names every doc the change affects (writing-documentation).

Then link the task file and ask the user to review it and choose how to execute it: **inline** (cheapest; one review at the end) or **subagent per task** (a fresh implementer and reviewer per task; costs more; needs a `subagent` tool). Recommend one, in one sentence: how coupled the tasks are, how many there are, and what a mistake would cost. On approval, set the file's `Status: plan approved (YYYY-MM-DD)` and commit it.
