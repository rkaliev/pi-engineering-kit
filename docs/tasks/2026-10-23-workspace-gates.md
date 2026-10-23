# Verify and review gates work in a folder of several git repositories

Status: design approved (2026-10-23)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: b7be81ddb2034b2b1c07a361be172ca3bf4d825e
Links: None

<details><summary>Original request</summary>

«что осталось из важного доделать?» → item 1 of the answer (the verify gate re-fires on a redirect to an unexpanded variable path; the review gate records no verdict) → «давай продолжим 1». Choices made in the conversation: «Поддержать workspace»; «Да, пересматриваем» (revisits the 0.16.0 rule that reverted multi-repo support); files outside the repositories: «Отпечаток файлов»; split into three tasks: «Да, начинаем с 1». Design: «да, давай».

</details>

## Intent

Someone who starts pi in a folder that is not a git repository but holds several (a polyrepo workspace: services side by side, frontend next to backend) gets the same verify and review gates as inside one repository, instead of gates that silently weaken.

## Context

The kit treats the session folder as one git repository. In a non-git folder of repositories `treeFingerprint` returns nothing, so the verify gate guesses written files from command text and counts `> $S/red.log` with an unknown `S` as the project file `$S/red.log` (reproduced: `cd src && … > $S/red.log`, `S=$(mktemp -d); … > $S/x`, a loop, a variable from an earlier call); it also misses changes made by `subagent` calls (their text is empty). `recordVerdict` runs `git rev-parse` in that folder and fails, so no verdict is ever recorded, and `cd <repo> && gh pr create` asks for want of a verdict that can't exist.

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | `projectRepos` reports `repo` inside git, `workspace` with the first-level git repositories (sorted, ignored folders and nested levels left out, at most 32) for a non-git folder that holds some, and `none` otherwise | unit: tests/repos.test.ts |
| 2 | In a workspace, a shell call that changes a file in any repository, commits in one, or changes a file outside the repositories is marked as an edit with its workspace-relative path; a call that changes nothing marks nothing, whatever its redirect text (`> $S/red.log` with unknown `S`) | unit: tests/worktree.test.ts; extension: tests/extensions.test.ts (tool_call → tool_result in a temp workspace) |
| 3 | Changes made by a `subagent` call in a workspace are marked when it returns | extension: tests/extensions.test.ts |
| 4 | Over 5000 entries or after a git failure, only the affected part falls back: a repository to text targets inside it, files outside the repositories to text targets outside them | unit: tests/worktree.test.ts |
| 5 | A `Tree` without the new field (a single repository's) still compares as before | unit: tests/worktree.test.ts |
| 6 | In a workspace, a reviewer's verdict is recorded in the store of every repository that has the reviewed commit; a SHA in none gives an error naming the repositories; the Inconclusive fallback lands on each repository's HEAD | unit: tests/reviews.test.ts; extension: `subagent` tool_result test in a temp workspace |
| 7 | `cd <repo> && gh pr create` and `git -C <repo> push` in a workspace pass with a `Yes` for that repository's HEAD and ask without one; same-named PR branches in two repositories don't affect each other | unit: tests/reviews.test.ts |
| 8 | `scripts/review-log.ts <sha>` run from the workspace folder finds the repository that has the commit | e2e: tests/extensions.test.ts (review-log block) |
| 9 | Inside a single repository every gate behaves as in 0.33.0 | the full existing suite stays green |
| 10 | Live in a workspace: a review records its verdict, and a run with a redirect to an unknown variable path doesn't re-fire the verify gate | manual: one session in a workspace after the change — needs a real pi session, agreed 2026-10-23 |

## Scope

**In scope:**
- shared module `extensions/lib/repos.ts` with `projectRepos`;
- the verify gate's fingerprint, comparison and fallback in a workspace (`extensions/lib/worktree.ts`, `extensions/verify.ts`);
- recording verdicts, checking landings and PR branch tracking per repository (`extensions/lib/reviews.ts`, `extensions/guard.ts`), and `scripts/review-log.ts`;
- README, docs/ARCHITECTURE.md, docs/ARCHITECTURE.ru.md, skills/requesting-code-review/references/review-gate.md, CHANGELOG 0.34.0.

**Out of scope:**
- the guard in a workspace (CI and protected paths in child repositories, own-branch push, the task-file leak guard, the approval gate): follow-up 1;
- the token ledger and kit-init command detection in a workspace: follow-up 2;
- repositories deeper than the first level, git submodules as separate repositories;

## Decisions

1. Support polyrepo workspaces as a general feature (user, 2026-10-23). This revisits the 0.16.0 rule ("kits change only for what serves any user"): a non-git parent of repositories is a common layout, and without support its gates weaken silently.
2. Files outside the repositories are tracked by a size-and-mtime walk, with text targets only past the limit (user, 2026-10-23).
3. Three tasks: this one, then the guard, then the ledger and kit-init (user, 2026-10-23).
4. Only first-level repositories, at most 32, found by a `.git` entry without running git; more than 32 is treated as `none`. **assumed**, shown in the design and approved.
5. A verdict goes to every repository that has the commit: two clones of one history share the commit, so the verdict holds in both. The Inconclusive fallback goes to every repository's HEAD (fail-closed). Shown in the design and approved.
6. `extensions/lib/repos.ts`, `extensions/lib/worktree.ts` and `extensions/lib/reviews.ts` stay byte-identical with the other edition's copies.
7. Release as 0.34.0.

## Design

**`extensions/lib/repos.ts`.** `projectRepos(projectDir, ignore): { kind: "repo" | "workspace" | "none"; repos: string[] }`. `repo` when `projectDir` is inside a git working tree; otherwise `workspace` when its direct subfolders that hold a `.git` entry (folder or file), minus ignored ones, number 1..32 (`repos` are their names, sorted); otherwise `none`. No git call for discovery.

**Fingerprint.** `Tree` gains `heads?: Record<string, string>` (repository → HEAD) and `outside?: boolean` (files outside the repositories walked). `treeFingerprint` in a workspace merges each repository's `git status` entries with the repository name prefixed, records each HEAD, and adds every file outside the repositories (not ignored, not under `.git`) with its size and mtime. `changedPaths` compares entries as today and, per repository whose HEAD moved, adds the files its commits touched. A repository over 5000 entries or failing git is left out of the tree and listed as such; the shell fallback then reads text targets inside it. A walk over 5000 files or over its time budget drops `outside`, and text targets outside the repositories count again. Without `heads` a saved tree reads as a single repository's.

**Extensions.** `track` in extensions/verify.ts takes the fingerprint and the fallback per part, as above; a `subagent` call is compared with its own snapshot. edit/write marking is unchanged.

**Reviews.** `recordVerdict` in a workspace resolves the SHA (and BASE) in each repository and writes the record into `reviewsDir(<repository>)` of each that has it; none → `Reviewed HEAD … is not a commit in any repository here (<names>)`. The guard's `subagent` tool_result fallback records Inconclusive on each repository's HEAD. `uncovered`, `notePr`, `settlePr` and `openPrBranches` read and write the store of the landing's repository (`where`) instead of the session folder's; in a single repository both resolve to the same git common dir. `review-log.ts` resolves the SHA in the current folder, else in each workspace repository.

**Errors.** Warnings name the repository. A failure in one repository never disables another.

## Rollout

Minor release 0.34.0. Review stores keep working: the stores were already keyed by git common dir. Rollback: install 0.33.0.

## Risks and open questions

- A large workspace makes each shell call slower (N × `git status` plus the walk) → the 2 s snapshot budget and the 5000-entry limits still apply; measure on a workspace with two repositories in the plan.
- An Inconclusive fallback on every HEAD can hold back a parallel reviewer's Yes in another repository → accepted as fail-closed; rare (needs a malformed report).

## Follow-ups

- 1. The guard in a workspace: CI and protected paths in child repositories ask, own-branch push in a child repository, the task-file leak guard and the approval gate per repository. Builds on `projectRepos`. Next, since it closes a protection gap.
- 2. The token ledger and kit-init command detection in a workspace. Builds on `projectRepos`.

## Plan

None yet

## Progress

None yet
