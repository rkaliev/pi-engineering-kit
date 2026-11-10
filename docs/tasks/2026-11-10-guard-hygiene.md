# Guard hygiene after 0.38.2: one-purpose comment scanner, precise docs, tighter tests

Status: in progress
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: 0489822
Links: workspace docs/review-rounds/0.38.2/round4-findings.md and round5-findings.md (follow-ups); the Claude Code edition (eng-kit) does the same task on its own branch

<details><summary>Original request</summary>

что важного дальше по бэклогу? → давай может с 4 разберемся (item 4: hygiene — README read-only-step lines, `blankQuoted` → scanner `{ text, comments }`, `mkdtempSync` cleanup in `tests/reviews.test.ts`, tests with several apostrophe comments). Scope ruling: «A–F, с task file».

</details>

## Intent

Maintainers of the guard get a comment scanner without a hidden output parameter, docs that state exactly what the guard does and doesn't read, and tests that pin the 0.38.2 fixes and clean up after themselves, with no change in what the guard decides.

## Context

The 0.38.2 review rounds left non-blocking follow-ups: `blankQuoted(command, comments?)` fills an optional output array, so one function has two jobs; the `comments()` doc comment and the review gate's known limits are imprecise; the D1 rows and the single-pass comment skip aren't pinned the way the other cases are; and 18 places in `tests/reviews.test.ts` call `mkdtempSync` directly, bypassing the file's `temp()` helper, so their folders stay in `tmpdir`.

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | `blankQuoted(command)` takes one argument and returns the same text as before; comments come from a separate exported `quotedComments(command)`; both use one private scanner; `patterns.ts` has no local `comments()` wrapper | `npm test` green before and after; a mutation inside the scanner's comment branch fails the comment tests (guard.test.ts "comment" rows) |
| 2 | None in this edition: the README already points to docs/ARCHITECTURE.md for which git forms count and what isn't checked | — |
| 3 | The doc comment of the comment scanner says a comment runs to `\n` while PowerShell ends a line at `\r`, and that for bash the wide blank class only adds a reading (and so maybe a question) | manual: read the comment — docs wording |
| 4 | The review gate's known limits name the heredoc gaps: `<<` inside quotes after a body with an unmatched quote, and a CRLF heredoc that never closes | manual: read docs/ARCHITECTURE.md — docs wording |
| 5 | `# it's⏎# it's⏎# it's⏎rm -rf ~` blocks | guard.test.ts block list; mutation: making the scanner not skip a comment's text fails the row |
| 6 | `git branch ')'`, `git branch \)` and `git remote -v ')'` before `gh pr create` block with the "runs a step before it lands" reason | reviews.test.ts `unsafe` loop; mutation: reverting the round-4 quoted-paren rule fails them |
| 7 | `tests/reviews.test.ts` leaves no temp folder behind | every temp folder comes from `temp()` (no direct `mkdtempSync(join(tmpdir()…` left); manual: count `tmpdir` entries with the file's prefixes before and after `node --test tests/reviews.test.ts` |

## Scope

**In scope:**
- The private scanner in `extensions/lib/shell.ts`, `blankQuoted` and the new `quotedComments`; the call site in `extensions/lib/patterns.ts`.
- The scanner's doc comment; the review gate's known limits in docs/ARCHITECTURE.md.
- The test rows in criteria 5–6 and the `temp()` cleanup in `tests/reviews.test.ts`.
- Version 0.38.4 and a CHANGELOG entry.

**Out of scope:**
- Any change to what the guard or the gates decide, including the other round-4/round-5 and §11.51 follow-ups (`$'\x29'` parentheses, `commentHidesLines` false asks, PowerShell `Copy-Item … "C:\out\"`, `stripRedirects` escapes, `heredocs()` gaps themselves).
- Temp-folder cleanup in other test files.

## Decisions

