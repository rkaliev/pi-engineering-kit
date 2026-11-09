# The guard asks about every reading of an implementer's push and trusts only read-only steps before a landing

Status: design approved (2026-11-09)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit 277ff1fbaeef146e63eb132f18d4ce19b45f6463, pi 0c8e480565915a4c33df9f38847d5bc2cd9ff1e7
Links: workspace docs/review-rounds/0.38.1/round4-findings.md (Follow-ups 0.38.2 and the pre-existing list)

<!-- One file per piece of work, standing in for a tracker issue: the sections before Plan are its description. Each section answers one question and never repeats another. Keep every heading; write "None" instead of deleting a section. -->

<details><summary>Original request</summary>

давай продолжим по важному

(Reply to the backlog summary. Scope picked in the question «Что берём в 0.38.2»: «Хвосты + isSafe (Recommended)».)

</details>

## Intent

0.38.2 closes what the 0.38.1 final round left open. An implementer's push asks however a shell reads it. A step the review gate lets run before a landing really is read-only. And the work-docs gate stays inside the hook timeout with CRLF input.

## Context

The implementer check in `lib/hooks.ts` calls `ownBranchPush` on the command as written only. So `g\rit push` from the implementer on its work branch passes without a question: its igncr reading is the own-branch push, which `judgeCommand` exempts, and the text as written is refused by `PUSH_REFUSED_CHARS` (probed by the round-4 reviewers).

`isSafe` in `lib/reviews.ts` lists `branch` and `remote` as safe git subcommands with a denylist of options. Unsafe forms pass as safe steps before a landing:
- git accepts long-option prefixes (`--forc`);
- `-d`, `--move`, `-u` and `git branch <name> <start>` change refs or the upstream;
- `git remote set-url` changes where a push goes;
- `git -c core.fsmonitor=<program> status` runs a program.

`checkWorkDocs` runs `workDocsGate` once per reading, and each run starts its own 3 s `UNPLACED_BUDGET_MS`. With CRLF that is up to ~9 s against the 10 s hook timeout.

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | From the implementer on its work branch, `g\rit push` and `git\r push` ask with the implementer's reason ("The implementer doesn't push; …"), and so does `git pu\rsh`. The coordinator's plain own-branch push still passes | unit, `hooks.test.ts` (eng-kit only), mutation-checked |
| 2 | `scopedConfig` adds the rules of every repository any reading touches. With a multi-letter fixture, `cd api && c\rd ../we\rb && make release` blocks when `web` has a block rule. `cd b && c\rd $X && make release` blocks when `a` has the rule | unit, `scope.test.ts` in both editions, mutation-checked (drop a reading from the union → red) |
| 3 | `checkWorkDocs` spends at most one `UNPLACED_BUDGET_MS` across all readings, and judges each repository's staged task files at most once per call. A CRLF command over a workspace where `git diff --cached` is slow ends within the budget plus one git timeout | unit, `workdocs.test.ts` in both editions, using the `slowGit` stand-in |
| 4 | `otherReadings` has no dedupe or self-filter that can never fire, and its doc comment and `judgeReadings` describe only what the code does | review; existing `otherReadings` tests stay green |
| 5 | `git branch` counts as a safe step only in a listing form: no positional word except with a list-mode option (`-l`, `--list`, `--contains`, `--no-contains`, `--merged`, `--no-merged`, `--points-at`), and every option from an exact allowlist. `--forc`, `-d`, `--delete`, `--move`, `-u`, `--set-upstream-to=x`, `git branch feat/x main` are not safe: followed by `git merge feat/a` on the base branch, the review gate blocks | unit, `reviews.test.ts` in both editions |
| 6 | `git remote` counts as a safe step only as `git remote`, `git remote -v`/`--verbose`, `git remote get-url …` or `git remote show …`. `git remote set-url origin <url> && git push` is not a safe step | unit, `reviews.test.ts` in both editions |
| 7 | A git call with any global option other than `-C <path>`, `--no-pager` or `-P` is not a safe step: `git -c core.fsmonitor=x status && git merge feat/a` on the base blocks, as do `--config-env`, `--git-dir=`, `--work-tree=` and `--exec-path=` | unit, `reviews.test.ts` in both editions |
| 8 | Missing rows from round 4: the reviewer refuses another blank in `git diff a..b<U+00A0>--output=x` (not only `\r`), and `cd $"-P" <dir>` leaves the folder unknown in `namedFolders` | unit, `hooks.test.ts`/`reviews.test.ts` in both editions, each mutation-checked |
| 9 | The 0.38.1 CHANGELOG entry no longer says `git branch $"-f"` writes a file or runs a program; it says it moves a ref | review |

## Scope

