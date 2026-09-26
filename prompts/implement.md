---
description: Implement a task or plan with tests and verified results
argument-hint: "<path to task or plan>"
---
Task: $@
If it is a path to a file, read the file first.

1. Read the task and its criteria, and the files it touches. If it is a plan, use the executing-plans skill instead of the steps below.
2. Show a short plan, 7 lines at most: files to change, and how each criterion will be checked. If the work turns out not to be bounded, stop and use brainstorming.
3. Implement with the test-driven-development skill. Keep the diff minimal and do no side refactoring.
4. Update the docs the change made stale (writing-documentation, "When code changes") in the same change.
5. Run the project's checks (run_verification, or the commands in AGENTS.md). If something fails, fix the cause and run them again.
6. Finish with the verification-before-completion report: changed files, commands run with results, each criterion and how it was verified, docs updated, and what remains unverified.

Report only checks that actually ran in this session.
