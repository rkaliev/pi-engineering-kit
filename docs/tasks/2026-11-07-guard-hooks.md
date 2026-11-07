# Guard closes case, git-hook and run-record bypasses

Status: in progress
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit 07385cb8c69db4b20a8a9fd73c9a5591f75318f1, pi 805377115352fa381ca329e1f30277478ccbf832
Links: FRAMEWORK-SOURCES §11.46–11.47 follow-ups; user ruling 2026-11-06 on the guard task

<!-- One file per piece of work, standing in for a tracker issue: the sections before Plan are its description. Each section answers one question and never repeats another. Keep every heading; write "None" instead of deleting a section. -->

<details><summary>Original request</summary>

давай

(Reply to: «Начинаю guard-задачу, включая защиту `eng-kit/runs/`? Или сначала разберём мелкие недоделки?». The task itself was set by the user's ruling of 2026-11-06: `.GIT` case-insensitive in all checkPath rules + hook files outside .git = known paths (.husky/, .githooks/, lefthook.yml, .pre-commit-config.yaml) plus core.hooksPath read at session start → confirm; shell writes into .git a separate later task. On the core.hooksPath question the user chose option A: confirm `git config … core.hooksPath` changes.)

</details>

## Intent

The guard stops three cheap bypasses: a capital letter in a protected path, an edit to a git hook that then runs on every commit, and a forged verify-run record that clears the verify gate.

## Context

`checkPath` (`lib/patterns.ts`, the same in both editions apart from the config name and outside-project writes) matches every path rule case-sensitively, but on macOS (APFS) and Windows `.GIT/config` is `.git/config`. Git hook files outside `.git` (`.husky/`, `.githooks/`, lefthook and pre-commit configs, a custom `core.hooksPath`) are edited without a question, though their code runs on the user's machine at every commit. In the Claude edition, `<tmp>/eng-kit/runs/*.json` is protected neither from Write/Edit nor from the shell, and `readRun` does not check who owns the folder, so a forged `{ok:true}` clears the verify gate (§11.47 follow-up).

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | Every `checkPath` path rule ignores case: `.GIT/config` and `.Git/HEAD` are blocked like `.git/…`; `.GITHUB/workflows/x.yml` asks like a CI pipeline; `.ENV` is blocked on read; `ENG-KIT/reviews/…` is blocked; `.CLAUDE/guard.json` (`.PI/guard.json` in pi) asks; a `protectedPaths` prefix matches in any case | unit, `guard.test.ts` in both editions |
| 2 | A Write or Edit (and a quoted-heredoc write) to `.husky/…`, `.githooks/…`, `lefthook.yml`, `lefthook.yaml`, `.lefthook.yml`, `.lefthook.yaml`, `lefthook-local.yml`, `lefthook-local.yaml` or `.pre-commit-config.yaml` asks, with a reason naming git hooks; a path that only resembles them (`docs/husky.md`) is allowed | unit, `guard.test.ts` in both editions |
| 3 | A `core.hooksPath` set in a repository to a folder inside the project, relative or absolute, makes writes under that folder ask; one pointing outside the project adds nothing; an unset key or a failing `git config` leaves only the known list; in a workspace each repository's own `core.hooksPath` applies to that repository | unit (`guard.test.ts`, `scope.test.ts`) and hook-level (`hooks.test.ts` in Claude, `extensions.test.ts` in pi) |
| 4 | `git config` that sets, unsets or replaces `core.hooksPath` (any scope flag, any key case) asks; `git config --get core.hooksPath` and `git config core.hooksPath` with no value are allowed | unit, `guard.test.ts` in both editions |
| 5 | `git -c core.hooksPath=…` (any key case) is blocked like `--no-verify` | unit, `guard.test.ts` in both editions |
| 6 | Claude only: a Write or Edit under `eng-kit/runs/` is blocked; a shell command writing there (by its path as written, its real path or a `$TMPDIR` word) is blocked | unit, `guard.test.ts` and `reviews.test.ts` (`checkGateFiles`) |
| 7 | Claude only: `readRun` and `readRunStart` ignore records in a runs folder owned by another user | unit, `hooks.test.ts` (ownership injected, as `ownDir` tests do) |
| 8 | Claude only: a run of the kit's own `verify.ts`, in the foreground and in the background, is still credited | existing `hooks.test.ts` cases stay green; live check below |
| 9 | Live: in a temp repo with the branch's kit, `claude -p` editing `.husky/pre-commit` gets a confirm (refused in `-p`), and `cat > $TMPDIR/eng-kit/runs/x.json` is blocked | live check script run once, output recorded in Progress |

## Scope

**In scope:**
- Case-insensitive path rules in `checkPath`, both editions.
- The known git-hook paths and the session's `core.hooksPath` as confirm paths, both editions.
- Confirm on `git config` changes to `core.hooksPath`; block on `git -c core.hooksPath=`, both editions.
- Run records protected like review records, Claude edition only (pi verifies in-process and has no run records).
- Version 0.37.0 in both editions, CHANGELOG, `docs/ARCHITECTURE(.ru).md`, workspace `docs/FRAMEWORK-SOURCES.ru.md` §11.48.

**Out of scope:**
- Plain shell writes into `.git` or into hook files (`echo > .husky/x`): a separate later task, as for CI pipelines today.
- Other git-config routes to hooks (`GIT_CONFIG_*` env vars, `include.path`, global config files).
- The verify run recorded under a subfolder's key, and SubagentStop settling a background run (§11.47 follow-ups).

## Decisions

1. Path rules ignore case on every OS (user ruling 2026-11-06: "all checkPath rules"; **assumed**: on Linux a real `.GIT` folder is an accepted false positive, simpler than detecting the file system).
2. Hook files ask, never block (user ruling 2026-11-06).
3. `core.hooksPath` is read once at session start, per repository (user ruling 2026-11-06); mid-session changes are caught by the `git config` confirm rule (user choice A, 2026-11-07).
4. `git -c core.hooksPath=…` is blocked, because it disables hooks for one command exactly as `--no-verify` does (**assumed**, part of the approved design 2026-11-07).
5. Hook-file rules apply where the CI-pipeline rule applies: Write, Edit and quoted-heredoc writes (part of the approved design 2026-11-07).
6. Run records get the full review-record treatment: path block, shell block, owner check (user agreed to include them, 2026-11-07).
7. `lib/patterns.ts` stays the same across editions apart from the existing differences; `compare-editions` reports no new drift.

## Design

- **`checkPath`** (`lib/patterns.ts`): every regex gets the `i` flag; `protectedPaths` prefixes and the guard-config path compare lowercased. A new `GIT_HOOKS` regex beside `CI_PIPELINE` asks: "… is a git hook; its code runs on every commit or push. Show the user the change first." `GuardConfig` gains `hooksPath?: string` (a project-relative folder, filled by the caller, never read from `guard.json`); a write under it asks with the same reason. Claude only: `eng-kit/runs/` is blocked beside `eng-kit/reviews/` ("Run records are written only by the verify script.").
- **Reading `core.hooksPath`**: a helper runs `git config --get core.hooksPath` in a repository (short timeout), resolves the value against the repository root, and returns the project-relative folder, or nothing when it is unset, outside, or git fails. Claude: `SessionStart` (and the baseline path that already records `guardBaseline`) stores it per repository in the session state; PreToolUse puts it into each repository's config before `checkPath`/`scopedPath`. pi: `session_start` keeps it in the extension's memory and passes it the same way.
- **Shell rules** (`checkSegment` / `CONFIRM_RULES`; found while planning: `git config` changes to `core.hooksPath` already ask through the push-setup rule, and `-c core.hooksPath=` already asks, so criterion 4 is pinned by tests and criterion 5 turns an ask into a block): `git … config … core.hooksPath` with a value, `--unset`, `--unset-all` or `--replace-all` asks; `-c core.hooksPath=` blocks. The key match ignores case, as git does.
- **Run records** (Claude): `checkGateFiles` checks the runs folder beside the reviews folder, with the same path forms. `readRun`/`readRunStart` return `undefined` unless `ownDir` holds for the runs folder. `verify.ts` writes from its own Node process, which no guard sees.
- **Errors**: a failure reading `core.hooksPath` falls back to the known list; it never blocks the session.

## Rollout

None beyond the release: branch `feat/guard-hooks` in both repos, 0.37.0, PRs opened by the user with `!`, CI releases on merge.

## Risks and open questions

- Lowercasing could change matches users rely on in `protectedPaths` → only widens what is protected; noted in CHANGELOG.
- Running git at session start costs time in a large workspace → one `git config --get` per repository, bounded by a timeout.
- Open questions: none.

## Follow-ups

- Shell writes into `.git` and into hook files: the guard reads shell write targets for these paths.
- Other git-config routes to hooks (`GIT_CONFIG_*`, `include.path`).

## Plan

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** close the case, git-hook and run-record bypasses of the guard in both editions (run records: Claude only).
**Architecture:** path rules live in `patterns.ts` (`checkPath`, `checkSegment`); `core.hooksPath` is read once per session by a shared helper in `scope.ts` and injected into each root's `GuardConfig` through the `load` callback both editions already pass to `guardScope`; run records reuse the review-record protection in the shared `reviews.ts` and the `ownDir` check.
**Stack / constraints:** Node ≥22.18, TypeScript 5.9.3, `node:test`, no new dependencies. `scope.ts`, `reviews.ts`, `repos.ts`, `shell.ts` stay byte-identical across editions; `patterns.ts` differs only where it does today (config file name, review-stamp wording, outside-project writes). Paths below are Claude-edition paths; the pi twin is `src/extensions/lib/<file>` and `src/tests/<file>`. Every shared change is made in both editions in the same task.
**Verification:** from the workspace root, the kit verify script, bare: `node "<kit>/scripts/verify.ts"` (typecheck and `npm test` of both editions).

### Review focus
1. `core.hooksPath` resolving to the repository root (`.`): every write in that repository asks; pinned in Task 4.
2. A hooks path or known hook path written with `./`, a trailing slash, mixed case or through a symlink: `scopedPath` already judges the real path too; pinned in Task 2.
3. A pi parent from 0.36.0 or earlier leaving a baseline record without `hooks`: the child reads it as `{}`; pinned in Task 6.
4. `git -c core.hooksPath` written as `-ccore.hooksPath=`, `--config-env=core.hooksPath=V`, or with the key in another case: all block; pinned in Task 3.
5. A Claude session resumed or compacted without `hooksPaths` in its state takes them then (restriction only, so no baseline rule applies); pinned in Task 5.

### Post-implementation
- `CHANGELOG.md` (both): 0.37.0 entry; note that path rules now ignore case (only widens what is protected).
- `package.json`, `package-lock.json`, `.claude-plugin/plugin.json` and marketplace version (Claude); `package.json`, `package-lock.json` (pi): 0.37.0.
- `README.md` guard table (both): hook files ask; case is ignored; `git -c core.hooksPath` blocks.
- `docs/ARCHITECTURE.md` + `.ru.md` (both): guard path rules (case, hook files, `core.hooksPath` read at session start); Claude: run records protected and owner-checked beside review records.
- Workspace `docs/FRAMEWORK-SOURCES.ru.md` §11.48: origin, user rulings, what was done, reviews, follow-ups.
- `node tools/compare-editions.mts` from the workspace: no new drift.
- Task file deleted as the last docs commit (git keeps it).

### Task 1: case-insensitive path rules (criterion 1)

**Files:** Modify `lib/patterns.ts` (both) · Test `tests/guard.test.ts` (both)

- [x] Write failing test `paths: every path rule ignores case`: `checkPath("write", p, cwd, {})` is `block` for `.GIT/config`, `.Git/HEAD`, `sub/.GIT/hooks/x`, `/tmp/ENG-KIT/reviews/x.json`; `confirm` for `.GITHUB/workflows/x.yml`, `.GitLab-CI.yml`, `.CLAUDE/guard.json` (pi: `.PI/guard.json`), `.ENV` (write); `checkPath("read", ".ENV", …)` and `read` of `ID_RSA` are `block`; `{ protectedPaths: ["infra/"] }` blocks `INFRA/main.tf`; `.env.EXAMPLE` read stays `allow`
- [x] Run `npm test --prefix src_claude` and `npm test --prefix src` → expect FAIL: `expected 'block', actual 'allow'` for `.GIT/config`
- [x] Add the `i` flag to every regex in `checkPath` and `isSecretPath` (`SECRET_EXAMPLE`, `SECRET_PATTERNS`, `CI_PIPELINE`, the `.git` and `eng-kit/reviews` tests); compare `rel` to the guard-config path and to `protectedPaths` prefixes lowercased
- [x] Run both suites → expect PASS
- [x] Commit in each repo `fix(guard): path rules ignore case, as macOS and Windows file systems do`

### Task 2: known git-hook files and a configured hooks folder ask (criteria 2, 3 unit)

**Files:** Modify `lib/patterns.ts` (both) · Test `tests/guard.test.ts`, `tests/scope.test.ts` (both)
**Interfaces:** Produces `GuardConfig.hooksPath?: string` (a folder relative to the config's root, set by the caller, never read from `guard.json`) and `GIT_HOOKS: RegExp`

- [x] Write failing test `paths: git hook files ask`: `write` and `edit` of `.husky/pre-commit`, `.husky/_/h`, `.githooks/pre-push`, `lefthook.yml`, `lefthook.yaml`, `.lefthook.yml`, `.lefthook.yaml`, `lefthook-local.yml`, `lefthook-local.yaml`, `.pre-commit-config.yaml`, `./.husky/pre-commit` are `confirm` with a reason matching `/git hook/`; `docs/husky.md`, `src/lefthook.yml.bak`, `husky/pre-commit` are `allow`; a heredoc `cat > .husky/pre-commit <<'EOF'` through `checkCommand` is `confirm`
- [x] Write failing test `paths: a configured hooks folder asks`: with `{ hooksPath: "tools/hooks" }`, `tools/hooks/pre-commit` and `TOOLS/Hooks/x` ask, `tools/hooksx/a` and `tools/a` are allowed; with `{ hooksPath: "" }` (the root) `src/a.ts` asks
- [x] Write failing test in `scope.test.ts` `scopedPath: a repository's hooks folder asks under it`: a workspace repo `a` with config `{ hooksPath: "hooks" }` makes `a/hooks/pre-commit` ask and leaves `hooks/pre-commit` at the workspace root allowed
- [x] Run both suites → expect FAIL: `expected 'confirm', actual 'allow'`
- [x] Implement `GIT_HOOKS = /^(\.husky\/|\.githooks\/|\.?lefthook(-local)?\.ya?ml$|\.pre-commit-config\.yaml$)/i` beside `CI_PIPELINE` with reason "`<path>` is a git hook; its code runs on every commit or push. Show the user the change first."; the `hooksPath` check (`rel` lowercased equals the folder or starts with `folder + "/"`; `""` matches every `rel`) gives the same reason
- [x] Run both suites → expect PASS
- [x] Commit `feat(guard): editing a git hook file asks`

### Task 3: hooks bypass on the command line blocks; config changes ask (criteria 4, 5)

**Files:** Modify `lib/patterns.ts` (both, `checkSegment`) · Test `tests/guard.test.ts` (both)

- [ ] Write failing test `git -c core.hooksPath blocks like --no-verify`: `block` for `git -c core.hooksPath=/dev/null commit -m x`, `git -ccore.hooksPath=x commit`, `git -c CORE.HOOKSPATH=x push`, `git --config-env core.hooksPath=V commit`, `git --config-env=core.hookspath=V commit`, `(git -c core.hooksPath= commit)`; move `git -c core.hooksPath=/x commit -m x` out of the confirm list of `-c asks only for keys that move where git pushes or what it runs`
- [ ] Write pinning test `git config changes to core.hooksPath ask; reading it is quiet`: `confirm` for `git config core.hooksPath x`, `git config --local core.hooksPath x`, `git config --global core.hookspath x`, `git config set core.hooksPath x`, `git config --unset core.hooksPath`, `git config --unset-all core.hooksPath`, `git config --replace-all core.hooksPath x`; `allow` for `git config --get core.hooksPath`, `git config core.hooksPath`, `git config get core.hooksPath` (already holds: run it once to see it pass and record that in Progress)
- [ ] Run both suites → expect FAIL only in the first test: `expected 'block', actual 'confirm'`
- [ ] In `checkSegment`, after the `--no-verify` check: a `git` word followed (before the subcommand) by `-c <k>=…`, `-c<k>=…`, `--config-env <k>=…` or `--config-env=<k>=…` where `k` lowercased is `core.hookspath` returns `block`, reason "Overriding core.hooksPath on the command line skips or replaces the git hooks. Fix what the hook reports instead."
- [ ] Run both suites → expect PASS
- [ ] Commit `fix(guard): git -c core.hooksPath blocks like --no-verify`

### Task 4: read core.hooksPath per repository (criterion 3, shared helper)

**Files:** Modify `lib/scope.ts` (both, byte-identical) · Test `tests/scope.test.ts` (both)
**Interfaces:** Produces `hooksPaths(projectDir: string): Record<string, string>`, keyed by each root as `guardScope` names it (`projectDir`, `join(projectDir, name)`), valued by a folder relative to that root (`""` for the root itself)

- [ ] Write failing test `hooksPaths: each repository's own core.hooksPath inside it`: in temp repos (`git init`, `git config core.hooksPath …`): a repo with `tools/hooks` → `{ [repo]: "tools/hooks" }`; absolute `<repo>/x` → `"x"`; `.` → `""`; `../outside` and `/tmp/elsewhere` → no key; unset → no key; a workspace with repos `a` (`h`) and `b` (unset) → `{ [join(ws,"a")]: "h" }`; a folder that is no repository → `{}`
- [ ] Write failing test `hooksPaths: a failing git leaves nothing`: with `PATH` pointing at an empty folder for the call → `{}` without throwing
- [ ] Run both suites → expect FAIL: `expected { … }, actual {}` (stub returning `{}` added first)
- [ ] Implement: for `projectDir` when `projectRepos(projectDir).kind === "repo"`, and for each workspace repo, `spawnSync("git", ["-C", root, "config", "--type=path", "--get", "core.hooksPath"], { timeout: 1000 })`; on status 0 resolve the trimmed value against the root (`git rev-parse --show-toplevel` not needed: the root is the top level), keep it when it is the root or inside it, store `relative(root, value)` with `\` → `/`
- [ ] Run both suites → expect PASS; `cmp src/extensions/lib/scope.ts src_claude/lib/scope.ts` → no output
- [ ] Commit `feat(guard): read each repository's core.hooksPath`

### Task 5: Claude wiring (criterion 3 hook-level)

**Files:** Modify `src_claude/lib/state.ts`, `src_claude/lib/hooks.ts` · Test `src_claude/tests/hooks.test.ts`
**Interfaces:** Consumes `hooksPaths` (Task 4) · Produces `SessionState.hooksPaths?: Record<string, string>`

- [ ] Write failing test `guard: the hooks folder a repository configures asks, from the session start`: temp repo with `core.hooksPath tools/hooks`; `SessionStart` (source `startup`), then `PreToolUse` Write `tools/hooks/pre-commit` → `permissionDecision: "ask"`; a workspace with repo `a` configuring `h` → Write `a/h/x` asks; changing the config after SessionStart to `other` leaves `other/x` allowed (read once)
- [ ] Write failing test `guard: a resumed session without hooks paths takes them`: state saved without `hooksPaths`, `SessionStart` source `resume` → Write `tools/hooks/x` asks
- [ ] Run `npm test --prefix src_claude` → expect FAIL: `expected 'ask', actual undefined`
- [ ] `state.ts`: parse `hooksPaths` (an object of strings, else `undefined`). `hooks.ts`: `sessionStart` stores `hooksPaths(env.projectDir)` when the state has none, for every source, via `bestEffort`; both `guardScope` calls pass `load` as `(root) => ({ ...<current load>(root), hooksPath: hooks[root] })` with `hooks = session.hooksPaths ?? {}`
- [ ] Run → expect PASS
- [ ] Commit `feat(guard): the session's hooks folders ask (Claude)`

### Task 6: pi wiring (criterion 3 hook-level)

**Files:** Modify `src/extensions/guard.ts` · Test `src/tests/extensions.test.ts`
**Interfaces:** Consumes `hooksPaths` (Task 4) · Produces `BaselineRecord.hooks: Record<string, string>`

- [ ] Write failing test `guard: the hooks folder a repository configures asks, from the session start`: as in Task 5 through `session_start` and a `write` `tool_call` (headless ctx → blocked with "Needs human confirmation"); a later config change is not seen
- [ ] Write failing test `guard: a child keeps its parent's hooks folders; an older parent's record without them reads as none`: `ENG_KIT_GUARD_BASELINE` with `hooks` → child asks for that folder; a record without `hooks` → the child still starts and a write under the configured folder of its own checkout asks (the own-checkout judgement reads `hooksPaths(top)` once per `top`)
- [ ] Run `npm test --prefix src` → expect FAIL: `expected block, actual undefined`
- [ ] `take()` adds `hooks: hooksPaths(ctx.cwd)` to a new record; `inherited()` accepts a record without `hooks` as `{}`; `judge()` receives the hooks map and wraps `loadConfig` as in Task 5; the own-checkout call uses a `Map<string, Record<string,string>>` memo of `hooksPaths(top)`
- [ ] Run → expect PASS
- [ ] Commit `feat(guard): the session's hooks folders ask (pi)`

### Task 7: run records protected like review records (criteria 6, 7, 8)

**Files:** Modify `lib/patterns.ts` (both), `lib/reviews.ts` (both, byte-identical), `src_claude/lib/state.ts` · Test `tests/guard.test.ts` (both), `tests/reviews.test.ts` (both), `src_claude/tests/hooks.test.ts`

- [ ] Write failing tests: `checkPath("write", <tmpdir>/eng-kit/runs/x.json)` and `ENG-KIT/Runs/x.json` → `block`, reason matching `/verify script/`; `checkGateFiles` (`reviews.test.ts`) → `block` for `echo '{"ok":true}' > $TMPDIR/eng-kit/runs/x.json`, `cp f ${TMPDIR}/eng-kit/runs/`, `cd $TMPDIR/eng-kit && tee runs/x.json`, the real-path form, and `allow` for `ls $TMPDIR/eng-kit/runs`
- [ ] Write failing test in `hooks.test.ts` `verify gate: a run record in a folder another user owns is ignored`: `readRun(project, root, () => false)` and `readRunStart(project, root, () => false)` → `undefined` for records `readRun(project, root)` reads
- [ ] Run both suites → expect FAIL: `expected 'block', actual 'allow'` and `expected undefined`
- [ ] `patterns.ts`: a separate `eng-kit/runs/` check (case-insensitive) after the reviews one, reason "Verify-run records are written only by the verify script. Run it instead." `reviews.ts` `checkGateFiles`: the runs folder beside the reviews folder in `records` and in the `$TMPDIR` word test, with the same reason for a runs hit. `state.ts`: `readRun` and `readRunStart` gain `owned: (dir: string) => boolean = ownDir` and return `undefined` when `!owned(dirname(file))`
- [ ] Run both suites → expect PASS, including the existing foreground and background verify-credit cases in `hooks.test.ts` (criterion 8); `cmp` of `reviews.ts` → no output
- [ ] Commit `fix(verify-gate): run records are protected and owner-checked like review records`

### Task 8: docs, version, live check (criterion 9)

**Files:** Modify the files in Post-implementation · Create a live-check script in the session scratchpad only

- [ ] Live check: temp git repo with `.husky/` and the branch's kit via `claude -p --plugin-dir src_claude` (installed eng-kit disabled): a prompt to edit `.husky/pre-commit` is refused with the git-hook reason and the file is unchanged; a prompt to run `cat > "$TMPDIR/eng-kit/runs/x.json"` is refused with the verify-script reason. Record both outputs in Progress
- [ ] Update every file in Post-implementation; bump both editions to 0.37.0
- [ ] Run the kit verify script from the workspace root → expect all four commands PASS; `node tools/compare-editions.mts` → no new drift
- [ ] Commit `docs: guard closes case, git-hook and run-record bypasses (0.37.0)` in each repo

## Progress

- Baseline (2026-11-07): verify run had one failure, pi `extensions.test.ts` "review gate: the lookups for one reviewer run share one deadline…" (actual [] vs one Inconclusive record) under full parallel load; alone 3/3 green. Same timing-test family as the §11.45 follow-up; not touched by this branch.
- Drift check: no changes to lib/, extensions/ or tests/ since the plan's Base.
- Ruling: Task 1 also lowercases the workspace rule in `scope.ts` `scopedPath` (a first-level folder's guard config outside git) — criterion 1 says every path rule, and that one is a path rule beside `checkPath` — cost if wrong: one extra lowercase compare. Test: the existing first-level-folder test in `scope.test.ts` gained an `x/.CLAUDE/guard.json` (pi: `.PI`) assertion, seen failing first.
- Task 1: complete (eng-kit and pi, kit verify script → all 4 checks PASS; RED seen: guard `expected 'block', actual 'allow'` for `.GIT/config`, scope `expected 'confirm', actual 'allow'`)
- Task 2: complete (eng-kit and pi, kit verify script → all 4 checks PASS; RED seen: 3 tests `expected 'confirm', actual 'allow'`)
