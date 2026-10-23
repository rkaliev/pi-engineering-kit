# Verify and review gates work in a folder of several git repositories

Status: plan approved (2026-10-23)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: 51faece0b31d9c6c96563a7bb3ac2decc781c214
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

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** the verify and review gates see every repository of a non-git folder of git repositories, as they see one repository.
**Architecture:** a new shared `extensions/lib/repos.ts` names the project's repositories; `extensions/lib/worktree.ts` fingerprints each of them plus a walk of the files outside them, and a shared `callChanges` decides what a call changed; `extensions/lib/reviews.ts` records a verdict in every repository that has the commit and checks a landing against its own repository's store. `extensions/verify.ts` only switches to `callChanges`.
**Stack / constraints:** Node ≥22.18 running `.ts` natively, `node:test`, no new dependencies. `extensions/lib/repos.ts`, `extensions/lib/worktree.ts`, `extensions/lib/reviews.ts` stay byte-identical with the other edition's copies (`cmp` must pass); imports stay relative (`./commands.ts`). Everything written in English. Commits: Conventional Commits, repo-local identity, no trailers. Values: at most 32 repositories (`MAX_REPOS`), 5000 entries per part (`MAX_ENTRIES`), workspace fingerprint budget 2000 ms (`WORKSPACE_BUDGET_MS`), git timeout per call `min(3000, time left)`.
**Verification:** `npm run typecheck`, `npm test`.

Ruling: the two defects' red reproductions open Task 3 (verify) and Task 4 (review): they need `projectRepos` (Task 1) to set up a workspace at all, and every commit stays green.

