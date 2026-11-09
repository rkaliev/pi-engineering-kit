# pi-engineering-kit

A [pi](https://pi.dev) package that turns the pi coding agent into a disciplined engineer.

It works on any project, and it adapts along three independent axes:
- **where the code runs:** web, mobile (Android, iOS) or desktop (Windows, Linux);
- **what it does:** anything from entertainment apps to point-of-sale systems and payments, with dedicated skills where mistakes are costly (money, fiscal rules, security);
- **what state the code is in:** a brand-new project or an existing codebase, including one written long before AI agents.

The process on top of them is the same everywhere: design → plan → TDD → verify → review → git.

It contains:
- **29 skills:**
  - **process core:** design, plan, TDD (with optional BDD), debugging, verification, review, git, CI quality gates, documentation, publishing documents (HTML/PDF), dependency updates;
  - **starting point:** choosing a stack for a new project, onboarding an existing one, changing legacy code safely;
  - **platforms:** web frontend, backend services, mobile, desktop, and UI motion across them;
  - **high-risk domains:** payments and money, POS and fiscal, security review, observability, database changes.
- **9 prompt templates** that act as entry points: `/brainstorm`, `/plan`, `/implement`, `/review`, `/debug`, `/onboard`, `/finish`, `/new-task`, `/docs`.
- **5 extensions:**
  - **bootstrap** loads the skill rules into every request.
  - **guard** blocks irreversible or secret-leaking tool calls and PRs or merges that would carry a task file to the base branch, and asks you before outward-facing ones and before landing a commit without a passing review.
  - **verify** runs the project's checks and won't let the agent finish with unverified edits, while an approved task file is uncommitted, or while an implemented one is still in the tree.
  - **init** adds `/kit-init`, which creates the project's `.pi/` config in one step.
  - **models** routes each command to its own model and thinking level (`/review` and `/implement` on the strongest model, `/onboard` and `/finish` on a mid-tier one), and adds `/mode` for manual switching.
- **A test-hygiene script** for the project's CI on any stack (`scripts/test-hygiene.ts`, Node only, no dependencies): focused tests, skips without a linked issue, fixed sleeps, retries in runner configs and test code, JUnit test counts. In an existing project it checks only the lines a change adds, so old debt doesn't block.

How it works and why: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). A step-by-step guide with a demo project is in [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md). Both are also available in Russian: [ARCHITECTURE.ru.md](docs/ARCHITECTURE.ru.md), [GETTING-STARTED.ru.md](docs/GETTING-STARTED.ru.md). The demo project itself is [examples/demo](examples/demo): a dependency-free cart library with one task, so you can try the whole loop in a minute.

## Install

First install pi itself (Node.js 22.19+; the installers set it up for you):

```bash
curl -fsSL https://pi.dev/install.sh | sh                          # macOS / Linux
irm https://pi.dev/install.ps1 | iex                               # Windows (PowerShell)
npm install -g --ignore-scripts @earendil-works/pi-coding-agent    # any OS, with Node
npx -y @earendil-works/pi-coding-agent                             # run without installing
```

