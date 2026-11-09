# The guard asks about every reading of an implementer's push and trusts only read-only steps before a landing

Status: in progress
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit 4b725766e7e73ca32f3c64285f855fbc88a5ab20, pi 9f9f02b834d62895aa247566f5d27bca928d1abb
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

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** close the 0.38.1 round-4 follow-ups and make `isSafe` an allowlist, in both editions, as 0.38.2.
**Architecture:** shared guard files (`patterns.ts` shared parts, `reviews.ts`, `workdocs.ts`, `scope.ts`) change in eng-kit `lib/` first, then are copied byte-identical to pi `extensions/lib/`. The implementer check exists only in eng-kit `lib/hooks.ts`. Tests change in both editions' `tests/` in the same way.
**Stack / constraints:** Node ≥ 22.18, `.ts` run directly, `node:test`, no new dependencies. English in code, tests and docs; the workspace FRAMEWORK-SOURCES section is Russian. Commits use the repo-local identity, no Claude or Co-Authored-By lines; write messages with backslashes via `git commit -F`.
**Verification:** the kit verify script, run bare from the workspace root (`cd` in its own call first); single files with `node --test tests/<file>.test.ts` inside a repo. pi: `npm test` in `src/`.

### Review focus
1. A reading that is a push while the decision is already a confirm from another rule: the implementer's reason must not hide a stricter block (criterion 1; a `--force` with `\r` stays block).
2. `git branch` clusters and value options: `-av` safe, `-dv` not; `--contains=x` safe, `--contains x feat/b` safe (list mode), `--sort -x` not (Task 4).
3. A cached `"late"` in the work-docs gate returns "can't tell" for later readings, never `undefined` (Task 5).
4. The global-option walk with `-C` and no value, or `-C` as the last word (Task 4).

### Post-implementation
- `CHANGELOG.md` (both): a 0.38.2 entry; in the 0.38.1 entry, `git branch $"-f"` moves a ref (it neither writes a file nor runs a program).
- `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.ru.md` (eng-kit), and pi's matching chapter: in the review-gate paragraph, the safe steps before a landing are `git branch` and `git remote` in their listing forms and git with only `-C`, `--no-pager` and `-P` as global options. In eng-kit §7 (line ~185), the implementer's push asks in every reading.
- Version 0.38.2 in every file that carries 0.38.1 outside CHANGELOG, `lib/` and `tests/` (eng-kit: `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`; pi: `package.json`, `package-lock.json`, `README.md`, `docs/GETTING-STARTED(.ru).md`, `templates/settings.json`); `tests/release.test.ts` checks them.
- Workspace `docs/FRAMEWORK-SOURCES.ru.md` §11.51: what 0.38.2 changed and why (Russian, for the user).
- Delete this task file in the last commit of each repo.

### Task 1: implementer push reads every reading (eng-kit only)

**Files:** Modify `lib/hooks.ts` · Test `tests/hooks.test.ts`
**Interfaces:** Consumes `otherReadings(command: string): string[]`, `ownBranchPush(...)` from `lib/patterns.ts`

- [x] In test `guard: the implementer's own-branch push asks; the main agent's passes`, for each implementer agent add `pre("g\rit push", agent) === "ask"` and `pre("git\r push", agent) === "ask"`; add a reason check that `git pu\rsh` from `eng-kit:implementer` matches `/implementer doesn't push; the coordinator does after review/`; and `pre("git push --force\r", "eng-kit:implementer")` stays `"deny"` (a block is never softened)
- [x] Run `node --test tests/hooks.test.ts` → expect FAIL: `g\rit push` gives `undefined`, expected `"ask"`
- [x] In `lib/hooks.ts`, the implementer check becomes: `decision.action !== "block" && IMPLEMENTER.test(...) && [command, ...otherReadings(command)].some((r) => ownBranchPush(r, cwd, process.env, env.projectDir))`; import `otherReadings`
- [x] Run `node --test tests/hooks.test.ts` → PASS; mutation-check: drop `...otherReadings(command)` → the new rows fail; restore
- [x] Commit `fix(guard): the implementer's push asks in every reading`

### Task 2: `otherReadings` without a no-op dedupe (both editions)

**Files:** Modify `lib/patterns.ts` (eng-kit), `extensions/lib/patterns.ts` (pi)

- [x] Replace the body with `[...(wide === undefined ? [] : [wide]), ...(command.includes("\r") ? [command.replaceAll("\r", "")] : [])]`; the doc comment adds that each reading always differs from the command and from the other (the PowerShell one has no `\r`, the igncr one keeps every other blank)
- [x] Run `node --test tests/guard.test.ts tests/reviews.test.ts` in both repos → PASS (no behavior change)
- [x] Commit `refactor(guard): otherReadings returns its readings without a dedupe that never fires`

