# Guard reads words as the shells split and quote them, and asks where they disagree

Status: in progress
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit 4ff782d2b63ba0469db83ab4d09e0b30c1f8944d, pi 047dab04393e6d397a0ee7cb6bdea7cc1d292317
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

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** the tokenizer splits and quotes words as bash and zsh do, marks the forms they read differently, and a marked word's likely reading feeds every block, question and gate check.
**Architecture:** All changes stay in the existing parser and checks.
- `tokenize` (patterns.ts) changes word splitting and `$` handling.
- `shell.ts` helpers follow the same `$'` boundary.
- `parseMove`, `gitLanding`, `several` and `viewsOf` read a word with its `\0` removed only where that adds a block, a question or a gate check.

**Stack / constraints:**
- Node ≥22.18 runs `.ts` directly; tests use `node:test`; no new dependencies.
- `shell.ts`, `workdocs.ts`, `reviews.ts` and `worktree.ts` stay byte-identical with `src/extensions/lib/`. `patterns.ts` differs only in its edition lines.
- Every test goes into both editions.
- Commit messages: Conventional Commits, no trailer. A message with a backslash goes through `git commit -F <file>`.

**Verification:** run from the workspace root, in its own call: `node "/Users/ruslanaliev/.claude/plugins/cache/eng-kit/eng-kit/0.38.0/scripts/verify.ts"`. Per task: `node --test tests/<file>.test.ts` inside each repo.

### Review focus
1. CRLF and `\r`: `git push --force\r` is one word `--force\r`, which git rejects. `rm -rf ~\r` must still block, because `isOutside` sees `~…` (Task 1).
2. `$\⏎` at the end of the command, or followed by an unquoted letter, a digit or `{`, stays a literal `$` and keeps `$HOME`/`${…}` (Task 2).
3. A stripped view must never reach `allow`: `{ allow: ["^terraform"] }` with `terr$'\x'aform destroy` still asks (Task 4).
4. In `several`, `$'\;'` decodes to the marked word `\0;` and must count as an operator word. A plain `';'` argument still counts too (Task 4).
5. In a workspace, a marked move gives an unknown folder, so `scopedConfig` applies every repository's restrictions (Task 3).

### Post-implementation
- **CHANGELOG.md (both):** a 0.38.1 entry covering words split as the shells split them, `$\⏎'…'` decoded, `$"…"` marked, a marked move leaving the folder unknown, the likely reading reaching project rules and the gate, the reason text, and the 0.38.0 test gaps.
- **README.md and docs/ARCHITECTURE(.ru).md (both):** in the "Command names and quoting" paragraph, add word splitting, the `$"…"`/continuation rules and the project-rule reading.
- **Version 0.38.1:** in `package.json` and `package-lock.json` (both), `.claude-plugin/plugin.json` (Claude), and the pi install pins `@v0.38.1` (README, GETTING-STARTED(.ru), templates/settings.json).
- **Workspace docs/FRAMEWORK-SOURCES.ru.md:** add §11.50.
- **No topic chapter:** behavior lives in ARCHITECTURE.

### Task 1: words split on space and tab only

**Files:** Modify `tokenize` in `lib/patterns.ts` / `extensions/lib/patterns.ts` · Test `tests/guard.test.ts`, `tests/reviews.test.ts` (both editions)

- [x] Write failing test `tokenize splits words only on space and tab, as the shells do`:
  - `tokenize("cd /tmp")` → `["cd /tmp"]`; the same for U+FEFF, `\r`, `\v` and `\f` inside a word;
  - `tokenize("a\tb c")` → `["a", "b", "c"]`;
  - `action("rm -rf ~\r")` → `block`.
- [x] Write failing review-gate test `a word joined by Unicode whitespace is not a move` (on main, in `repo()`): `check("cd /tmp; git merge feat/a")` → block. Add `segmentFolders("cd b; git status", ws)[1].dir === ws`.
- [x] Run both test files in src_claude → expect FAIL on `["cd", "/tmp"]` vs `["cd /tmp"]`.
- [x] Implement: the whitespace test at the word break becomes `ch === " " || ch === "\t"`.
- [x] Run the tests in both editions → PASS. Run the full suites → pass.
- [x] Commit `fix(guard): words split on space and tab only, as the shells split them`.

### Task 2: `$` before a continuation and a quote; `$"…"` marked; shell helpers agree

