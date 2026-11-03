# The guard protects every repository of a workspace as it protects one repository

Status: plan approved (2026-11-03)
Base: ecb93b9 (eng-kit), 4acc4d5 (pi)
Links: follow-up 1 of `docs/tasks/2026-10-23-workspace-gates.md` (deleted in 4773b06; eng-kit) · FRAMEWORK-SOURCES §11.44 and the 0.34.x entries of both CHANGELOGs

<details><summary>Original request</summary>

«что у нас по плану?» → the answer listed the open items, item 1 "Guard in a folder of repositories (security gap)" recommended first → «давай как рекомендуешь». Choices made in the conversation: approach «Судить «как в нём»»; loosening rules «Только репозиторий, куда попадает действие». Design: «давай».

</details>

## Intent

Someone who starts Claude Code or pi in a folder that is not a git repository but holds several (a workspace, see `projectRepos`) gets the same guard in each repository as a session started inside it: CI and protected paths ask or block, the repository's own `guard.json` applies, task files can't leak to its base branch, the approval gate reminds, and a plain push of the own work branch passes without a question.

## Context

0.34.0 made the verify and review gates work in a workspace (`lib/repos.ts`, per-repository review stores, the review gate following `cd` and `-C` to the landing's checkout). The rest of the guard still measures paths from the session folder and runs git only there. A probe on 2026-11-03 (temp workspace with repository `a`, the kit's own functions) showed: a write to `a/.github/workflows/ci.yml` → allow (inside `a`: confirm); a write to `a/.claude/guard.json` → allow; `a`'s `protectedPaths` → not read; `cd a && gh pr create` with a task file on the branch → allow (inside `a`: block); `uncommittedApproved` in the workspace → `[]`; `git -C a push` of the own work branch → asks (`commonDir` of the workspace is undefined).

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | In a workspace, a Write/Edit of `a/.github/workflows/ci.yml` (or another CI pipeline path) asks, and a write of `a/.claude/guard.json` (`.pi/guard.json` in pi) asks, by Write and by a shell write | unit: guard.test.ts; hooks: hooks.test.ts / pi extensions.test.ts in a temp workspace |
| 2 | `a`'s `protectedPaths` block writes under `a/`, measured from `a`; `a`'s `block` and `confirm` rules apply to a command that runs in `a` (`cd a && …`, `git -C a …`) and to a command whose folder the guard can't tell, and not to `cd b && …` | unit: guard.test.ts |
| 3 | `a`'s `allow` rules apply only when every segment of the command runs in `a`; the workspace's own `allow` applies everywhere | unit: guard.test.ts |
| 4 | `cd a && gh pr create` and `git -C a push origin feat/x:main` with a task file in `a` are blocked; `a`'s `workDocs` setting decides `a`'s folders; a landing whose repository the guard can't tell is blocked with a reason | unit: workdocs.test.ts |
| 5 | `"reviewGate": false` in `a` lifts the review gate for landings in `a` only; a PR from `b` is still gated | unit: reviews.test.ts |
| 6 | `git -C a push` of `a`'s current convention-named work branch passes without a question, under the same conditions as inside `a`; the implementer is still asked | unit: guard.test.ts; hooks: implementer case |
| 7 | Stop names approved but uncommitted task files and finished task files of every workspace repository (`a/docs/tasks/x.md`), each with its own base branch; repositories it ran out of time for are named in a warning | hooks: hooks.test.ts; pi: extensions.test.ts |
| 8 | A session inside one repository behaves as before | the existing suites, unchanged, in both editions |
| 9 | Live: a Claude Code session in a scratch workspace with `--plugin-dir src_claude` is asked before writing `a/.github/workflows/ci.yml` | manual: one session — hook delivery can't be simulated, agreed 2026-11-03 |

## Scope

**In scope:**
- both editions: Claude Code (`lib/hooks.ts`, `lib/patterns.ts`, `lib/workdocs.ts`) and pi (`extensions/guard.ts`, `extensions/verify.ts`, `extensions/lib/patterns.ts`, `extensions/lib/workdocs.ts`);
- shared byte-identical files as needed: `lib/repos.ts`, `lib/reviews.ts`, `lib/shell.ts`, `lib/approvals.ts`;
- ARCHITECTURE (en, ru), README, CHANGELOG 0.35.0 in both repositories; FRAMEWORK-SOURCES §11.45 covering 0.34.0, 0.34.1 and 0.35.0.

