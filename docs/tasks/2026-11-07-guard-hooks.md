# Guard closes case, git-hook and run-record bypasses

Status: design approved (2026-11-07)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit a75d1a7b97b61b5450d6bb9c031c0c0304a453a0, pi e4b1d55e7879a1ce63e0cc9b9430341d248aa61a
Links: FRAMEWORK-SOURCES §11.46–11.47 follow-ups; user ruling 2026-11-06 on the guard task

<!-- One file per piece of work, standing in for a tracker issue: the sections before Plan are its description. Each section answers one question and never repeats another. Keep every heading; write "None" instead of deleting a section. -->

<details><summary>Original request</summary>

давай

(Reply to: «Начинаю guard-задачу, включая защиту `eng-kit/runs/`? Или сначала разберём мелкие недоделки?». The task itself was set by the user's ruling of 2026-11-06: `.GIT` case-insensitive in all checkPath rules + hook files outside .git = known paths (.husky/, .githooks/, lefthook.yml, .pre-commit-config.yaml) plus core.hooksPath read at session start → confirm; shell writes into .git a separate later task. On the core.hooksPath question the user chose option A: confirm `git config … core.hooksPath` changes.)

</details>

## Intent

The guard stops three cheap bypasses: a capital letter in a protected path, an edit to a git hook that then runs on every commit, and a forged verify-run record that clears the verify gate.

## Context

`checkPath` (`lib/patterns.ts`, the same in both editions apart from the config name and outside-project writes) matches every path rule case-sensitively, but on macOS (APFS) and Windows `.GIT/config` is `.git/config`. Git hook files outside `.git` (`.husky/`, `.githooks/`, lefthook and pre-commit configs, a custom `core.hooksPath`) are edited without a question, though their code runs on the user's machine at every commit. In the Claude edition, `<tmp>/eng-kit/runs/*.json` is protected neither from Write/Edit nor from the shell, and `readRun` does not check who owns the folder, so a forged `{ok:true}` clears the verify gate (§11.47 follow-up).

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | Every `checkPath` path rule ignores case: `.GIT/config` and `.Git/HEAD` are blocked like `.git/…`; `.GITHUB/workflows/x.yml` asks like a CI pipeline; `.ENV` is blocked on read; `ENG-KIT/reviews/…` is blocked; `.CLAUDE/guard.json` (`.PI/guard.json` in pi) asks; a `protectedPaths` prefix matches in any case | unit, `guard.test.ts` in both editions |
| 2 | A Write or Edit (and a quoted-heredoc write) to `.husky/…`, `.githooks/…`, `lefthook.yml`, `lefthook.yaml`, `.lefthook.yml`, `.lefthook.yaml`, `lefthook-local.yml`, `lefthook-local.yaml` or `.pre-commit-config.yaml` asks, with a reason naming git hooks; a path that only resembles them (`docs/husky.md`) is allowed | unit, `guard.test.ts` in both editions |
| 3 | A `core.hooksPath` set in a repository to a folder inside the project, relative or absolute, makes writes under that folder ask; one pointing outside the project adds nothing; an unset key or a failing `git config` leaves only the known list; in a workspace each repository's own `core.hooksPath` applies to that repository | unit (`guard.test.ts`, `scope.test.ts`) and hook-level (`hooks.test.ts` in Claude, `extensions.test.ts` in pi) |
| 4 | `git config` that sets, unsets or replaces `core.hooksPath` (any scope flag, any key case) asks; `git config --get core.hooksPath` and `git config core.hooksPath` with no value are allowed | unit, `guard.test.ts` in both editions |
| 5 | `git -c core.hooksPath=…` (any key case) is blocked like `--no-verify` | unit, `guard.test.ts` in both editions |
| 6 | Claude only: a Write or Edit under `eng-kit/runs/` is blocked; a shell command writing there (by its path as written, its real path or a `$TMPDIR` word) is blocked | unit, `guard.test.ts` and `reviews.test.ts` (`checkGateFiles`) |
| 7 | Claude only: `readRun` and `readRunStart` ignore records in a runs folder owned by another user | unit, `hooks.test.ts` (ownership injected, as `ownDir` tests do) |
| 8 | Claude only: a run of the kit's own `verify.ts`, in the foreground and in the background, is still credited | existing `hooks.test.ts` cases stay green; live check below |
| 9 | Live: in a temp repo with the branch's kit, `claude -p` editing `.husky/pre-commit` gets a confirm (refused in `-p`), and `cat > $TMPDIR/eng-kit/runs/x.json` is blocked | live check script run once, output recorded in Progress |

## Scope

**In scope:**
- Case-insensitive path rules in `checkPath`, both editions.
- The known git-hook paths and the session's `core.hooksPath` as confirm paths, both editions.
- Confirm on `git config` changes to `core.hooksPath`; block on `git -c core.hooksPath=`, both editions.
- Run records protected like review records, Claude edition only (pi verifies in-process and has no run records).
- Version 0.37.0 in both editions, CHANGELOG, `docs/ARCHITECTURE(.ru).md`, workspace `docs/FRAMEWORK-SOURCES.ru.md` §11.48.

**Out of scope:**
- Plain shell writes into `.git` or into hook files (`echo > .husky/x`): a separate later task, as for CI pipelines today.
- Other git-config routes to hooks (`GIT_CONFIG_*` env vars, `include.path`, global config files).
- The verify run recorded under a subfolder's key, and SubagentStop settling a background run (§11.47 follow-ups).

## Decisions

1. Path rules ignore case on every OS (user ruling 2026-11-06: "all checkPath rules"; **assumed**: on Linux a real `.GIT` folder is an accepted false positive, simpler than detecting the file system).
2. Hook files ask, never block (user ruling 2026-11-06).
3. `core.hooksPath` is read once at session start, per repository (user ruling 2026-11-06); mid-session changes are caught by the `git config` confirm rule (user choice A, 2026-11-07).
4. `git -c core.hooksPath=…` is blocked, because it disables hooks for one command exactly as `--no-verify` does (**assumed**, part of the approved design 2026-11-07).
5. Hook-file rules apply where the CI-pipeline rule applies: Write, Edit and quoted-heredoc writes (part of the approved design 2026-11-07).
6. Run records get the full review-record treatment: path block, shell block, owner check (user agreed to include them, 2026-11-07).
7. `lib/patterns.ts` stays the same across editions apart from the existing differences; `compare-editions` reports no new drift.

## Design

- **`checkPath`** (`lib/patterns.ts`): every regex gets the `i` flag; `protectedPaths` prefixes and the guard-config path compare lowercased. A new `GIT_HOOKS` regex beside `CI_PIPELINE` asks: "… is a git hook; its code runs on every commit or push. Show the user the change first." `GuardConfig` gains `hooksPath?: string` (a project-relative folder, filled by the caller, never read from `guard.json`); a write under it asks with the same reason. Claude only: `eng-kit/runs/` is blocked beside `eng-kit/reviews/` ("Run records are written only by the verify script.").
- **Reading `core.hooksPath`**: a helper runs `git config --get core.hooksPath` in a repository (short timeout), resolves the value against the repository root, and returns the project-relative folder, or nothing when it is unset, outside, or git fails. Claude: `SessionStart` (and the baseline path that already records `guardBaseline`) stores it per repository in the session state; PreToolUse puts it into each repository's config before `checkPath`/`scopedPath`. pi: `session_start` keeps it in the extension's memory and passes it the same way.
- **Shell rules** (`checkSegment` / `CONFIRM_RULES`): `git … config … core.hooksPath` with a value, `--unset`, `--unset-all` or `--replace-all` asks; `-c core.hooksPath=` blocks. The key match ignores case, as git does.
- **Run records** (Claude): `checkGateFiles` checks the runs folder beside the reviews folder, with the same path forms. `readRun`/`readRunStart` return `undefined` unless `ownDir` holds for the runs folder. `verify.ts` writes from its own Node process, which no guard sees.
- **Errors**: a failure reading `core.hooksPath` falls back to the known list; it never blocks the session.

## Rollout

None beyond the release: branch `feat/guard-hooks` in both repos, 0.37.0, PRs opened by the user with `!`, CI releases on merge.

## Risks and open questions

- Lowercasing could change matches users rely on in `protectedPaths` → only widens what is protected; noted in CHANGELOG.
- Running git at session start costs time in a large workspace → one `git config --get` per repository, bounded by a timeout.
- Open questions: none.

## Follow-ups

- Shell writes into `.git` and into hook files: the guard reads shell write targets for these paths.
- Other git-config routes to hooks (`GIT_CONFIG_*`, `include.path`).

## Plan

None yet

## Progress

None yet
