# Close the guard's known parsing gaps and the open doc nits

Status: design approved (2026-10-04)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: e2631a2d9ea5af2b8896d5b35b4131fbb9969308
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

None yet

## Progress

None yet