**Out of scope:**
- new guard rules: what the guard doesn't catch in one repository (for example a write of `verify.json`) stays uncaught in a workspace;
- pi S18 (mirror non-Yes verdicts into the workspace folder's store) — a review-gate change, not the guard;
- the case-sensitive `.git` match and unprotected husky / `core.hooksPath` hooks — gaps of one repository too;
- the token ledger and kit-init detection in a workspace (follow-up 2 of the 0.34.0 task).

## Decisions

1. Judge as inside the repository (user, 2026-11-03): a path or command is first placed in its repository, then checked by the same rules as a session there; the workspace's own rules are checked on top and the strictest decision wins (block > ask > allow).
2. Restrictions add up: `block`, `confirm` and `protectedPaths` of the workspace and of the repository both apply, each measured from its own root.
3. Loosening only where it is written (user, 2026-11-03): a repository's `allow`, `"reviewGate": false` and `workDocs` apply only to actions that land or run in that repository; the workspace's own apply everywhere.
4. A folder the guard can't tell is the strictest case: every repository's restrictions apply, no repository's loosening does, and a landing there is blocked as the review gate blocks it.
5. Ruling while planning (2026-11-03): rules combine into one config per command, so an `allow` that applies (the workspace's, or the one repository's) skips the combined `confirm` rules, as a single config's `allow` skips its own; it never skips a `block`. Cost if wrong: a workspace `confirm` rule a repository's `allow` also matches doesn't ask.
6. Ruling while planning (2026-11-03): in pi a repository's loosening is read only when the session's project is trusted (`ctx.isProjectTrusted()`), as the session folder's is today.
7. Constraints: Node ≥ 22.18 running `.ts` natively, `node:test`, no new dependencies; `lib/repos.ts`, `lib/reviews.ts`, `lib/shell.ts`, `lib/approvals.ts` stay byte-identical between the editions; at most 32 repositories (`MAX_REPOS`); a session inside one repository keeps today's behaviour.

## Design

**Placement.** A new `repoOf` (lib/repos.ts) returns the workspace repository holding a path. The review gate's directory tracking (`Subshells` in the shared lib/shell.ts, which follows the move words in `MOVES`, and a landing's `-C`) is wrapped in one exported function that returns, for a command started in `cwd`, the folder each segment runs in, `undefined` where it can't tell.

**Config.** A guard config is loaded per root (the workspace, each repository that has one). The effective config for an action combines: the workspace's restrictions and loosening, plus the restrictions of every repository the action runs or lands in (all repositories when a folder is unknown), plus that repository's loosening only when the action runs or lands in exactly that one. An invalid repository config gives a warning naming its path and is ignored, as today.

**Paths** (Write, Edit, a heredoc write target, `checkGateFiles`): a path inside repository `a` is judged twice, by `checkPath` from the workspace with its config and from `a` with `a`'s config; the strictest decision wins. `a`'s `guard.json` is a gate file like the workspace's.

**Commands:** `checkCommand` runs with the effective config above. `ownBranchPush` compares the pushed repository's common git dir with that of the workspace repository holding the push's folder, instead of the session folder's. `checkWorkDocs` judges each landing in the repository it lands in (the same tracking), with that repository's task-file folders; an unknown landing folder in a workspace blocks. The review gate skips a landing in a repository whose config sets `"reviewGate": false`.

**Stop** (Claude `stopGates`, pi `verify.ts`): `uncommittedApproved` and `finishedWorkDocs` run in each workspace repository with its folders, paths prefixed with the repository name, `onBaseBranch` per repository, within a time budget; repositories left out are named.

**Cost:** each PreToolUse adds `projectRepos` (one `git rev-parse` and a directory read) and up to 32 small JSON reads; other git calls run only where they run today.

## Rollout

Release 0.35.0 in both editions. Rollback: revert the release; no stored state changes.

## Risks and open questions

- A repository's `block` rule now also applies to a command whose folder is unknown, so a workspace may block what each repository alone wouldn't → the reason names the repository config the rule came from; accepted as fail-closed.
- Stop over many repositories may approach the hook timeout → a time budget with the skipped repositories named.
- No open questions.

## Follow-ups

