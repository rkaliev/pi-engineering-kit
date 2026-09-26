---
name: dispatching-parallel-agents
description: Use when facing two or more independent tasks - separate failures, research questions, audits or reviews - that share no state and have no ordering dependency
---

# Dispatching parallel agents

Independent problems investigated one after another waste time and fill one context. Give each problem to a focused agent at the same time, then integrate the results yourself.

**Requires a `subagent` tool** (pi-subagents: call `subagents_enable` first if only it is visible). Without one, handle the domains one after another in this session, with a short summary after each.

## When it fits

- Several failures with different root causes (different subsystems or test files).
- Research or scouting across unrelated areas.
- Multi-angle reviews: correctness, security, tests, performance.

## When it doesn't

- The failures may share a cause. Investigate once first (systematic-debugging).
- The tasks edit the same files or shared state. Parallel writers conflict.
- You don't yet understand the problem well enough to split it.

## Process

1. **Group by independent domain.** Write down why each group can't affect the others.
2. **Write one focused prompt per agent**, self-contained, since it has none of your context:
   - **Scope:** exact files, tests, or the question.
   - **Goal:** what "done" means, with the verification command.
   - **Constraints:** read-only, or which files it may change; don't touch anything else.
   - **Output:** root cause, changes as a file list, commands run with results, open questions.
3. **Dispatch all agents in one call** (the parallel `tasks` mode), using the matching agent: `scout` for recon, `reviewer` for review, `worker` for edits. Writers must have disjoint file sets. Otherwise use separate worktrees or run them sequentially.
4. **Integrate:**
   - read every result;
   - check the actual diffs (don't trust the reports);
   - look for conflicting edits;
   - run the full verification suite on the combined state.

Bad prompt: "Fix the failing tests." Good prompt: "Fix the 3 failures in `src/payments/refund.test.ts` (listed below). The cause is likely timing. Change only `src/payments/refund*`. Do not weaken assertions. Report the root cause and the `npm test -- refund` result."
