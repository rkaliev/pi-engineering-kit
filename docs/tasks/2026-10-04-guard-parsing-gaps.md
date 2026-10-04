# Close the guard's known parsing gaps and the open doc nits

Status: in progress
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: 5e58570840862a3be7808f1f14635f2c8ad21576
Links: None

<!-- One file per piece of work, standing in for a tracker issue: the sections before Plan are its description. Each section answers one question and never repeats another. Keep every heading; write "None" instead of deleting a section. -->

<details><summary>Original request</summary>

давай с 3 и 4 разберемся

(3: the open minor gaps in the guard and the review gate; 4: the open documentation nits. Push without a refspec: option A, ask git through `@{push}`.)

</details>

## Intent

Commands an agent can write by mistake or on a simple injected instruction no longer slip past the review gate, the gate-file protection or the command guard, and the docs stop contradicting themselves.

## Context

Each form below was run against the 0.21.0 guard functions and passed silently, or was misread. The shared libraries (`lib/reviews.ts`, `lib/workdocs.ts`, `scripts/test-hygiene.ts`) are byte-identical in both editions; `lib/patterns.ts` has an edition copy in each.

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | `git push >\|log origin main` and `git push >& log origin main` are read as a push of `main` to `origin`; `x &< f y` keeps `&` as a command separator | unit: `stripRedirects` / `checkReview` rows in `tests/reviews.test.ts`, seen failing first |
| 2 | `git push -o ci.skip origin` (and `--push-option`, `--repo`, `--receive-pack`, `--exec` with a separate value) is read as remote `origin` with no refspec | unit: `landing` rows in `tests/workdocs.test.ts` |
| 3 | A `git push` without a refspec is checked against where git would push (`@{push}`): with `push.default=upstream` and the upstream on the base, the review gate applies; the remote it names is used for the "already landed" check | unit with a temp repo: `checkReview` rows |
| 4 | `checkGateFiles` blocks a write into the review records after `cd nope; cd <records>`, `cd -- <records>`, `cd -P <records>`, `cd $TMPDIR/eng-kit/reviews`, `cd ${TMPDIR}/…`; `pushd X && popd && rm x` checks `x` in the starting folder; a `>` inside quotes isn't a write | unit: `checkGateFiles` rows |
| 5 | `checkReview` follows `cd -P`, `cd --`, `cd -` and `pushd`/`popd` instead of failing closed or keeping the pushed folder | unit: `checkReview` rows |
| 6 | `git commit --no-veri` (any abbreviation of `--no-verify` from `--no-veri` up) is blocked, for every git subcommand that blocks `--no-verify` today | unit: `tests/guard.test.ts` rows, both editions |
| 7 | `declare &>/dev/null -x GIT_DIR=/x; git status` and `&>>` asks like `declare -x GIT_DIR=/x` | unit: patterns rows, both editions |
| 8 | The reviewer sets earlier reports aside only after `git merge-base --is-ancestor {BASE} {REMOTE_BASE}` succeeds, and says Inconclusive otherwise; requesting-code-review fills `{REMOTE_BASE}` | review of the prompt diff; the reviewer's shell allowlist already permits `merge-base` (existing test) |
| 9 | Vitest `context.skip("platform: windows")` keeps its reason; Mocha `context.skip("name", fn)` still needs one | unit: `tests/test-hygiene.test.ts` rows |
| 10 | Docs: git-workflow's `--ff-only` step no longer mentions a merge commit; `/finish` reads the same in README, GETTING-STARTED and WALKTHROUGH (PR by default after a Yes); README and ARCHITECTURE say an `allow` branch pattern also quiets an implementer's push; the README guard table lists PR/MR merges once; ARCHITECTURE §7 names the residual (`remote.<name>.push` refspecs) | review of the docs diff; `tests/lint-skills.test.ts` stays green |

## Scope

**In scope:**
- the rows above in both editions; Claude-only docs (WALKTHROUGH, README table) only where the pi edition has no counterpart;
- version 0.21.1 and CHANGELOG in both editions.

**Out of scope:**
- the Stop-hook reminder for verification-before-completion and the eval follow-ups;
- `remote.<name>.push` refspec config (documented residual);
- obfuscated forms (variables built from parts, `eval` of encoded strings): the documented residual stays.

## Decisions

1. Push without a refspec: ask git through `git rev-parse --abbrev-ref --symbolic-full-name @{push}` (user, 2026-10-04). When the command names a remote other than the one `@{push}` names, keep today's rule (the current branch's name).
2. One `cd` tracker serves `checkReview` and `checkGateFiles`. `checkReview` still fails closed when a folder is unknown; `checkGateFiles` keeps every candidate folder, because a write may create the folder it later moves into.
3. Option ends follow the 0.18.2 lesson: options end only at the narrowest safe token.
4. Patch release 0.21.1 in both editions, versions stay equal. **assumed**