Then run `pi` and `/login` to connect a model. All options (pnpm, bun, Docker, per-project version, Termux, updates, uninstall) are in the [getting-started guide](docs/GETTING-STARTED.md#0-install-pi).

Then add this kit:

```bash
# install for yourself (all projects)
pi install git:github.com/rkaliev/pi-engineering-kit@v0.38.2

# or pin it for one project and its team (-l writes .pi/settings.json; commit it)
pi install -l git:github.com/rkaliev/pi-engineering-kit@v0.38.2

# or try a local clone for one session only
git clone https://github.com/rkaliev/pi-engineering-kit && pi -e ./pi-engineering-kit

# recommended: subagents for reviews, parallel scouting and per-task execution
pi install npm:pi-subagents
```

Without `pi-subagents`, the skills fall back to doing that work inline.

## Set up a project

1. Run `/kit-init`. It creates the missing `.pi/verify.json` (commands detected from AGENTS.md, a Turbo monorepo's `turbo.json`, package scripts or build tools), `.pi/guard.json` and `.pi/model-routing.json`, and adds `pi-subagents` to `.pi/settings.json`. It never overwrites existing files other than an older copy of the kit's test-hygiene script, and `--yes` skips the questions. `/kit-init --test-hygiene` also copies the test-hygiene script into `.ci/test-hygiene.mts` for CI (an ES module whatever `package.json` says) and replaces an older copy; without the flag it is only offered. It reports an older copy and a CI that doesn't run it.
2. Run `/onboard`. It maps the repo, proves the build and test commands, and proposes `AGENTS.md` and `.pi/verify.json`. For new projects, start from [templates/AGENTS.md](templates/AGENTS.md).
3. Tune `.pi/guard.json` ([example](templates/guard.json)) and `.pi/model-routing.json` if needed.
4. Each piece of work gets one task file, `docs/tasks/YYYY-MM-DD-<slug>.md`, from [templates/task.md](templates/task.md): description, criteria, plan and progress in one place, standing in for a tracker issue (`/new-task` writes the description for you).

A typical loop:

```
/brainstorm add refunds to the checkout API     # task file, design approved before code
/plan docs/tasks/2026-09-25-refunds.md          # bite-sized TDD tasks in its ## Plan
/implement docs/tasks/2026-09-25-refunds.md     # executes, verifies; moves what lasts to docs/, deletes the task file
/review                                         # fresh-context review: Confirmed vs Assumptions
/finish                                         # verify → PR by default after a Yes; merge, keep or discard on your choice
```

Small, bounded changes need no task file: they stay in chat, e.g. `/implement make search ignore case`.

## Extensions

### guard

| Blocks | Asks first (blocked in non-interactive modes) |
|---|---|
| `--no-verify` and its abbreviations down to `--no-veri` (also inside groups and substitutions), `git commit -n`, `git -c core.hooksPath=…` (or `--config-env`) | `git push` other than your own work branch (below), publish and release commands |
| `push --force` / `-f` / `+ref` / `--mirror` | deploys, `terraform apply`, `kubectl apply`, `helm upgrade` |
| recursive `rm` outside the project (`/`, `~`, `$HOME`, `..`, other absolute paths) | DB migrations and rollbacks, `prisma db execute`, `DROP` / `TRUNCATE` |
| reading `.env*`, keys, keystores and credential files | `git reset --hard`, `git clean -f`, `branch -D`, `sudo`/`doas`, `curl … \| sh` |
| writing into `.git/` and `protectedPaths`; path rules ignore letter case (`.GIT/config` is `.git/config` on macOS and Windows) | shell access to secret files; writes outside the project |
| `gh pr create/merge`, `glab mr create/merge`, merging into or pushing to the base branch while a task file is tracked; committing it on the base branch | editing CI and release pipelines, and git hooks: `.husky/`, `.githooks/`, lefthook and pre-commit configs, and the folder `core.hooksPath` named, inside its repository, when the session started |
| writing into the review records | `gh pr create`, `glab mr create`, merging into or pushing to the base branch and pushing to a PR branch the agent opened, without a reviewer `Yes` for the commit being landed or chained after anything but read-only steps and the project's verification commands (review gate); every PR/MR merge (`gh pr merge`, `glab mr merge`), even after a `Yes`; editing `.pi/guard.json` (edit/write, or a shell command naming it) |

**What the guard reads:** a command that, as a whole, only writes a file through a quoted heredoc (`cat > file <<'EOF'`, `cat >> file`, `tee [-a] file`, then the body and the delimiter as the last line) into a file inside the project is judged by its first line, since writing the file runs nothing in it, and its target is judged as a Write to it would be (`.git/` is blocked; CI pipelines, git hooks, the guard config and secret files ask). A program fed to `python`, `python3` or `node` (optionally `-`) the same way, with nothing else in the command and no backtick in it, is code, not shell: the blocks for a recursive delete outside the project, `--no-verify` and a force push read only its first line, so a comment or string that looks like one no longer blocks. The questions still match the program's text as they match a shell command, so a push, `npm publish`, `DROP TABLE`, `sudo` or a secret file written out as its own words still asks; what the code does by itself (`open('.env')`, `['npm', 'publish']`, `shutil.rmtree`) is not seen, as with an interpreter one-liner. A target elsewhere (`~/.zshrc`), every other heredoc, an unquoted delimiter, a `$` in the path, a carriage return or anything after the delimiter is judged whole. In a recursive `rm`, `/dev/null` left by `2>/dev/null` isn't a path to delete. Your own `block`, `confirm` and `allow` patterns still match the whole command.

**Command names and quoting.** The guard and the gates read a command as the shell runs it. Words split on spaces and tabs only, as in bash and zsh: U+00A0, U+FEFF, `\r`, `\v` and `\f` stay inside a word. The blocks, questions and gates also judge the command as PowerShell splits it (every blank, U+0085 included, as a space and `\r` as a line end) and with every `\r` dropped, as bash with `igncr` reads it; the stricter decision wins. In a folder of repositories, a repository's `allow` holds only when every reading runs in it. A program's name counts in any letter case, since macOS and Windows run `GIT`, `/usr/bin/Git` or `ſh` as git and sh: wherever a check names a program (git, gh, glab, rm, the wrappers, `sh -c`, the review gate's landings, `git -C` and `env -C` in a folder of repositories, and tee and sed in the verify gate's fallback), the word's base name is folded like a path. Builtins and keywords (`cd`, `pushd`, `popd`, `eval`, `export`, `if`…) count only as written: in another case they aren't builtins (`CD x` runs `/usr/bin/cd` in a child process), so they move nothing. A `$'…'` word is decoded where bash and zsh agree: the letter escapes (`\n`, `\t`…), `\\`, `\'`, `\"`, `\?`, octal, and `\x` with digits, as bytes read as UTF-8 (`$'\147it'` is `git`, `$'\xc5\xbf'h` is `ſh`), also after line continuations (`$\⏎'…'`). Anything the two shells may read differently asks and gets no verify credit, and as a move or a folder it leaves the folder unknown: any other escape (`\u` and `\U`, which macOS's bash 3.2 lacks; `\c`; zsh's `\C` and `\M`; an unknown letter; `\x` without digits), bytes that aren't UTF-8 on their own (`$'\xc5'$'\xbf'`), a NUL byte or BOM, a `$` right before a `$'…'` word (`$$'`, also across a continuation), and `$"…"` (bash's translation reads `"…"`, zsh `$…`). A word read that way that would be a `cd` leaves the folder unknown. Such a word is also read the way it most likely runs, without the mark, by the built-in blocks, your `block` and `confirm` patterns and the gates, and a block there wins over the question (`rm$'\x' -rf ~`). So `read -d $'\0'` asks; a quoted heredoc that only writes a project file has its body read as data. A quoted or escaped `;`, `&&` or `|`, or a quoted newline, is an argument, not a separator (`rm -rf ';' ~` deletes `~`); a segment that holds one runs several commands, so no part of it is a safe step before a landing, and every commit, merge, push or PR call in a segment is judged. The built-in rules and your `block` and `confirm` patterns also match the decoded command folded three ways (options left as written; every word, for a command glued to an option such as `-c"…('GIT push')"`; and the raw text with its quotes, for `env -S"GIT push"`); `allow` and the own-branch push see only the command as written, so folding never loosens anything. Arguments keep their case (`branch -d` isn't `-D`), and git itself refuses a subcommand in another case.

`.pi/guard.json` has six keys: `block`, `confirm`, `allow` (regex sources), `protectedPaths` (path prefixes), `workDocs` (the task-file folders, default `["docs/tasks"]`; `[]` turns that rule off) and `reviewGate` (`false` turns the review gate off). `allow` only relaxes confirmation, never a block. `allow`, `workDocs` and `reviewGate` apply only in trusted projects.

**In a folder of repositories** (a workspace, see the verify gate), the guard judges each repository's paths and commands as a session inside it would, with that repository's own `.pi/guard.json`, and the folder's `.pi/guard.json` on top; the stricter decision wins. Restrictions add up: a repository's `block`, `confirm` and `protectedPaths` (measured from the repository) apply to its files and to a command that runs in it (`cd a && …`, `git -C a …`), and every repository's apply to a command whose folder the guard can't follow. Loosening counts only where it is written, and only in a trusted project: a repository's `allow` only for a command that runs in that repository alone (and then it skips the folder's `confirm` rules too, as one config's `allow` does), its `workDocs` for its own task files, its `"reviewGate": false` for its own landings; the folder's apply everywhere. A PR, merge or push whose folder the guard can't follow is blocked. A plain push of a repository's own work branch (`git -C a push`) passes as it does inside it. The task-file reminders in the follow-up name each repository's task files (`a/docs/tasks/…`), skipping repositories the session found slow or that the 3-second budget didn't reach, named once in a notice. A command, or a part of one, that doesn't run inside one repository (from the workspace folder itself, or where the guard can't follow it: any PowerShell command, a shell string, `env -C`, git's `--git-dir` or an exported `GIT_DIR`) gets every repository's restrictions, and a repository the command names as a path (`--prefix a`, `../a/x`, through a symlink or in another case) adds its restrictions; a path with `$` or a glob next to `..` counts as one the guard can't follow. A path is judged from the repository it is written in and the one it really lands in (symlinks, a case-swapped name). A first-level folder's guard config asks when a Write or a shell command names it, also through `cd` or before the folder has a `.git`; copying, moving or deleting the folder doesn't ask, but what a repository restricted when the session started still holds, also without its `.git` or under another name. Only the repositories present when the session started (the same `.git`, not a clone put in their place) loosen anything or push silently, and only with their configs as they were; one cloned or changed later only restricts. The guard records them the first time a pi process starts a session in this folder and leaves the record in the environment: a later session or a subagent started in this folder or inside it takes that record and is judged as that session (a subagent in a repository's subfolder too), so a repository cloned since pushes only with a question; one working in another git checkout below it (a `.worktrees/<branch>`, a repository below the folder pi started in) is also judged as a session started there, and the stricter decision wins. A subagent, wherever it starts, gets loosening only when its parent session was trusted too. A session in an unrelated folder takes a record of its own, which keeps its parent's trust, and coming back after it records the folder anew; a later session of the same pi process counts as such a subagent, so it loosens only while its first session was trusted. A reason names the config its rule came from.

**Pushing the work branch.** A plain `git push` of the agent's own work branch passes without a question when all of these hold:

- the command is exactly `git [-C path] push [-u|--set-upstream|-q|-v|--progress|--no-progress|-n|--dry-run|--porcelain] [remote [refspec]]`, with no shell operators, quotes or variables (a trailing `2>&1` is allowed);
- the current branch is named by the convention `<type>/<kebab>` (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `style`, `revert`) and is not the base;
- the remote is configured and its effective push URL equals its configured URL;
- the push config adds nothing (no mirror, push refspecs, `followTags`, `pushOption`, `recurseSubmodules`, `receivepack` or unusual `push.default`) and no `GIT_*` redirect variable is set;
- the refspec, if any, names only the current branch;
- the repository is the session's project (same git common directory; worktrees count), or in a folder of repositories one that was there when the session started. A push from any other repository, such as one the agent cloned, asks first.

Everything else that pushes still asks first. `--force`, `-f`, `+ref` and `--mirror` stay blocked, and `--force-with-lease` asks first. The review gate is unchanged: `gh pr create` / `glab mr create` and pushes to a PR branch the agent opened need a `Yes` covering HEAD; PR/MR merges (`gh pr merge`, `glab mr merge`) always ask first, and so do pushes to the base.

Also asks first, because they can point a push elsewhere or write outside the repository: `git remote add|set-url|rename|set-head`; `git config` writes to `remote.`, `url.`, `push.`, `branch.`, `alias.`, `include.` and `includeif.`, to keys that run a command (`core.pager`, `core.editor`, `core.askpass`, `core.hooksPath`, `core.sshCommand`, `core.fsmonitor`, `core.gitProxy`, `sequence.editor`, `diff.external`, `gpg.program`, `filter.*`, `pager.*`, diff and merge drivers, difftool and mergetool commands, `submodule.*.update`, credential helpers, `http.proxy`) and `git config -e`; removing or renaming `core` or one of those sections (`--remove-section`, `--rename-section`); `--config-env`, and `-c` with any of those keys (with `core.hooksPath` both are blocked, as `--no-verify` is); for the program-running ones (pager, editor, askpass, `sequence.editor`, `diff.external`, `gpg.program`, `filter.*`, `pager.*`, drivers, tool commands, `submodule.*.update`) a harmless value (empty, `cat`, `true` or `:`) stays quiet, while `core.hooksPath`, `core.sshCommand`, `core.fsmonitor`, `core.gitProxy`, `http.proxy` and credential helpers always ask; `git symbolic-ref` writes; `git update-ref --stdin` or on `refs/remotes`; `git svn dcommit|branch|tag|set-tree` and `git p4 submit|commit`; unknown git options before the subcommand; indirect git (`xargs git …`, wrappers such as `sudo`, `env`, `timeout`, `stdbuf`, `flock`, `ionice`, `taskset`, `chrt`, `setsid`, `unbuffer` and `doas`; a dashed `git-<sub>` is treated as `git <sub>`); `sh -c`, `bash -c` and `eval` strings that contain git; `gh api` and `glab api` writes (a non-GET method, field or input flags without a method, GraphQL mutations, and GraphQL queries taken from `$VAR`, `$(…)`, a `@file` or `--input`; an inline read query stays quiet); `prisma db execute`, `prisma migrate resolve` and `migrate:down` / `migrate rollback` runs; `doas`, `run0` and `pkexec`, like `sudo`. `--no-verify` is blocked inside groups and substitutions too. Everyday reads stay quiet: `git --version`, read-only git in substitutions, `git config <key>` with one operand, `git symbolic-ref` reads, and `git -c` with ordinary keys or a harmless value. A git variable that runs a program or redirects git also asks when it is set in front of a git call (`X=… git …`, `env X=… git …`) or exported in the same command (an `export NAME` by name asks too, also `declare -x` and `typeset -x`, after `{`, `then` and the like): the program-running group (`GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_PROXY_COMMAND`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, and `PAGER`, `EDITOR`, `VISUAL` in front of a git call), the config-injection group (`GIT_CONFIG`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`) and the redirecting group (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_EXEC_PATH`, `GIT_NAMESPACE`, `GIT_TEMPLATE_DIR`). A harmless pager, editor or askpass value (empty, `cat`, `true`, `:`) and every other variable stay quiet.

**What the guard can't see.** A command guard reads the command, not the machine. It does not see indirect execution: quote-obfuscated shell strings (`sh -c 'g""it …'`), interpreter one-liners (`python -c "os.system('git …')"`), shells it doesn't list (`fish -c`), sourced scripts and script files, a setup command behind a wrapper the guard doesn't list (`find -exec`, `caffeinate`, `watch`), git under another name (a symlink or a copied binary) or through a relative path (`bin/git`), a variable placed before a program that runs git itself (`gh`, `npm install` with git dependencies, `make`, scripts), a variable already exported by the user's shell profile, proxy variables (`HTTPS_PROXY`, `ALL_PROXY`), `GIT_ALLOW_PROTOCOL`, and `export EDITOR=…` (by design), a `gh api` method set by a header override, and shell writes into `.git/config` or `.git/refs`. Any of these can configure a remote or push. Like `curl`, exfiltration is not something the guard prevents. Server-side CI, review and branch protection carry the rest.

**Review gate:** the guard records the verdict of each `reviewer` run in the `subagent` tool result (the `Reviewed BASE: <sha>`, `Reviewed HEAD: <sha>` and `Ready to merge: <one of Yes, No, With fixes, Inconclusive>` lines, with the report), so run the reviewer in the foreground; a failed reviewer run counts as `Inconclusive`, and so does a review that ran while edits were unverified. Before `gh pr create`, `glab mr create`, merging into or pushing to the base branch, and pushing to the branch of a PR the agent opened, it asks you unless the last verdict for that commit is `Yes` and its range reaches the remote base, directly or through earlier rounds (a repeat round's reviewer reads the previous findings and the round number with `scripts/review-log.ts`). A guard check that throws makes pi block the call. A verdict covers exactly the commit the reviewer reviewed: any change after it (a new commit, an amend, a rebase onto a newer base, a docs edit, deleting the task file) needs a new review, and a branch that changes only documentation is reviewed the same way, so the final review comes last, after docs, the task-file removal and any rebase. Commits already on the remote base land nothing new. A plain `cd`, `pushd` or `popd` and `git -C <dir>` are followed, so a worktree's branch is checked; any other move, or a move after `&&` once the chain breaks, makes the folder unknown, and the landing asks (details: docs/ARCHITECTURE.md). Land in a command of its own: a landing chained after anything but read-only steps and the project's verification commands asks; a PR/MR merge (`gh pr merge`, `glab mr merge`) always asks, whatever the verdict. In a folder of repositories (see the verify gate), the verdict is recorded in every repository that has the reviewed commit, a landing is checked against the verdicts and PR branches of the git repository it lands from, (a worktree elsewhere finds the same ones; PR branches registered in the folder's own store still count, retired by age only, and PR branches still gate once the folder stops being one of repositories); a verdict short of Yes that can't reach a repository with the commit is recorded in the others and followed by an Inconclusive for that commit (for each repository's HEAD only when the commit is named nowhere or a repository couldn't be searched for it in time, which the notice names), reported if it can't be recorded everywhere either, and `scripts/review-log.ts` run from that folder finds the commit's repository. A `Reviewed HEAD` or `BASE` written in hex must abbreviate the commit it names: a branch or tag named like a SHA doesn't count.

### token usage

The guard also keeps a token ledger per repository and branch, from the `subagent` results' usage and the session's own, shows `sub 1.2M · branch 5.6M` in pi's footer and prints a branch's tokens by agent with `/usage`; `/finish` points to it. pi's own footer already shows context use and the session's cost.

### verify

- **Where the commands come from:** `.pi/verify.json` (`{"commands": [...], "timeoutSec": 600}`), or else the `## Commands` section of `AGENTS.md` (the test, typecheck, lint and build lines; dev and watch commands are skipped), or else they are detected from the project's manifests as `/kit-init` does (package.json scripts, turbo, gradle, cargo, go, dotnet, pytest, make).
- **`/verify`** runs them and shares the result with the agent. **`run_verification`** is the tool the agent calls to get evidence.
- **The gate:** after an `edit`/`write` of a file inside the project, or any change a bash command makes to it (a heredoc, `sed -i`, a script, `npm install`; in git found from a fingerprint of the working tree taken before and after each bash call, so gitignored files don't count and staging or committing isn't an edit; in a project folder outside git that holds git repositories as direct subfolders (a folder of repositories: up to 32, ignored folders and deeper levels left out), from each repository's fingerprint under its folder plus the files outside them by size and time, skipping what the OS, an editor, a dependency install or a local tool writes on its own (`.DS_Store`, `Thumbs.db`, `.pi/git`, `.pi/npm`, `.idea`, `.vscode`, `node_modules`); a repository's files also follow that repository's own ignore globs, by their path inside it; a symlink pointing into the project counts by what it points to, and one pointing elsewhere, or whose text climbs with `..` after another segment, is a blind part, never read. Each part gets a share of the fingerprint's 2-second budget. A part that runs out of its share or whose git fails, and a symlink the walk meets that leads to a folder or out of the project, aren't fingerprinted in that call: they keep their last fingerprint (a listed file is read again), and the command's own targets inside them count. A part (a repository, or the files outside them) over 5,000 entries, or out of its share in two fingerprints running, is left out for the rest of the session and keeps its stored fingerprint. With such a part, a command that moves the shell has its targets placed from every folder its moves may reach, and one whose moves or names can't be followed (a variable, `chdir`, `CDPATH`, any PowerShell command, or `source`, `.`, `eval` or a `case` as a command) has every target count, or only those written under a symlink when only symlinks are blind (so a write after such a move into a symlinked folder isn't counted); a `subagent` call's changes inside such a part aren't seen; outside git with no repositories, in a tree of more than 5,000 listed files or once git has timed out in the session, from the command's `>`, `>>`, `tee` and `sed -i` targets (a redirection target written as a plain word in bash has `~`, `$HOME`, `$TMPDIR`, `$TMP`, `$TEMP` and variables the command assigns once expanded; any other target counts as written)), the workspace counts as unverified until every command passes, either through the tool or as an exact, unpiped bash run of that command. What a check changes itself (a formatter, `lint --fix`) doesn't count when it passed and the command ran nothing but checks joined by `&&`, with no redirection into a file; a write chained with a check, a check piped or followed by `;`, a failed check's changes and any log written into the project do, and a command that changed files doesn't count as a green run of the checks it also ran. A `subagent` call's changes are its own, with or without a UI. `git stash` counts: the files are no longer what was checked. Changes between tool calls (your editor, a background process) count only in a session with a UI, since a run without one is usually a subagent's own process. Files matching `ignore` in `.pi/verify.json` don't count (default: `**/*.md`, `**/*.mdx`, `**/*.txt`, `docs/**`; set `"ignore": []` if your checks lint docs).
- **The follow-up:** if the agent stops while the workspace is unverified, it gets one follow-up per user message asking for evidence and for its complete final report again. With no commands configured or detected there is no follow-up: you get one notice per session to run `/kit-init` or add `.pi/verify.json` (none without a UI). A `.pi/verify.json` that doesn't parse still gets the follow-up, naming the error. The review gate's "unverified edits" rule and the read-only steps allowed before a landing use configured commands only, never detected ones.
- **Task files** (`docs/tasks/`) live only on the work branch. The same follow-up asks to commit a task file marked `Status: design approved` or `plan approved` (on a work branch), and, once every `## Plan` checkbox is ticked, to move what lasts into `docs/`, show its Follow-ups and delete it. The ci-quality-gates templates add a `working-docs` CI job that fails on any tracked `docs/tasks/*.md`, for people and other tools alike.

### models (routing by command)

Configure it in `~/.pi/agent/model-routing.json` (global) and/or `.pi/model-routing.json` (project; applied only in trusted projects, so a cloned repo can't route you to a paid model). The project file overrides the global one key by key. Start from [templates/model-routing.json](templates/model-routing.json):

```json
{
  "modes": {
    "deep": { "model": ["anthropic/claude-opus-5-5"], "thinking": "xhigh" },
    "fast": { "model": ["anthropic/claude-sonnet-5"], "thinking": "medium" }
  },
  "commands": { "review": "deep", "plan": "deep", "implement": "deep", "onboard": "fast", "skill:security-review": "deep" }
}
```

- `model` is one `provider/id` or a list of them. The first one available to you is used, so teammates with different providers can share one file. Check the exact IDs with `pi --list-models`.
- **Switching:** a message starting with a routed command (`/review …`, `/skill:security-review …`) switches the model before the turn runs.
- **Sticky model:** plain messages keep the current model. Follow-ups sent by extensions, such as the verify gate, never switch it.
- **When a model is unavailable,** you get a warning and the current model stays.
- **`/mode deep`** switches manually. **`/mode`** lists the modes and routes.

Built into pi without this extension: `defaultModel`, `enabledModels` (`Ctrl+P` cycling) and `modelThinkingLevels` in settings, `/model`, and `--model provider/id:high`.

**Subagents:** give `pi-subagents` agents their own models. Use a cheap or mid-tier model for `scout`, and the most capable one for `worker`, `reviewer` and `oracle`: writing the code and judging it are where quality is worth paying for. See its [models docs](https://github.com/nicobailon/pi-subagents/blob/main/docs/models.md) for the configuration keys.

## Develop

```bash
npm install
npm test          # extension unit tests, test-hygiene, release check, skill linter (frontmatter, budgets, links, named skills and agents)
npm run typecheck
```

Edit skills with the `writing-skills` skill. Keep `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.ru.md` in sync.

**Releasing:** bump `version` in `package.json` and the `@vX.Y.Z` in the install sources of this README, the getting-started guides and `templates/settings.json`, add its `## X.Y.Z` section to `CHANGELOG.md`, and merge to `main`. CI checks the section and the pinned versions on every PR, and after a green run on `main` it creates the `vX.Y.Z` tag and GitHub Release with that section as the notes.

**Name clashes:** pi silently keeps one prompt per name. With `pi install`, a project's own `.pi/prompts/implement.md` or `review.md` wins over this kit's; with `pi -e`, the kit wins. Rename one of them if you need both.

**Team installs:** `pi install -l <local path>` records a machine-specific relative path. For teams, use the git source with a version tag: `pi install -l git:…@vX.Y.Z`. See the getting-started guide.

## License

MIT, see [LICENSE](LICENSE). Third-party notices: [NOTICE.md](NOTICE.md).
