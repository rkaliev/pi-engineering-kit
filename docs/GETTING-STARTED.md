# Getting started

Russian version: [GETTING-STARTED.ru.md](GETTING-STARTED.ru.md)

There is nothing to copy. The package is a regular pi package, and pi installs it for you.

The package repository: [github.com/rkaliev/pi-engineering-kit](https://github.com/rkaliev/pi-engineering-kit). Below, **`<kit>`** is a local clone (`git clone https://github.com/rkaliev/pi-engineering-kit`); you only need it for the demo and for development.

## 0. Install pi

Pi is a CLI agent that runs in the terminal. It needs **Node.js 22.19 or newer**: the official installers set it up for you if it is missing. The npm package is `@earendil-works/pi-coding-agent`, and the command is called `pi`.

| Option | When it fits |
|---|---|
| [macOS / Linux installer](#macos--linux-installer-recommended) | Regular install, recommended |
| [Windows installer](#windows) | Native Windows |
| [npm / pnpm / yarn / bun globally](#via-a-package-manager) | Node is already installed and you want to manage the version yourself |
| [npx / pnpm dlx / bunx without installing](#without-installing-npx) | Trying it out, CI, a one-off run |
| [Version in the project (devDependency)](#pi-version-in-the-project) | The whole team on one pi version |
| [Docker](#docker-isolated) | Untrusted or autonomous tasks |
| [Android (Termux)](#android-termux) | Phone or tablet |

### macOS / Linux installer (recommended)

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

- Checks that Node.js ≥ 22.19 and npm are present. If they are not, it offers to install them: through Homebrew if you have it, otherwise as standalone Node.js.
- Running it again on a machine where pi is already installed offers to reinstall or remove pi.

### Windows

In PowerShell:

```powershell
irm https://pi.dev/install.ps1 | iex
```

- The installer checks for Node.js 22.19+ and **Git for Windows**: pi uses Git Bash for shell commands.
- The other option is to install pi inside **WSL** and use it as on Linux.
- More details, including `shellPath` and PowerShell as a model tool: [Windows setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md). This package's guard has not yet been tested with the `powershell` tool on Windows.

### Via a package manager

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # the official way
pnpm add -g @earendil-works/pi-coding-agent
yarn global add @earendil-works/pi-coding-agent                   # yarn 1
bun add -g @earendil-works/pi-coding-agent
```

- `--ignore-scripts` comes from the official documentation: pi does not need its install scripts.
- Only npm and the installers are officially documented. pnpm, yarn and bun install the same npm package.

### Without installing (npx)

```bash
npx -y @earendil-works/pi-coding-agent          # latest version
npx -y @earendil-works/pi-coding-agent@0.87.1   # a specific version
pnpm dlx @earendil-works/pi-coding-agent        # the same via pnpm
bunx @earendil-works/pi-coding-agent            # the same via bun
```

- All arguments are passed as usual, for example `npx -y @earendil-works/pi-coding-agent -e <kit>`.
- Settings, login and packages are stored in the same `~/.pi/agent` as with a global install.
- The first run downloads the package into the cache, so a global install is more convenient for daily work.
- `npx` and `pnpm dlx` were tested with pi 0.87.1, `bunx` was not: the test machine had no bun.

### pi version in the project

```bash
npm install -D @earendil-works/pi-coding-agent@0.87.1
npx pi
```

The version is pinned in `package.json` and the lockfile, so the whole team and CI get the same pi version. This package itself works the same way: its tests and typecheck run on this version.

### Docker (isolated)

For tasks where the agent must not get access to the whole machine. The official recipe is `Dockerfile.pi`:

```dockerfile
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
WORKDIR /workspace
ENTRYPOINT ["pi"]
```

```bash
docker build -t pi-sandbox -f Dockerfile.pi .
docker run --rm -it -e ANTHROPIC_API_KEY -v "$PWD:/workspace" -v pi-agent-home:/root/.pi/agent pi-sandbox
```

- Don't mount the host's `~/.pi/agent`: it holds your keys and sessions.
- Other isolation options (Docker Sandboxes, OpenShell, Gondolin) are described in [Containerization](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md).

### Android (Termux)

First `pkg install nodejs git`, then install through npm as above. Details: [Termux setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/termux.md).

### Check, update, remove

```bash
pi --version          # check the installation
pi update             # update pi
pi update --all       # update pi and all installed pi packages
```

- **Remove:** run the installer again and choose removal, or `npm uninstall -g @earendil-works/pi-coding-agent`.
- **`pi: command not found` after installing through npm:** npm's global binaries directory is not in `PATH`. Find it with `npm prefix -g` and add `<prefix>/bin` to `PATH`.

### Connect a model

Pi works with a subscription, an API key or a local model.

```bash
cd ~/projects/my-app
pi
```

Inside pi:

```
/login            # choose a provider: subscription (OAuth) or API key
/model            # choose a model
```

- Credentials are saved in `~/.pi/agent/auth.json`.
- Instead of `/login`, you can set the key in an environment variable, for example `export ANTHROPIC_API_KEY=…`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`. The full list is in [Providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md).
- Available models: `pi --list-models`.
- On the first run in a project folder, pi asks whether to trust the project. Without that, it does not read the project's `.pi/`.

#### Claude (Anthropic)

**Through a Claude subscription (Pro/Max):**
1. In pi, run `/login` and choose **"Anthropic (Claude Pro/Max)"**.
2. `claude.ai` opens in the browser. Sign in with your Claude account and approve access.
3. Pi receives the response via `localhost`. If the browser is on another machine (SSH, server), paste the final redirect URL or the authorization code into pi; pi will prompt you for it.
4. The tokens are saved in `~/.pi/agent/auth.json` and refresh on their own from then on. To sign out: `/logout`.

> **Check the terms first.** Anthropic restricts the use of consumer subscription credentials in third-party tools, and pi is a third-party agent. Corporate accounts (Team, Enterprise) are also subject to company policy. Before using it, check Anthropic's current terms and talk to your account administrator.

**Through an API key (the reliable path for any third-party agent):**
1. Create a key in the Claude Console (`platform.claude.com`). For a corporate account, the administrator issues the key.
2. Connect it in one of these ways:
   - `/login` → Anthropic → API key;
   - `export ANTHROPIC_API_KEY=sk-ant-...` before starting `pi`;
   - keep the key in the macOS keychain instead of a file. To do that, put this in `~/.pi/agent/auth.json`:
     ```json
     { "anthropic": { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" } }
     ```
3. Billing is by usage (pay-as-you-go), separate from the subscription.

In both cases the provider is called `anthropic`, so `.pi/model-routing.json` (modes `deep`, `fast`, `cheap`) works without changes. Check the exact model IDs with `pi --list-models`.

### What else

- **`pi-subagents`** (recommended): needed for fresh-context reviews and parallel scouting. `/kit-init` adds it to the project for you.
- **Node.js 22.18+ separately** is needed only for `npm test` in the demo project and for developing the package itself.
- Official pi documentation: [pi.dev](https://pi.dev) and the [docs in the repository](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs).

## 1. Installation: three ways

### Try it without installing anything

```bash
cd ~/projects/my-app
pi -e <kit>
```

The package works only in this session; nothing changes in your settings.

### Install it for yourself, from a local folder

```bash
pi install <kit>      # for all your projects (~/.pi/agent/settings.json)
```

- Pi links the folder instead of copying it, so edits in `<kit>` show up after `/reload` or a restart.
- There is also `pi install -l <path>`, but it writes a **relative path to your folder** into the project's `.pi/settings.json`. That path won't work for your teammates, so for a team use the method below.

### From GitHub (recommended)

For yourself, for all projects:
```bash
pi install git:github.com/rkaliev/pi-engineering-kit@v0.8.0
```

For a team, one line in the project:
```bash
cd ~/projects/my-app
pi install -l git:github.com/rkaliev/pi-engineering-kit@v0.8.0
git add .pi/settings.json && git commit -m "chore: enable pi-engineering-kit"
```

A teammate only needs to clone the project, run `pi` and confirm trust in the project. Pi installs the package at the right version on its own. **Updating:** change the version after `@` to a new tag from the [releases](https://github.com/rkaliev/pi-engineering-kit/releases). The version does not change on its own.

## 2. Set up the project: `/kit-init`

Inside pi, at the project root:

```
/kit-init
```

The command shows what it will create, asks about each file and **never overwrites existing ones** (the one exception is an older test-hygiene copy, below):

| File | What it contains |
|---|---|
| `.pi/verify.json` | Verification commands: from `## Commands` in AGENTS.md, otherwise from `package.json` scripts (npm/pnpm/yarn/bun by lockfile; with a `turbo.json`, one `turbo run` of its typecheck, lint and test tasks), otherwise `./gradlew check`, `cargo test`, `go test`, `dotnet test`, `pytest` |
| `.pi/guard.json` | Empty project guard rules. The built-in rules apply without them, including the task-file rule for `docs/tasks` (the `workDocs` key changes the folders; `[]` turns it off) |
| `.pi/model-routing.json` | The `deep`, `fast` and `cheap` modes and which command runs in which mode. **Check the model IDs against `pi --list-models`** |
| `.pi/settings.json` | Adds `npm:pi-subagents` to `packages` and leaves the other keys alone |

- If the project has no `AGENTS.md`, the command offers to run `/onboard`: the agent studies the repository, runs the commands and proposes an AGENTS.md.
- The command also reports CI that doesn't run every verification command or lacks the `working-docs` job (the ci-quality-gates skill adds both).
- `/kit-init --yes` creates everything missing without questions. This is handy for scripts.
- `/kit-init --test-hygiene` also copies the stack-independent test-hygiene check for CI into `.ci/test-hygiene.mts` (the ci-quality-gates skill adds its job), or replaces an older copy. Without the flag it is only offered. Flags combine (`/kit-init --yes --test-hygiene`), and the command completes each of them.

Commit all the `.pi/*` files: then the team has the same checks, rules and models.

## 3. Demo on a test project

The package includes a mini project, `examples/demo`: a dependency-free cart library and one task with numbered criteria. Copy it so you don't touch the original:

```bash
cp -r <kit>/examples/demo /tmp/kit-demo
cd /tmp/kit-demo && git init -q && git add -A && git commit -qm init
npm test                    # 2 tests, green
pi install <kit>            # or: pi -e <kit>
pi
```

From here on, commands are typed inside pi.

| Step | What to type | What you'll see |
|---|---|---|
| 1 | confirm trust | Pi loads the project's `.pi/` |
| 2 | `/kit-init` | Questions about the files. `npm test` ends up in `verify.json`: pi took it from AGENTS.md |
| 3 | `/mode` | The current model, modes and routes. If you don't have the models from `model-routing.json`, fix the IDs |
| 4 | `/implement tasks/01-percent-discount.md` | The model switches to `fast`. The agent shows a plan of up to 7 lines and follows TDD: a failing test for each criterion first. The task is about money, so `payments-and-money` kicks in: integer arithmetic only and half-up rounding. After the first edit, `verify: unverified edits` appears in the status |
| 5 | (the agent says "done") | If there were no checks after the edits, the verify gate sends the agent back: "Verify gate: files changed…". The agent calls `run_verification` and gives a report: files, commands with results, criteria 1–5, what was not verified |
| 6 | `/review tasks/01-percent-discount.md` | The `deep` model. The review is read-only: Criteria / Confirmed / Assumptions / Questions / Verdict |
| 7 | `/verify` | A manual run of the checks; the agent sees the result too |
| 8 | `/finish` | The merge / PR / keep / discard options. Push and merge run only after you choose |

How to check guard: create `.env` with any value and ask the agent to read it. Reading through the `read` tool is blocked, and `cat .env` in the shell needs confirmation. `git push --force` is refused with a hint about `--force-with-lease`.

Other ways into the work:
- `/brainstorm <idea>`: design before code, written to a task file in `docs/tasks/`;
- `/plan <task file>`: a plan in its `## Plan`;
- `/debug <symptom>`: finding a bug's root cause;
- `/new-task <what to do>`: write a task file with only the description and criteria;
- `/skill:<name>`: force-load a skill.

On your own project the sequence is the same: `/kit-init` → `/onboard` (if there is no AGENTS.md) → `/new-task` → `/implement`.

## 4. FAQ

- **The commands from `.pi/` did not show up.** The project is not trusted: run `/trust`, or restart pi and confirm. Without trust, pi does not read `.pi/settings.json`, `.pi/prompts`, `.pi/skills` or `.pi/model-routing.json`. The built-in guard and verify rules work anyway.
- **The project has its own prompts with the same names** (for example, `.pi/prompts/implement.md`). Pi silently picks one version:
  - with `pi install`, the project's prompts (`.pi/prompts/*.md`) win;
  - with `pi -e`, the package wins.
  To use our version, rename the project file, or delete it if it duplicates ours.
- **"no available model for mode …".** `model-routing.json` names a model you don't have access to. Fix the ID or give a list, for example `"model": ["anthropic/…", "openai/…"]`: the first available one is used.
- **Guard refuses `gh pr create` or a merge: "Task files would reach …".** A task file (`docs/tasks/`) lives only on the work branch. Finish it first (`/finish` does it): move what lasts into `docs/` (topic chapter, decision records), look at its Follow-ups, then delete it in one commit.
- **Guard asks before `gh pr create` or a merge: "Review gate: …".** The branch's code has no reviewer `Yes`. Run `/review` (the reviewer in the foreground, not in the background), fix its findings, and review the new range. Land in a command of its own, not chained after `git commit` or `git switch`. Any change after the review, docs included, needs a new one, so review last. The review's range starts at the merge-base with `origin/<base>`, or at the previous round's HEAD. Skipping it is your call.
- **The verify gate says there are no commands.** Fill in `.pi/verify.json` or the `## Commands` section in AGENTS.md.
- **How to see what is loaded.** `pi list` shows the packages, `pi config` turns individual package resources on and off.

How it all works and why: [ARCHITECTURE.md](ARCHITECTURE.md).
