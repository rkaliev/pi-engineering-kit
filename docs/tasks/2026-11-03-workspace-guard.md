# The guard protects every repository of a workspace as it protects one repository

Status: design approved (2026-11-03)
Base: 830fcf1 (eng-kit), 7edcc38 (pi)
Links: follow-up 1 of `docs/tasks/2026-10-23-workspace-gates.md` (deleted in 4773b06; eng-kit) · FRAMEWORK-SOURCES §11.44 and the 0.34.x entries of both CHANGELOGs

<details><summary>Original request</summary>

«что у нас по плану?» → the answer listed the open items, item 1 "Guard in a folder of repositories (security gap)" recommended first → «давай как рекомендуешь». Choices made in the conversation: approach «Судить «как в нём»»; loosening rules «Только репозиторий, куда попадает действие». Design: «давай».

</details>

## Intent

Someone who starts Claude Code or pi in a folder that is not a git repository but holds several (a workspace, see `projectRepos`) gets the same guard in each repository as a session started inside it: CI and protected paths ask or block, the repository's own `guard.json` applies, task files can't leak to its base branch, the approval gate reminds, and a plain push of the own work branch passes without a question.

## Context

0.34.0 made the verify and review gates work in a workspace (`lib/repos.ts`, per-repository review stores, the review gate following `cd` and `-C` to the landing's checkout). The rest of the guard still measures paths from the session folder and runs git only there. A probe on 2026-11-03 (temp workspace with repository `a`, the kit's own functions) showed: a write to `a/.github/workflows/ci.yml` → allow (inside `a`: confirm); a write to `a/.claude/guard.json` → allow; `a`'s `protectedPaths` → not read; `cd a && gh pr create` with a task file on the branch → allow (inside `a`: block); `uncommittedApproved` in the workspace → `[]`; `git -C a push` of the own work branch → asks (`commonDir` of the workspace is undefined).

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | In a workspace, a Write/Edit of `a/.github/workflows/ci.yml` (or another CI pipeline path) asks, and a write of `a/.claude/guard.json` (`.pi/guard.json` in pi) asks, by Write and by a shell write | unit: guard.test.ts; hooks: hooks.test.ts / pi extensions.test.ts in a temp workspace |
| 2 | `a`'s `protectedPaths` block writes under `a/`, measured from `a`; `a`'s `block` and `confirm` rules apply to a command that runs in `a` (`cd a && …`, `git -C a …`) and to a command whose folder the guard can't tell, and not to `cd b && …` | unit: guard.test.ts |
| 3 | `a`'s `allow` rules apply only when every segment of the command runs in `a`; the workspace's own `allow` applies everywhere | unit: guard.test.ts |
| 4 | `cd a && gh pr create` and `git -C a push origin feat/x:main` with a task file in `a` are blocked; `a`'s `workDocs` setting decides `a`'s folders; a landing whose repository the guard can't tell is blocked with a reason | unit: workdocs.test.ts |
| 5 | `"reviewGate": false` in `a` lifts the review gate for landings in `a` only; a PR from `b` is still gated | unit: reviews.test.ts |
| 6 | `git -C a push` of `a`'s current convention-named work branch passes without a question, under the same conditions as inside `a`; the implementer is still asked | unit: guard.test.ts; hooks: implementer case |
| 7 | Stop names approved but uncommitted task files and finished task files of every workspace repository (`a/docs/tasks/x.md`), each with its own base branch; repositories it ran out of time for are named in a warning | hooks: hooks.test.ts; pi: extensions.test.ts |
| 8 | A session inside one repository behaves as before | the existing suites, unchanged, in both editions |
| 9 | Live: a Claude Code session in a scratch workspace with `--plugin-dir src_claude` is asked before writing `a/.github/workflows/ci.yml` | manual: one session — hook delivery can't be simulated, agreed 2026-11-03 |

## Scope

**In scope:**
- both editions: Claude Code (`lib/hooks.ts`, `lib/patterns.ts`, `lib/workdocs.ts`) and pi (`extensions/guard.ts`, `extensions/verify.ts`, `extensions/lib/patterns.ts`, `extensions/lib/workdocs.ts`);
- shared byte-identical files as needed: `lib/repos.ts`, `lib/reviews.ts`, `lib/shell.ts`, `lib/approvals.ts`;
- ARCHITECTURE (en, ru), README, CHANGELOG 0.35.0 in both repositories; FRAMEWORK-SOURCES §11.45 covering 0.34.0, 0.34.1 and 0.35.0.