**Files:** Modify `tokenize` (patterns.ts, both); `blankQuoted` and `stripRedirects` in `lib/shell.ts` (copied to pi) · Test `tests/guard.test.ts`, `tests/reviews.test.ts`
**Interfaces:** Produces the `\0` mark on `$"…"` words, which Task 3 and Task 4 consume.

- [x] Write failing test `$ with continuations before a quote reads as both shells read it`:
  - `tokenize("$\\\n'a\\x62'")` → `["ab"]`, and the same with two continuations;
  - block: `$\\\n'rm' -rf ~` and `$\\\n'a\\'' ; rm -rf ~`;
  - confirm: `$"cd" /tmp; git status` and `$\\\n"cd" /tmp; git status`;
  - allow: `echo $\\\nHOME`;
  - `echo $\\\n` at the end gives `["echo", "$"]`.
- [x] Write failing test `shell helpers find the $\⏎'…' boundary as tokenize does`:
  - `blankQuoted("$\\\n'a b' c")` keeps `c` and blanks `a b`;
  - `stripRedirects("$\\\n'x > y' z")` keeps the quoted `>` as text;
  - `segmentFolders("$\"cd\" b; git status", ws)[1].dir` → `undefined`.
- [x] Run → expect FAIL: `["$\u0000'a\\x62'…"]`-style tokens vs `["ab"]`.
- [x] Implement in `tokenize`, at an unquoted `$`: skip `\⏎` pairs to the next character `c`.
  - `c === "'"`: open `$'…'` at that quote. The `$$` mark keeps its rule, and a continuation between two `$` keeps its mark.
  - `c === '"'`: add `\0`, then read a double-quoted word.
  - otherwise: a literal `$`, with the continuations dropped.
  - Remove the old "mark a continuation after `$` before a quote" branch; this replaces it.
- [x] Implement the same `$`-skip-continuations-then-`'` opener in `blankQuoted` and `stripRedirects`.
- [x] Run in both editions → PASS; `cmp` the two `shell.ts` → same; full suites → pass.
- [x] Commit `fix(guard): $\⏎'…' reads as $'…', $"…" asks, shell helpers agree`.

### Task 3: a marked move leaves the folder unknown

**Files:** Modify `parseMove` in `lib/shell.ts` (copied to pi) · Test `tests/reviews.test.ts`
**Interfaces:** Consumes the `\0` mark (Task 2 and 0.38.0).

- [ ] Write failing test `a marked cd leaves the folder unknown`:
  - `segmentFolders("$'\\u0063d' b; git status", ws)[1].dir` → `undefined`;
  - the same for `$'\\xef\\xbb\\xbf'cd b` and `c$'\\d' b`;
  - in `repo()` on `feat/a`, with a worktree of main as `<main>`: `check("$'cd' <main>; git push")` → block. The test makes the worktree with `git worktree add`.
- [ ] Run → expect FAIL: `ws` vs `undefined`.
- [ ] Implement in `parseMove`: when `words[at]` contains `\0` and `MOVES.has(words[at].replaceAll("\0", ""))`, return `"other"`.
- [ ] Run in both editions → PASS; `cmp` `shell.ts` → same; full suites → pass.
- [ ] Commit `fix(gates): a marked move leaves the folder unknown`.

### Task 4: the likely reading reaches project rules, the git subcommand and quoted operators

**Files:** Modify `checkCommand` (`viewsOf`) in patterns.ts (both), `gitLanding` in `lib/workdocs.ts`, and `several` in `lib/reviews.ts` (copied to pi) · Test `guard.test.ts`, `reviews.test.ts`, `workdocs.test.ts`

- [ ] Write failing tests:
  - `project rules also read a marked word without its mark`:
    - `terr$'\\x'aform destroy` with `{ block: ["terraform destroy"] }` → block;
    - with `{ confirm: ["terraform"] }` → confirm;
    - with `{ allow: ["^terraform"] }` → still confirm (focus 3).
  - `allLandings(["git", "\0merge", "feat/a"])[0].kind` → `"merge"`.
  - On main: `check("git $'\\m'erge feat/a")` → block.
  - On `feat/a`: `check("find . -maxdepth 0 -exec git switch main $'\\;' -exec git merge feat/a $'\\;'")` → block.