## Design

- `stripRedirects` (reviews.ts): operators `>|`, `>&` with a word target, `&>`/`&>>`; a leading `&` before anything else stays a separator. `writes()` runs on the command with quoted text blanked.
- `landing` (workdocs.ts): push options that take a separate value are skipped with it.
- `checkReview`: for a push with no refspec and no remote, or with the remote `@{push}` names, the target is the branch `@{push}` names; the remote from it replaces the `origin` default.
- New `cdTarget(dirs, tokens)` in reviews.ts: options `-L -P -e -@` and `--` are skipped; `-` is the previous folder; `pushd`/`popd` keep a stack; `$TMPDIR`, `${TMPDIR}`, `$HOME`, `${HOME}`, `~` expand; any other `$`, backtick or `(` makes the folder unknown.
- patterns.ts (both copies): the tokenizer keeps `&>` and `&>>` as redirections; the `--no-verify` check matches `/^--no-veri(fy?)?$/`.
- test-hygiene.ts: the JS name strip needs a following `,`.
- reviewer-prompt.md: `{REMOTE_BASE}` in the Range section and the is-ancestor check; requesting-code-review step 2 fills it.

## Rollout

None. Tag v0.21.1 after merge in both repos.

## Risks and open questions

- `@{push}` fails without an upstream or remote config → fall back to today's rule (current branch name on its own remote).
- A broader `stripRedirects` could hide a separator → every new operator gets a row where a separator right after it still splits.

## Follow-ups

- Stop-hook reminder to load verification-before-completion, measured with an eval.
- Eval: harder cases, tool-agnostic order graders, the 0.20.0 row note in EVALS.md, a pi runner.

## Plan

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** close the 0.21.0 guard parsing gaps and doc nits from criteria 1–10 in both editions, released as 0.21.1.
**Architecture:** all parsing fixes go into the existing functions in `lib/reviews.ts`, `lib/workdocs.ts`, `lib/patterns.ts` and `scripts/test-hygiene.ts` (eng-kit paths). The pi edition gets byte-identical copies of the shared files (`src/extensions/lib/{reviews,workdocs}.ts`, `src/scripts/test-hygiene.ts`) and the same edit in its own `src/extensions/lib/patterns.ts`; each test row is added to both editions' `tests/` files.
**Stack / constraints:** Node ≥22.18 running `.ts` directly, `node:test`, no new dependencies. A guard parser ends options only at the narrowest safe token (0.18.2). Commits use the repo-local identity, with no trailers.
**Verification:** in each repo `npm test`, `npm run typecheck`, `node .github/release.ts check`; the kit verify script.

### Review focus
1. A new redirect operator swallowing a real separator: `a >| b; git push origin main` must still split at `;`.
2. `@{push}` when the branch has no upstream, or the remote's name contains `/`: falls back to today's rule, never throws.
3. A `cd` the tracker can't follow (`cd "$X"`) followed by a write: `checkGateFiles` keeps the last known folder plus the named-path check; `checkReview` fails closed.
4. `popd` with an empty stack, and `cd -` before any `cd`: the folder becomes unknown in `checkReview`.
5. `--no-ver` (ambiguous in git) and `--no-verify-foo` stay unaffected; `--no-veri` and `--no-verif` block.

### Post-implementation
- `docs/ARCHITECTURE.md` + `.ru.md` §7 (both editions): `>|`, `>&`, push options, `@{push}`, the `cd` forms, the `--no-verify` abbreviations; residual: `remote.<name>.push` refspecs.
- README (both): the guard table lists PR/MR merges once; an `allow` branch pattern also quiets an implementer's push (Claude) or a subagent's push (pi).
- GETTING-STARTED (both), WALKTHROUGH (Claude): `/finish` reads "PR by default after a Yes; merge, keep or discard on your choice".
- `skills/git-workflow/SKILL.md` step 3.1 (both): the `--ff-only` sentence.
- CHANGELOG `## 0.21.1` and the version in `package.json` (+ `.claude-plugin/plugin.json` in eng-kit), both repos.
- Private `docs/FRAMEWORK-SOURCES.ru.md`: new §11.26; the memory file's open-minor lists.

### Task 1: redirections in the review gate

**Files:** Modify `lib/reviews.ts` (`stripRedirects`, `writes`) · Test `tests/reviews.test.ts`
**Interfaces:** Produces the same `stripRedirects(command: string): string`

