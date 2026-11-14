# Verify gate owes what failed or vanished, and the repo meets GitHub Community Standards

Status: design approved (2026-11-14)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit c93a6f2, pi 527a72b
Links: workspace docs/review-rounds/0.39.0/round4-findings.md (U1–U3, "missed earlier")

<details><summary>Original request</summary>

> давай тогда начнем с хвоста и так же в гитхабе есть Community Standards по репозиторию, можем ли мы полностью соотвествовать?

Rulings: «Issues + PR» (contribution model), «Только GitHub» (reports via GitHub only, no email; the agent enables Private Vulnerability Reporting through `gh api`), «Вместе в 0.39.1» (community files ship with the gate fixes), U1 «Все, чей глоб достаёт внутрь», design sections approved («Да, пиши task file»).

</details>

## Intent

The verify gate never stays silent about changes its checks did not pass: a vanished folder owes every check whose globs reach inside it, and a failed or foreign run credits nothing; and both public repos pass every item of GitHub's Community Standards checklist.

## Context

0.39.0 added verify.json `paths`; its final review left three fail-open gaps: `commandsUnder` (`lib/commands.ts`) owes a gone label only for globs that literally start with `<label>/`, so a deleted submodule under `**/*.ts` owes nothing (U1); a failed run leaves its checks in `green` (pi `runChecks`, eng-kit `creditCall`/`settleLaunch` for the verify script); and eng-kit's PostToolUse takes the latest run record as the call's own (`scriptRun` → `exempt`, `ran`) even when this call wrote none. `onlyFolders` misses `apps/*` when `apps/` also holds `.DS_Store`, `.gitkeep`, a README or a folder symlink (U2), and the docs don't list that problem (U3). Both repos score 42% on GitHub's community profile: no code of conduct, contributing guide, security policy, issue or PR templates.

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | A gone label owes every command with a glob that can match a path inside `<label>/` (segment by segment, `**` spans folders, case folded): `**/*.ts` and `vendor/*/src/**` are owed for `vendor/lib`; `packages/**` and `vendor/lib` itself (no deeper segment) are not | `commandsUnder` unit tests (both editions); deleted-submodule gate test with `paths: {"tsc": ["**/*.ts"]}` (eng-kit hooks, pi extension) |
| 2 | pi: a `run_verification` that fails while edits are unverified removes the checks that failed or were skipped from `green`; the follow-up names them | pi extension test (lint green after `only: [lint]`, then a failing run of lint) |
| 3 | eng-kit: a verify-script run that finished not ok, started at or after this call's launch, removes its commands from `green` while unverified, in the foreground (`creditCall`) and when settled from the record (`settleLaunch`) | hooks unit tests, one per path |
| 4 | eng-kit: a verify call whose result has no record of its own (none, or one that started before the call's PreToolUse) neither exempts its own changes nor credits through `ran`: changes it made owe every command | hooks unit test (stale passing record < 15 min old, call exits 0 and edits a file) |
| 5 | `apps/*` is a paths problem when `apps/` holds package folders (or symlinks to folders) plus only dot files, `README*`, `*.md` or `*.txt`; `src/*` beside a code file still isn't | `resolveVerifyPaths` unit tests (both editions) |
| 6 | ARCHITECTURE.md, ARCHITECTURE.ru.md and the `globProblem` docstring list the `apps/*` problem | review of the diff |
| 7 | Both repos have `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/` (bug, feature, config) and `.github/pull_request_template.md`; none contains an email address or a mention of the other kit | after merge: `gh api repos/rkaliev/<repo>/community/profile` lists every file and `health_percentage` is 100; `grep -E '@[a-z0-9.-]+\.[a-z]'` on the new files finds nothing |
| 8 | Private Vulnerability Reporting is on in both repos | `gh api repos/rkaliev/<repo>/private-vulnerability-reporting` → `{"enabled": true}` |
| 9 | Version 0.39.1 in both editions with a CHANGELOG entry; every existing suite stays green | kit verify script in each repo; PR CI |

## Scope

**In scope:**
- Items 1–5 in both editions (eng-kit `lib/commands.ts`, `lib/hooks.ts`; pi `extensions/lib/commands.ts`, `extensions/verify.ts`) and their tests.
- Docs: ARCHITECTURE(.ru), docstring, CHANGELOG, version bump.
- Community files in both repos, Private Vulnerability Reporting via `gh api` after merge.

**Out of scope:**
- T7–T10 and the 0.39.0 nits (see Follow-ups); any change to guard parsing.
- The "Accept content reports" setting: GitHub has no API for it, so the user switches it on in Settings → Moderation options.

## Decisions

1. U1 matches every gone label, file or folder, without asking git what it was (user, «Все, чей глоб достаёт внутрь»): a deleted file under a `**`-led glob owes that command too. Over-owing on a rare deletion is the fail-safe direction; a git lookup would miss nested repositories outside the index.
2. A failed run takes out of `green` what it did not pass: pi knows each check (failed and skipped ones leave, ones that passed stay as they were); the eng-kit record only says the run failed, so all its commands leave. Only while edits are unverified, like a failed plain command today.
3. eng-kit: a run record belongs to a verify call only if its `startedAt` is at or after that call's PreToolUse time (`verifyCall.at` for the same `tool_use_id`); otherwise the call has no record of its own.
4. `onlyFolders` ignores entries named `.*`, `README*`, `*.md`, `*.txt`, and counts a symlink that resolves to a folder as a folder.
5. Community files (user, «Issues + PR», «Только GitHub»): Contributor Covenant 2.1, enforcement reports through GitHub's "Report content"; security reports through Private Vulnerability Reporting; supported version: the latest release. Files live in the repo root (templates in `.github/`), in English, with no provenance and no cross-links between the kits.
6. Everything ships as 0.39.1 in both editions (user, «Вместе в 0.39.1»); at most two review rounds (patch release).

## Design

- **`commandsUnder(label, commands, scopes)`**: owes a command when one of its globs `reachesInto(glob, label)`. Both are split into segments after `\` → `/` and case folding; label segments are consumed in order: `**` matches zero or more of them, any other glob segment must match the label segment by the existing segment rules (`*`, `?`); the label reaches into the glob only if at least one glob segment remains after the label is consumed (or a `**` is still being consumed). Pure function, no file system.
- **pi `runChecks`**: when not `ok` and `unverified`, delete from `greenSinceEdit` every selected command after the last passing one (the failed one and the skipped ones), then `setStatus`.
- **eng-kit**: a helper `ownRun(state, toolUseId, run)` returns the record only if `state.verifyCall?.id === toolUseId` and `run.startedAt >= state.verifyCall.at`. PostToolUse computes `scriptPassed` and `ran` from it. `creditCall` (verify branch) and `settleLaunch`: a finished, owned run that is not ok removes `run.commands` from `green` when `state.unverified`.
- **`onlyFolders`** filters the entries by Decision 4 before the "only folders" test; a symlink is checked with `statSync` (follows the link).

## Rollout

Release 0.39.1 in both repos through the usual PRs (the user runs push and `gh pr create` with `!`). After merge: enable Private Vulnerability Reporting with `gh api -X PUT repos/rkaliev/<repo>/private-vulnerability-reporting` (approved by the user), check the community profile, and ask the user to switch on content reports. Rollback: revert the release commit; the community files are independent of the code.

## Risks and open questions

- Over-owing on deletions under `**` globs → accepted (Decision 1); the gate names the subset, so the cost is one more check.
- A record from a concurrent session that started after this call's launch can still pass as the call's own → unchanged from 0.39.0 (one project, one verify run at a time); not in scope.
- Contributor Covenant text must be copied verbatim with its attribution → fetch the official 2.1 text, fill only the enforcement contact.

## Follow-ups

- T7: route-folder globs like `app/[id]/**` get a hint (`?`) instead of "syntax not supported".
- T8–T9: one shared `isFolder`; the O(n²) partition in `markEdited` and a stat per label paid without `paths`.
- T10: Unicode case folding (match raw or folded).
- Nits: pi comment at `verify.ts:250` overstates `~` expansion; pi rewrites Unicode spaces and `file://`.
- kit-init proposes `paths`; per-repository `paths` in a workspace.
- Re-measure verify-gate send-backs on real transcripts; realistic guard tails (`# Let's …⏎cmd`, PowerShell `"C:\out\"`, `git fetch && git merge origin/x`, verify credit for `echo x #; npm test`).

## Plan

None yet

## Progress

None yet
