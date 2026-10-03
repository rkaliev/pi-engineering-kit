---
name: git-workflow
description: Use when starting work that needs an isolated branch or worktree, when committing, and when implementation is verified and the branch must be merged, pushed as a PR, kept or discarded
---

# Git workflow

## Before starting: isolate

1. **Detect the current state.** Fetch first (`git fetch`), so that the base is current.
   - Isolation: `git rev-parse --git-dir` differs from `--git-common-dir` means you are already in a worktree.
   - Branch: `git branch --show-current`.
   - Uncommitted changes: `git status --porcelain`.
2. **On `main`/`master`**, on a branch that is already merged into the base, or with someone else's uncommitted changes: create a branch from the fresh base, or ask first. Never stash or reset work you didn't create.
3. **Parallel work** needs a worktree. Use the project's convention, else `.worktrees/<branch>`, and confirm the path is ignored first (`git check-ignore -q .worktrees`; if it isn't, add it to `.gitignore` in its own commit).
   ```bash
   git worktree add .worktrees/<branch> -b <branch>
   ```
4. **Set up and record a baseline:** install with the lockfile (`npm ci`, `pnpm i --frozen-lockfile`…), then run the verification commands. Report existing failures before you change anything.

Branch names follow the repo convention. Default: `<type>/<short-kebab-description>`, for example `feat/refund-api`.

## Commits

- Commit small, coherent steps, each green. Follow the repo's convention, or Conventional Commits by default (`feat(scope): add refund endpoint`). The subject says *what* changed; the body says *why*, when it isn't obvious.
- Stage specific paths (`git add path/…`), never secrets, build output or unrelated changes. Review `git diff --staged` before committing.
- Respect hooks. **Never** use `--no-verify`, `-n`, or `commit --amend` on pushed commits. Never rewrite shared history: no `push --force`. On your own branch after the user agrees, use `--force-with-lease`.
- Follow the project's rules on trailers (some forbid AI co-author lines) and on issue IDs in messages.
- If the repo has a commit linter (commitlint, a `commit-msg` hook), follow its config and fix the message rather than bypass it. When one change becomes several commits, order them so each one is green: build and config, then code, then tests, then docs.
- Resolve conflicts by rebasing onto the base branch, not by merging it into a PR branch, unless the repo prefers merging. A rebase, like any change, makes the last review stale: rebase before the final review, or review again after it. Rebasing your own pushed branch uses `--force-with-lease=<branch>:<sha before the rebase>`, after the user agrees.

## Finishing a branch

1. Run verification-before-completion on the final state. Don't offer options while tests are red. The task file is already deleted (executing-plans, Finish); the guard refuses a PR or a merge into the base while it exists.
2. Determine the base branch (`git merge-base HEAD main`, or ask).
3. After a `Yes` on HEAD, do option 2 without asking, unless the user asked for another. The other options wait for the user's choice:
   1. **Merge locally** into the base branch with `--ff-only` after the rebase (a merge commit is a new, unreviewed commit: review it before pushing the base), re-run the tests on the merged result, delete the branch.
   2. **Push and open a PR** (the default). One concern per PR; if the diff is far over about 1000 meaningful lines, suggest splitting it.
      The PR body: one or two sentences on what changed and why; at most seven bullets for the decisions a reviewer needs; `Out of scope:` bullets for what was deliberately left out; how it was verified (the commands run, and how each new test was seen failing first, as test-standard defines it); risks and rollback; screenshots for UI; a link to the task file at the last commit that had it (`blob/<sha>/docs/tasks/…`), and the issue it closes (`Closes …`) last.
   3. **Keep the branch** as is for later.
   4. **Discard.** Require the user to type `discard`. Show what will be lost (commits, files) first.
4. Remove only worktrees you created, and only after merge or discard. Never delete a worktree or branch with unpushed work that you didn't create.

Push the work branch and open the PR yourself once the review covers HEAD; merging, keeping, discarding, pushing to the base and rewriting pushed history stay the user's choice.

## After a push

When the user wants CI followed:
- Watch with the host's own tool (`gh pr checks --watch`, `gh run watch`, `glab ci status --live`), in the background, rather than a hand-written polling loop.
- Every check in the required gate counts, not only the ones you ran locally.
- A failing check gets a root cause first (systematic-debugging), then a fix, commit and push. At most two attempts per check; then stop and ask. Each fix pushed to an open PR moves its head past the reviewed commit: run requesting-code-review on the new head before you call the PR ready.
- A "changes requested" review goes through receiving-code-review; don't keep pushing around it.
- Never merge yourself, and never re-run a red check hoping it passes.
