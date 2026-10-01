---
name: requesting-code-review
description: Use when a task, feature or bugfix is implemented and verified, before merging or opening a PR, or when a user asks for a review of changes
---

# Requesting code review

A review in a fresh context catches what the author's context hides. The reviewer gets precisely crafted inputs, never your session history.

## When

- **Required:** after finishing a plan (whole branch), before merge or PR, and after each task in subagent-per-task execution.
- **Useful:** when stuck, before a risky refactor, and after a tricky bug fix.

## How

1. **Fix the range:** `RULES_BASE=$(git merge-base origin/<base-branch> HEAD)` (`<base-branch>` without a remote), `BASE=$RULES_BASE` and `HEAD=$(git rev-parse HEAD)`. The range must start on the remote base: the gate counts a review only when its range reaches it, directly or through earlier rounds. For a repeat round after fixes, `BASE` is the newest reviewed commit (the previous round's HEAD): only the new commits are reviewed, and the reviewer reads that round's findings from the gate's store itself. A round can't skip a newer reviewed commit, and a rewritten history means a full review from the merge-base. Commit or stash first so the review is of a known state. Include untracked files you created.
2. **Fill `reviewer-prompt.md`** with: what was built, the requirements (the task file path or the request, numbered criteria; once the task file is removed, its path at its last commit, `git show <sha>:docs/tasks/…`), the range (`{RULES_BASE}`, `{BASE}`, `{HEAD}`), the verification commands, the plan's Review focus if it has one, and `{SKILL_DIR}` = this skill's absolute directory. Don't paste earlier findings: the reviewer runs review-log.
3. **Dispatch:**
   - **With a `subagent` tool:** use the `reviewer` agent (pi-subagents) with the filled prompt (the review gate counts only `reviewer` runs), on the most capable model available. For risk-floor changes (money, auth, permissions, secrets, schema, CI or release config, deploy config), a second `reviewer` run in parallel whose Review focus is security (security-review's method) is required. For other large diffs, 2–3 reviewers with different focuses (correctness, security, tests) are optional. Merge their findings: one finding per root cause, and where two reviewers flag the same `file:line`, keep the higher severity. The merged verdict is the worst one.
   - **Without one:** do the review yourself in a *separate pass*. Re-read the requirements, then walk the diff file by file with the checklist. Don't rely on your memory of writing it.
4. **Act on the findings** with receiving-code-review:
   - fix Critical before anything else;
   - fix Important before proceeding;
   - log Minor;
   - push back with evidence when the reviewer is wrong.
   Re-review the fixes (scoped to the new range).

## Review gate

Before a PR/MR, a merge into the base branch, a push to it or a push to the branch of a PR you opened, the guard asks the user unless the reviewer's verdict is `Yes` for exactly the commit being landed, and its range reaches the remote base (directly or through earlier rounds). Any change after the review needs a new one. The guard records the verdict and the report from the `reviewer` run's own lines; you never write them. Run the reviewer in the foreground and land in a command of its own. The rules (why any change needs a new review, how verdicts combine, the waiver) are in `references/review-gate.md`.

## Reviewer rules (they are in the prompt too)

- Read-only: never modify the working tree or move HEAD.
- Every finding gives `file:line`, the trigger conditions, the consequence, the evidence, and the fix. Missing information becomes a **Question** that says what the answer would establish.
- A failing check is compared against the base revision before it is blamed on the change. No required check is waived silently.
- Separate **Confirmed** (reproduced or visible in code) from **Assumptions** (worth checking, not proven).
- Map every numbered criterion to done / not done / not visible in the code.
- Flag scope creep: changes the task didn't ask for.
- Severity reflects the effect on a real user, not the reviewer's taste. A visible performance regression is Critical. The fixed severities at the top of the checklist (secrets, placeholder code, suppressed errors, weakened tests…) are not negotiable.
- If there are no findings, say so, with the scope covered and its limits. An AI review informs human approval; it never replaces it.

The checklist is in `references/checklist.md`. Load the sections that match the diff (payments, UI, DB, and so on). The platform and domain skills (web-frontend, mobile-development, desktop-development, payments-and-money, pos-systems, security-review) add their own review points.