- pi S18: mirror non-Yes verdicts into the workspace folder's store and merge it in `uncovered`.
- Case-insensitive `.git` match (`.GIT/`) and protection of husky / `core.hooksPath` hooks, in one repository and in a workspace.
- The token ledger and kit-init command detection in a workspace.
- A workspace of more than 32 repositories is not a workspace and keeps the single-folder guard.

## Plan

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** in a workspace, every guard check judges a path or command in the repository it belongs to, with that repository's config, and the workspace's checks on top.
**Architecture:** two placement primitives (`repoOf`, `segmentFolders`) and a new shared `lib/scope.ts` that loads the configs in force and combines them for a path or a command; the existing checks (`checkPath`, `checkCommand`, `ownBranchPush`, `checkWorkDocs`, the review gate, the Stop reminders) take the placement instead of the session folder. Built in the Claude edition first (Tasks 1–7), then ported to pi (Tasks 8–9), then docs and release (Task 10).
**Stack / constraints:** Node ≥ 22.18 running `.ts` natively, `node:test`, TypeScript `tsc --noEmit`, no new dependencies. Byte-identical between `src_claude/lib/` and `src/extensions/lib/` (`cmp` must pass): `repos.ts`, `shell.ts`, `reviews.ts`, `approvals.ts`, new `scope.ts`; imports stay relative (`./patterns.ts`). Edition files: Claude `lib/patterns.ts`, `lib/workdocs.ts`, `lib/hooks.ts`, guard config `.claude/guard.json`; pi `extensions/lib/patterns.ts`, `extensions/lib/workdocs.ts`, `extensions/guard.ts`, `extensions/verify.ts`, guard config `.pi/guard.json`. Stop reminder budget `TASK_FILE_BUDGET_MS = 3000` (hook timeout is 10 s). Everything written in English. Commits: Conventional Commits, repo-local identity, no trailers; the same subject in both repositories for a ported change.
**Verification:** per edition `npm run typecheck` and `npm test` (`npm run typecheck --prefix src_claude`, `npm test --prefix src_claude`, same with `src`); from the workspace root `node "<kit>/scripts/verify.ts"` (workspace `.claude/verify.json`, four commands); `node .github/release.ts check` in each repository at Task 10.

### Review focus
1. A command that moves twice (`cd a && cd ../b && npm publish`) runs in `b`, not `a` → Task 1 (`segmentFolders`).
2. A path that leaves its repository by `..` (`ws/a/../b/x`) or names a prefix of a repository (`ws/ab/x` next to `a`) → Task 1 (`repoOf`).
3. A session whose own folder is inside a repository (`input.cwd` = `ws/a`, project = `ws`): `gh pr create` without `cd` lands in `a` → Task 4.
4. An invalid `a/.claude/guard.json` (bad JSON, bad regex) → a warning naming its path, the rest of the guard unchanged → Task 6.
5. pi, untrusted session: `a`'s `allow`, `workDocs` and `"reviewGate": false` are ignored, its restrictions still apply → Task 9.

### Post-implementation
- `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.ru.md` (both repositories): the guard rows and the workspace section name per-repository judging, the combination rules (Decisions 2–6) and the 32-repository limit. This is the topic chapter for the guard.
- `README.md` (both): the workspace paragraph says the guard now applies per repository.
- `CHANGELOG.md` (both): section 0.35.0.
- Workspace `docs/FRAMEWORK-SOURCES.ru.md`: §11.45 covering 0.34.0, 0.34.1 and 0.35.0 (what, where from, why, lessons).
- Decision records: none; the rulings live in the CHANGELOG and ARCHITECTURE.

### Task 1: placement primitives (Claude edition, shared files)

**Files:** Modify `src_claude/lib/repos.ts`, `src_claude/lib/shell.ts` · Test `src_claude/tests/repos.test.ts`, `src_claude/tests/reviews.test.ts`
**Interfaces:** Produces `repoOf(projectDir: string, repos: string[], path: string): string | undefined` (absolute folder of the workspace repository holding the resolved `path`, else undefined) · `segmentFolders(command: string, cwd: string): Array<{ raw: string[]; dir: string | undefined; move: boolean }>`

