---
name: verification-before-completion
description: Use when about to claim work is complete, fixed or passing, before committing, pushing, opening a PR or handing a task back
---

# Verification before completion

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the check in this session after your last change, you can't claim it passes.

## The gate

1. **Identify**: which command proves the claim? Use the project's commands (`run_verification`, AGENTS.md, `.pi/verify.json`, CI config).
2. **Run** the full command, fresh. Don't use a filtered subset, and don't pipe it into `tail` in a way that hides the exit code.
3. **Read** the output: exit code, count of failures, warnings.
4. **Verify**: does the output confirm the claim? If not, report the actual state with the evidence.
5. **Only then claim it**, and quote the evidence ("`npm test`: 142 passed, 0 failed").

| Claim | Requires | Not enough |
|---|---|---|
| Tests pass | Full test run, 0 failures | An earlier run, "should pass", one file |
| Builds | Build command exits 0 | Lint or typecheck passing |
| Bug fixed | The original symptom no longer reproduces, plus a regression test | "Code changed" |
| Requirement met | Checked against each numbered criterion | "Tests are green" |
| Subagent finished | You inspected the diff and ran the checks | Its "DONE" report |
| Works on the device or UI | You exercised it (emulator, browser, screenshot) | Unit tests alone |

## Report honestly

The final message lists:
- **Changed:** files, one line each.
- **Checks run:** command → result, only those actually run in this session.
- **Criteria:** each requirement or criterion → how it was verified (test name, or manual step).
- **Not verified:** anything skipped or impossible here, and why. Examples: no emulator, no credentials, a production-only integration.
- **State:** local only / committed / pushed / CI green / deployed. Never merge these together.

A failing or skipped check goes in the report by name. Silence about it is misreporting.

## Red flags

"Should work", "probably", "looks right". Saying "Done!" or "Perfect!" before running anything. Committing without a run. Trusting a subagent's or tool's success message. "It's a tiny change." All of these mean: run the gate.