1. Scope A–F with a task file, because F touches the guard's parser (user ruling «A–F, с task file», 2026-11-10).
2. Scanner shape: a private `scan(command, withComments)` returning `{ text, comments }`, exported as `blankQuoted(command): string` and `quotedComments(command)`. Rejected: `blankQuoted` always returning `{ text, comments }`, because the ten existing callers would change and the text would differ when comments are collected (their text isn't blanked).
3. Patch release rules: at most two review rounds; a guard finding blocks only on input an agent would plausibly write.

## Design

- `scan(command, withComments)`: today's loop unchanged; the comment branch runs only when `withComments`.
- `blankQuoted(command)` = `scan(command, false).text`; `quotedComments(command)` = `scan(command, true).comments`, with the doc comment from criterion 3.
- `patterns.ts`: `withoutComments` calls `quotedComments`; the local `comments()` goes.
- Tests: the D1 rows move from their own assertion into `unsafe`; the replaced `mkdtempSync` calls drop their own `t.after(rmSync…)` where `temp()` now covers them.

## Rollout

None. No behavior change; released as 0.38.4 by CI like any other version.

## Risks and open questions

- A refactor of the parser could change a reading silently → the full suite runs before and after, and the comment tests are shown to catch a mutation in the moved branch.
- A test that already passes proves nothing → each new row (criteria 5–6) is mutation-checked.

## Follow-ups

None.

## Plan

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** the comment scanner gets one-purpose functions, docs state the scanner's and the review gate's limits exactly, and new tests pin the 0.38.2 fixes and clean up after themselves, with no change in any guard decision.
**Architecture:** one private `scan(command, withComments)` in `extensions/lib/shell.ts` holds today's loop; `blankQuoted` and the new `quotedComments` are thin exports; `extensions/lib/patterns.ts` calls `quotedComments`. Everything else is tests and docs.
**Stack / constraints:** Node ≥ 22.18 running `.ts` directly, `node:test`; no new dependencies; English in code and docs, Russian only in `docs/*.ru.md`; version 0.38.4.
**Verification:** `npm test` and `npm run typecheck` (or the kit verify script).

### Review focus
1. A comment inside a `$'…'` or `"…"` quote, and a `#` glued to a word (`a#b`), must stay non-comments after the move — the existing guard.test.ts rows cover them; confirm they ran green in Task 1.
2. `blankQuoted` with one argument must give byte-identical text for every caller (ten call sites) — covered by the full suite in Task 1.
3. Three comments in a row, each with an apostrophe — Task 2.

### Post-implementation
- CHANGELOG.md: a 0.38.4 entry (no behavior change; scanner split, docs, tests) — Task 4.
- docs/ARCHITECTURE.md and docs/ARCHITECTURE.ru.md: the review gate's known limits gain the heredoc gaps — Task 4.
- Version 0.38.4 in `package.json`, `package-lock.json` (both entries), `templates/settings.json`, the `@v0.38.3` install lines in `README.md`, `docs/GETTING-STARTED.md` and `docs/GETTING-STARTED.ru.md` — Task 4.
- What outlives this file: nothing new for docs/decisions; the private FRAMEWORK-SOURCES §11.53 in the workspace (not in this repo).

Files: `extensions/lib/shell.ts` (scanner and its two exports) · `extensions/lib/patterns.ts` (caller) · `tests/guard.test.ts` (comment rows) · `tests/reviews.test.ts` (unsafe rows, temp folders, `quotedComments` unit test) · docs and version files above.

### Task 1: one-purpose comment scanner

**Files:** Modify `extensions/lib/shell.ts`, `extensions/lib/patterns.ts` · Test `tests/reviews.test.ts`
**Interfaces:** Produces `blankQuoted(command: string): string` and `quotedComments(command: string): Array<{ start: number; end: number }>`

- [x] Write test `quotedComments finds each comment once, quotes inside it open nothing` next to the `blankQuoted` test: `quotedComments("ls # it's\n# it's\necho '#x'")` deep-equals `[{ start: 3, end: 9 }, { start: 10, end: 16 }]`, and `quotedComments("a#b \"# x\"")` equals `[]`; add a stub `export function quotedComments(): Array<{ start: number; end: number }> { return []; }` in `extensions/lib/shell.ts`
- [x] Run `node --test tests/reviews.test.ts` → expect FAIL: the first deep-equal gets `[]`
- [x] Move the loop into a private `scan(command: string, withComments: boolean): { text: string; comments: Array<{ start: number; end: number }> }`; `blankQuoted(command)` returns `scan(command, false).text` (drop its second parameter); `quotedComments(command)` returns `scan(command, true).comments`. Its doc comment (criterion 3): an unquoted `#` that starts a word (after any blank, an operator or a backtick) runs to the next `\n` and a quote inside it opens nothing; PowerShell ends a line at `\r` too, so there a comment may end sooner than this range; U+00A0 and `\r` count as blanks because PowerShell reads them so, which for bash only adds a reading (and so maybe a question). In `extensions/lib/patterns.ts` delete `comments()`, import `quotedComments` instead of `blankQuoted`, and call it in `withoutComments`
- [x] Run `npm test` and `npm run typecheck` → expect PASS
- [x] Mutation: in `scan`, let the comment branch record the comment without skipping its text (`out += ch` in place of the slice, no `i = stop - 1`) → expect guard.test.ts comment rows to FAIL; revert
- [x] Commit `refactor(guard): split the comment scan out of blankQuoted`

### Task 2: comment rows pin the single-pass skip (criterion 5)

**Files:** Test `tests/guard.test.ts`

- [x] Add `"# it's\n# it's\n# it's\nrm -rf ~"` to the block list that holds `"echo hi \r# it's\nrm -rf ~"` (the comment-hiding block rows)
- [x] Run `node --test tests/guard.test.ts` → expect PASS (behavior already right)
- [x] Mutation as in Task 1 (comment branch doesn't skip) → expect this row to FAIL with `block` expected; revert
- [x] Commit `test(guard): pin several apostrophe comments in a row`

### Task 3: review-gate rows and temp folders (criteria 6–7)

**Files:** Test `tests/reviews.test.ts`

- [x] Move `"git branch ')'"`, `"git branch \\)"` and `"git remote -v ')'"` from their own `for` line (comment «Final review of 0.38.2…») into the `unsafe` array under the same comment, and delete the old line, so they also match `/runs a step before it lands/`
- [x] Run `node --test tests/reviews.test.ts` → expect PASS; mutation: `const textParens = false` in `extensions/lib/reviews.ts` → expect the three rows to FAIL; revert
- [x] Replace each of the 18 direct `mkdtempSync(join(tmpdir(), "<prefix>"))` calls with `temp("<prefix>")`; delete a `t.after(() => rmSync(<dir>…))` only where `<dir>` now comes from `temp()`; drop `mkdtempSync` from the import if unused
- [x] Count `$TMPDIR` entries matching the file's prefixes before and after `node --test tests/reviews.test.ts` → expect no new entries; `grep -c "mkdtempSync(join(tmpdir" tests/reviews.test.ts` → expect 1 (inside `temp()`)
- [x] Run `npm test` → expect PASS
- [x] Commit `test(reviews): pin quoted parentheses with their reason; clean up every temp folder`

### Task 4: docs and version

**Files:** Modify `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE.ru.md` · `CHANGELOG.md` · `package.json`, `package-lock.json` (both entries), `templates/settings.json`, the `@v0.38.3` install lines in `README.md`, `docs/GETTING-STARTED.md` and `docs/GETTING-STARTED.ru.md`

- [x] docs/ARCHITECTURE.md "Known limits of the review gate" (and the matching sentence in ARCHITECTURE.ru.md): after the clause on a substitution's own quoting and PowerShell's syntax, add that heredoc bodies are found as written: a `<<` inside quotes after a body with an unmatched quote, and a heredoc with CRLF line ends that never closes, may hide the lines after them
- [x] Version 0.38.4 in `package.json`, `package-lock.json` (both entries), `templates/settings.json`, the `@v0.38.3` install lines in `README.md`, `docs/GETTING-STARTED.md` and `docs/GETTING-STARTED.ru.md`; CHANGELOG `## 0.38.4`: one bullet — no change in what the guard decides; the comment scanner is split from `blankQuoted`; the scanner's and the review gate's documented limits are precise; tests pin quoted parentheses and several comments in a row, and the review-gate tests remove their temp folders
- [x] Run `npm test` and `npm run typecheck` → expect PASS
- [x] Commit `chore(release): 0.38.4`

## Progress

Plan approved 2026-11-10, inline execution. Drift: none (plan written at HEAD). Baseline: `npm test` 739 tests, 728 pass, 11 skipped, 0 fail; `npm run typecheck` clean. The scanner code is identical to the eng-kit edition's.
- Ruling: `commentHidesLines` in `extensions/lib/patterns.ts` also called `comments()`; it calls `quotedComments` too — the plan missed the second caller — cost if wrong: none, same ranges.
- Ruling: the Task 1 mutation (comment recorded, its text not skipped) is caught by the new `quotedComments` unit test, not by the single-comment guard rows (one comment's range stays right); Task 2's row is the guard-level pin — found in the eng-kit edition, same code here.
- Task 1: complete (a1bfb23..aaaea57, `npm test` → 740 tests, 729 pass, 11 skipped, 0 fail; `npm run typecheck` clean; RED: stub → actual `[]`; mutation → unit test finds 1 of 2 comments)
- Task 2: complete (aaaea57..1bdacaa, `node --test tests/guard.test.ts` → 91 pass, 0 fail; mutation → the assertion names the new row, `confirm` for `block`)
- Task 3: complete (1bdacaa..bdc2d4c, `npm test` → 740 tests, 729 pass, 11 skipped, 0 fail; mutation `textParens = false` → `git branch ')'` fails; `$TMPDIR` `reviews-*`/`gate-files-*` count 3573 before and after `node --test tests/reviews.test.ts`; one `mkdtempSync(join(tmpdir` left, inside `temp()`)
- Task 4: complete (bdc2d4c..c5e903a, `npm test` → 740 tests, 729 pass, 11 skipped, 0 fail; `npm run typecheck` clean)