- [ ] Write failing tests with stubs (`repoOf` → undefined, `segmentFolders` → `[]`):
  - repos.test.ts `repoOf places a path in its workspace repository` → workspace `ws` with `a/.git`, `b/.git`: `ws/a/x/y` → `ws/a`; `ws/a` → `ws/a`; `ws/a/../b/x` → `ws/b`; `ws/ab/x` → undefined; `ws/notes/x` → undefined;
  - reviews.test.ts `segmentFolders follows moves and git -C` → in `ws`: `cd a && npm publish` → dirs `[ws, ws/a]`, moves `[true, false]`; `cd a && cd ../b && npm publish` → last dir `ws/b`; `git -C b status` → `[ws/b]`; `echo $(cd b && npm publish)` → every dir undefined.
- [ ] Run `node --test tests/repos.test.ts tests/reviews.test.ts` → expect FAIL: `undefined !== '<ws>/a'` and `[] deepEqual [...]`
- [ ] Implement `repoOf`: `resolve(path)`, then the first `r` of `repos` with `abs === join(projectDir, r)` or `abs.startsWith(join(projectDir, r) + sep)`. Implement `segmentFolders` with the review gate's loop (`Subshells`, `segmentsOf(tokenize(stripRedirects(command)))`, `enter` before reading `dir`, `move` after); a segment whose git call has `-C <x>` (git's options scanned as `landing` scans them) gets `follow(dir, x)`.
- [ ] Run the two files → PASS; `npm test` → all pass
- [ ] Commit `feat(guard): place a path and each command segment in a workspace repository`

### Task 2: the configs in force and how they combine (shared `lib/scope.ts`)

**Files:** Create `src_claude/lib/scope.ts` · Modify `src_claude/lib/patterns.ts` (an optional `judgeWrite` parameter) · Test `src_claude/tests/scope.test.ts`
**Interfaces:** Consumes Task 1 · Produces:
- `interface GuardScope { projectDir: string; config: GuardConfig; repos: Map<string, GuardConfig> }` (absolute repository folder → its config; empty outside a workspace);
- `guardScope(projectDir: string, load: (root: string) => GuardConfig): GuardScope`;
- `strictest(a: GuardDecision, b: GuardDecision): GuardDecision` (block > confirm > allow; a tie keeps `a`);
- `scopedPath(tool: "read" | "write" | "edit", path: string, scope: GuardScope): GuardDecision` (`checkPath` from `projectDir` with `config`, and from the holding repository with its config; strictest);
- `scopedConfig(command: string, cwd: string, scope: GuardScope): GuardConfig` (outside a workspace: `scope.config`; inside: `block`/`confirm` = the workspace's plus those of each repository a segment runs in, all repositories when any `dir` is undefined; `allow` = the workspace's plus the one repository's when every non-move segment runs in that repository and no `dir` is undefined; `protectedPaths`, `workDocs`, `reviewGate` = the workspace's);
- `checkCommand(…, env, judgeWrite = (target) => checkPath("write", target, cwd, config))` judges a heredoc write target with `judgeWrite`.

- [ ] Write failing tests (stub module returning `scope.config` and `checkPath` from `projectDir` only), each in a temp workspace with repositories `a`, `b` and configs passed through `load`:
  - `a CI pipeline or guard config in a workspace repository asks` → `scopedPath("write", ws/a/.github/workflows/ci.yml)` → `confirm`; `ws/a/.claude/guard.json` → `confirm`; criterion 1;
  - `a repository's protected paths block under it, measured from it` → `a` `{ protectedPaths: ["secret/"] }`: `ws/a/secret/x` → `block`, `ws/b/secret/x` → `allow`; criterion 2;
  - `a repository's rules apply where the command runs` → `a` `{ block: ["npm publish"] }`, through `checkCommand(cmd, ws, scopedConfig(cmd, ws, scope), ws)`: `cd a && npm publish` → `block`; `cd b && npm publish` → `allow`; `echo $(cd b) && npm publish` → `block`; criterion 2;
  - `a repository's allow applies only when the whole command runs in it` → `a` `{ allow: ["npm run deploy"] }`: `cd a && npm run deploy` → `allow`; `cd b && npm run deploy` → `confirm`; `cd a && npm run deploy && cd ../b && npm run deploy` → `confirm`; workspace `{ allow: ["npm run deploy"] }` → `cd b && npm run deploy` → `allow`; criterion 3;
  - `outside a workspace the scope is the project's config` → a single repository: `scopedConfig` returns `scope.config` unchanged, `scopedPath` equals `checkPath`; criterion 8.
