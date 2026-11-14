# Verify gate owes what failed or vanished, and the repo meets GitHub Community Standards

Status: design approved (2026-11-14)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit 2818091, pi 28ec758
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

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** close the three fail-open gaps and the `apps/*` miss of the 0.39.0 verify gate in both editions, add the GitHub community files, and release 0.39.1.
**Architecture:** pure-function change in `commands.ts` (`commandsUnder`, `onlyFolders`), identical in both editions; state changes in the gate's run handling (pi `runChecks` in `extensions/verify.ts`, eng-kit `postToolUse`/`creditCall`/`settleLaunch` in `lib/hooks.ts`). Community files are static Markdown/YAML.
**Stack / constraints:** Node ≥ 22.18 running `.ts` directly, `node:test`, TypeScript 5.9.3, no new dependencies. Files in English, no provenance, no cross-links between the kits, no email addresses. Commits with the repo-local identity and no Claude/Co-Authored-By trailers. Each task is done in eng-kit (`src_claude/`) and pi (`src/`); paths below are eng-kit first, pi second.
**Verification:** in each repo `npm test` and `npm run typecheck` (eng-kit also `npm run validate`); CI runs `check` (Node 22/24), `security`, `gate`.

### Review focus
1. A glob that ends exactly at the label (`vendor/lib`, `vendor/*`) must not count as reaching inside it; `vendor/lib/**` and `vendor/*/**` must → Task 1 unit rows.
2. A failed run that ran a subset (`--only`, `only`) must take out only what it selected, never commands outside the selection → Task 2 test with a subset.
3. A record without `startedAt` (written by a pre-0.36 script) is not the call's own → Task 3 row.
4. The eng-kit foreground verify call still credits a fresh passing record of its own exactly as before (no regression to "nothing credits") → Task 3 control assertion.
5. `apps/*` with only a README and no folders is not a problem (a folder is still required) → Task 4 row.

### Post-implementation
- `docs/ARCHITECTURE.md` + `.ru.md` (both repos): the Stop / `verify.ts` rows — the `apps/*` problem in the list of globs that can never match (U3), a deleted label owing commands whose globs reach inside it, a failed run taking its checks out of green, and (eng-kit) a record counting only for the call that launched it. Done in Task 6.
- `CHANGELOG.md` `## 0.39.1` (both); version 0.39.1 in eng-kit `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`; pi `package.json`, `package-lock.json`, `README.md`, `docs/GETTING-STARTED.md`, `docs/GETTING-STARTED.ru.md`, `templates/settings.json` (`.github/release.ts` check fails otherwise). Task 6.
- README: none — the verify.json section doesn't describe these edge cases.
- What outlives this file: behavior goes to ARCHITECTURE; decisions 1–3 go into the CHANGELOG wording; the community files are themselves the lasting artifact. Then delete this file.

### Task 1: a gone label owes every command whose globs reach inside it (C1)

**Files:** Modify `lib/commands.ts` · `extensions/lib/commands.ts` · Test `tests/commands.test.ts` (both), `tests/hooks.test.ts`, `tests/extensions.test.ts`
**Interfaces:** `commandsUnder(folder: string, commands: string[], scopes: Map<string, string[]>): string[]` keeps its signature; new private `reachesInto(glob: string, folder: string): boolean`