### Review focus
1. A repository whose `git status` times out or exceeds 5000 entries: only it becomes blind, and text targets inside it still count (Task 2, Task 3).
2. Two repositories that are clones of one history: a verdict lands in both, and a branch named the same in both doesn't share PR state (Task 4).
3. A tree without `heads`/`blind` (a single repository's) compares exactly as in 0.33.0 (the existing worktree and extension tests, run in Task 3).
4. A repository folder removed between two fingerprints: its listed files count as changed, nothing throws (Task 2).
5. A `.git` *file* (a worktree checkout) at the first level counts as a repository; a symlinked folder is neither a repository nor walked (Task 1, Task 2).

### Post-implementation
- README.md, the verify gate and review gate paragraphs: a paragraph on folders of repositories (what is fingerprinted, where verdicts go, the 32 / 5000 / 2 s limits).
- docs/ARCHITECTURE.md and docs/ARCHITECTURE.ru.md: the guard and verify rows (the "outside git" note, `subagent` calls), the reviews path note, "How it's verified".
- skills/requesting-code-review/references/review-gate.md: records per repository, found from a folder of repositories too.
- CHANGELOG.md `## 0.34.0`; version 0.34.0 in package.json (`node .github/release.ts check` passes).
- The topic chapter is the README's verify and review gate paragraphs (this repo has no `docs/NN-*` chapters). No decision record: the decisions go to CHANGELOG and ARCHITECTURE.

### Files
- Create `extensions/lib/repos.ts`: which repositories the project is (`projectRepos`, `repoOf`).
- Modify `extensions/lib/worktree.ts`: workspace fingerprint, `changedPaths` per repository, `callChanges`.
- Modify `extensions/verify.ts`: `track` uses `callChanges`.
- Modify `extensions/lib/reviews.ts`: `commitRepos`, workspace `recordVerdict`, landing store through `repoOf`, PR tracking per repository.
- Modify `scripts/review-log.ts`: finds the commit's repository.
- Tests: create `tests/repos.test.ts`; modify `tests/worktree.test.ts`, `tests/extensions.test.ts`, `tests/reviews.test.ts`.

### Task 1: repositories of a project

**Files:** Create `extensions/lib/repos.ts` · Test `tests/repos.test.ts`
**Interfaces:** Produces `projectRepos(projectDir: string, ignore?: string[]): { kind: "repo" | "workspace" | "none"; repos: string[] }`, `repoOf(projectDir: string, path: string): string`, `MAX_REPOS = 32`

- [ ] Write failing tests against a stub that returns `{ kind: "none", repos: [] }` and `projectDir`:
  - `a folder inside git is one repository` → `{ kind: "repo", repos: [""] }`, also from a subfolder;
  - `a non-git folder of repositories is a workspace` → temp dir with `b/.git` (folder), `a/.git` (file `gitdir: …`), `plain/`, `ignored/.git` with ignore `["ignored/**"]`, `deep/x/.git`, a symlink `link → b` → `{ kind: "workspace", repos: ["a", "b"] }`;
  - `no repositories, or more than 32, is none` → an empty dir and a dir of 33 repositories give `{ kind: "none", repos: [] }`;
  - `repoOf names the repository a path is in` → `repoOf(ws, ws/b/src/x)` = `ws/b`; `repoOf(ws, ws/plain/x)` and `repoOf(ws, /elsewhere)` = `ws`; inside a repo it returns `projectDir`.
- [ ] Run `node --test tests/repos.test.ts` → expect FAIL on the `kind` and `repos` assertions
- [ ] Implement: `repo` when `git rev-parse --is-inside-work-tree` succeeds (one call, 3 s timeout); else the direct subfolders (`readdirSync` with file types, symlinks excluded) holding a `.git` entry, minus those a glob ignores (`isIgnored(name, ignore)`, or a `<stem>/**` glob whose stem is `name`), sorted; 1..32 of them → `workspace`. `repoOf` returns `join(projectDir, r)` for the workspace repository containing `path`, else `projectDir`.
- [ ] Run `node --test tests/repos.test.ts` → PASS, then `npm test`
- [ ] Commit `feat(repos): name the repositories of a project folder`

### Task 2: workspace fingerprint

**Files:** Modify `extensions/lib/worktree.ts` · Test `tests/worktree.test.ts`
**Interfaces:** Consumes `projectRepos` · `Tree` gains `heads?: Record<string, string>` (repository → HEAD, `""` before its first commit) and `blind?: string[]` (parts not fingerprinted: a repository, or `""` for the files outside the repositories) · `treeFingerprint(projectDir, ignore, why = {}, limits: { deadline?: number; maxEntries?: number } = {})`; `changedPaths` keeps its signature

- [ ] Write failing tests in a temp workspace with repositories `a`, `b` (one commit each) and a loose file `notes/x.js`:
  - `a workspace fingerprint lists each repository's changes under its folder` → edit `a/f.ts`, add `b/n.ts` → `changedPaths` = `["a/f.ts", "b/n.ts"]`;
  - `a commit in one repository counts its files` → commit `b/c.ts` between fingerprints → `["b/c.ts"]`, `heads.b` differs;
  - `a file outside the repositories counts, an ignored one doesn't` → edit `notes/x.js` and `docs/y.md` → `["notes/x.js"]`;
  - `a repository over the limit is blind, not the workspace` → `limits.maxEntries = 2` with three new files in `a` → `blind` = `["a"]`, a change in `b` still listed;
  - `an expired deadline leaves every part blind` → `limits.deadline = Date.now() - 1` → `blind` = `["", "a", "b"]`, `files` = `{}`;
  - `a removed repository folder counts its listed files` → remove `a/` after a fingerprint with `a/f.ts` dirty → `a/f.ts` listed, no throw.
- [ ] Run `node --test tests/worktree.test.ts` → expect FAIL: `treeFingerprint` returns `undefined` for the workspace
- [ ] Implement `workspaceFingerprint` behind `treeFingerprint` (kind `repo` → today's code, unchanged; `none` → `undefined`): per repository today's status logic with paths prefixed `<repo>/` and its HEAD into `heads`; then a walk of the project skipping repository folders, `.git`, symlinks and ignored paths (a directory is pruned when a `<stem>/**` glob's stem matches it), each file by `identity()`. A part over `maxEntries` (default `MAX_ENTRIES`), failing git, or reached after the deadline (default now + `WORKSPACE_BUDGET_MS`) goes into `blind` and contributes no entries; each git call's timeout is `min(GIT_TIMEOUT_MS, time left)`. `changedPaths`: when both trees have `heads`, the HEAD diff runs per repository whose HEAD moved, in `join(projectDir, repo)`, results prefixed; without `heads`, as today.
- [ ] Measure `treeFingerprint` on the real workspace root, 5 runs; record the median in Progress (risk "a large workspace").
- [ ] Run `node --test tests/worktree.test.ts` → PASS, then `npm test`
- [ ] Commit `feat(verify): fingerprint every repository of a workspace and the files outside them`

### Task 3: the verify gate counts what a workspace call changed

**Files:** Modify `extensions/lib/worktree.ts`, `extensions/verify.ts` · Test `tests/worktree.test.ts`, `tests/extensions.test.ts`
**Interfaces:** Produces `callChanges(before: Tree | undefined, now: Tree | undefined, projectDir: string, after?: { command: string; cwd: string; powershell?: boolean }): string[]` (ignore filtering stays with the caller)

- [ ] Red reproduction in `tests/extensions.test.ts` with a helper `workspaceProject()` (temp dir, repositories `a` and `b` with one commit each, `.pi/verify.json` with one command): `in a workspace, a redirect to an unknown variable path marks nothing` → a `bashCall("cd a && true > $S/red.log")` writing no project file → `agent_end` sends no `verify-gate` message. Run `node --test tests/extensions.test.ts` → expect FAIL: a `verify-gate` message naming `$S/red.log`.
- [ ] Write failing tests:
  - extension `in a workspace, a shell write in a repository marks it` → a bash call that writes `a/f.ts` → `agent_end` message names `a/f.ts`;
  - extension `a subagent call's changes in a workspace are its own` → `subagent` tool_call, write `b/n.ts`, tool_result → `agent_end` message names `b/n.ts`;
  - unit `callChanges reads text targets only inside blind parts` → blind `["a"]`: `> a/x` counts, `> b/x` doesn't; blind `[""]`: `> loose.js` counts, `> a/x` doesn't.
- [ ] Run `node --test tests/extensions.test.ts tests/worktree.test.ts` → expect FAIL on those assertions
- [ ] Implement `callChanges`: both trees → `changedPaths(before, now, projectDir)` plus `shellWriteTargets` filtered to paths inside a part blind in either tree (`""` = under no repository named in `heads` or `blind`); a tree missing and `after` given → text targets, as today. `track` computes `paths` as `callChanges(...).filter((p) => !isIgnored(p, ignore))`; `gitOff` is set only by a `repo` fingerprint (a workspace never sets `why.slow`).
- [ ] Run `node --test tests/extensions.test.ts tests/worktree.test.ts` → PASS, then `npm test` and `npm run typecheck`
- [ ] Commit `fix(verify): a workspace call counts what it changed, not what its text names`

### Task 4: verdicts per repository

**Files:** Modify `extensions/lib/reviews.ts` · Test `tests/reviews.test.ts`
**Interfaces:** Consumes `projectRepos`, `repoOf` · Produces `commitRepos(projectDir: string, rev: string): Array<{ dir: string; sha: string }>`; `recordVerdict` and `recordReview` keep their signatures and return the first record

- [ ] Red reproduction: `a workspace records the verdict in the repository that has the commit` → workspace of `repo()`-style repositories `a`, `b`; `recordReview(ws, <report naming a's HEAD>)` returns a record and `readReviews(ws/a)` holds it. Run `node --test tests/reviews.test.ts` → expect FAIL: `"Reviewed HEAD … is not a commit in this repository"`.
- [ ] Write failing tests:
  - `clones of one history both record the verdict` → `b` cloned from `a` → both stores hold it;
  - `a SHA in no repository names them` → `"Reviewed HEAD <sha> is not a commit in any repository here (a, b)"`;
  - `HEAD records on each repository's HEAD` → `recordVerdict(ws, "HEAD", "Inconclusive")` → one record per store, each on its own HEAD;
  - `a workspace PR from a repository passes with its Yes and is denied without` → `check("cd a && gh pr create", { missing: "block" }, ws)`;
  - `a push to a repository's PR branch is gated by that repository's store` → `notePr`/`settlePr` for `cd a && gh pr create`, then `git -C a push origin feat/a` is gated;
  - `a branch named the same in another repository is not a PR branch` → push of `feat/a` from `b` is not gated by `a`'s PR.
- [ ] Run `node --test tests/reviews.test.ts` → expect FAIL on those assertions
- [ ] Implement: `commitRepos` → `[{ dir: projectDir, sha }]` for kind `repo`, each workspace repository where `rev^{commit}` resolves, `[]` otherwise. `recordVerdict` writes one record per entry into `reviewsDir(entry.dir)`, BASE resolved in the same repository (entries without it skipped; none left → the BASE error); the not-a-commit error names the repositories in a workspace. `uncovered` and `openPrBranches` use the store of `repoOf(projectDir, where)`. `notePr` stores `{ prs: Array<{ branch, dir }>, at, last }`; `settlePr` writes each branch into the `prs.json` of `repoOf(projectDir, dir)` and still reads the legacy `branches`/`branch` entries (dir = `projectDir`).
- [ ] Run `node --test tests/reviews.test.ts` → PASS, then `npm test`
- [ ] Commit `fix(review-gate): record and check verdicts per repository of a workspace`

### Task 5: the guard's reviewer result and review-log in a workspace

**Files:** Modify `scripts/review-log.ts` · Test `tests/extensions.test.ts`
**Interfaces:** Consumes `commitRepos`

- [ ] Write failing test `review-log finds the commit from the workspace folder` → spawn the script with `cwd: ws`, `ENG_KIT_REVIEWS_ROOT`, rev = `a`'s HEAD with a recorded review → exit 0 and the report printed. Run → expect FAIL: exit 1, `is not a commit in this repository`.
- [ ] Add extension tests `a reviewer subagent result records a workspace verdict` (→ `readReviews(ws/a)` has `Yes`, no notify) and `a malformed report in a workspace lands Inconclusive on each HEAD`. They pass on Task 4's code: confirm each fails when `commitRepos` returns `[]` (a temporary mutation of a copy, not the file), then keep them as regression tests.
- [ ] Implement: review-log resolves `rev` in `process.cwd()`; failing that, takes the first `commitRepos(process.cwd(), rev)` entry and reads its reports, chain and IDs from that folder; error `<rev> is not a commit in this repository or any repository here`.
- [ ] Run `node --test tests/extensions.test.ts` → PASS, then `npm test`
- [ ] Commit `fix(review-log): find the commit's repository from a workspace folder`

### Task 6: docs and release 0.34.0

**Files:** Modify README.md, docs/ARCHITECTURE.md, docs/ARCHITECTURE.ru.md, skills/requesting-code-review/references/review-gate.md, CHANGELOG.md, package.json

- [ ] Update each doc as Post-implementation lists; ARCHITECTURE.ru.md stays Russian (an existing Russian file keeps its language)
- [ ] Run `npm test` (lint-skills, release) and `node .github/release.ts check` → PASS
- [ ] Commit `docs: workspace gates (0.34.0)`

### Task 7: live check

- [ ] Criterion 10: from a workspace root, `pi -e <this repo>`; run one review and one `cd <repo> && … > $S/red.log` call → the verdict is recorded (review-log from the workspace prints it) and the verify gate doesn't send a follow-up. Record in Progress.

## Progress

None yet