- [ ] Run `node --test tests/scope.test.ts` → expect FAIL: `'allow' !== 'confirm'` on the CI case
- [ ] Implement `lib/scope.ts`; `guardScope` uses `projectRepos(projectDir)`.
- [ ] Run → PASS; `npm test` → all pass (guard.test.ts unchanged)
- [ ] Commit `feat(guard): combine the workspace's and its repositories' guard configs`

### Task 3: own-branch push from a workspace (`ownBranchPush`)

**Files:** Modify `src_claude/lib/patterns.ts` · Test `src_claude/tests/guard.test.ts`
**Interfaces:** Consumes `repoOf`, `projectRepos`

- [ ] Write failing test `a plain push of a workspace repository's work branch passes` → helper `pushWorkspace()`: a temp folder holding `pushRepo()`'s setup as `a` (move or build it there); `ask("git -C a push", ws, env, ws)` → `allow`; with `a` on `main` → `confirm`; `ask("git -C a push", ws/a, env, ws)` → `allow`; criterion 6
- [ ] Run `node --test tests/guard.test.ts` → expect FAIL: `'confirm' !== 'allow'`
- [ ] Implement: the owner is `project` outside a workspace, else `repoOf(project, repos, dir)`; no owner → false; compare `commonDir(dir)` with `commonDir(owner)`.
- [ ] Run → PASS; `npm test` → all pass
- [ ] Commit `fix(guard): a workspace repository's own work branch is pushed without a question`

### Task 4: task-file leak guard per landing repository (`checkWorkDocs`)

**Files:** Modify `src_claude/lib/workdocs.ts` · Test `src_claude/tests/workdocs.test.ts`
**Interfaces:** Consumes `repoOf`, `segmentFolders` · Produces `checkWorkDocs(command, projectDir, dirs = WORK_DOC_DIRS, workspace?: { cwd: string; repos: string[]; dirsFor: (repo: string) => string[] })`; without `workspace`, today's behaviour

- [ ] Write failing tests: workspace with `repo()`-style `a` on `feat/x` holding a committed `docs/tasks/t.md`, and a clean `b`; `ws = (cmd, cwd = root) => checkWorkDocs(cmd, root, undefined, { cwd, repos: ["a", "b"], dirsFor: (r) => (r === join(root, "a") ? aDirs : WORK_DOC_DIRS) })?.action ?? "allow"`:
  - `cd a && gh pr create` → `block`; `git -C a push origin feat/x:main` → `block`; `gh pr create` with `cwd` = `root/a` → `block` (review focus 3); `cd b && gh pr create` → `allow`; criterion 4;
  - `a repository's workDocs folders decide its task files` → `aDirs = ["plans"]`, `a/plans/p.md` committed: `cd a && gh pr create` → `block` naming `plans/p.md`; with only `docs/tasks/t.md` → `allow`;
  - `a landing whose repository the guard can't tell is blocked` → `cd $D && gh pr create` → `block`, reason matches `/can't tell which repository/`.
- [ ] Run `node --test tests/workdocs.test.ts` → expect FAIL: `'allow' !== 'block'`
- [ ] Implement: move today's per-landing body into `judge(landings: Landing[], checkout: string, dirs: string[])`; with `workspace`, each landing segment of `segmentFolders(command, workspace.cwd)` is judged in `repoOf(projectDir, repos, dir)` with `dirsFor(repo)`; an undefined `dir` or no repository → `block` with reason `Task-file guard: can't tell which repository this command lands in. Run it from the repository's folder (\`cd <repo> && …\`).`
- [ ] Run → PASS; `npm test` → all pass
- [ ] Commit `fix(guard): task files can't reach a workspace repository's base branch`

### Task 5: review gate waived per repository

**Files:** Modify `src_claude/lib/reviews.ts` · Test `src_claude/tests/reviews.test.ts`
**Interfaces:** Produces `ReviewGateOptions.waived?: (checkout: string) => boolean`

- [ ] Write failing test `a repository's waiver lifts the gate for its landings only` → `workspaceRepos()`, no reviews recorded, options `{ missing: "block", …, waived: (c) => c === join(ws, "a") }`: `check("cd a && gh pr create", …, ws)` → undefined; `cd b && gh pr create` → `block`; criterion 5
- [ ] Run `node --test tests/reviews.test.ts` → expect FAIL: the `a` case returns `block`
- [ ] Implement in `checkSegments`: after the checkout is known to be git, `if (options.waived?.(where)) continue;`. A hidden landing still decides as today.
- [ ] Run → PASS; `npm test` → all pass
- [ ] Commit `feat(review-gate): a repository's waiver covers only its own landings`