- [x] Add rows to "redirections are stripped outside quotes only": `git push >|log origin main` → `git push origin main`; `git push >& log origin main` → `git push origin main`; `true &</dev/null git push x` keeps the `&` (normalized `true & git push x`); `a >| b; git push origin main` keeps the `;`. Add a `checkGateFiles` row: `grep "a>b" <records>/x` is a read (allow), while `cat x > <records>/y` blocks
- [x] Run `node --test tests/reviews.test.ts` → expect FAIL on the `>|` row (received `git push |log origin main`)
- [x] Implement: the operator regex accepts `>|` and `>&` followed by a word target; a leading `&` is an operator only before `>`; `writes()` scans the command with quoted text blanked
- [x] Run → PASS, then `npm test`
- [x] Copy `lib/reviews.ts` to `../src/extensions/lib/reviews.ts`, add the same rows to `../src/tests/reviews.test.ts`, run `npm test` there
- [x] Commit `fix(guard): read >|, >& and &< as the shell does` in both repos

### Task 2: push options that take a value

**Files:** Modify `lib/workdocs.ts` (`landing`) · Test `tests/workdocs.test.ts`

- [x] Rows: `git push -o ci.skip origin` → `{remote: "origin", refspecs: []}`; same for `--push-option x`, `--repo x`, `--receive-pack x`, `--exec x`; `--push-option=x origin main` → remote `origin`, refspecs `["main"]`
- [x] Run `node --test tests/workdocs.test.ts` → expect FAIL: remote `ci.skip`
- [x] Implement: a `PUSH_VALUE_FLAGS` set beside `MERGE_VALUE_FLAGS`; positional args skip the token after one of them
- [x] Run → PASS, full suite; copy `lib/workdocs.ts` to pi, same rows, pi suite
- [x] Commit `fix(guard): push options with a separate value don't name the remote`

### Task 3: push without a refspec goes where git says

**Files:** Modify `lib/reviews.ts` (`checkReview`, `targets`, new `pushDestination`) · Test `tests/reviews.test.ts`
**Interfaces:** Produces `pushDestination(where: string): { remote: string; branch: string } | undefined` (reads `git rev-parse --abbrev-ref --symbolic-full-name @{push}`, splits the longest prefix that is a name in `git remote`)

- [x] Test "a push without a refspec lands where @{push} points": temp repo with remote `origin`, branch `feat/x` with upstream `origin/main` and `push.default=upstream`, an unreviewed commit; `git push` → block; `git push origin` → block; with `push.default=simple` → allow (no base landing); a branch with no upstream → today's rule
- [x] Run → expect FAIL: `git push` allowed (received "allow", expected "block")
- [x] Implement: when a push has no refspecs and no `--all`, and its remote is absent or equals `pushDestination(where).remote`, treat it as refspec `HEAD:<branch>` on that remote; the remote also replaces the `origin` default in `uncovered`
- [x] Run → PASS, full suite; copy to pi, same test, pi suite
- [x] Commit `fix(guard): a push without a refspec is checked where git pushes it`

### Task 4: one `cd` tracker for both checks

**Files:** Modify `lib/reviews.ts` (new `changeDir`, used by `checkReview` and `checkGateFiles`; `isCd`, `follow` folded in) · Test `tests/reviews.test.ts`
**Interfaces:** Produces `type DirState = { dirs: string[]; prev: string[]; stack: string[][] }` (`dirs` empty = unknown) and `changeDir(state: DirState, tokens: string[], mustExist: boolean): DirState | undefined` (undefined: not a cd/pushd/popd)

- [x] Rows in "shell writes to the gate's own files": from the temp dir, `cd nope; cd eng-kit/reviews; rm x`, `cd -- eng-kit/reviews; rm x`, `cd -P eng-kit/reviews; rm x`, `cd $TMPDIR/eng-kit/reviews && rm x`, `cd ${TMPDIR}/eng-kit/reviews && rm x` → block; `pushd eng-kit/reviews && popd && rm x` → allow; `cd "$X" && rm x` from inside the records → block
- [x] Rows in "cd and git -C are followed": `cd -P <worktree> && git push origin HEAD:main` and `cd -- <worktree> && …` check the worktree; `pushd <worktree> && popd && git push origin main` checks the start folder; `popd` with an empty stack and `cd -` first → ask (unknown)
- [x] Run → expect FAIL on `cd nope; cd eng-kit/reviews; rm x` (received allow)
- [x] Implement `changeDir`: options `-L -P -e -@` and `--` skipped; `-` swaps with `prev`; `pushd` pushes, `popd` pops; `$TMPDIR`, `${TMPDIR}`, `$HOME`, `${HOME}` and `~` expand; any other `$`, backtick or `(` → unknown. `mustExist` (checkReview) drops a missing folder → unknown; without it (checkGateFiles) a missing folder keeps the old candidates too. Subshell restore in `checkReview` saves and restores the whole state
- [x] Run → PASS, full suite; copy to pi, same rows, pi suite
- [x] Commit `fix(guard): follow cd options, cd -, pushd/popd and $TMPDIR`

### Task 5: command guard: hook-bypass abbreviations and `&>`