**In scope:**
- The implementer check in `lib/hooks.ts` (eng-kit only; pi has no implementer subagent).
- `otherReadings` and `judgeReadings` in `patterns.ts`.
- `isSafe`, `SAFE_GIT` in `reviews.ts`.
- `checkWorkDocs`, `workDocsGate`, `judgeCommit` in `workdocs.ts`.
- Tests in `hooks.test.ts`, `scope.test.ts`, `workdocs.test.ts`, `reviews.test.ts`.
- Version 0.38.2 in both editions, CHANGELOG (0.38.2 entry and the 0.38.1 wording fix), workspace FRAMEWORK-SOURCES §11.51.

**Out of scope (later, from the round-4 pre-existing list):**
- Gate-file candidates with a path glued to a short option (`cp -t<records>/…`, `sort -o<records>/…`) and `WRITING.less` missing `--log=`.
- Marked path words in `scope.ts`'s `pathLike`/`said`.
- Verify credit (`commandMatches`) reading only the bash split.
- `mkdtempSync` without cleanup in `tests/reviews.test.ts:829`.

## Decisions

1. Scope: the 0.38.1 follow-ups plus `isSafe` (user, 2026-11-09, «Хвосты + isSafe»).
2. `isSafe` moves from a denylist of options to an exact allowlist of read-only forms for `git branch` and `git remote`, and of global git options. Anything else is not safe, so a long-option prefix or a new git option is refused without being listed. **Assumed**; part of this design.
3. `git remote` joins the fix: it is in `SAFE_GIT`, and `set-url`/`add`/`rename` change where a later push goes, which is the same class as `git branch -u`. **Assumed**; part of this design.
4. Z6: one deadline from `checkWorkDocs` for all readings, plus a per-call cache of `judgeCommit` results by repository. The deadline alone bounds the time but can turn a slow first reading into a false "can't tell" for the next; the cache alone doesn't bound a reading whose landings differ. **Assumed**; part of this design.
5. The implementer check reads the command and every other reading, and applies its reason whenever any reading is the own-branch push and the decision isn't a block. **Assumed**; part of this design.
6. The 0.38.1 CHANGELOG line is corrected in place: it describes released behavior wrongly. **Assumed**.
7. Shared files (`patterns.ts` shared parts, `reviews.ts`, `workdocs.ts`, `scope.ts`) stay byte-identical across editions; both editions go to 0.38.2.

## Design

**Implementer push (eng-kit `lib/hooks.ts`).** Replace `ownBranchPush(command, …)` in the implementer check with `[command, ...otherReadings(command)].some((r) => ownBranchPush(r, …))`, and apply it when `decision.action !== "block"`, so a confirm from another reading (`git pu\rsh`) also gets the implementer's reason.

**`isSafe` (`reviews.ts`).** For `git`:
- Walk the global options: `-C <path>`, `--no-pager` and `-P` are skipped; any other option before the subcommand returns false.
- `branch`: every option is in `{-a, --all, -r, --remotes, -l, --list, -v, -vv, --verbose, --show-current, --color, --no-color, --column, --no-column, -i, --ignore-case}`, or is a short cluster of `a r l v i`, or is `--format=`/`--sort=`/`--contains[=]`/`--no-contains[=]`/`--merged[=]`/`--no-merged[=]`/`--points-at[=]`. Positional words are allowed only when a list-mode option is present.
- `remote`: no word after `remote`, or the next word is `-v`/`--verbose`/`get-url`/`show`.
- `fetch` keeps its rule, and the other `SAFE_GIT` subcommands are unchanged.
- Tokens are read through `bare()` as now.

**`otherReadings` (`patterns.ts`).** Return the PowerShell split and the igncr reading, without `Set` or filter: each always differs from the command and from the other. The doc comment of `judgeReadings` keeps "a block ends the search".

**Work-docs budget (`workdocs.ts`).** `checkWorkDocs` computes `until = Date.now() + UNPLACED_BUDGET_MS` and a `Map<repo, result>`, and passes both to `workDocsGate`. The unplaced-commit loop uses them instead of starting its own deadline, and caches "late" too.

## Rollout

None. It ships as eng-kit and pi 0.38.2 through the usual PRs; CI tags the release.

## Risks and open questions

- The `git branch` allowlist turns forms agents rarely chain before a landing into "not safe". The cost is one block that asks to run the landing as its own command, and that block already exists today for unknown commands.
- A cached "late" makes every later reading "can't tell" for that repository. That is the same answer the first reading gave, so the decision doesn't change.

## Follow-ups

- Gate-file paths glued to a short option and `less --log=`: forged review records via `cp -t…`/`sort -o…`.
- Marked path words in `scope.ts` `pathLike`/`said`.
- Verify credit (`commandMatches`) over every reading.
- `tests/reviews.test.ts:829` temp dir cleanup.

## Plan

None yet

## Progress

None yet