**Out of scope:**
- new guard rules: what the guard doesn't catch in one repository (for example a write of `verify.json`) stays uncaught in a workspace;
- pi S18 (mirror non-Yes verdicts into the workspace folder's store) — a review-gate change, not the guard;
- the case-sensitive `.git` match and unprotected husky / `core.hooksPath` hooks — gaps of one repository too;
- the token ledger and kit-init detection in a workspace (follow-up 2 of the 0.34.0 task).

## Decisions

1. Judge as inside the repository (user, 2026-11-03): a path or command is first placed in its repository, then checked by the same rules as a session there; the workspace's own rules are checked on top and the strictest decision wins (block > ask > allow).
2. Restrictions add up: `block`, `confirm` and `protectedPaths` of the workspace and of the repository both apply, each measured from its own root.
3. Loosening only where it is written (user, 2026-11-03): a repository's `allow`, `"reviewGate": false` and `workDocs` apply only to actions that land or run in that repository; the workspace's own apply everywhere.
4. A folder the guard can't tell is the strictest case: every repository's restrictions apply, no repository's loosening does, and a landing there is blocked as the review gate blocks it.
5. Constraints: Node ≥ 22.18 running `.ts` natively, `node:test`, no new dependencies; `lib/repos.ts`, `lib/reviews.ts`, `lib/shell.ts`, `lib/approvals.ts` stay byte-identical between the editions; at most 32 repositories (`MAX_REPOS`); a session inside one repository keeps today's behaviour.

## Design

**Placement.** `repoOf(projectDir, path)` (lib/repos.ts) already returns the workspace repository holding a path. The review gate's directory tracking (`Subshells` in the shared lib/shell.ts, which follows the move words in `MOVES`, and a landing's `-C`) is wrapped in one exported function that returns, for a command started in `cwd`, the folder each segment runs in, `undefined` where it can't tell.

**Config.** A guard config is loaded per root (the workspace, each repository that has one). The effective config for an action combines: the workspace's restrictions and loosening, plus the restrictions of every repository the action runs or lands in (all repositories when a folder is unknown), plus that repository's loosening only when the action runs or lands in exactly that one. An invalid repository config gives a warning naming its path and is ignored, as today.

**Paths** (Write, Edit, a heredoc write target, `checkGateFiles`): a path inside repository `a` is judged twice, by `checkPath` from the workspace with its config and from `a` with `a`'s config; the strictest decision wins. `a`'s `guard.json` is a gate file like the workspace's.

**Commands:** `checkCommand` runs with the effective config above. `ownBranchPush` compares the pushed repository's common git dir with that of the workspace repository holding the push's folder, instead of the session folder's. `checkWorkDocs` judges each landing in the repository it lands in (the same tracking), with that repository's task-file folders; an unknown landing folder in a workspace blocks. The review gate skips a landing in a repository whose config sets `"reviewGate": false`.

**Stop** (Claude `stopGates`, pi `verify.ts`): `uncommittedApproved` and `finishedWorkDocs` run in each workspace repository with its folders, paths prefixed with the repository name, `onBaseBranch` per repository, within a time budget; repositories left out are named.

**Cost:** each PreToolUse adds `projectRepos` (one `git rev-parse` and a directory read) and up to 32 small JSON reads; other git calls run only where they run today.

## Rollout

Release 0.35.0 in both editions. Rollback: revert the release; no stored state changes.

## Risks and open questions

- A repository's `block` rule now also applies to a command whose folder is unknown, so a workspace may block what each repository alone wouldn't → the reason names the repository config the rule came from; accepted as fail-closed.
- Stop over many repositories may approach the hook timeout → a time budget with the skipped repositories named.
- No open questions.

## Follow-ups

- pi S18: mirror non-Yes verdicts into the workspace folder's store and merge it in `uncovered`.
- Case-insensitive `.git` match (`.GIT/`) and protection of husky / `core.hooksPath` hooks, in one repository and in a workspace.
- The token ledger and kit-init command detection in a workspace.
- A workspace of more than 32 repositories is not a workspace and keeps the single-folder guard.

## Plan

None yet

## Progress

None yet
