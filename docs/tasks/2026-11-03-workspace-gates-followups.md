# Workspace gates: close the open review findings of 0.34.0

Status: in progress (plan approved 2026-11-03, inline)
Base: c34ed28e (main after PR #30)
Links: review findings after round 6 (kept outside the repo); PR #30, PR #31

<details><summary>Original request</summary>

давай начнем по приоритеты

давай делать

</details>

## Intent

Teams using the kit in a single repository or a workspace get verify and review gates that don't miss a sourced file after a function header or `command -p`, that always hold a reviewed commit back when a verdict can't reach every repository, that stay within the hook's time limit, and whose docs describe what the code does.

## Context

0.34.0 (PR #30) passed six review rounds. The user ruled the sixth the last one and moved every non-Critical finding to follow-ups; this task closes them. The findings, with the code they point to:
- `bindsAsCommand` (extensions/lib/worktree.ts) starts a command position only after a STARTERS word, an opening `(`/`{` or a `)`-ending word. It misses `source`/`.` after a glued header (`f(){ . ./env; }`) and after `command -p`/`time -p`/`command --`. And it restarts the command position on a STARTERS word or a `)`-ending word that is an argument (`grep -rn "time" . > $S/x`, `rg "(A|B)" . > $S/x`), so `.` counts and the gate re-fires.
- `holdBack` (extensions/lib/reviews.ts): a lookup that found nothing because a repository hung returns "is not a commit". `holdBack` then repeats it, and the shared deadline runs out before the HEAD fallback. `reviewsDir`'s `git rev-parse --git-common-dir` (5 s) runs outside the deadline, and when it fails the record is written to a folder-keyed store nobody reads. The other edition runs its token ledger before its 7 s deadline starts (no counterpart here: pi has no hook timeout).
- The docs are stale:
  - the `callChanges` JSDoc still describes the removed any-position rule;
  - ARCHITECTURE(.ru) says a missed verdict's Inconclusive goes "else for each HEAD";
  - README and CHANGELOG don't name the `..` symlink rule.
- This package only:
  - `run_verification` reports output over pi's cap as TIMEOUT (`truncated` is not read);
  - no extension test pins the guard's deadline wiring.

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | With a blind part, `f(){ . ./env; }; echo > $S/x`, `f()(source ./env); echo > $S/x`, `command -p source ./env; echo > $S/x`, `time -p . ./env; echo > $S/x` and `command -- eval x; echo > $S/x` count every text target as when `.` is a plain command word | unit tests in tests/worktree.test.ts, each seen failing on the old code |
| 2 | `command -v source; echo > $S/x` and `command -V .` don't count as binding: they only look the name up | unit test |
| 3 | A STARTERS word or a `(`/`)` word in an argument position doesn't start a command position: `grep -rn "time" . > $S/x` and `rg "(A|B)" . > $S/x` with only a non-symlink blind part place their targets from the cwd. `case x in a) . ./env;; esac` and `if true; then . ./env; fi` still count as binding | unit tests; the binding cases pass before and after |
| 4 | A lookup that found nothing because a repository didn't answer in time says so ("could not be searched in time"), distinct from "is not a commit". `holdBack` then goes straight to each repository's HEAD without repeating the lookup, and reports the miss | unit tests in tests/reviews.test.ts with `slowGit` hanging only the SHA lookup, seen failing on the old code |
| 5 | When resolving a repository's store (`git rev-parse --git-common-dir`) times out or runs past the deadline, nothing is written to a folder-keyed store, and the result is a miss that the caller holds back and warns about | unit test with `slowGit` on `rev-parse --git-common-dir` |
| 6 | (the other edition only; nothing to change here) | — |
| 7 | The two tests named weak in round 6 ("…times out again is named" in reviews, the hooks deadline test) fail on the code before their fix | each mutated or run on the parent commit; result recorded in Progress |
| 8 | `run_verification` reports output over pi's limit as an output-limit failure, not TIMEOUT; the gate still fails | extension test with a fake `pi.exec` returning `truncated: true, killed: true` |
| 9 | an extension test pins that the guard's reviewer-result paths share one deadline | extension test, seen failing with the deadline removed |
| 10 | The `callChanges` JSDoc, ARCHITECTURE and ARCHITECTURE.ru (guard and verify rows), README and CHANGELOG describe the code at HEAD: command-position rule, hold-back order (the named commit; each HEAD only when it names no commit or couldn't be searched), the `..` symlink rule | reviewer checks text against code; `node .github/release.ts check` |
| 11 | The shared files (extensions/lib/repos.ts, worktree.ts, reviews.ts, shell.ts) stay byte-identical with the other edition's copies, and the package releases as 0.34.1 | `cmp` of the shared files; typecheck and the full test suite in both; release check |

## Scope

**In scope:**
- items 1–11 above; the other edition gets the same shared files in its own PR;
- F39: STARTERS entries that can never match are removed, or kept with a comment saying why, whichever the item 1/3 fix needs.

**Out of scope:**
- the guard in a workspace (CI and protected paths in child repositories, own-branch push, task-file leak guard, approval gate, `core.fsmonitor`, `--git-dir`/`--work-tree` landings): the next task;
- mirroring non-Yes verdicts into the workspace folder's store (pi S18): goes with the guard task;
- the token ledger and kit-init command detection in a workspace: a later task;
- the round-5 carried items not named above: `~`/`$HOME` after a move, CDPATH from startup files, zsh `noglob`/aliases, a minimum lookup share with 32 repositories, With fixes turned Inconclusive by a hold-back, guard protection of child repositories' verify.json.

## Decisions

1. One task for the follow-ups of 0.34.0, before the guard-in-workspace task: they are defects in released code with known fixes. User's choice (2026-11-03, "давай делать" on that order).
2. Narrowing the command-position rule (item 3) reduces false re-fires only. Every case that binds as a command still counts (item 3's second half), and anything the parser can't read still fails closed.
3. **Assumed:** release as 0.34.1 (fixes only, no new behaviour beyond the output-limit label).
4. Shared files stay byte-identical across editions; they are written test-first in the other edition and copied here with their tests.

## Design

- `bindsAsCommand`:
  - a command position starts after a token ending in `(`, `{` or `)` only where that token is itself in a command position or a `case` pattern;
  - the text after the last `(`/`{` inside a token is judged as a command word;
  - `command`, `time` and `exec` keep the position across their dash options, but `command -v`/`-V` ends it;
  - STARTERS count only in a command position.
- `lookup` returns `complete`; `recordVerdict` returns a distinct "could not be searched in time" when nothing was found and the search was incomplete. `holdBack` treats that like a missing `rev`: each HEAD, then the miss.
- `reviewsDir` gets an optional deadline. In `recordVerdict` a failed or late common-dir lookup is a `failure` (a miss), never a fallback to the folder key.
- `run_verification`: `r.truncated === true` is read before `r.killed`.

## Rollout

Patch release 0.34.1. Rollback: install 0.34.0.

## Risks and open questions

- The tokenizer may strip quotes, so `"time"` and `time` look alike → item 3 relies on position, not on quoting. A quoted command word in a command position (`"source" ./env`) still counts.
- Hanging one git subcommand only (`rev-parse --git-common-dir`) needs `slowGit` to match on arguments → extend tests/slow-git.ts if its `only` filter can't.

## Follow-ups

- Review gate: a store failure for a commit only one repository has makes the result a string, so the guard reports no verdict recorded though the report parsed (as on 0.34.0 for a write failure).
- Guard in a workspace, with pi S18 (non-Yes verdicts mirrored into the folder store).
- Token ledger and kit-init command detection in a workspace.
- Round-5 carried items listed under Out of scope.

## Plan

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** close the 0.34.0 follow-ups here: the shared files and their tests from the other edition, the guard's hold-back calls, and the `run_verification` label.
**Stack / constraints:** Node ≥ 22.18, `node:test`, no new dependencies; extensions/lib/repos.ts, worktree.ts, reviews.ts and shell.ts byte-identical with the other edition (`cmp`).
**Verification:** `npm run typecheck`, `npm test`, `node .github/release.ts check`.

### Post-implementation
- docs/ARCHITECTURE.md and docs/ARCHITECTURE.ru.md: guard row (hold-back order, deadline, store reserve, `..` symlink rule) and the verify row (the output-limit label).
- README: the `..` symlink rule; CHANGELOG `## 0.34.1`; version 0.34.1 in package.json, package-lock.json and the install pins (README, docs/GETTING-STARTED(.ru), templates/settings.json).

### Task 1: shared files and their tests (criteria 1–5, 7)

- [x] Copy extensions/lib/repos.ts, worktree.ts, reviews.ts, shell.ts and tests/slow-git.ts from the other edition; `cmp` → identical.
- [x] Port the new and reworked tests in tests/worktree.test.ts and tests/reviews.test.ts; run them with main's shared files → FAIL, except the two checked by mutation (see Progress).
- [x] Full suite → PASS. Commit.

### Task 2: guard hold-back calls and their deadline (criteria 4, 9)

- [x] Write `review gate: the lookups for one reviewer run share one deadline, …` (a malformed report, `c` hanging on `rev-parse`; under 7.5 s, `a`'s HEAD held); seen failing with the deadline removed.
- [x] extensions/guard.ts passes its own failed result to `holdBack` on the unverified and the no-verdict paths.
- [x] Full suite → PASS. Commit.

### Task 3: `run_verification` output limit (criterion 8)

- [x] Write `verify: run_verification reports output over pi's limit as an output-limit failure, not a timeout` (fake exec `{ code: 1, killed: true, truncated: true }`) → FAIL.
- [x] Read `truncated` before `killed` in extensions/verify.ts → PASS; full suite. Commit.

### Task 4: docs and 0.34.1 (criteria 10–11)

- [x] Post-implementation items; `node .github/release.ts check` → ok 0.34.1. Commit.

## Progress

- Baseline (c34ed28): typecheck clean; `npm test` 562 tests, 551 pass, 11 skipped, 0 fail.
- Ruling: the ported tests "…times out again is named" and "…recorded there even when another repository uses up the lookup's time" pass on main's shared files. The first pins the miss over `undefined`, the second the store reserve this change adds; both were seen failing by mutation in the other edition on identical code.
- Ruling: the token ledger item (F36) has no counterpart: pi records subagent usage in-process with no hook timeout.
- Tasks 1–3: complete (`npm test` → 570 tests, 559 pass, 11 skipped, 0 fail).
- Task 4: complete (`release.ts check` → ok 0.34.1).
- Review round 1 (With fixes): the narrowed command position missed `function f {`, `f () {`, a spaced case `)` and an assignment's substitution (fixed, tests added); the timing tests leaned on a sub-second share for a healthy repository (given room; "no second search" proven from the stand-in git's log); the guard's passing of its failed lookup had no test (two tests, failing with it removed); README's hold-back order, the guard comments, the verify rows and `command -V` (fixed). Deferred: a store failure for a commit only one repository has is a string, so the guard reports no verdict for it (pre-existing for a write failure).
- User ruling (2026-11-03, "Переосмыслить разбор"): after the other edition's round 2 found new misses in the narrowed reader, the shared `bindsAsCommand` reads the whole command, with brackets, `$(`, `${` and backticks taken from the quote-blanked text; copied here byte-identical with its tests.
- User ruling (2026-11-03, "case → всегда учитывать"): the other edition's round 3 found that a case pattern's `)` inside a function body or group popped the wrong bracket and hid the arm's `source`; instead of reading patterns, a `case` in a command position counts as a binding. Escaped characters outside quotes are blanked in the shape, and a token whose shape differs in length is judged by its shape.
