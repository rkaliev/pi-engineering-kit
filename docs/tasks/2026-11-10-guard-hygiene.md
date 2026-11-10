# Guard hygiene after 0.38.2: one-purpose comment scanner, precise docs, tighter tests

Status: design approved (2026-11-10)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: a943db2
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

None yet

## Progress

None yet
