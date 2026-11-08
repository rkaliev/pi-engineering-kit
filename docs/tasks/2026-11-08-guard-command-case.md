# Guard judges command names in any case and ANSI-C quoted words as the shell runs them

Status: in progress
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit 3c5336e7cb3ca89d7093a570f1836af79a6c89c6, pi 8729545f00492d89e4a0ca8323ba782fbb07541a
Links: FRAMEWORK-SOURCES §11.48 ("Follow-ups после 0.37.0" and "Добавлено в 0.38.0 по отчёту пользователя")

<!-- One file per piece of work, standing in for a tracker issue: the sections before Plan are its description. Each section answers one question and never repeats another. Keep every heading; write "None" instead of deleting a section. -->

<details><summary>Original request</summary>

да

(Reply to: «Начать задачу 0.38.0 сейчас?». The task was set by the 0.37.0 follow-up "git command word in any case (`GIT push --force` passes silently on APFS/NTFS) and `$'…'` escapes in the tokenizer", and by the user's rulings of 2026-11-08 on a report of frequent Stop-hook firings: text-only skill fixes in both editions, shipped inside 0.38.0 — the kit verify script runs bare, plan checkboxes are ticked with the Progress line and checked at Finish, the plan is committed before approval is asked. During design the user chose "all command names" over "git only" and "judge as lowercase" over a single fallback confirm rule.)

</details>

## Intent

The guard and the gates judge `GIT push --force`, `RM -rf ~`, `GH pr merge` or `$'\147it' reset --hard` exactly as they judge the lowercase, unquoted command, so letter case and ANSI-C quoting no longer slip a command past them; and three skill texts stop sending agents into needless gate firings and silent task-file deletions.

## Context

On a case-insensitive file system (macOS APFS, Windows NTFS) any command name runs in any case (`GIT`, `LS`, `GH` verified on this machine), and bash runs `$'\147it'`, `$'\x67it'` and `$"git"` as `git`; but every command-name comparison in the guard and the gates is case-sensitive (`gitLike`, `checkSegment`, `CONFIRM_RULES`, `PUSH_WORDS`, `segmentFolders`, `landing`, the `tee`/`sed` fallback), and `tokenize` keeps `$'\147it'` as `147it`. git itself refuses a subcommand in another case (`git STATUS` → "cannot handle STATUS as a builtin"). In life-bpms sessions `executing-plans`' "redirect long output to a file" led to about 110 runs of `verify.ts > log; echo exit=$?` that the verify gate never credits, two task files were deleted with 0 of 24 and 0 of 42 plan boxes ticked, and the approval gate fired after almost every plan because `writing-plans` asks for approval of an uncommitted plan.

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | `tokenize` decodes `$'…'` as bash and zsh do (`\a \b \e \E \f \n \r \t \v \\ \' \" \?`, octal `\nnn`, `\xHH`, `\uHHHH`, `\UHHHHHHHH`, `\cX`; an unknown escape keeps its backslash) and reads `$"…"` as `"…"`: `$'\147it'`, `$'\x67it'`, `$'git'` and `$"git"` are the token `git` | unit, `patterns`/`guard` tests in both editions |
| 2 | Blocks hold in any case and through ANSI-C quoting: `GIT push --force`, `Git commit -n`, `$'\147it' push --force`, `GIT -c core.hooksPath=x commit`, `/usr/bin/GIT push --mirror`, `RM -rf ~` and `rM -rf ~` are blocked like their lowercase forms | unit, `guard.test.ts` in both editions |
| 3 | Confirms hold in any case: `GIT push origin main` (not the own-branch allowlist form), `GH pr merge 1`, `GLAB mr merge`, `SUDO ls`, `ſudo ls` (a compatibility form `foldPath` folds), `NPM publish`, `TERRAFORM destroy`, `GIT reset --hard`, `BASH -c "git push"`, `GIT remote add x y`, `GIT_SSH_COMMAND=x GIT fetch` ask as their lowercase forms do | unit, `guard.test.ts` in both editions |
| 4 | Project `block` and `confirm` rules also match the decoded, folded view (`block: ["terraform destroy"]` blocks `TERRAFORM destroy`); a project `allow` rule matches only the command as written | unit, `guard.test.ts` in both editions |
| 5 | Nothing gets looser and arguments keep their case: `git branch -d x` and `git checkout -b X` stay allowed, `ls ~/Git` and `cat Git.md` don't ask, `rm -rf /<project>/Git/build` inside a project whose path has capitals is not "outside", and the plain own-branch `git push` still passes silently | unit, `guard.test.ts` in both editions |
| 6 | Workspace folders follow `GIT -C a push` and `/usr/bin/GIT -C a push` like `git -C a push`, and `ENV -C a git push` is unknown like `env -C`; `CD a && …` and `PUSHD a` are not moves (a builtin in another case runs `/usr/bin/cd` in a child or isn't found) | unit, `scope.test.ts` / `shell` tests (shared files) |
| 7 | The review gate sees landings in any case: `GH pr merge`, `GH pr create`, `GIT merge`, `GIT push` register like their lowercase forms | unit, `reviews.test.ts` / workdocs tests (shared files) |
| 8 | The verify gate's text fallback counts `TEE f` and `SED -i … f` targets | unit, `worktree.test.ts` (shared file) |
| 9 | Live: in a temp repo with the branch's kit, `claude -p` running `GIT push --force` and `$'\147it' push --force` is blocked | live check run once, output recorded in Progress |
| 10 | Skill texts: `executing-plans` and `verification-before-completion` say the kit verify script runs bare (optionally piped into `tail`/`head`/`grep`), never redirected or chained, or it isn't credited; `executing-plans` ticks the task's boxes and adds its Progress line in one edit, and at Finish, before deleting the task file, confirms no `- [ ]` remains in Plan and names any undone step to the user and in Follow-ups; `writing-plans` commits the plan before asking for its approval | the kit's skill lint and the editions comparison stay green; text reviewed in the final review |

## Scope

**In scope:**
- `tokenize` ANSI-C and `$"…"` decoding (`lib/patterns.ts` / `extensions/lib/patterns.ts`).
- Folded command-name comparison at every site where a case-sensitive compare loosens a check: `patterns.ts`, `shell.ts`, `workdocs.ts`, `worktree.ts` (shared files byte-identical in both editions).
- The decoded, folded text view for built-in regex rules and project `block`/`confirm`.
- The skill text fixes in `executing-plans`, `verification-before-completion`, `writing-plans`, both editions.
- Version 0.38.0 in both editions, CHANGELOG, `docs/ARCHITECTURE(.ru).md`, README guard section, workspace `docs/FRAMEWORK-SOURCES.ru.md` §11.49.

**Out of scope:**
- Brace expansion (`{git,} push`) and variables as command names (`$G push`).
- Subcommand and argument case (git refuses `git PUSH`; `-D` and `-d` differ).
- Sites where a case-sensitive compare only refuses more: the reviewer allowlist, `isSafe`, `ownBranchPush`, `isKitScript`.
- The other §11.48 follow-ups (shell writes into `.git` and hook files, `GIT_CONFIG_*`, `include.path`, hooks folders outside the repository).
- Changing the verify gate's crediting rule (user ruling 2026-11-08: text only).

## Decisions

1. All command names the guard and gates compare, not only git (user, 2026-11-08).
2. Judged as lowercase: blocks stay blocks; no catch-all confirm rule (user, 2026-11-08).
3. Case is ignored on every OS with `foldPath`, as for paths in 0.37.0; on Linux `GIT …` is judged as `git …` (**assumed**, an accepted false positive, consistent with the 0.37.0 ruling).
4. Shell builtins and keywords (`cd`, `pushd`, `popd`, `chdir`, `eval`, `source`, `export`, `declare`, `if`…) are never folded: in another case they are not builtins (`CD x` runs `/usr/bin/cd` in a child, `EVAL` isn't found; verified 2026-11-08 in bash and zsh), and treating `CD a` as a move would judge the command in the wrong folder (ruling while planning, 2026-11-08).
5. `$"…"` is read as bash reads it (`"…"`); in zsh it is `$…`, so this only makes the guard stricter (**assumed**).
6. An extra view may only add a block or a confirm, never remove one: `allow` and the own-branch push allowlist see only the command as written (part of the approved design, 2026-11-08).
7. Skill fixes are text only; the gate's code is not loosened (user, 2026-11-08). They ship inside 0.38.0 (user, 2026-11-08).

## Design

- **`tokenize`**: in a `$'…'` word, a backslash escape is decoded into its character (unknown escapes keep the backslash, as bash does); `\c?` and control escapes follow bash. `$"` opens a double-quoted word like `"`. Every token consumer (guard, review gate, workdocs, folder tracking) sees decoded words with no change of its own.
- **`commandName(token)`** in `patterns.ts`: `foldPath` of the token's base name (after `/`). It replaces `=== "git"`, `indexOf("rm")`, `WRAPPERS.has(...)`, `MOVES.has(...)` and the like at the sites listed in Context; `gitLike` tests the folded base name against `git(-<sub>)?` and keeps its path rule. Paths and arguments are never folded.
- **Folded view for regex rules**: `checkCommand` builds `view = foldPath(tokens of the checked text joined by spaces, operators kept)`; `CONFIRM_RULES`, the discard rule, `PUSH_WORDS`, the shell-string git check and project `block`/`confirm` test both the text and the view; the first match decides as today. `allow` and `ownBranchPush` see only the text.
- **Errors**: none new; decoding never throws (a malformed escape stays literal).

## Rollout

None. Released as 0.38.0 in both editions by CI on merge.

## Risks and open questions

- A missed comparison site leaves a gap → the plan lists every site from a grep of command-name comparisons in `lib/` and `extensions/lib/`, each with a red test; reviewers get the grep.
- Folding the view adds false positives only where the lowercase form already matches (`echo SUDO` asks like `echo sudo`) → accepted, criterion 5 guards against folding paths and arguments.
- Node 22 support for regexp modifiers is uncertain → the design uses `foldPath` on the text, not `(?i:…)`.

## Follow-ups

- Brace expansion and variables as command names (`{git,} push`, `$G push`): decide fail-closed handling.
- The other §11.48 follow-ups, unchanged.

## Plan

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** the guard and the gates judge external command names in any case and `$'…'`/`$"…"` words as the shell runs them, without loosening anything, and three skill texts are fixed.
**Architecture:** `tokenize` decodes ANSI-C quoting, so every token consumer sees the real word. A new `commandName(token)` (`foldPath` of the base name) replaces the exact compare at each site where an external program's name is matched; shell builtins and keywords are never folded (Decision 4). Regex rules additionally test a folded view of the decoded tokens; only `block`/`confirm` see it, `allow` and the own-branch push allowlist don't.
**Stack / constraints:** Node ≥22.18 running `.ts` directly, `node:test`, no new dependencies, no regexp modifiers. `lib/shell.ts`, `lib/workdocs.ts`, `lib/worktree.ts` stay byte-identical with `src/extensions/lib/`; `patterns.ts` differs only in its edition lines. Every new test goes into both editions' matching test file. Commit messages: Conventional Commits, no Co-Authored-By trailer (user rule).
**Verification:** from the workspace root, in its own call: `node "<kit root>/scripts/verify.ts"` (runs `npm run typecheck` and `npm test` in `src` and `src_claude`). Per task: `node --test tests/<file>.test.ts` inside each repo.

### Review focus
1. A comparison site left exact: the reviewer gets the output of `grep -nE '(===|!==) "(git|gh|glab|rm|env|tee|sed|sudo)"|indexOf\("(git|rm|gh|glab)"\)|includes\("git"\)|BASE_NAME\(' lib/*.ts` and checks every hit is folded or listed as fail-closed in Scope.
2. Folding that reaches a path or an argument: `rm -rf /work/App/build` inside `/work/App` stays allowed, `git branch -d x` stays allowed (Task 3).
3. A decoded `$'…'` that yields an operator stays inside its word: `echo $'a\x3bgit'` is two tokens (Task 1).
4. Builtins stay unfolded: `CD b && git status` and `PUSHD b; git status` are judged in the session folder (Task 4).
5. Malformed or truncating escapes: `$'\x'`, `$'\u'`, `$'\c'` at the end, and `$'a\0b'` (bash ends the word at NUL → `a`) (Task 1).

### Post-implementation
- `CHANGELOG.md` (both): 0.38.0 entry: the guard and gates judge command names in any case and ANSI-C quoting; the skill fixes.
- `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.ru.md` (both): the guard row says command names compare folded and `$'…'`/`$"…"` are decoded, builtins excepted.
- `README.md` (both): the guard section's case sentence covers command names, not only paths; version pins `@v0.38.0` wherever `checkRelease` checks them.
- `package.json`, `package-lock.json` (both), `.claude-plugin/plugin.json` (Claude): version 0.38.0.
- Workspace `docs/FRAMEWORK-SOURCES.ru.md`: §11.49 for 0.38.0 (source, decisions, review rounds, follow-ups).
- No topic chapter or decision record: the kit keeps behavior in ARCHITECTURE and decisions in FRAMEWORK-SOURCES.

### Task 1: `tokenize` decodes `$'…'` and reads `$"…"` as `"…"`

**Files:** Modify `lib/patterns.ts` (Claude), `extensions/lib/patterns.ts` (pi), `tokenize` only · Test `tests/guard.test.ts` in both
**Interfaces:** Produces `tokenize(command: string): string[]` with decoded words (signature unchanged)

- [x] Write failing test `tokenize decodes ANSI-C quoting as bash does`: `tokenize("$'\\147it' push")` → `["git", "push"]`; the same for `$'\\x67it'`, `$'g\\u0069t'`, `$'\\U00000067it'`, `$"git"`; `$'a\\tb'` → `["a\tb"]`; `$'\\cA'` → `["\x01"]`; `$'\\q'` → `["\\q"]` (an unknown escape keeps its backslash); `$'a\\0b'` → `["a"]`; `$'\\x'` → `["\\x"]`; `$'\\u'` → `["\\u"]`; `echo $'a\\x3bgit'` → `["echo", "a;git"]`. And test `ANSI-C quoted git is judged as git`: `$'\\147it' push --force` and `$"git" commit -n` → `block`; `$'\\x67it' reset --hard` → `confirm`.
- [x] Run `node --test tests/guard.test.ts` in `src_claude` → expect FAIL: `["147it", "push"]` vs `["git", "push"]`
- [x] Implement in `tokenize`: inside `$'…'` decode `\a \b \e \E \f \n \r \t \v \\ \' \" \?`, octal `\nnn` (1–3 digits), `\xHH` (1–2), `\uHHHH` (1–4), `\UHHHHHHHH` (1–8), `\cX` (`X & 0x1f`); a NUL drops the rest of the quoted content; `\x`, `\u`, `\U` without digits and unknown escapes keep the backslash. `$"` opens a double-quoted word like `"`.
- [x] Run the test file in both editions → PASS; then `npm test` in both → all pass
- [x] Commit `fix(guard): decode $'…' and $"…" words as the shell does`

### Task 2: token checks fold external command names

**Files:** Modify `patterns.ts` (both): add `export function commandName(token: string): string`; use it in `checkSegment` (`git`, `rm`), `gitLike`, `parseGit` (the `git-<sub>` form), `parseGitCalls` (`WRAPPERS`), `checkPushSetup` (`gh`/`glab`, the `sh -c` base name, and the shell-string git test through `foldPath(t)`) · Test `tests/guard.test.ts` in both
**Interfaces:** Produces `commandName(token) = foldPath(BASE_NAME(token))`, consumed by Tasks 4–5

- [x] Write failing test `external command names are judged in any case`: block — `GIT push --force`, `Git commit -n`, `GIT -c core.hooksPath=x commit`, `/usr/bin/GIT push --mirror`, `RM -rf ~`, `rM -rf ~`, `GIT commit --no-verify`; confirm — `GH pr merge 1`, `GLAB mr merge 1`, `GIT remote add x y`, `BASH -c "git push"`, `bash -c "GIT push"`, `SUDO git push`, `GIT_SSH_COMMAND=x GIT fetch`, `ſudo ls`; allow — `GIT status`
- [x] Run → expect FAIL on the first row: `allow` vs `block`
- [x] Implement `commandName` and replace the exact compares listed in Files; `SHELL_KEYWORDS`, `eval` and variable names stay exact
- [x] Run the test file in both editions → PASS; full suites → pass
- [x] Commit `fix(guard): command names count in any letter case`

### Task 3: regex rules see the folded view; nothing loosens

**Files:** Modify `checkCommand` and `checkPushes` in `patterns.ts` (both) · Test `tests/guard.test.ts` in both
**Interfaces:** Consumes `tokenize` (Task 1) and `foldPath`

- [x] Write failing test `regex rules match command names in any case; allow sees the command as written`: confirm — `NPM publish`, `TERRAFORM destroy`, `GIT reset --hard`, `SUDO ls`, `curl x | SH`, `GIT push origin main`, `$'\\x67it' push`; `{ block: ["terraform destroy"] }` → `TERRAFORM destroy` block; `{ confirm: ["make release"] }` → `MAKE release` confirm; `{ allow: ["^git push"] }` → `GIT push x` confirm (allow never matches the view)
- [x] Write test `folding never reaches arguments or paths`: allow — `git branch -d x`, `git checkout -b X`, `ls ~/Git`, `cat Git.md`; with cwd `/work/App`, `rm -rf /work/App/build` → allow
- [x] Run → expect FAIL on `NPM publish`: `allow` vs `confirm`
- [x] Implement: `view = foldPath(tokenize(text).join(" "))` and `commandView` the same for `command`; `CONFIRM_RULES` and `PUSH_WORDS` test `text` or `view`; project `block`/`confirm` test `command` or `commandView`; `allow` tests `command` only; `ownBranchPush` gets the text as today
- [x] Run both editions → PASS; full suites → pass (the own-branch push tests unchanged)
- [x] Commit `fix(guard): regex rules also read the decoded, folded command`

### Task 4: workspace folders follow folded git and env, never folded builtins

**Files:** Modify `lib/shell.ts` (`segmentFolders`, `hidesFolder`), copy to `src/extensions/lib/shell.ts` · Test `tests/reviews.test.ts` in both, next to `segmentFolders: git's -C counts…`
**Interfaces:** Consumes `commandName` (Task 2)

- [x] Write failing test `segmentFolders: git and env in any case, builtins as written`: in workspace `ws` with folder `b`: `GIT -C b status` → `join(ws, "b")`; `/usr/bin/GIT -C b status` → `join(ws, "b")`; `ENV -C b git push` → `undefined`; `npm run x GIT -C b` → `undefined`; `BASH -c "cd b"` → `undefined`; `CD b && git status` → second segment `ws`; `PUSHD b; git status` → `ws`
- [x] Run → expect FAIL: `ws` vs `join(ws, "b")` on the first row
- [x] Implement: `commandName(words[at]) === "git"` in the `-C` loop; in `hidesFolder`, `commandName(w)` for `git`, `env` and the `sh` pattern, and the git-is-not-the-command test by index; `MOVES`, `PREFIXES`, `eval`, `export` stay exact
- [x] Run both editions → PASS; `cmp` the two `shell.ts` → same; full suites → pass
- [x] Commit `fix(guard): workspace folders follow git and env in any case`

### Task 5: review-gate landings and the verify fallback in any case

**Files:** Modify `lib/workdocs.ts` (`landing`) and `lib/worktree.ts` (`tee`/`sed` targets), copy both to `src/extensions/lib/` · Test `tests/workdocs.test.ts`, `tests/worktree.test.ts` in both
**Interfaces:** Consumes `commandName` (Task 2)

- [x] Write failing test `landing sees gh, glab and git in any case`: `GH pr merge 1` → `kind: "pr", merge: true`; `GH pr create` → `kind: "pr", merge: false`; `GLAB mr merge` → merge; `GIT push origin main` → `kind: "push"`, `remote: "origin"`; `GIT merge x` and `GIT commit -m x` → the same kinds as lowercase
- [x] Write failing test `shellWriteTargets counts TEE and SED -i targets`: `TEE out.txt` → `["out.txt"]`; `SED -i s/a/b/ f.txt` → `["f.txt"]` (same helper arguments as the existing `shellWriteTargets` test)
- [x] Run → expect FAIL: `undefined` vs a landing
- [x] Implement: `landing` finds `gh`/`glab`/`git` by `commandName`; `worktree.ts` compares `commandName(seg[0])` with `tee`/`sed`
- [x] Run both editions → PASS; `cmp` both pairs → same; full suites → pass
- [x] Commit `fix(gates): landings and write targets in any letter case`

### Task 6: skill texts

**Files:** Modify `skills/executing-plans/SKILL.md`, `skills/writing-plans/SKILL.md` (both), `skills/verification-before-completion/SKILL.md` (Claude)

- [x] Claude `executing-plans`, after "Keep long command output out of context: redirect it to a file and read the tail.": "The kit verify script is the exception: run it as the command's only step, at most piped into `tail`, `head` or `grep`; its output is already short, and a redirected, chained or `cd … &&` run isn't credited by the verify gate." pi: "`run_verification` needs no redirect; its output is already short."
- [x] Claude `verification-before-completion` step 2: the same rule in one sentence. pi unchanged (it uses `run_verification`).
- [x] Both `executing-plans` Completion contract: "Then, in one edit, tick the task's checkboxes in the Plan and add `Task N: complete (BASE..HEAD, <command> → <result>)` to Progress." Finish step 2 begins: "**Task file:** check that no `- [x]` is left in its Plan; name any step not done to the user, with why, and add it to Follow-ups. Then move what lasts…"
- [x] Both `writing-plans` last paragraph begins: "Then commit the plan (`docs(tasks): plan <feature>`), link the task file and ask…"
- [x] Run `node --test tests/lint-skills.test.ts` in both → PASS; `node tools/compare-editions.mts` → only the expected edition differences
- [x] Commit `docs(skills): bare verify runs, ticked plans, committed plans`

### Task 7: docs, version, live check

**Files:** the Post-implementation list · live script in the session scratchpad

- [x] Update every doc in Post-implementation; version 0.38.0 in both editions
- [x] Live check (Claude edition): temp git repo with one commit; `claude -p --plugin-dir <src_claude> "Run exactly this Bash command and report the result: GIT push --force"`, and the same with `$'\147it' push --force` → each run shows the block reason "Force-pushing rewrites shared history"; record output and cost in Progress
- [x] Run the kit verify script from the workspace root → all checks pass
- [x] Commit `docs: guard judges command names in any case and ANSI-C quoting (0.38.0)` in each repo

## Progress

- Baseline (eng-kit c696145, pi 9922161): kit verify from the workspace root → typecheck and tests pass in both editions. No drift since Base (only the task file changed).
- Ruling: `$'…'` follows the stricter of bash and zsh, not the plan's bash-only reading: an unknown escape is its character (zsh: `$'\g\it'` runs git) and a decoded NUL ends the whole word (zsh/exec: `$'git\0'push` runs git); `\x`/`\u`/`\U` without digits stay as written (bash) — the description asks for the word the shell runs, and zsh is the user's shell — cost if wrong: a bash-only false positive. Ruling: the `$'\x67it' reset --hard` → confirm assertion moved to Task 3, because regex rules read the raw text until Task 3 builds the view — cost if wrong: none, Task 3 asserts it.
- Task 1: complete (eng-kit c696145..HEAD, pi 9922161..HEAD; `tokenize decodes ANSI-C quoting…` failed first on ["147it","push"], `ANSI-C quoted git is judged as git` on allow vs block; the pi copy is the same code and test; kit verify → all 4 checks pass).
- Ruling: Task 2's table differs from the plan's: `SUDO git push` and `ſudo ls` move to Task 3 (sudo is a regex rule; lowercase git push already asks), `GIT commit --no-verify` is dropped (the flag blocks whatever the command word), and `NICE git -c core.sshCommand=x fetch`, `XARGS git log`, `BASH -c \"git status\"`, `Git-remote add x y` are added, each the only row that fails when its site is reverted; the `xargs`/`parallel` input check (not in the plan's list) is folded too — cost if wrong: none, every row mirrors a lowercase decision checked on the same code. Probe: `ſh -c` runs sh on APFS, so `foldPath` (NFKC + case) is the right fold.
- Task 2: complete (eng-kit c5b5428..HEAD, pi 93883af..HEAD; `external command names are judged in any case` failed first on `GIT push --force` allow vs block and on `XARGS git log`; mutants: reverting any folded site fails the test except `gh`/`glab`, which were already lowercased (equivalent for ASCII); kit verify → all 4 checks pass).
- Task 3: complete (eng-kit 6d45f47..HEAD, pi 1887fc0..HEAD; the regex test failed first on `NPM publish` allow vs confirm; `folding never reaches arguments or paths` passes before and after by design (it pins today's decisions the view must not change); added row `python3 -c \"…os.system('GIT push')\"` (git inside an interpreter string, decided only by PUSH_WORDS on the view); mutants — dropping the view from CONFIRM_RULES, project block, project confirm or PUSH_WORDS, or letting allow read it — each fail the test; kit verify → all 4 checks pass).
- Task 4: complete (eng-kit 4c1cb29..HEAD, pi 581f848..HEAD; `segmentFolders: git and env in any case, builtins as written` failed first on `GIT -C b status` → ws vs ws/b; added row `GIT --git-dir=b/.git log` → unknown; `/usr/bin/git -C b` was judged in the session folder before too (an absolute path failed open), now followed; the git-is-not-the-command test compares indexes, so a second git word after the command with `-C` now hides the folder (stricter); mutants on the -C loop, sh -c, env, --git-dir and not-the-command each fail the test; shell.ts identical in both editions; kit verify → all 4 checks pass).
- Task 5: complete (eng-kit 4d0ff8e..HEAD, pi 0f404dd..HEAD; `landing sees gh, glab and git in any letter case` failed first on `GH pr merge 1` → undefined (expected values are the lowercase landings, which the test also asserts are defined), `shellWriteTargets counts TEE and SED -i targets…` on [] vs ["src/c.ts"]; a path to gh or git (`/opt/homebrew/bin/gh pr merge`) now counts too; mutants on gh/glab, git and tee/sed each fail; workdocs.ts and worktree.ts identical in both editions; kit verify → all 4 checks pass).
- Ruling (Task 6): pi's `executing-plans` was at 799 of the 800-word lint budget, and the new text took it to 839. Both editions now fold the "Stop and ask only for" list into one sentence and use a shorter Finish step 2. pi drops the planned `run_verification` sentence, because pi never had the redirect problem. pi's inline implementer instructions move unchanged to `skills/executing-plans/references/implementer-instructions.md`, which is what the lint's own message asks. The budget was not raised, since that would weaken a test. Cost if wrong: pi's subagent mode needs one more file read when it dispatches a worker.
- Task 6: complete (eng-kit b674bb9..HEAD, pi ced0f0c..HEAD; `lint-skills` passes in both after the budget ruling; it failed first in pi at 839 words. `compare-editions` lists executing-plans, writing-plans and verification-before-completion as adapted on purpose. `claude plugin validate .` passes. No eval run: no suite case covers these skills, and the user ruled text only. Kit verify → all 4 checks pass).
- Task 7: complete (eng-kit 0d06d98..HEAD, pi 09a1782..HEAD). Docs updated: CHANGELOG, README, ARCHITECTURE(.ru) in both editions; pi install pins moved to @v0.38.0; version 0.38.0. Live check run with claude 2.1.319, `--plugin-dir`, the installed eng-kit disabled, sonnet, in a temp repo with a local bare remote. `GIT push --force origin feat/x` and `$'\147it' push --force origin feat/x` were each refused with "Force-pushing rewrites shared history…", the remote branch was not created, and the runs cost $0.08 + $0.07. Workspace FRAMEWORK-SOURCES §11.49 written. Kit verify → all 4 checks pass.
