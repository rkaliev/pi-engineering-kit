---
name: git-workflow
description: Use when starting work that needs an isolated branch or worktree, when committing, and when implementation is verified and the branch must be merged, pushed as a PR, kept or discarded
---

# Git workflow

## Before starting: isolate

1. **Detect the current state.**
   - Isolation: `git rev-parse --git-dir` differs from `--git-common-dir` means you are already in a worktree.
   - Branch: `git branch --show-current`.
   - Uncommitted changes: `git status --porcelain`.
2. **On `main`/`master`**, or with someone else's uncommitted changes: create a branch, or ask first. Never stash or reset work you didn't create.
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
- Resolve conflicts by rebasing onto the base branch, not by merging it into a PR branch, unless the repo prefers merging.

## Finishing a branch

1. Run verification-before-completion on the final state. Don't offer options while tests are red.
2. Determine the base branch (`git merge-base HEAD main`, or ask).
3. Offer exactly these options:
   1. **Merge locally** into the base branch, re-run the tests on the merged result, delete the branch.
   2. **Push and open a PR.** One concern per PR; if the diff is far over about 1000 meaningful lines, suggest splitting it.
      The PR body: one or two sentences on what changed and why; at most seven bullets for the decisions a reviewer needs; `Out of scope:` bullets for what was deliberately left out; how it was verified (the commands run); risks and rollback; screenshots for UI; links to the spec and plan, and the issue it closes (`Closes …`) last.
   3. **Keep the branch** as is for later.
   4. **Discard.** Require the user to type `discard`. Show what will be lost (commits, files) first.
4. Remove only worktrees you created, and only after merge or discard. Never delete a worktree or branch with unpushed work that you didn't create.

Pushing, opening PRs, and merging are outward-facing: do them only on the user's choice.
