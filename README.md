# pi-engineering-kit

A [pi](https://pi.dev) package that turns the pi coding agent into a disciplined engineer.

It works on any project, and it adapts along three independent axes:
- **where the code runs:** web, mobile (Android, iOS) or desktop (Windows, Linux);
- **what it does:** anything from entertainment apps to point-of-sale systems and payments, with dedicated skills where mistakes are costly (money, fiscal rules, security);
- **what state the code is in:** a brand-new project or an existing codebase, including one written long before AI agents.

The process on top of them is the same everywhere: design → plan → TDD → verify → review → git.

It contains:
- **28 skills:**
  - **process core:** design, plan, TDD (with optional BDD), debugging, verification, review, git, CI quality gates, documentation, dependency updates;
  - **starting point:** choosing a stack for a new project, onboarding an existing one, changing legacy code safely;
  - **platforms:** web frontend, backend services, mobile, desktop, and UI motion across them;
  - **high-risk domains:** payments and money, POS and fiscal, security review, observability, database changes.
- **9 prompt templates** that act as entry points: `/brainstorm`, `/plan`, `/implement`, `/review`, `/debug`, `/onboard`, `/finish`, `/new-task`, `/docs`.
- **5 extensions:**
  - **bootstrap** loads the skill rules into every request.
  - **guard** blocks irreversible or secret-leaking tool calls and PRs or merges that would carry a task file to the base branch, and asks you before outward-facing ones and before landing a commit without a passing review.
  - **verify** runs the project's checks and won't let the agent finish with unverified edits, while an approved task file is uncommitted, or while an implemented one is still in the tree.
  - **init** adds `/kit-init`, which creates the project's `.pi/` config in one step.
  - **models** routes each command to its own model and thinking level (`/review` on the strongest model, `/implement` on a mid-tier one), and adds `/mode` for manual switching.
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
pi install git:github.com/rkaliev/pi-engineering-kit@v0.13.0

# or pin it for one project and its team (-l writes .pi/settings.json; commit it)
pi install -l git:github.com/rkaliev/pi-engineering-kit@v0.13.0

# or try a local clone for one session only
git clone https://github.com/rkaliev/pi-engineering-kit && pi -e ./pi-engineering-kit

# recommended: subagents for reviews, parallel scouting and per-task execution
pi install npm:pi-subagents
```

Without `pi-subagents`, the skills fall back to doing that work inline.

## Set up a project

1. Run `/kit-init`. It creates the missing `.pi/verify.json` (commands detected from AGENTS.md, package scripts or build tools), `.pi/guard.json` and `.pi/model-routing.json`, and adds `pi-subagents` to `.pi/settings.json`. It never overwrites existing files other than an older copy of the kit's test-hygiene script, and `--yes` skips the questions. `/kit-init --test-hygiene` also copies the test-hygiene script into `.ci/test-hygiene.mts` for CI (an ES module whatever `package.json` says) and replaces an older copy; without the flag it is only offered. It reports an older copy and a CI that doesn't run it.
2. Run `/onboard`. It maps the repo, proves the build and test commands, and proposes `AGENTS.md` and `.pi/verify.json`. For new projects, start from [templates/AGENTS.md](templates/AGENTS.md).
3. Tune `.pi/guard.json` ([example](templates/guard.json)) and `.pi/model-routing.json` if needed.
4. Each piece of work gets one task file, `docs/tasks/YYYY-MM-DD-<slug>.md`, from [templates/task.md](templates/task.md): description, criteria, plan and progress in one place, standing in for a tracker issue (`/new-task` writes the description for you).

A typical loop:

```
/brainstorm add refunds to the checkout API     # task file, design approved before code
/plan docs/tasks/2026-09-25-refunds.md          # bite-sized TDD tasks in its ## Plan
/implement docs/tasks/2026-09-25-refunds.md     # executes, verifies; moves what lasts to docs/, deletes the task file
/review                                         # fresh-context review: Confirmed vs Assumptions
/finish                                         # verify → merge / PR / keep / discard
```

Small, bounded changes need no task file: they stay in chat, e.g. `/implement make search ignore case`.

## Extensions

### guard

| Blocks | Asks first (blocked in non-interactive modes) |
|---|---|
| `--no-verify`, `git commit -n` | `git push`, publish and release commands |
| `push --force` / `-f` / `+ref` / `--mirror` | deploys, `terraform apply`, `kubectl apply`, `helm upgrade` |
| recursive `rm` outside the project (`/`, `~`, `$HOME`, `..`, other absolute paths) | DB migrations, `DROP` / `TRUNCATE` |
| reading `.env*`, keys, keystores and credential files | `git reset --hard`, `git clean -f`, `branch -D`, `sudo`, `curl … \| sh` |
| writing into `.git/` and `protectedPaths` | shell access to secret files; writes outside the project |
| `gh pr create/merge`, `glab mr create/merge`, merging into or pushing to the base branch while a task file is tracked; committing it on the base branch | editing CI and release pipelines |
| writing into the review records | the same without a reviewer `Yes` for the commit being landed, chained after anything but read-only steps and the project's verification commands, or `gh pr merge <number\|URL>` (review gate); editing `.pi/guard.json` (edit/write, or a shell command naming it) |

`.pi/guard.json` has six keys: `block`, `confirm`, `allow` (regex sources), `protectedPaths` (path prefixes), `workDocs` (the task-file folders, default `["docs/tasks"]`; `[]` turns that rule off) and `reviewGate` (`false` turns the review gate off). `allow` only relaxes confirmation, never a block. `allow`, `workDocs` and `reviewGate` apply only in trusted projects.

**Review gate:** the guard records the verdict of each `reviewer` run in the `subagent` tool result (the `Reviewed HEAD: <sha>` and `Ready to merge: <one of Yes, No, With fixes, Inconclusive>` lines), so run the reviewer in the foreground; a failed reviewer run counts as `Inconclusive`, and so does a review that ran while edits were unverified. Before `gh pr create/merge`, `glab mr create/merge`, merging into or pushing to the base branch it asks you unless the last verdict for that commit is `Yes`. A verdict covers exactly the commit the reviewer reviewed: any change after it (a new commit, an amend, a rebase onto a newer base, a docs edit, deleting the task file) needs a new review, and a branch that changes only documentation is reviewed the same way, so the final review comes last, after docs, the task-file removal and any rebase. Commits already on the remote base land nothing new. `cd <dir>` and `git -C <dir>` are followed, so a worktree's branch is checked. Land in a command of its own: a landing chained after anything but read-only steps and the project's verification commands asks, and so does `gh pr merge <number>`.

### verify

- **Where the commands come from:** `.pi/verify.json` (`{"commands": [...], "timeoutSec": 600}`), or else the `## Commands` section of `AGENTS.md` (the test, typecheck, lint and build lines; dev and watch commands are skipped).
- **`/verify`** runs them and shares the result with the agent. **`run_verification`** is the tool the agent calls to get evidence.
- **The gate:** after an `edit`/`write` of a file inside the project, the workspace counts as unverified until every command passes, either through the tool or as an exact, unpiped bash run of that command. Files matching `ignore` in `.pi/verify.json` don't count (default: `**/*.md`, `**/*.mdx`, `**/*.txt`, `docs/**`; set `"ignore": []` if your checks lint docs).
- **The follow-up:** if the agent stops while the workspace is unverified, it gets one follow-up per user message asking for evidence.
- **Task files** (`docs/tasks/`) live only on the work branch. The same follow-up asks to commit a task file marked `Status: design approved` or `plan approved` (on a work branch), and, once every `## Plan` checkbox is ticked, to move what lasts into `docs/`, show its Follow-ups and delete it. The ci-quality-gates templates add a `working-docs` CI job that fails on any tracked `docs/tasks/*.md`, for people and other tools alike.

### models (routing by command)

Configure it in `~/.pi/agent/model-routing.json` (global) and/or `.pi/model-routing.json` (project; applied only in trusted projects, so a cloned repo can't route you to a paid model). The project file overrides the global one key by key. Start from [templates/model-routing.json](templates/model-routing.json):

```json
{
  "modes": {
    "deep": { "model": ["anthropic/claude-opus-5-5"], "thinking": "high" },
    "fast": { "model": ["anthropic/claude-sonnet-5"], "thinking": "medium" }
  },
  "commands": { "review": "deep", "plan": "deep", "implement": "fast", "skill:security-review": "deep" }
}
```

- `model` is one `provider/id` or a list of them. The first one available to you is used, so teammates with different providers can share one file. Check the exact IDs with `pi --list-models`.
- **Switching:** a message starting with a routed command (`/review …`, `/skill:security-review …`) switches the model before the turn runs.
- **Sticky model:** plain messages keep the current model. Follow-ups sent by extensions, such as the verify gate, never switch it.
- **When a model is unavailable,** you get a warning and the current model stays.
- **`/mode deep`** switches manually. **`/mode`** lists the modes and routes.

Built into pi without this extension: `defaultModel`, `enabledModels` (`Ctrl+P` cycling) and `modelThinkingLevels` in settings, `/model`, and `--model provider/id:high`.

**Subagents:** give `pi-subagents` agents their own models. Use a cheap or mid-tier model for `scout` and `worker`, and the most capable one for `reviewer` and `oracle`: the final review is the judgment call worth paying for. See its [models docs](https://github.com/nicobailon/pi-subagents/blob/main/docs/models.md) for the configuration keys.

## Develop

```bash
npm install
npm test          # extension unit tests, test-hygiene, skill linter (frontmatter, budgets, links)
npm run typecheck
```

Edit skills with the `writing-skills` skill. Keep `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.ru.md` in sync.

**Releasing:** bump `version` in `package.json`, add its `## X.Y.Z` section to `CHANGELOG.md`, and merge to `main`. CI checks the section on every PR, and after a green run on `main` it creates the `vX.Y.Z` tag and GitHub Release with that section as the notes.

**Name clashes:** pi silently keeps one prompt per name. With `pi install`, a project's own `.pi/prompts/implement.md` or `review.md` wins over this kit's; with `pi -e`, the kit wins. Rename one of them if you need both.

**Team installs:** `pi install -l <local path>` records a machine-specific relative path. For teams, use the git source with a version tag: `pi install -l git:…@vX.Y.Z`. See the getting-started guide.

## License

MIT, see [LICENSE](LICENSE). Third-party notices: [NOTICE.md](NOTICE.md).