- [ ] Add test `commandsUnder: a glob that can match a path inside a gone label (0.39.1, U1)` (both editions): scopes `{fmt: ["docs/**"], tsc: ["**/*.ts"], vend: ["vendor/*/src/**"], pk: ["packages/**"], exact: ["vendor/lib"], star: ["vendor/*"], deep: ["Vendor/*/**"]}`; `commandsUnder("vendor/lib", all, scopes)` deep-equals `["tsc", "vend", "deep"]`; `commandsUnder("vendor/li", ["vend"], …)` → `["vend"]` (a `*` segment matches `li` too); existing round-3 T1 rows stay unchanged.
- [ ] Add gate tests `verify paths: a deleted submodule under a wildcard glob owes its command (0.39.1, U1)`: copy the round-3 T1 test with `paths: {fmt: ["docs/**"], test: ["**/*.ts"]}`; Stop reason matches `/--only "test"/` (eng-kit hooks) / the follow-up matches `only: ["test"]` (pi extension).
- [ ] Run `node --test tests/commands.test.ts tests/hooks.test.ts` (pi: `tests/commands.test.ts tests/extensions.test.ts`) → expect FAIL: the unit row gets `[]`-like results without `tsc`/`vend`, the gate test gets no block (`undefined`).
- [ ] Implement `reachesInto`: fold case and `\`→`/` on both, split into segments; walk the label's segments: `**` may consume zero or more of them, any other glob segment must match the label segment with `globToRegExp(segment)`; true only if, after the whole label is consumed, at least one glob segment remains or the glob is at a `**`. `commandsUnder` = commands with some glob `reachesInto` the folder. Update its docstring.
- [ ] Run both test files → PASS; then `npm test` and `npm run typecheck` in each repo.
- [ ] Commit in each repo `fix(verify): a gone folder owes the commands whose globs reach inside it`

### Task 2: eng-kit — a verify call uses only its own run record (C4)

**Files:** Modify `lib/hooks.ts` · Test `tests/hooks.test.ts`
**Interfaces:** Produces `ownRun(state: SessionState, toolUseId: string | undefined, run: RunRecord | undefined): RunRecord | undefined`

- [ ] Write test `verify gate: a verify call that wrote no record of its own exempts nothing (0.39.1)`: `setupGit`; SessionStart; `bash("npm test")`, `bash("npm run typecheck")`; write a passing record `{ok: true, commands: both, startedAt: now - 60_000, finishedAt: now - 30_000}`; `bash(\`node "<kit>/scripts/verify.ts" 2>&1 | tail -30\`, {}, () => edit("export const a = 2;\n"))` → Stop reason matches `/src\/a\.ts/`. Same with a record that has no `startedAt` (review focus 3). Control (review focus 4): the record written inside `during` with `startedAt: Date.now()` → Stop is `{}`.
- [ ] Run `node --test tests/hooks.test.ts` → expect FAIL: Stop returns `{}` for the stale record.
- [ ] Implement `ownRun`: returns `run` only when `toolUseId` and `state.verifyCall?.id === toolUseId` and `run.startedAt !== undefined && run.startedAt >= state.verifyCall.at`. In `postToolUse` compute `const ownRecord = ownRun(loadState(…), input.tool_use_id, readRun(…))` once, before `trackTree` and `reported()` (which clears `verifyCall` on success); `scriptPassed` and `ran` use it; a call without one gets `ran = []` and no exemption.
- [ ] Run the full suite. Tests that seed a record *before* the call and expect it to exempt the call's writes now fail; each is changed in a separate commit `test(verify): write the run record during the call, as the script does` that moves the `run(...)`/`writeRun` into the call's `during` with `startedAt: Date.now()`, its body listing each test and why (the old order is a record from an earlier run). Any other failure is a stop: report it.
- [ ] Run `npm test` + typecheck → PASS.
- [ ] Commit `fix(verify): a verify call credits and exempts only by its own run record`

### Task 3: a failed run takes the checks it didn't pass out of green (C2, C3)

**Files:** Modify `extensions/verify.ts` (pi), `lib/hooks.ts` (eng-kit) · Test `tests/extensions.test.ts`, `tests/hooks.test.ts`
**Interfaces:** eng-kit: Consumes `ownRecord` (Task 2) as a new `creditCall` argument; `settleLaunch` keeps its own `startedAt >= launch` rule.

- [ ] pi test `verify: a failed run_verification takes the checks it didn't pass out of green (0.39.1)`: a `pathsProject`-like setup with `fakePi(codes)` where `codes` is a mutable object; edit `src/a.ts`; `run(["fmt"])` passes; set `codes.fmt = 1`; `run()` → follow-up matches `` /`fmt`/ `` and `` /`test`/ `` and doesn't match `/only:/`. Second case (review focus 2): with `paths: {test: ["src/**"], lint: ["src/**"]}`, commands `["fmt", "lint", "test"]`, edit `docs/x.md` + `src/a.ts`, `run(["lint"])` passes, `codes.fmt = 1`, `run(["fmt"])` fails → follow-up names `fmt` and `test`, not `` `lint` ``.
- [ ] eng-kit tests `verify gate: a failed verify run takes its commands out of green (0.39.1)`: (a) foreground: `setupGit`, edit, `bash("npm test")` passes, then an unpiped verify-script call reported as `PostToolUseFailure` whose `during` writes `{ok: false, commands: ["npm test", "npm run typecheck"], startedAt: now, finishedAt: now}` → Stop reason has no `--only` and matches `` /`npm test`/ ``; (b) background: same with `launchedVerify` (`bash("npm test")` first, then `finished({ ok: false })`) → Stop reason matches `` /`npm test`/ ``.
- [ ] Run the two test files → expect FAIL: the reason/follow-up offers only the other command (`--only "npm run typecheck"` / `only: ["test"]`).
- [ ] Implement. pi `runChecks`: when `!ok` and `unverified`, delete `commands.slice(results.length - 1)` (the failed one and the skipped ones) from `greenSinceEdit`, then `setStatus(ctx)`. eng-kit: pass `ownRecord` (Task 2) into `creditCall`; in its record branch, an `ownRecord` that is not ok while `state.unverified` saves `{...state, green: state.green.filter((c) => !run.commands.includes(c))}` through `credited(…, [])`; in `settleLaunch`, a finished run with `startedAt >= launch` and `!run.ok` does the same before `settled`.
- [ ] Run the test files → PASS; full `npm test` + typecheck in each repo.
- [ ] Commit `fix(verify): a failed run takes the checks it didn't pass out of green`

### Task 4: `apps/*` beside READMEs, dot files and folder symlinks (C5, C6 docstring)

**Files:** Modify `lib/commands.ts` · `extensions/lib/commands.ts` · Test `tests/commands.test.ts` (both)

- [ ] Add test `resolveVerifyPaths: apps/* is a problem beside dot files, READMEs and folder symlinks (0.39.1, U2)`: `apps/web/`, `apps/api/` plus `apps/.DS_Store`, `apps/.gitkeep`, `apps/README.md`, `apps/notes.txt` → the round-3 T4 problem text for `"apps/*"`; `apps/web` as a symlink to `../pkgs/web` (a folder) plus `apps/README.md` → same problem; controls: `src/*` with `src/index.ts` and `src/lib/` → no problem; `apps/*` with only `apps/README.md` → no problem.
- [ ] Run `node --test tests/commands.test.ts` → expect FAIL: `problems` is `[]` for the first two cases.
- [ ] Implement in `onlyFolders`: skip entries named `.*`, `README*`, `*.md`, `*.txt` (case folded); an entry is a folder if `isDirectory()` or a symlink whose `statSync` is a directory; require at least one folder and every remaining entry a folder. Add the `apps/*` problem to the `globProblem` docstring.
- [ ] Run → PASS; full suite + typecheck.
- [ ] Commit `fix(verify): apps/* over package folders is a problem beside READMEs and dot files`

### Task 5: GitHub community files (C7)

**Files:** Create in each repo `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/pull_request_template.md`

- [ ] `CODE_OF_CONDUCT.md`: Contributor Covenant 2.1, verbatim from contributor-covenant.org, with the enforcement contact replaced by "using GitHub's **Report content** option on the comment, issue or pull request, or by reporting the account to GitHub"; keep its attribution section.
- [ ] `CONTRIBUTING.md`: issues for bugs and ideas (templates), a discussion issue before a large change; setup (`npm ci`, Node ≥ 22.18), checks (`npm test`, `npm run typecheck`, eng-kit also `npm run validate`); one branch per change, Conventional Commit messages as in `git log`, a CHANGELOG line for user-visible changes; `main` is protected and needs the `gate` check; by contributing you license under the repo's MIT license; security issues go to SECURITY.md, conduct to CODE_OF_CONDUCT.md.
- [ ] `SECURITY.md`: supported version = the latest release; report through GitHub's **Report a vulnerability** (Security tab, private vulnerability reporting), never a public issue; what to include; acknowledgement within 7 days (**assumed**, tell the user in the PR); scope note: the guard and gates reduce agent mistakes and are not a sandbox.
- [ ] Issue forms: bug (version, Claude Code/pi version, OS, what happened, expected, steps, logs with secrets removed), feature (problem, proposal, alternatives); `config.yml` with `blank_issues_enabled: false` and a contact link "Security vulnerability" to `https://github.com/rkaliev/<repo>/security/advisories/new`.
- [ ] PR template: summary, linked issue, checklist (tests added or why not, `npm test` + typecheck pass, CHANGELOG updated for user-visible changes, docs updated).
- [ ] Check: `grep -rEn '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' CODE_OF_CONDUCT.md CONTRIBUTING.md SECURITY.md .github/ISSUE_TEMPLATE .github/pull_request_template.md` → no output; the other kit's name and `superpowers` → no output; `npm test` still PASS (scope/hygiene tests may list root files — if one fails, read it before changing anything).
- [ ] Commit `docs: community health files`

### Task 6: docs and release 0.39.1 (C6, C9)

**Files:** Modify `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE.ru.md`, `CHANGELOG.md`, version files listed in Post-implementation

- [ ] ARCHITECTURE (en and ru, both repos): in the Stop / `verify.ts` rows add `apps/*` over package folders to the "glob that can never match" list; "a label that is gone also owes the commands with globs inside it" → "…whose globs can match a path inside it"; a failed run takes the checks it didn't pass out of green; eng-kit: a run record counts only for the verify call that launched it.
- [ ] `CHANGELOG.md` `## 0.39.1` (both): one bullet per user-visible change (Tasks 1–5), in the 0.39.0 style.
- [ ] Bump the version in every file listed in Post-implementation (`npm install --package-lock-only` for the lockfile).
- [ ] Run `npm test`, `npm run typecheck` (eng-kit `npm run validate`) and `node .github/release.ts check` if it has a CLI entry (else `tests/release.test.ts` covers it) → PASS.
- [ ] Commit `chore(release): 0.39.1`

### Task 7: after merge (user runs push and PR commands; then)

- [ ] `gh api -X PUT repos/rkaliev/eng-kit/private-vulnerability-reporting` and the same for `pi-engineering-kit`; `gh api repos/rkaliev/<repo>/private-vulnerability-reporting` → `{"enabled":true}` (C8).
- [ ] `gh api repos/rkaliev/<repo>/community/profile --jq .health_percentage` → `100` and every file listed (C7); ask the user to switch on Settings → Moderation options → Reported content.

## Progress

None yet
