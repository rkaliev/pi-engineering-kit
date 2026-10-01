---
description: Review the current changes against a task, read-only
argument-hint: "[path to task] [base ref]"
---
Task: ${1:-the task described in this conversation}
Base: ${2:-the merge-base with the default branch}
If the task is a path to a file, read the file.

Do not change code; this is a review only. Use the requesting-code-review skill. With a `subagent` tool, dispatch the reviewer in the foreground with the filled `reviewer-prompt.md`: the review gate records its verdict. Without one, review in a separate pass yourself; the gate will then ask the user before a PR or merge.
1. Look at `git status` and `git diff` against the base. Read new untracked files in full.
2. Map each criterion to done / not done / not visible from the code.
3. Check the project's own rules: AGENTS.md and the decision records (`docs/decisions/`) the diff touches or cites. A broken rule is Important.
4. Check edge cases: empty input, whitespace, case, combined conditions, empty results, errors, concurrency. Load the matching domain skill for money, POS, security or platform code.
5. Find anything the task did not ask for.

Split the answer into **Confirmed** (reproduced, or visible in the code, with file:line) and **Assumptions** (worth checking, not confirmed), then end with the verdict lines `Reviewed HEAD: <sha>` and `Ready to merge: Yes / No / With fixes / Inconclusive`.