### Task 3: tests for the `touched` union in `scopedConfig` (both editions)

**Files:** Test `tests/scope.test.ts`

- [x] Give the test helper `workspace(configs, repos = ["a", "b"])` a repository list. New test `scopedConfig: every reading adds the rules of the repositories it touches`: with `workspace({ web: { block: ["make release"] } }, ["api", "web"])`, `command("cd api && c\rd ../we\rb && make release")` → `"block"`; with `workspace({ a: { block: ["make release"] } })`, `command("cd b && c\rd $X && make release")` → `"block"`
- [x] Run `node --test tests/scope.test.ts` → expect PASS (the code exists); mutation-check: in `scopedConfig` use `placed[0]!.touched` instead of the union → both rows FAIL with `"allow"`; restore
- [x] Copy the test file change to pi; run there → PASS
- [x] Commit `test(scope): pin that every reading adds its repositories' rules`

### Task 4: `isSafe` allows only read-only git forms (both editions)

**Files:** Modify `lib/reviews.ts` · Test `tests/reviews.test.ts`
**Interfaces:** Produces `safeGit(tokens: string[]): boolean` (module-private), called from `isSafe` for `tokens[0] === "git"`

- [x] New test `the review gate trusts only listing forms of git branch and remote, and only -C, --no-pager and -P, before a landing`, with `repo()`, `review(report(head, "Yes", base))`:
  - safe, `check("<step> && gh pr create --fill")` → `undefined`: `git branch`, `git branch --show-current`, `git branch -av`, `git branch --list 'feat/*'`, `git branch --contains=HEAD`, `git branch --contains HEAD feat/a`, `git remote -v`, `git remote get-url origin`, `git --no-pager log -1`, `git -C . status`;
  - not safe, `action(check(...))` → `"block"` and reason matches `/runs a step before it lands/`: `git branch --forc main feat/a`, `git branch -d x`, `git branch --delete x`, `git branch --move x y`, `git branch -u origin/main`, `git branch --set-upstream-to=origin/main`, `git branch feat/x main`, `git branch -dv x`, `git branch --sort -x`, `git remote set-url origin /tmp/x`, `git remote add x /tmp/x`, `git -c core.fsmonitor=x status`, `git --config-env=core.pager=X log`, `git --git-dir=x status`, `git --work-tree=x status`, `git --exec-path=x status`, `git -C`
- [x] Run `node --test tests/reviews.test.ts` → expect FAIL: `git branch --forc main feat/a` gives `undefined`, expected `"block"`
- [x] Implement `safeGit` in `lib/reviews.ts`, reading every token through `bare()`:
  - global options: `-C` skips its value (none → false), `--no-pager` and `-P` are skipped, any other word starting with `-` → false;
  - `branch`: options in `BRANCH_LIST_OPTIONS = {-a, --all, -r, --remotes, -l, --list, -v, -vv, --verbose, --show-current, --color, --no-color, --column, --no-column, -i, --ignore-case}`, a short cluster matching `/^-[arlvi]+$/`, or `/^--(format|sort|contains|no-contains|merged|no-merged|points-at)=/`; `--contains`, `--no-contains`, `--merged`, `--no-merged`, `--points-at`, `-l`, `--list` are list mode; a positional word without list mode → false;
  - `remote`: nothing after it, or the next word is `-v`, `--verbose`, `get-url` or `show`;
  - `fetch` keeps its `:` rule; any other subcommand → `SAFE_GIT.has(sub)`, with `branch` and `remote` handled above.
- [x] Run `node --test tests/reviews.test.ts` → PASS, including the existing `git branch -f`, `git branch $"-f"` and `git status && git fetch origin` rows
- [x] Copy `lib/reviews.ts` → pi `extensions/lib/reviews.ts` (confirm `diff` is empty) and the test change; run pi `npm test` → PASS
- [x] Commit `fix(gates): only listing forms of git branch and remote, and plain git options, are safe before a landing`

### Task 5: one work-docs budget across readings (both editions)

**Files:** Modify `lib/workdocs.ts` · Test `tests/workdocs.test.ts`

