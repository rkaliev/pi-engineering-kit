---
name: receiving-code-review
description: Use when receiving code review feedback from a person, a reviewer agent or a PR, before implementing any suggestion, especially if it seems unclear or technically questionable
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
7. **Account for every item.** Each comment ends either fixed (with where) or answered (with why not). None is skipped silently. Don't call the review resolved while a blocking item is open, and don't reply again to a thread whose latest message is already yours.

## Pushback is part of the job

Push back, with evidence, when a suggestion:
- breaks behavior;
- lacks context;
- is YAGNI (for example "implement it properly" for an endpoint nothing calls; grep first);
- is wrong for this stack or version;
- conflicts with the user's architecture decisions.

Declining a comment needs a concrete reason why the current approach is correct: a test, a spec line, a constraint. "It works" or "I checked" alone is not a reason.

If a conflict is architectural, involve the user. If you can't verify a claim, say what you'd need.

## Tone

- No performative agreement: no "You're absolutely right!", "Great catch!" or thanks.
- State the fix instead: "Fixed: `parseAmount` now rejects negative values (payment.ts:42), test added."
- If your pushback turns out wrong: "Checked: you're correct, X does Y. Fixing." Then move on.
- When replying on a PR, answer in the inline thread, not in a new top-level comment.
