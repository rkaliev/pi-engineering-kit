# Guard reads words as the shells split and quote them, and asks where they disagree

Status: design approved (2026-11-09)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit ab18c8644c6b90a7f7d6b840995cde7f16cff3c5, pi f884fe4aeddb61b02c0924ffb02766ea4562cd8f
Links: FRAMEWORK-SOURCES §11.49 ("Задача 0.38.1"); workspace docs/review-rounds/0.38.0/round5-findings.md (W1–W4 and the out-of-scope list)

<!-- One file per piece of work, standing in for a tracker issue: the sections before Plan are its description. Each section answers one question and never repeats another. Keep every heading; write "None" instead of deleting a section. -->

<details><summary>Original request</summary>

давай

(Reply to the 0.38.1 design in chat. The task was set by the user's ruling after the 0.38.0 final round, «Выпускать, остаток — 0.38.1», and by «да» to «Начать 0.38.1?».)

</details>

## Intent

The guard and the gates read words where bash and zsh split them, and decode `$'…'` across a line continuation as both shells do. They ask about every form the two shells read differently. They also judge a marked word by its most likely reading wherever that only adds a block or a question, so none of the 0.38.0 review's leftovers lets a command past a check.

## Context

The tokenizer splits words on any JavaScript `\s`. bash and zsh keep U+00A0, U+FEFF, `\r`, `\v` and `\f` inside a word: probed, `cd` + U+00A0 + `/tmp` fails as one word in both. So `cd` + U+00A0 + `/tmp; git merge …` makes the review gate judge the merge in `/tmp`.

Some forms read differently in the guard and in the shells:
- `$\⏎'a\x62'` is `ab` in both shells (probed), but the guard marks it and only asks.
- `$"cd"` and `$\⏎"cd"` are `cd` in bash and `$cd` in zsh (probed), but the guard reads `cd` with no mark.
- A marked `cd` (`$'cd'`) is neither followed nor made unknown.

Project `block`/`confirm` patterns, the gate's git subcommand and the quoted-operator check (`several`) read a marked word with its mark. The 0.38.0 changes to the continuation narrowing and the mark-stripping in `commandName` have no test that fails without them (round5-findings.md W2).

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | `tokenize` splits words only on space and tab (newline stays an operator). U+00A0, U+FEFF, `\r`, `\v` and `\f` stay inside a word. With them, `cd` + U+00A0 + `/tmp; git merge feat/a` on the base branch is judged in the session folder and blocks, and `segmentFolders` doesn't move into `/tmp` | unit, `guard.test.ts` and `reviews.test.ts` (review gate, `segmentFolders`) in both editions |
| 2 | `$` followed by one or more line continuations and then `'` opens a `$'…'` word, as both shells read it. `tokenize("$\\\n'a\\x62'")` → `["ab"]`; `$\⏎'rm' -rf ~` blocks; `$\⏎'a\'' ; rm -rf ~` blocks | unit, `guard.test.ts` in both editions |
| 3 | `$"…"` and `$\⏎"…"` mark the word, because bash and zsh read them differently. `$"cd" /tmp; git status` asks, and `segmentFolders("$\"cd\" b; git status")` leaves the second segment's folder unknown | unit, `guard.test.ts` and `reviews.test.ts` in both editions |
| 4 | A marked word that would be a move without its mark (`$'cd'`, `c$'\d'`, `$'\xef\xbb\xbf'cd`) makes the folder unknown. `segmentFolders("$'\\u0063d' b; git status")[1].dir` → `undefined`. From `feat/a`, a bare `git push` after `$'cd' <main checkout>;` is refused by the review gate | unit, `reviews.test.ts` in both editions |
| 5 | Wherever it only adds a block or a question, a marked word is also judged without its mark: project `block` and `confirm` patterns (`terr$'\x'aform destroy` with `block: ["terraform destroy"]` blocks), the git subcommand of a landing (`git $'\m'erge feat/a` on main → the review gate blocks), and the quoted-operator check (`find … -exec git switch main $'\;' -exec git merge feat/a $'\;'` blocks). `allow` and the own-branch push still read only the command as written | unit, `guard.test.ts`, `reviews.test.ts`, `workdocs.test.ts` in both editions |
| 6 | The guard's NUL-mark question names the causes the code has: an escape bash and zsh decode differently, bytes that aren't UTF-8 on their own, a NUL byte or BOM, `$$'`, `$"…"`, or a line continuation between `$` and a quote or `$`. The CHANGELOG and README say the same | unit (`reason` matches), and docs reviewed in the final review |
| 7 | The 0.38.0 gaps get tests that fail without their code: `echo $\⏎HOME` → allow (the narrowed continuation mark); `$'\g'it merge feat/a` on main → the review gate blocks (mark-stripping in `commandName`); `$'\xef\xbb\xbf'cd <tmp>; git merge feat/a` on main → block; `segmentFolders("$'\\g'it -C b status")[0].dir` → `b` | unit, `guard.test.ts` and `reviews.test.ts` in both editions; each mutation-checked |
| 8 | `blankQuoted` and `stripRedirects` in `shell.ts` find quote boundaries as `tokenize` does for `$\⏎'…'`, so the helpers and the tokenizer agree on where a word ends | unit, `reviews.test.ts` (shell helpers) in both editions |

## Scope

**In scope:**
- `tokenize` (word splitting, `$` with continuations before `'` and `"`, `$"…"` mark) in `lib/patterns.ts` and `extensions/lib/patterns.ts`.
- `viewsOf` and the project-rule checks in `checkCommand`.
- `parseMove`, `blankQuoted` and `stripRedirects` in `lib/shell.ts`.
- `gitLanding` in `lib/workdocs.ts`.
- `several` in `lib/reviews.ts` (shared files byte-identical in both editions).
- The reason text.
- Version 0.38.1 in both editions, CHANGELOG, README, `docs/ARCHITECTURE(.ru).md`, workspace FRAMEWORK-SOURCES §11.50.

**Out of scope:**
- Raw-text regexes that use `\s` (`writes`, `quiet`, redirect-target ends in `shell.ts`, `ownBranchPush`'s split). With U+00A0 they only widen matches, or split a word whose command then runs nothing.
- Pre-existing or deferred items:
  - glued `env -S…`;
  - unquoted heredoc apostrophes;
  - `"$(rm -rf ~)"` and `${x:-'…'}`;
  - globs, brace expansion and variables as command names;
  - `=git`, `git.exe`, `sudo -D`;
  - HFS+ ignorable code points;
  - a failed `cd X ;`.

## Decisions

1. Split words as the shells do (space and tab), not by marking every word that holds Unicode whitespace. Both shells keep these characters in the word (probed 2026-11-09), so this reading is exact and adds no questions (**assumed**, part of the design approved in chat).
2. `$` + continuations + `'` is a `$'…'` word, because both shells agree (probed 2026-11-09). `$"…"` and `$\⏎"…"` are marked, because the shells disagree (probed). This revises 0.38.0 Decision 5, which held `$"…"` "only stricter": pi S round 5 showed it moves the folder tracking (**assumed**, part of the design).
3. `$\⏎$'` stays marked. Both shells read `$$` and a plain quote (probed), which differs from the tokenizer's reading, and marking is the existing fail-closed rule.
4. Every new reading without the mark feeds only blocks, questions and gate detection, never `allow` or the own-branch push (continues 0.38.0 Decision 6).
5. User rulings still in force from 0.38.0: all command names; judged as lowercase; `$'…'` fails closed where the shells may disagree; a NUL or a mark asks.

## Design

- **`tokenize`**: the whitespace test becomes `ch === " " || ch === "\t"`. At an unquoted `$`, the tokenizer looks past `\⏎` pairs to the next character.
  - `'`: opens `$'…'` as now (with the `$$`/continuation marks unchanged).
  - `"`: marks the word, then reads a double-quoted word.
  - otherwise: a literal `$`; the continuation is dropped.
- **`viewsOf`**: adds the stripped views (tokens with `\0` removed, folded both ways) to the views that `block` and `confirm` read.
- **`parseMove`**: a word that holds `\0` and is a move without it returns `"other"`.
- **`gitLanding`**: the subcommand is compared with `\0` removed.
- **`several`**: `OPERATOR_WORD` is tested on each token with `\0` removed.
- **`blankQuoted` / `stripRedirects`**: a `$` followed by `\⏎` pairs and `'` opens the `$'` quote state.

## Rollout

None. Released as 0.38.1 in both editions by CI on merge.

## Risks and open questions

- Splitting on fewer characters could join words that a rule expected separate. Only U+00A0-class characters change, which agents rarely write unquoted. The existing suites cover `\t` and space.
- A marked word read without its mark may match a project `block` more broadly. That is stricter by design (Decision 4).

## Follow-ups

- The raw-text `\s` regexes in `writes`, `quiet` and redirect targets.
- The pre-existing tokenizer classes listed in Out of scope.

## Plan

None yet

## Progress

None yet