- [x] New test `in a workspace, an unplaced commit spends one budget across the readings and asks git once per repository`: `slowGit(realpathSync(join(root, "a")), "diff", 2)`; `check("cd $D && git commit -m x\r")` → `undefined` (nothing staged); elapsed < 3500 ms; `readFileSync(slow.log)` has exactly one line containing `diff --cached`
- [x] Run `node --test tests/workdocs.test.ts` → expect FAIL: elapsed ≈ 6000 ms (or two `diff --cached` calls)
- [x] In `checkWorkDocs`, create `const budget = { until: Date.now() + UNPLACED_BUDGET_MS, seen: new Map<string, GuardDecision | "late" | undefined>() }` and pass it to `workDocsGate(text, projectDir, dirs, workspace, budget)`; the unplaced-commit loop uses `budget.until` and reads `budget.seen.get(repo)` before calling `judgeCommit`, storing every result, `"late"` included
- [x] Run `node --test tests/workdocs.test.ts` → PASS, including `an unplaced commit is judged within a deadline`
- [x] Copy `lib/workdocs.ts` → pi `extensions/lib/workdocs.ts` (empty `diff`) and the test change; run pi `npm test` → PASS
- [x] Commit `fix(workdocs): an unplaced commit spends one budget across the readings`

### Task 6: missing test rows from round 4 (both editions)

**Files:** Test `tests/reviews.test.ts`

- [x] In the reviewer test, add `check("git diff a..b --output=x")` → `"block"`. In the PR record test's marked-move loop, add `["p", (p) => \`PR=$(cd $"-P" ${p} && gh pr create --fill)\`]`
- [x] Run `node --test tests/reviews.test.ts` → PASS; mutation-check each: drop the blank refusal in `checkReviewerCommand` → the U+00A0 row fails; read `t` instead of `bare(w)` for the option skip in `namedFolders` → the `-P` row fails; restore both
- [x] Copy to pi; run → PASS
- [x] Commit `test(gates): pin the reviewer's blank refusal and a marked -P in namedFolders`

### Task 7: docs and version 0.38.2 (both editions)

**Files:** the Post-implementation list

- [x] Update the docs and versions named in Post-implementation; write FRAMEWORK-SOURCES §11.51
- [x] Run the kit verify script (eng-kit) and `npm test` (pi) → PASS, including `release.test.ts`; `diff` of the shared lib files between editions is empty
- [x] Commit `docs: 0.38.2` in each repo; then delete this task file in its own commit `chore(tasks): remove the 0.38.2 task file`

## Progress

Plan approved 2026-11-09, inline. Baseline: kit verify script from the workspace root → all checks passed (typecheck + test, both editions). Drift: none (Base = the plan commit's parent in both repos).
Task 1: complete (b6fc056..b11348d, `node --test tests/hooks.test.ts` RED `g\rit push` → undefined, then GREEN; mutations "drop otherReadings" and "=== allow" each fail a row; eng-kit `npm test` → 766 pass, 0 fail)
Task 2: complete (eng-kit b11348d..a34d3aa, pi 2fc12e2..96217fa; refactor, guard/reviews/scope/workdocs tests → 262 and 261 pass, 0 fail)
Task 3: complete (eng-kit a34d3aa..652f850, pi 96217fa..b372519; pins existing code, passes first by design; mutation `placed[0]!.touched` → row 1 `allow`, row 2 `allow` (checked by a script); scope tests 33 pass both)
Task 4: complete (eng-kit 652f850..653b6fe, pi b372519..c20c247; RED `git branch --forc main feat/a` → allow; mutations global options / remote / positional each fail a row; reviews 113 pass both)
Ruling: Task 4 — `--contains` and the other list-mode options are listing options without `=` too — the plan's allowlist missed them, so `git branch --contains HEAD feat/a` (a criterion-5 safe form) failed — cost if wrong: none, they only list.
Task 5: complete (eng-kit 653b6fe..b5c5403, pi c20c247..6dd381e; RED 6139 ms, GREEN 2401 ms; mutation "no cache" → false "can't tell"; workdocs 30 pass both)
Ruling: Task 5 — the shared deadline has no test of its own (a reading whose landings differ from the first's is hard to build); the cache test covers the combination — cost if wrong: a CRLF command with differing unplaced commits could exceed 3 s.
Ruling: Task 5 — a cached repository skips the deadline check: its answer is known, so no git call waits.
Task 6: complete (eng-kit b5c5403..c468cca, pi 6dd381e..c136d7b; rows pin existing code; mutations: dropping the blank refusal turns only `git diff a..b<U+00A0>--output=x` and the `\r` row to allow (checked by a script); `!w.startsWith` fails the `cd $"-P"` row; reviews 113 pass both)
Ruling: a python heredoc that names `gh pr create` is a landing to the task-file guard (correct: an interpreter may run it) — edit scripts go to the scratchpad as files.
Task 7: complete (docs, CHANGELOG, version 0.38.2, FRAMEWORK-SOURCES §11.51; kit verify script from the workspace root → all checks passed; shared lib files identical across editions)
Ruling: Task 7 — the CHANGELOG says unsafe steps "are treated like any other unsafe step", since pi asks where eng-kit denies.
