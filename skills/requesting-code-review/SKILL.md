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

1. **Fix the range:** `BASE=$(git merge-base <base-branch> HEAD)` (or the task's BASE) and `HEAD=$(git rev-parse HEAD)`. For a repeat round after fixes, pass the previous round's HEAD and its open findings, so only the new commits are reviewed and every earlier finding is re-checked (a rewritten history means a full review). Commit or stash first so the review is of a known state. Include untracked files you created.
2. **Fill `reviewer-prompt.md`** with: what was built, the requirements (the task file path or the request, numbered criteria), the range, the verification commands, the plan's Review focus if it has one, and `{SKILL_DIR}` = this skill's absolute directory.
3. **Dispatch:**
   - **With a `subagent` tool:** use the `reviewer` agent (pi-subagents) or a general agent with the filled prompt, on the most capable model available. For large or high-risk diffs (payments, auth, migrations), you may run 2–3 reviewers in parallel with different focus (correctness, security, tests). Merge their findings: one finding per root cause, and where two reviewers flag the same `file:line`, keep the higher severity. The merged verdict is the worst one.
   - **Without one:** do the review yourself in a *separate pass*. Re-read the requirements, then walk the diff file by file with the checklist. Don't rely on your memory of writing it.
4. **Act on the findings** with receiving-code-review:
   - fix Critical before anything else;
   - fix Important before proceeding;
   - log Minor;
   - push back with evidence when the reviewer is wrong.
   Re-review the fixes (scoped to the new range).

## Review gate

Before opening or merging a PR/MR, merging into the base branch or pushing to it, the guard asks the user unless the reviewer's last verdict is `Yes` for the commit being landed. The guard records the verdict from a `subagent` result that carries the reviewer's `Reviewed HEAD:` and `Ready to merge:` lines; you never write it yourself. Run the reviewer in the foreground, so its report comes back as that result.

- A commit after the review that touches more than task files or ignored paths (docs by default) needs a new review. Deleting the task files after the final review doesn't.
- `With fixes`, `No` and `Inconclusive` don't pass: fix, then re-review the new range.
- A branch that only changes ignored paths needs no review. Only the user can waive the gate: by confirming, or with `"reviewGate": false` in `.pi/guard.json` (trusted projects only; the guard asks before that file is edited). A self-review in a separate pass does not satisfy the gate, so without a `subagent` tool the user decides at the prompt.

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