### Task 6: Claude hooks judge per repository (PreToolUse)

**Files:** Modify `src_claude/lib/hooks.ts` · Test `src_claude/tests/hooks.test.ts`
**Interfaces:** Consumes Tasks 1–5

- [ ] Write failing hooks tests with `setupWorkspace()` (extend it to write per-repository `.claude/guard.json` when given):
  - `guard: in a workspace, a Write of a repository's CI pipeline asks` → PreToolUse Write `a/.github/workflows/ci.yml` → `permissionDecision: "ask"`; criterion 1;
  - `guard: a shell write of a repository's guard config asks` → Bash `echo {} > a/.claude/guard.json` → `ask`; criterion 1;
  - `guard: a heredoc write under a repository's protected path is denied` → `a` `{ protectedPaths: ["secret/"] }`, Bash `cat > a/secret/x <<'EOF'` / `x` / `EOF` → `deny`; criterion 2;
  - `guard: the implementer is asked before pushing in a workspace` → `a` with a bare origin and branch `feat/x` set up as `pushRepo()` does, `agent_type: "eng-kit:implementer"`, Bash `git -C a push` → `ask`; the same call from the main agent → no decision; criterion 6;
  - `guard: an invalid repository config warns with its path` → `a/.claude/guard.json` = `{` → stderr warning contains `a/.claude/guard.json`, Write `a/x.ts` → no decision (review focus 4).
- [ ] Run `node --test tests/hooks.test.ts` → expect FAIL: no `ask` for the CI Write
- [ ] Implement in `preToolUse`: `const scope = guardScope(env.projectDir, (root) => collect(loadGuardConfig(root)))` (warnings prefixed with the root's relative path); Read/Grep/Write/Edit → `scopedPath`; shell → `checkCommand(command, projectDir, scopedConfig(command, cwd, scope), cwd, process.env, (t) => scopedPath("write", t, scope))`; `checkWorkDocs` with `workspace` when `scope.repos.size > 0` (`dirsFor` = that repository's `workDocs ?? WORK_DOC_DIRS`); `checkGateFiles` for `.claude/guard.json` and each `<repo>/.claude/guard.json`, strictest; `checkReview` with `waived = (c) => scope.repos.get(repoOf(…, c) ?? "")?.reviewGate === false`.
- [ ] Run → PASS; `npm test` → all pass
- [ ] Commit `fix(guard): judge each workspace repository's paths and commands by its own rules`

### Task 7: Stop reminders per repository

**Files:** Modify `src_claude/lib/approvals.ts`, `src_claude/lib/hooks.ts` · Test `src_claude/tests/hooks.test.ts`, `src_claude/tests/workdocs.test.ts`
**Interfaces:** Produces `taskFileReminders(projectDir: string, dirsFor: (root: string) => string[], deadline: number): { approved: string[]; finished: string[]; onBase: string | undefined; skipped: string[] }` (paths prefixed with the repository name in a workspace; `onBase` is `main` in one repository, `main in a, master in b` in a workspace; `skipped` = repositories not reached before `deadline`)

- [ ] Write failing tests:
  - hooks `Stop names a workspace repository's approved and finished task files` → uncommitted `a/docs/tasks/t.md` with `Status: design approved (2026-11-03)`, committed `b/docs/tasks/done.md` whose Plan has only `- [x]` → Stop reason contains `a/docs/tasks/t.md` and `b/docs/tasks/done.md`; criterion 7;
  - workdocs.test.ts `taskFileReminders names the repositories it had no time for` → `deadline = Date.now() - 1` → `skipped` = `["a", "b"]`, nothing else listed; and `taskFileWarning(["a", "b"])` (exported from approvals.ts) → `"Task-file reminders skipped (no time left): a, b"`, `taskFileWarning([])` → undefined; criterion 7.
