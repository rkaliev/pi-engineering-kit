---
name: receiving-code-review
description: Use when receiving code review feedback from a person, a reviewer agent or a PR, or when the user corrects your work, before implementing any suggestion, especially if it seems unclear or technically questionable
---

# Receiving code review

Review feedback is a set of technical claims to verify, not orders to obey or praise to perform. Technical correctness matters more than social comfort.

## Process

1. **Read** all the feedback before reacting.
2. **Restate** each item as a concrete requirement. **If any item is unclear, ask about it before implementing anything.** Items are often related, and partial understanding leads to the wrong fix.
3. **Verify** each claim against the code: reproduce it, grep for real usage, check the pinned library version and the target platforms.
4. **Evaluate**: is it correct for *this* codebase? Does it break existing behavior? Is there a reason for the current implementation (compatibility, a legal requirement, a device quirk)? Does it contradict an earlier decision by the user?
5. **Respond** with a technical acknowledgment or with reasoned pushback.
6. **Implement** one item at a time, in this order: blocking issues (breakage, security, money), simple fixes, complex fixes. Test each one and check for regressions.
7. **Account for every item.** Feedback comes in three places: inline threads, the review's own body (where reviewers and bots often put nitpicks and findings outside the diff) and top-level comments. Each item ends either fixed (with where) or answered (with why not). None is skipped silently. Answer an inline finding in its thread, and the items of a review body in one reply that numbers them in the review's order. "Will fix later" doesn't close an item: fix it now, or decline it here and add it to the task file's Follow-ups. Nitpicks on an approval still count. Don't call the review resolved while a blocking item is open or before a re-review has closed it, and don't reply again to a thread whose latest message is already yours.
8. **Report coverage**, one line per item: `fixed (<sha>, file:line)`, `replied (<why>)` or `failed (<why>)`. A PR is ready only when every item is closed, no changes-requested verdict stands and the required checks have all reported on its current head. Green checks alone don't make it ready.

## Pushback is part of the job

Push back, with evidence, when a suggestion:
- breaks behavior;
- lacks context;
- is YAGNI (for example "implement it properly" for an endpoint nothing calls; grep first);
- is wrong for this stack or version;
- conflicts with the user's architecture decisions.

Declining a comment needs a concrete reason why the current approach is correct: a test, a spec line, a constraint. "It works" or "I checked" alone is not a reason.

If a conflict is architectural, involve the user. If you can't verify a claim, say what you'd need.

## Make it stick

When a finding or a correction from the user shows a gap that will recur (not a one-off slip), propose closing it once, at the strongest level that fits:
1. a mechanical check: a lint rule, a type, a test, a guard rule or a CI job;
2. a rule in the project's agent manifest (CLAUDE.md, AGENTS.md) or a path-scoped rule;
3. a gap in the kit itself: a follow-up to change the skill with writing-skills (RED, then GREEN).

Propose it with the evidence; the user decides. Don't add a rule for what a check already enforces. Add each open proposal to the task file's Follow-ups when you make it; once the task file is gone, list it in the final report to the user.

## Tone

- No performative agreement: no "You're absolutely right!", "Great catch!" or thanks.
- State the fix instead: "Fixed: `parseAmount` now rejects negative values (payment.ts:42), test added."
- If your pushback turns out wrong: "Checked: you're correct, X does Y. Fixing." Then move on.
- While a blocking point still stands, even in part, lead with it: "Still blocking: <what stands>; <what you accept>." Open with "Agreed" or "You're right" only in a reply that names the fix.
- Fixes pushed to a reviewed PR are a new commit: re-review the new range (requesting-code-review) before you report the PR ready again.
