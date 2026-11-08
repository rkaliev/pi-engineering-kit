# Guard judges command names in any case and ANSI-C quoted words as the shell runs them

Status: design approved (2026-11-08)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit 8ae9a900f1b7265586a984b86216b0e0e844295c, pi 875b923dfd113e3881911557cf1ac6a8e3b19e4a
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
| 6 | Workspace folders follow `GIT -C a push` and `ENV -C a git push` like their lowercase forms; `CD a && …` and `PUSHD a` are followed or made unknown like `cd`/`pushd` | unit, `scope.test.ts` / `shell` tests (shared files) |
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
4. `$"…"` is read as bash reads it (`"…"`); in zsh it is `$…`, so this only makes the guard stricter (**assumed**).
5. An extra view may only add a block or a confirm, never remove one: `allow` and the own-branch push allowlist see only the command as written (part of the approved design, 2026-11-08).
6. Skill fixes are text only; the gate's code is not loosened (user, 2026-11-08). They ship inside 0.38.0 (user, 2026-11-08).

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

None yet

## Progress

None yet