- [ ] Run → expect FAIL: the Stop reason lacks `a/docs/tasks/t.md`
- [ ] Implement `taskFileReminders` (one repository: today's `uncommittedApproved` + `finishedWorkDocs` + `onBaseBranch`; workspace: the session folder's `finishedWorkDocs` first, then each repository until `deadline`); `stopGates` uses it with `Date.now() + TASK_FILE_BUDGET_MS` and returns `taskFileWarning(skipped)` as `warning`.
- [ ] Run → PASS; `npm test` → all pass
- [ ] Commit `fix(guard): approval and task-file reminders cover every workspace repository`

### Task 8: pi edition — shared files and libraries

**Files:** Copy to `src/extensions/lib/`: `repos.ts`, `shell.ts`, `reviews.ts`, `approvals.ts`, `scope.ts` · Modify `src/extensions/lib/patterns.ts`, `src/extensions/lib/workdocs.ts` (Tasks 2–4 changes) · Copy and adapt tests: `src/tests/repos.test.ts`, `reviews.test.ts`, `scope.test.ts` (`.pi/guard.json`), `guard.test.ts`, `workdocs.test.ts`

- [ ] Copy the shared files and their tests (their RED was seen in Tasks 1, 2, 5 and 7); copy Task 3's and Task 4's test cases into pi's `guard.test.ts` and `workdocs.test.ts`; run `node --test tests/guard.test.ts tests/workdocs.test.ts` → expect FAIL: `'confirm' !== 'allow'` (push) and `'allow' !== 'block'` (task file)
- [ ] Port the `patterns.ts` and `workdocs.ts` changes (pi's `checkPath` still asks for writes outside the project)
- [ ] Run `npm test --prefix src` → all pass; `for f in repos shell reviews approvals scope; do cmp src_claude/lib/$f.ts src/extensions/lib/$f.ts; done` → no output
- [ ] Commit `feat(guard): place paths and commands in a workspace repository` (pi)

### Task 9: pi edition — guard and verify extensions

**Files:** Modify `src/extensions/guard.ts`, `src/extensions/verify.ts` · Test `src/tests/extensions.test.ts`

- [ ] Write failing tests with `workspaceProject()` (per-repository `.pi/guard.json` when given):
  - `guard: in a workspace, a write of a repository's CI pipeline asks` → `tool_call` write `a/.github/workflows/ci.yml` with `confirm: false` → blocked, reason matches `/CI\/release pipeline/`; criterion 1;
  - `guard: an untrusted session ignores a repository's loosening` → `a` `{ allow: ["npm run deploy"], block: ["npm publish"] }`, `trusted: false`: `cd a && npm run deploy` asks; `cd a && npm publish` blocked; with `trusted: true` the deploy passes (review focus 5);
  - `verify: the reminder names a workspace repository's approved task file` → uncommitted `a/docs/tasks/t.md` with `Status: design approved (2026-11-03)` → the follow-up message contains `a/docs/tasks/t.md`; criterion 7.
- [ ] Run `node --test tests/extensions.test.ts` → expect FAIL: the CI write isn't asked
- [ ] Implement: `loadConfig(ctx, root = ctx.cwd)` reads `<root>/.pi/guard.json` with today's trust rule; `check` uses `guardScope`, `scopedPath`, `scopedConfig`, `checkWorkDocs` with `workspace`, `checkGateFiles` per repository, `checkReview` with `waived`, as Task 6; `verify.ts` uses `taskFileReminders` and notifies `taskFileWarning(skipped)`.
- [ ] Run → PASS; `npm test --prefix src` → all pass
- [ ] Commit `fix(guard): judge each workspace repository by its own rules` (pi)

### Task 10: docs, release 0.35.0, live check

**Files:** Modify in both repositories `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE.ru.md`, `README.md`, `CHANGELOG.md`, `package.json` (+ `package-lock.json`), and in eng-kit `.claude-plugin/plugin.json`; workspace `docs/FRAMEWORK-SOURCES.ru.md`

- [ ] Update the docs as Post-implementation says; version 0.35.0 in every file `node .github/release.ts check` compares
- [ ] Run `node .github/release.ts check` in each repository → passes; the workspace verify script → 4/4 PASS
- [ ] Criterion 9: a scratch workspace (repositories `a`, `b`), `claude -p --plugin-dir src_claude` from it with other plugins disabled, ask the agent to create `a/.github/workflows/ci.yml` → the permission request is refused in `-p` with the guard's CI reason; record the result in Progress
- [ ] Commit `docs: guard in a workspace (0.35.0)` in each repository

## Progress

None yet
