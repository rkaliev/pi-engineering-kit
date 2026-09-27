---
name: writing-plans
description: Use when you have an approved spec or clear requirements for a multi-step change, before touching code
---

# Writing plans

A plan is the set of decisions the implementer cannot make alone: which files, which names and signatures, which values from the spec, which tests prove each task. Write for a capable engineer who has never seen this codebase or conversation. **A plan longer than the code it describes has written the code instead.**

Save the plan to `docs/plans/YYYY-MM-DD-<feature>.md`, or wherever the project keeps plans.

## Header

```markdown
# <Feature> implementation plan

> Execute with the executing-plans skill. Steps use `- [ ]` checkboxes.

**Status:** draft (→ approved → in progress → done)
**Base:** the commit SHA this plan was written against (`git rev-parse HEAD`)
**Goal:** one sentence
**Spec:** path to the spec; it must say `Status: approved`. If it is still a draft, ask the user to approve it first; never approve it yourself
**Architecture:** 2–3 sentences
**Stack / constraints:** versions, dependency limits, platform floors, naming and copy rules. Exact values, copied from the spec or the repo.
**Verification:** the project's commands (from AGENTS.md or `.pi/verify.json`)

## Review focus
Up to five inputs or failure modes the spec implies but no test yet covers, most likely first
(empty input, concurrency, retries, offline, locale, large data…). Each gets a test in the task that owns it.

## Post-implementation
Docs this change makes stale (README, docs/, decision record, CHANGELOG, agent manifest, API reference),
each with what to update, or "none: <why>". Name the topic chapter that describes this feature;
a new feature gets a new `docs/NN-<feature>.md`. Done in the same branch, before finishing.
```

## Map files first

List the files to create or modify and each one's single responsibility, before defining tasks. Split by responsibility, not by layer. In existing code, follow its structure.

## Tasks

A task is the smallest unit that has its own test cycle and could be rejected by a reviewer independently of its neighbours. Fold setup, config and docs into the task that needs them.

````markdown
### Task N: <component>

**Files:** Create `path/a.ts` · Modify `path/b.ts` · Test `path/a.test.ts`
**Interfaces:** Consumes `fnX(a: A): B` from Task 2 · Produces `fnY(c: C): D`

- [ ] Write failing test `rejects empty email` asserting `{ error: "Email required" }`
- [ ] Run `npm test -- a.test.ts` → expect FAIL: "fnY is not defined"
- [ ] Implement `fnY(c: C): D` in `path/a.ts` (one line on approach only if the test leaves a choice)
- [ ] Run `npm test -- a.test.ts` → expect PASS, then the full suite
- [ ] Commit `feat(scope): add fnY`
````

What each step contains:
- **Test step:** the test name and its assertions, with the spec's exact values (quote the criterion). Each numbered criterion names its acceptance test, at the level that shows it as the user sees it; with BDD in the project, that is a scenario tagged with the criterion.
- **Code step:** the signature, the file, and any pinned values. Include a body only for an algorithm the tests don't determine.
- **Run step:** the command and the expected output.

Lines that decide nothing ("handle edge cases", "add validation", "TBD") are gaps. Fix them.

## Self-review before handing off

1. **Coverage:** every spec requirement maps to a task.
2. **Steps:** each step allows exactly one reasonable implementation.
3. **Consistency:** names and types match across tasks.
4. **Review focus:** each line has a test in its owning task.
5. **Proportion:** if code blocks dominate, replace them with signatures and assertions. Every step ends in something checkable: a command with its expected output, or an observable behavior.
6. **Docs:** Post-implementation names every doc the change affects (writing-documentation).

Then link the plan and ask the user to review it and choose how to execute it: **inline** (cheapest; one review at the end) or **subagent per task** (a fresh implementer and reviewer per task; costs more; needs a `subagent` tool). Recommend one, in one sentence: how coupled the tasks are, how many there are, and what a mistake would cost. On approval, set the plan's `Status: approved` and commit it.