- [ ] Run → expect FAIL: `confirm` vs `block` on the project rule.
- [ ] Implement:
  - `viewsOf` also returns the three folded views of the command with `\0` removed. `allow` still reads only `command`.
  - `gitLanding` compares `rest[verb].replaceAll("\0", "")`.
  - `several` is `tokens.some((t) => OPERATOR_WORD.test(t) || OPERATORS.has(t.replaceAll("\0", "")))`, with a local `OPERATORS` set equal to the tokenizer's.
- [ ] Run in both editions → PASS; `cmp` `workdocs.ts` and `reviews.ts` → same; full suites → pass.
- [ ] Commit `fix(guard): a marked word's likely reading reaches project rules and the gates`.

### Task 5: the reason names the causes

**Files:** Modify the reason string in `checkCommand` (both) · Test `tests/guard.test.ts`

- [ ] Write failing test `the mark's reason names the cause`. The reasons for `$"cd" x` and `$'\\cu'rl x` match `/\$"…"/` and `/escape/`. The reason does not say "`$` before a quote".
- [ ] Run → expect FAIL on `/\$"…"/`.
- [ ] Implement the reason: "A word in this command may be read differently by bash and zsh (an escape in $'…' they decode differently, bytes that aren't UTF-8 on their own, a NUL byte or BOM, `$$'`, `$"…"`, or a line continuation between `$` and another `$`), so the guard can't tell what runs. Write the word in plain quotes."
- [ ] Run in both → PASS. Commit `fix(guard): the mark's question names its causes`.

### Task 6: tests for the 0.38.0 changes that had none

**Files:** Test `tests/guard.test.ts`, `tests/reviews.test.ts` (both)

- [ ] Write tests (they pin code already on main). On main:
  - `check("$'\\g'it merge feat/a")` → block;
  - `check("$'\\xef\\xbb\\xbf'cd " + tmp + "; git merge feat/a")` → block.
  - Also `segmentFolders("$'\\g'it -C b status", ws)[0].dir` → `join(ws, "b")`.
  - (`echo $\⏎HOME` → allow is covered in Task 2.)
- [ ] Mutation-check each row: remove `replaceAll("\0", "")` from `commandName` → the first and third rows fail. Set `ignoreBOM: false` → the second fails. Record each in Progress.
- [ ] Commit `test(guard): pin the 0.38.0 mark-stripping and BOM handling`.

### Task 7: docs, version, live check

- [ ] Update every doc in Post-implementation; version 0.38.1 in both editions.
- [ ] Live check (Claude), with the scratchpad `live-check.sh` adapted. Never use `~`: the repo is nested at `$TMP/live/a/repo`, with a sibling `$TMP/live/a/sib` holding a marker file.
  - `$\⏎'rm' -rf ../sib` must be refused with the guard's "outside the project" reason, and the marker must survive. A miss deletes only that temp sibling.
  - `GIT push --force` must still be blocked.
  - Record the output and cost in Progress.
- [ ] Run the kit verify script from the workspace root → all checks pass.
- [ ] Commit `docs: guard tokenizer follow-ups (0.38.1)` in each repo.

## Progress

- Baseline (eng-kit debe9d1, pi 47573f1): kit 0.38.0 verify from the workspace root → typecheck and tests pass in both editions. No drift since Base.
- Task 1: complete (eng-kit debe9d1..HEAD, pi 47573f1..HEAD). Both tests failed first: `["cd","/tmp"]` vs one word, and the review gate allowed the U+00A0 `cd`. The fix is one line in `tokenize`; kit verify → all 4 pass.
- Ruling (Task 2): the `segmentFolders('$"cd" b …')` row moved to Task 3. The marked `$"cd"` stops being a move, but leaving the folder unknown is Task 3's `parseMove` change. Cost if wrong: none, Task 3 asserts it. Old rows changed with Decision 2: `$"git"` is now marked, and the round-3 rows `$\⏎'rm'` and `$\⏎"rm"` (confirm) were replaced by Task 2's block rows.
- Task 2: complete (eng-kit 73e21bc..HEAD, pi 9d3dafd..HEAD). Tests failed first: `["$\u0000a\\x62"]` vs `["ab"]`, and the `blankQuoted` boundary. `tokenize` handles a `$` in one branch that looks past continuations; `ansiQuoteAt` is shared by `blankQuoted` and `stripRedirects`. `shell.ts` is identical in both editions. Kit verify → all 4 pass.