**Files:** Modify `lib/patterns.ts` and `../src/extensions/lib/patterns.ts` (`checkSegment`, `tokenize`) · Test `tests/guard.test.ts` in both
- [ ] Rows: `git commit --no-veri -m x`, `git commit --no-verif -m x`, `git push --no-veri origin feat/x`, `(git merge --no-veri x)` → block; `git commit --no-ver -m x` and `git log --no-verify-foo` → not blocked by this rule; `declare &>/dev/null -x GIT_DIR=/x; git status`, `declare &>>log -x GIT_DIR=/x; git status`, `declare 2>&1 -x GIT_DIR=/x; git status` → confirm; `npm test &>/dev/null && git status` → allow
- [ ] Run `node --test tests/guard.test.ts` → expect FAIL: `--no-veri` allowed
- [ ] Implement: the check matches tokens and words against `/^--no-veri(fy?)?$/`; in `tokenize`, an `&` right after `<`/`>` or right before `>` is part of the redirection, not a separator
- [ ] Run → PASS, full suite, both repos
- [ ] Commit `fix(guard): block hook-bypass abbreviations; &> is a redirection` in both repos

### Task 6: Vitest `context.skip` keeps its reason

**Files:** Modify `scripts/test-hygiene.ts` (`skipReason`) · Test `tests/test-hygiene.test.ts`
- [ ] Rows: `context.skip("platform: no symlinks on windows")` inside a test → no violation; `context.skip("needs db")` → `skip-without-reason`; Mocha `context.skip("suite", () => {})` → `skip-without-reason`; `it.skip("name", fn) // #12` → none
- [ ] Run → expect FAIL: the platform row reports `skip-without-reason`
- [ ] Implement: the JS name strip applies only when a `,` follows the first string
- [ ] Run → PASS, full suite; copy the script to `../src/scripts/test-hygiene.ts`, same rows, pi suite
- [ ] Commit `fix(test-hygiene): a one-argument context.skip keeps its reason`

### Task 7: reviewer checks that BASE is on the remote base

**Files:** Modify `skills/requesting-code-review/reviewer-prompt.md`, `skills/requesting-code-review/SKILL.md` (both editions)
- [ ] Range section: `Remote base: {REMOTE_BASE}`; the repeat-round rule: before setting reports aside when {BASE} is {RULES_BASE}, run `git merge-base --is-ancestor {BASE} {REMOTE_BASE}`; if it fails, say Inconclusive. SKILL step 2 lists `{REMOTE_BASE}` = `origin/<base-branch>`
- [ ] Run `node --test tests/lint-skills.test.ts` and the reviewer-allowlist test (`git merge-base --is-ancestor a b` allowed) → PASS in both repos
- [ ] Commit `fix(review): the reviewer checks that BASE is on the remote base`

### Task 8: docs, version, changelog

**Files:** those in Post-implementation
- [ ] Apply every Post-implementation item; bump to 0.21.1 with a `## 0.21.1` CHANGELOG entry in both repos
- [ ] Run `npm test`, `npm run typecheck`, `node .github/release.ts check` in both repos → all green; the kit verify script
- [ ] Commit `docs: guard parsing gaps and doc nits (v0.21.1)`; then move what lasts into docs, delete the task file, and finish (verify → review last)

## Progress

- Baseline 2026-10-04: eng-kit `npm test` 382 pass, pi 380 pass, typecheck clean in both. Drift: none (only the task file changed since Base).
- Task 1: complete (both repos; `npm test` → eng-kit 384 pass, pi 382 pass; each new row checked against the HEAD version: all differ, fd duplications unchanged)
- Task 2: complete (both repos; RED: remote `x` instead of `origin`; `npm test` → eng-kit 385 pass, pi 383 pass)
- Task 3: complete (both repos; RED: `git push` allowed with push.default=upstream onto main; a slash-named remote row is proven by mutation (first-slash split → FAIL); `npm test` → eng-kit 386 pass, pi 384 pass)
- Ruling: `pushDestination` stays module-private, not exported as the plan's Interfaces line said — only `checkReview` uses it — no cost.
- Task 4: complete (both repos; RED: `cd nope; cd eng-kit/reviews; rm x` allowed, `cd -P <wt>` failed closed; each gate-file row checked against the HEAD version, all but `cd "$X"` differ — that row guards Review focus 3 and is proven by mutation (unknown → no folder: FAIL); `npm test` → eng-kit 388 pass, pi 386 pass)
- Ruling: `notePr` uses the same tracker as `checkReview` (it followed `cd` the same way before) — one rule for both — cost if wrong: a PR opened after `cd -` registers the previous folder's branch, as the shell would.
- Ruling: a bare `cd` goes to the home folder instead of failing closed — that is what the shell does; home is rarely a checkout, so a landing there still asks — none.
