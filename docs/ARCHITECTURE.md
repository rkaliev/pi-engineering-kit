# pi-engineering-kit: how it works

Russian version: [ARCHITECTURE.ru.md](ARCHITECTURE.ru.md)

pi-engineering-kit is a package for the [pi](https://pi.dev) coding agent that turns it into a disciplined engineer. The package fits any project and adapts to it along three independent axes:
- **where the code runs:** web, mobile apps (Android, iOS), desktop (Windows, Linux);
- **what it does:** anything from entertainment apps to point-of-sale systems and payments; where mistakes are costly (money, fiscal rules, security), there are dedicated skills;
- **what state the code is in:** a new project or an existing one, including one written long before agentic development.

On top of these axes runs one and the same process: design → plan → TDD → verify → review → git.

This document describes how the package is built and why it is built this way. How to install it and try it: [GETTING-STARTED.md](GETTING-STARTED.md).

---

## 1. The idea in three sentences

1. **The process scales with the size of the task.** A small fix takes the short path, an architectural change takes the full path from task file to review. When in doubt, the heavier path is chosen. Risk sets the floor: CI and release pipelines, permissions, auth, secrets, money, schema and deploy config never take the short path, however small the change.
2. **The model does not decide on its own that the work is done.** The project's checks decide that. A gate in an extension sends the agent back to work if there was no green run after its edits.
3. **Irreversible and outward-facing actions go through a human.** The guard extension blocks dangerous commands and asks for confirmation on deploy, migrations, publishing, merging and any push except a plain push of the agent's own work branch.

---

## 2. Architecture

```
┌──────────────────────────────────── project ────────────────────────────────────┐
│ AGENTS.md (commands, rules, boundaries, DoD)   .pi/verify.json   .pi/guard.json │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ read by
┌─────────────────────── pi-engineering-kit (this package) ───────────────────────┐
│ extensions/bootstrap.ts  → into every request: the using-skills skill           │
│ extensions/guard.ts      → tool_call: block / confirm / allow                   │
│ extensions/verify.ts     → /verify, run_verification, gate on agent_end         │
│ extensions/models.ts     → model and thinking per command, /mode                │
│ extensions/init.ts       → /kit-init: the project's .pi/ in one command         │
│ skills/   28 skills (process, start, platforms, domains), by description        │
│ prompts/  9 entry points: /brainstorm /plan /implement /review …                │
│ templates/ AGENTS.md, task.md, verify.json, ts-monorepo/, …                     │
│ scripts/  test-hygiene.ts (/kit-init --test-hygiene), scaffold-template.ts, …   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**The work loop:**

```
idea ──/brainstorm──▶ classification: Spike | Bounded | Architectural
  Spike ─────────▶ probe → recommendation (throwaway code)
  Bounded ───────▶ design in chat → "yes" → /implement (TDD) → verify → report
  Architectural ─▶ task file → "yes" → /plan → "yes" → /implement (executing-plans)
                    → requesting-code-review → /finish (merge / PR / keep / discard)
bug ──/debug──▶ systematic-debugging: root cause → failing test → one fix → verify
someone else's repo ──/onboard──▶ map → proven commands → AGENTS.md + .pi/verify.json
```

**Who is responsible for what:**
- **Prompts** are thin entry points.
- **Skills** contain the whole method.
- **Extensions** mechanically enforce what cannot be left to text alone.

Thanks to this split, the package does not duplicate itself: the definition-of-done rules live in one place instead of being repeated in every prompt.

---

## 3. Skills

### Process core

| Skill | What it does | Why this way |
|---|---|---|
| `using-skills` | The "check skills first" rule, priorities, three paths (Spike / Bounded / Architectural), a "where to start" table, the "Always true" block, red flags | It is injected into every request, so it carries the common rules: evidence before claims, scope, tests, questions at forks, secrets |
| `brainstorming` | Design before code: work classification, one question at a time, 2–3 approaches, the task file's description, self-review | Domain questions (money, POS, OS) are asked up front, because changing things later is expensive. Several independent subsystems become separate tasks: one now, the rest one line each in Follow-ups. Split only at real seams: each task delivers value or a rollout step and is green on its own; a coherent change is never cut to fit a size |
| `writing-plans` | A plan, written into the task file's `## Plan`, as the set of decisions the executor won't make on its own: files, signatures, Interfaces, Review focus | A plan longer than the code means the code is already written in the plan. Execution is inline or one subagent per task |
| `executing-plans` | Plan execution with a record in the task file's `## Progress`, "rulings, not stalls", a task completion contract, the "subagent per task" mode | Progress is plain markdown: it survives compaction and needs no scripts. The `worker` dispatched per task reports like an implementer: changed files, each new test and that it was seen failing first, the commands run with their results; fixes go back to the same worker, so it keeps its context. At the finish, what lasts moves into `docs/`, the Follow-ups go to the user, and the task file is deleted in one commit |
| `test-driven-development` | Iron Law, RED→GREEN→REFACTOR; `references/test-standard.md` is the single source of the test rules, `references/bdd.md` the optional BDD layer | "A test that was never red proves nothing" and "don't weaken tests to get green". For legacy, characterization tests come first. Other skills link to the standard instead of restating it |
| `systematic-debugging` | 4 phases, root-cause tracing, "3 failed fixes means a question about the architecture" | System boundaries with examples for POS and mobile, a rule on flaky tests |
| `verification-before-completion` | The IDENTIFY→RUN→READ→VERIFY→CLAIM gate and the format of an honest report | local / commit / push / CI / deploy / live are kept separate. A pipe into `tail` hides the exit code |
| `requesting-code-review` | Review in a fresh context over a SHA range, a reviewer prompt template, a checklist | **Confirmed / Assumptions / Questions**; every finding has a trigger, a consequence and evidence. A failure is compared against the base revision. The project's own rules (AGENTS.md, the decision records the diff touches or cites) are requirements too. AI review does not replace human approval |
| `receiving-code-review` | Verify before implementing; YAGNI via grep | A comment is rejected only with a concrete justification |
| `git-workflow` | Isolation, baseline, commits, 4 ways to finish a branch | Never `--no-verify`, force only as `--force-with-lease`, discard only on explicit input. The PR body links the task file at the last commit that had it |
| `dispatching-parallel-agents` | Grouping by independent domains, self-contained prompts | Writers with non-overlapping files; without subagents, sequentially |
| `writing-documentation` | Where things live (README, docs/, decision records, CHANGELOG, agent manifest, API reference, comments), rules for text and comments, what goes stale when code changes | Documentation is part of the change: in the same commit and about the current state. Before "docs updated", commands are run and links are checked. If the project has its own format, that one is used. It rests on four layers: the rule in this skill; the "Post-implementation" block in every plan and the docs update step in `/implement` and `executing-plans`; stale docs in review are Important; mechanical checks (`references/checks.md`) are offered for the project's verify and CI |
| `ci-quality-gates` | Checks in the project's CI | CI runs at least everything from verify.json; one required `gate` job; per-stack layers are added only with a "yes": test hygiene (the kit's `test-hygiene` script and the stack's native linters), e2e without retries and with a JUnit count of executed tests, provider sandboxes as a separate job, secrets and dependency audit, migrations and drift, contracts, coverage as a floor on a schedule; a `working-docs` job, so task files never reach the base branch from any author; branch protection only with a "yes" |
| `updating-dependencies` | Updating, adding and removing dependencies, SDKs and toolchains | One at a time; changelog read, breaking changes written down; a major version or a new dependency only with a "yes"; vulnerabilities first; only the package manager changes the lockfile; a full run of the checks |
| `writing-skills` | How to write and test skills | The description is triggers only. A skill is tested with a scenario run without it (RED) |

### Starting point: new or existing code

| Skill | Why |
|---|---|
| `choosing-a-stack` | The stack is chosen for reliability in the domain. A table of defaults per platform. **Choosing a stack is always a fork for the user.** Versions are checked against official sources, not memory |
| `onboarding-existing-codebase` | CI is the truth; commands are proven by running them. The output is an AGENTS.md from the template, with its Docs section filled in, and `.pi/verify.json` |
| `changing-legacy-code` | Characterization tests, seams, sprout/wrap, strangler fig. Delete only your own orphans: a strange branch may be a requirement |

**TypeScript full-stack profile.** `choosing-a-stack/references/ts-fullstack-profile.md` is one candidate for a new TypeScript web product or SaaS with one team and Postgres, never a default. Per role it gives a choice, the reason, when not to take it and an alternative, and it names no versions. If you pick it, `node <kit>/scripts/scaffold-template.ts <absolute dir> --postgres <major>` (`<kit>` is the folder the kit package is installed in, or a clone of the kit) copies `templates/ts-monorepo/` (pnpm workspaces, Turbo, a Vite web app, an Express API, Prisma with Kysely, CI). The template holds no versions: the script installs each package at its highest stable release that is at least a day old, capped at the major of a stable `latest` tag and pinned exactly, with `@types/node` at the Node major and workspace packages as `workspace:*`. The Postgres major is not guessed: pass `--postgres <major>` or `--postgres=<major>` (check the current supported major at postgresql.org; the script refuses without a positive integer, and refuses unknown options). It is written to `.postgres-version`, the single source like `.nvmrc`, and `pnpm db:up` and `pnpm db:down` run `node scripts/db.mjs up|down` (no shell, so it works on Windows too) to start and stop the local database from it; the database healthcheck waits for TCP. Four practices of that stack live in skills with no stack attached: monorepo CI in ci-quality-gates (affected-only, falls back to everything, one gate), one store until measured in backend-services (the existing database carries the queue, cache and locks until a measurement shows a separate service is needed), an enforced client/server boundary in web-frontend, and dependency discipline in updating-dependencies (every override and patch has a reason and a removal condition).

### Platforms

| Skill | Why |
|---|---|
| `web-frontend` | Semantics and baseline a11y, loading / empty / error / success states, races and stale responses, performance, security, review items. In `references/`: where state lives and optimistic updates; the design system, design context and destructive-action copy |
| `backend-services` | Config in one module validated at startup, one artifact for all environments, stateless processes, readiness and liveness, graceful shutdown on SIGTERM, dev ≈ prod, one-off tasks from the release, the API contract as the source of truth (12-factor without duplicating observability and database-changes) |
| `mobile-development` | Lifecycle, permissions, security, a verification ladder (unit → release build → emulator → device). Android and iOS are in `references/` |
| `desktop-development` | UI thread, per-platform paths, IPC, signing, auto-update, installation on a clean VM. Windows and Linux are in `references/` |
| `ui-motion` | Animation and gestures on every platform. First the gate: how often the element is seen and what the motion is for; frequent and keyboard actions get none. Then easing by movement, budgets under 300 ms, interruptibility, cheap properties, reduced motion as "gentler, not zero", gesture physics. Values and per-platform APIs are in `references/` |

### High-risk domains

| Skill | Why |
|---|---|
| `payments-and-money` | Minor units or decimal, ISO 4217, idempotency, state machine, a timeout means "unknown", webhooks, outbox, double-entry, reconciliation, PCI DSS scope |
| `pos-systems` | Offline-first, sync queue, immutable receipts, fiscalization (54-FZ; for other countries, "ask for the jurisdiction"), X/Z shifts, peripherals behind interfaces |
| `observability` | Logs (levels, static messages, fields, no PII even masked), request/trace id correlation, metrics (RED/USE, bounded labels, histograms), deadlines on every wait, alerts with a runbook and on telemetry loss, investigation from logs with bounded queries |
| `database-changes` | Migrations via expand/contract (work with both old and new code), reversibility, locks, backfill as a separate task, deploy order and drift checks, transactions and outbox, safeguards for queries, data lifecycle, on-device database migrations |
| `security-review` | STRIDE over data flows, a checklist (injection, authN/Z, secrets, crypto, supply chain, prompt injection), tools, finding format |

---

A **task file** is written from the `templates/task.md` template, one per piece of work, standing in for a tracker issue:
- Status / Base / Links, the original request verbatim, then Intent / Context / Success criteria / Scope / Decisions / Design / Rollout / Risks and open questions / Follow-ups, then Plan and Progress;
- each section has an exact heading and one question; an empty section is marked "None";
- status `draft → design approved (date) → plan approved (date) → in progress`: brainstorming writes the description and you approve it, writing-plans fills `## Plan` and you approve that. There is no "done" status: a finished task file is deleted (section 5).

Before asking questions, the agent builds a **context map** (`brainstorming/references/context-map.md`) and writes down the intent, assumptions and open questions. Tickets, old task files and docs count as hypotheses: each claim it relies on is checked against the code and its tests. A plan has a `Base:` with the commit SHA; during execution it is checked whether the code has drifted. A PR has a description format, and one topic per PR.

---

## 4. Extensions

| Extension | How it works | Why this way |
|---|---|---|
| `bootstrap.ts` | On the `context` event, inserts `using-skills` as a **user** message after compactionSummary, deduplicated by a marker | Without bootstrap, skills are inert: the model sees only their descriptions. Changes made in `context` are not saved to history, so the rules are injected into **every** request. The message sits at a stable position with the same timestamp and lands in the prompt cache |
| `guard.ts` | A tokenizer aware of quotes and chains (`&&`, `\|`, `;`). Three decisions: block, confirm or allow. Project `.pi/guard.json`. Edits to CI and release pipelines (`.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile` and similar) need confirmation. While a task file is tracked, `gh pr create/merge`, `glab mr create/merge`, `git merge` into the base branch and `git push` to it are blocked; `git commit` on the base branch with a staged task file is blocked too. A plain `git push` of the work branch (named `<type>/<kebab>`, not the base, in the session's repository, to a configured remote, with nothing added by push config) passes without a question; every other push confirms, and `--force` and `--mirror` are blocked (conditions and the residual: README, guard). The folders come from the `workDocs` key (default `["docs/tasks"]`, `[]` turns the rule off). **Review gate:** the same commands without a reviewer `Yes` verdict for the commit being landed need confirmation. The guard writes a verdict record for each `details.results[]` entry with `agent === "reviewer"` in a `subagent` tool result, from its `finalOutput` (`Reviewed BASE:`, `Reviewed HEAD:` and `Ready to merge:`, with the report); a failed reviewer run (non-zero `exitCode` or no output) counts as Inconclusive, and so does a review that ran while edits were unverified (in a project with verification commands), and reviews within one user message (the `input` event) combine to the worst verdict. A `bash` call with `gh pr create`/`glab mr create` notes its branch where it starts (`tool_call`) and registers it when its `tool_result` succeeds, or fails after the PR step. A report without one of the three lines counts as Inconclusive. A check that throws makes pi block the call. Records live in `<tmpdir>/eng-kit/reviews/<sha1(the repository's git common directory)>/`, one file per reviewer run and commit, pruned after 30 days and trusted only when the folder belongs to the current user. Editing `.pi/guard.json` (edit/write, or a non-read-only shell command naming it) needs confirmation; writing into the review records (edit/write, or a shell command naming their path) is blocked | `allow`, `workDocs` and `reviewGate` work only in a trusted project: someone else's repository must not weaken the protection. The review gate asks instead of blocking: a background pi-subagents run may not return the report in this result. Without a UI, confirmation is impossible, so such calls are blocked |
| `verify.ts` | Commands from `.pi/verify.json` or from `## Commands` in AGENTS.md. `/verify` and the `run_verification` tool. After an `edit`/`write`, the working copy counts as unverified. On `agent_end`, the agent gets a follow-up, **no more than one per user message**. The same follow-up carries two more gates. **Approval gate:** a task file marked `Status: design approved` or `plan approved` that is not committed; on the base branch it says to create a work branch first. **Working-docs gate:** a task file whose `## Plan` has every checkbox ticked is due: move what lasts into `docs/` and `docs/decisions/`, show its Follow-ups and delete it. The verify state the guard reads lives on `globalThis`: pi loads each extension in its own module graph, so a module-level object would be one copy per extension | Only an exact run of the command counts as evidence: no pipe (it hides the exit code), no `cd`, no filter. An approval that isn't in git can be lost or silently edited; a finished task file left in the tree becomes stale context |
| `init.ts` | `/kit-init` creates the missing `.pi/verify.json`, `guard.json`, `model-routing.json` and adds `pi-subagents` to `settings.json`. It does not overwrite existing files other than an older copy of the test-hygiene script. It reports CI that doesn't run every verification command or lacks the `working-docs` job. It offers the `test-hygiene` script and copies it into `.ci/test-hygiene.mts` (an ES module whatever `package.json` says) only with `/kit-init --test-hygiene`; the same flag replaces a copy older than the package's (versions compared numerically). It reports an older copy and a CI that doesn't run the script, in the same run that adds it. Completion offers `--yes` and `--test-hygiene` and keeps the flags already typed | AGENTS.md is deliberately not written from a template: a file the agent builds from the code and verified commands is better than a stub full of placeholders |
| `models.ts` | `model-routing.json`: modes (`deep`, `fast`, `cheap`) and a mapping of commands to modes. `/review` switches the model and thinking before the turn starts. `/mode` does it manually. A model can be a list | The strongest model is for reviews and plans, a mid-tier one for execution. The project file applies only in a trusted project. The gate's follow-up does not change the model |

---

## 5. Prompts and templates

**Two kinds of documents.**
- **Working** documents record intent and progress: one task file per piece of work, filled along the way (`brainstorming`, `writing-plans`, `executing-plans`), living only on the work branch. Bounded work stays in chat and has none.
- **System** documents describe what exists now: README, `docs/NN-topic.md` chapters with a `docs/README.md` index, decision records, CHANGELOG. Only they reach the base branch. `/docs` creates them, and the Post-implementation block and the docs step during plan execution keep them up to date.

| Document | Where it lives | Statuses | End of life |
|---|---|---|---|
| Task file | `docs/tasks/YYYY-MM-DD-<slug>.md`, work branch only | `draft → design approved → plan approved → in progress` | deleted at the finish, after its Follow-ups are shown |
| Decision record | `docs/decisions/NNNN-slug.md` | none: only the decision in force | rewritten in place when the decision changes, deleted when it no longer applies |

**Finishing a feature** (`executing-plans`, Finish step 2): behavior moves into the topic chapter, decisions and lasting rulings into `docs/decisions/`, the task's Follow-ups are shown to you, and then the task file is deleted in one commit, `docs: remove the task file for <feature>`. Git keeps it; the PR body links it at the last commit that had it. There is no roadmap: each follow-up becomes its own task file, branch and PR.

**Decision records** are living: one topic per file, the number is a stable ID for citations ("see decision 0007"), and the sections are Decision, Why, Consequences, Considered and rejected. There is no status, date or changelog. Personal notes go in the agent's memory, not the repo.

- **Prompts** are thin entry points into skills: `/brainstorm`, `/plan`, `/implement`, `/review`, `/debug`, `/onboard`, `/finish`, `/new-task`, `/docs`. The method lives only in skills.
- **`templates/AGENTS.md`**: structure, commands, a Docs section, rules, "ask / never" boundaries, DoD. Versions are given as a link to the source, not as a number. The Docs section holds:
  - the index (`docs/README.md`, `llms.txt` if the repo keeps one) and a "Task → Start with" table, so the agent reads only what the task needs;
  - which source wins: code, tests and CI say what exists; decision records say which rules hold and why; topic docs describe. A contradiction is a bug to report, not to resolve silently;
  - the task-file rule.

  pi reads `AGENTS.md` from the working directory and its parents only, so in a monorepo a package's own `AGENTS.md` applies when pi starts in that package; the root task map routes to package docs.
- **`templates/task.md`**: the task file (section 3). `/new-task` writes only its description, `/plan <task file>` fills its Plan, and `/implement <path>` runs executing-plans when the Plan is filled and the short flow otherwise.
- **`templates/settings.json`, `guard.json`, `verify.json`, `model-routing.json`** are examples of project settings.

---

## Review and after push

**Review** (`requesting-code-review`, the `reviewer` agent):
- **fixed severity** from the table in the checklist. Critical: secrets, injections and authZ, loss of money or data, a test weakened, skipped or changed in a way test-standard's "Changing tests" doesn't allow, a committed focused test, a CI check removed, skipped or retried, retries in a runner config, stub code, type or linter errors suppressed without a reason. Important: a criterion without a test or with a manual check that isn't necessary or agreed, a plan's Review focus line without a test, a test without an assertion or asserting mock echo, an expected value copied from the code or recomputed with its algorithm, a test-only helper in production code, a fixed sleep or a real network call outside the sandbox suite, payments without a sandbox test, POS without a list of what ran on real hardware, stale docs, an unflagged breaking change, a function longer than ~100 lines or a file longer than ~1000 lines;
- **only verified code:** a review that ran while edits were unverified (the verify gate wasn't green) is recorded as Inconclusive; checks first, then review;
- **rules against persuasion:** "it's like that everywhere in the project" is debt, not permission; severity is not lowered under the pressure of arguments; what is judged is the changed lines and what they break;
- **rule changes in the diff itself:** if the diff changes the rules (agent manifest, linter config, standards), it is judged by the rules of the base branch;
- **repeat round:** only what is new since the last review is checked, and every earlier finding is re-checked;
- **project rules:** the reviewer reads AGENTS.md and the decision records the diff touches or cites; breaking one is Important;
- **project rules with a quote:** a finding against a rule names it (file with a heading, anchor or ID) and gives a short quote;
- **don't duplicate CI:** what the verify commands and linters check (format, lint, types) the reviewer doesn't repeat, unless the check fails or is missing. Verbose text is at most one grouped Minor;
- **repeat round by defect:** findings are matched by the substance of the defect, not by wording; the same defect in other words is not a new finding;
- **several reviewers** (payments, auth, migrations) are merged by root cause; on one `file:line` the higher severity stays, the overall verdict is the worst;
- **verdict** `Ready to merge: <exactly one of Yes, No, With fixes, Inconclusive>` and the `Reviewed BASE: <sha>` and `Reviewed HEAD: <sha>` lines; an echoed template (`Yes / No / …`) is not a verdict. Inconclusive means the reviewer couldn't read the requirements, the range or the rules;
- **no noise:** no praise and no made-up references.

**Review gate** (mechanics, not an instruction). Before `gh pr create`, `glab mr create`, `git merge` into the base branch, `git push` to it and `git push` to the branch of a PR the agent opened (registered after a successful `gh pr create`/`glab mr create`, forgotten once the PR's head `origin/<branch>` is on the base, or after 30 days), the guard asks you if the reviewer's last verdict for that commit isn't `Yes`, or its range doesn't reach the remote base (without a UI, it blocks). The range reaches it when the record's `Reviewed BASE` is on the push remote's base branch (else `origin`'s, else any remote's; the local base only when no remote tracks it), or is a commit whose own review counts by the same rule, up to 20 rounds and 300 git calls. A round must start at the newest reviewed commit below it, so no round's findings are skipped. A repeat round reviews only the new commits; its reviewer reads the previous round's reports with `scripts/review-log.ts`, not from the author. An empty range, a range broken by a rebase and a record without a range cover nothing. The guard writes the verdict record from the `subagent` result with the reviewer's report, so the reviewer is not run in the background; only `reviewer` runs count, and a review that ran while edits were unverified is recorded as `Inconclusive`. A verdict covers exactly the commit the reviewer reviewed: any change after it (a new commit, an amend, a rebase onto a newer base, a docs edit, deleting the task file) needs a new review, and a branch that changes only documentation is reviewed the same way, so the final review comes last, after docs, the task-file removal and any rebase. Commits already on the remote base land nothing new. Records are kept per reviewer run and per commit, so reviewing another branch doesn't forget this one. `cd <dir>` and `git -C <dir>` are followed, so a worktree's branch is checked where the command runs. A landing chained after anything but read-only steps and the project's verification commands (`git commit … && gh pr create`, `git switch main && git merge …`) asks: the guard can't see what it lands. PR/MR merges (`gh pr merge`, `glab mr merge`) always ask, whatever the verdict; `gh pr create --head <branch>` checks that branch. `With fixes`, `No` and `Inconclusive` don't pass. Only the user turns the gate off: by confirming, or with `"reviewGate": false` in `.pi/guard.json` (trusted project). A self-review without `subagent` doesn't pass the gate; the decision stays with you.

**Responding to review** (`receiving-code-review`): every comment is either fixed or answered; none is silently skipped. You can't write "resolved" while a blocker is open or until a repeat review has closed the finding.

**People in the chain** (`ci-quality-gates`, only with your "yes"): one required human approval (AI review complements it but doesn't replace it) and CODEOWNERS on the files that govern the rest: the agent manifest and its folder, path rules, CI, `docs/decisions/`, linter and type configs.

**After push** (`git-workflow`):
- CI is watched with the hosting platform's tool, not with a hand-written loop;
- for each failed check, no more than two attempts with an identified cause, then a question to you;
- the agent never merges on its own;
- rebasing its own branch only with `--force-with-lease=<branch>:<sha>`.

**Processes:** dev servers and watchers run in the background; the agent stops only what it started itself.

---

## Two verification loops: session and CI

- **The agent session.** TDD, the verify gate after every edit, the approval and working-docs gates, guard, review. Catches a problem right away, while the agent is working.
- **The project's CI** (`ci-quality-gates`). Runs on every change, whoever made it, and does not depend on hooks or the model:
  - at least everything from `verify.json`;
  - one required `gate` (it lists `e2e` only if the project has that job);
  - per stack and only with your "yes": test hygiene, e2e without retries whose JUnit reports are checked with `--junit test-results/` (reports only), provider sandboxes as a separate job, secret scanning and dependency audit, migrations and schema drift, contracts, coverage as a floor on a schedule;
  - the `working-docs` job: fails on any tracked `docs/tasks/*.md` on the base branch, whoever put it there.
- **The `test-hygiene` script** (`scripts/test-hygiene.ts`): one dependency-free file that needs only Node ≥22.18, whatever the project's stack. `/kit-init` offers it and copies it into `.ci/test-hygiene.mts` (an ES module whatever the project's `package.json` says) only with `/kit-init --test-hygiene`, after your "yes". The same flag replaces an older copy (versions compared numerically), and the CI gap is reported in the same run. The `test-hygiene` and `e2e` jobs from the ci-quality-gates templates run it. It checks:
  - focused tests and skips without a linked issue (`#123`, a URL or `ABC-123`; a reason in words is not enough, except reasons starting with `platform:`/`mode:`) in JS/TS (Playwright `test.describe.only/skip/fixme`, Cypress, Mocha and Nest layouts), Python, JVM, Go, Swift, .NET, Gherkin; fixed sleeps; retries in runner configs and in test code (`this.retries`, `describe.configure`, pytest `flaky`);
  - `--junit <dir>` alone checks only the reports: missing or empty, or a declared count that differs from the cases that ran (a crashed shard).

  In an existing project it is a ratchet: only lines the change adds count (renames are followed), and pre-existing debt is counted in the summary, not blocking (`--all` checks every line). Without a merge base it stops with a message: CI needs `fetch-depth: 0` and, on GitLab, an explicit fetch of the target branch. `test-hygiene: allow <reason>` marks a line where the pattern is the behavior under test; an allow without a reason is itself reported, and one that hides a forbidden skip, retry or sleep needs your agreement. `.ci/test-hygiene.json` adds test files, ignores and patterns. Next to it go the stack's native linters (table in `ci-quality-gates/references/ci-templates.md`).
- **Verify commands in a Turbo monorepo.** With a `turbo.json` (or `turbo.jsonc`, comments allowed) `kit-init` detects one `<exec> turbo run typecheck lint test` built from the tasks it declares; a `pkg#task` key declares `task`, and `<exec>` is `pnpm`, `yarn`, `bunx --no-install` or `npx --no` by lockfile, so only a locally installed turbo runs. A manifest's Commands still win, and a `turbo.json` that can't be read or declares none of those tasks falls through to the `package.json` scripts. `pnpm-workspace.yaml` alone selects pnpm. CI coverage: a Turbo verify command counts as covered when a CI step runs `turbo run` with all its tasks, in any order and with harmless flags (`--affected`, `--continue`, `--cache-dir` and other output or performance flags); `--filter`, `-F` or `--dry-run` narrow the run, so they don't cover. Other commands are matched as text.
- **Reversible template migrations.** Every migration in the `ts-monorepo` template ships a `down.sql`. `pnpm --filter @repo/db migrate:down <name>` reverts the latest applied migration with it, in one transaction, and marks the history row rolled back; `migrate deploy` applies it again. Prisma has no down migrations of its own and `migrate resolve --rolled-back` accepts only failed ones, so the script updates the row itself. Run it only after the code that needs the migration was rolled back; it reverts the schema, not data, and the guard asks before it runs. `template-smoke` checks deploy, revert to an empty schema and deploy again.
- **A DB job in the template's CI.** The template's `pr.yml` has a `db` job in the gate (`needs`): it starts Postgres with `pnpm db:up`, deploys, reverts the latest migration, checks that the schema is empty, deploys again and checks that it matches `schema.prisma`. No Postgres version is written in the workflow. The kit's own `template-smoke` scaffolds with `--postgres 18`.
- **Linking the loops:**
  - `kit-init` mechanically checks that CI runs every verification command, has the `working-docs` job and runs `.ci/test-hygiene.mts` when the project has it, and reports a copy older than the package's;
  - review treats a command missing from CI as Important, and a removed, skipped or retried check as Critical.
- **BDD** is an optional acceptance layer (`test-driven-development/references/bdd.md`). Each user-visible task criterion is exactly one scenario tagged with that criterion. The result is a "criterion → scenario → CI" chain, and review checks the tags against the task file.

---

## Testing

The foundation is the iron rule of TDD: a failing test first, then the minimal code, then a run of the whole suite. Every other test rule lives in one place, the `test-driven-development/references/test-standard.md` standard; TDD, BDD, writing-plans and the review checklist link to it instead of restating it:
- **expected values** come from the task's criteria, not from the code's output. The one exception is characterization tests of legacy code: `*.char.test.*` (or the stack's tag), they pass on first run by design and don't count as coverage of new behavior. Golden data in a port is an acceptance test that fails first, not characterization;
- **seen failing first:** every new test, except a characterization test;
- **a test must pay for itself:** no tests on constants, config, schema shape, "it renders", mock echo; identical cases are merged into a parameterized test; snapshots are small and inline;
- **structure and names:** Arrange–Act–Assert, one behavior per test, name = subject + circumstance + result; test-only helpers live in test code;
- **mocks:** only unmanaged dependencies are faked; your own database and queues are real in integration tests. Provider sandboxes are a separate suite and CI job, the only place a test talks to the network;
- **determinism and isolation:** time and randomness are under control, no network, there is a run outside UTC; waits are on a condition with one project-wide ceiling, never a fixed sleep; tests run in any order and in parallel; missing test infrastructure (a database, a container, an emulator) fails the run, never skips it;
- **no retries:** a test never retries, not in the runner config, not in CI, not in a loop. Waiting on a condition (web-first assertions, `expect.poll`, `waitFor`) is not a retry. A flake is fixed only when five criteria hold: the failing run and boundary found, the root cause removed, a repeated run green on the same commit, green in the configuration where it failed, the full suite green;
- **criteria and levels:** with BDD a user-visible criterion has exactly one scenario tagged with it; any other criterion has at least one test at the cheapest level that shows it the way a user or caller sees it; end-to-end without BDD covers critical flows only, one journey each;
- **manual check** replaces a test only where automation is impossible (real hardware, a store review, a fiscal device, a physical signature): the task file gives the reason, you agree, the report says it ran. Elsewhere a criterion without a test is a gap;
- **outside-in with BDD:** the scenario is written first and seen failing, unit TDD cycles drive the code, and the scenario passing closes the criterion. The unit tests underneath test their unit's own contract and stay; only a unit test asserting the user-level outcome the scenario already proves is left out;
- **changing tests:** deleting a test together with its behavior, or one that never protected anything, needs only the reason in the commit; editing an assertion, deleting a test whose behavior still exists, or a skip or quarantine needs your agreement and its own commit; a skip names a linked issue (a platform or test-mode skip whose reason starts with `platform:` or `mode:` is the one exception). `test-hygiene: allow <reason>` is for a pattern that is the behavior under test; using it to hide a forbidden skip, retry or sleep needs your agreement, and review rates it like the pattern;
- **coverage** is a floor, not a goal; visual baselines are produced only in CI.

The plan names the test for each criterion, and the PR body says how each new test was seen failing first. The reviewer checks the rules with the checklist's fixed severities. The mechanical layer (the `test-hygiene` script and the stack's linters) is added by ci-quality-gates only with your "yes".

---

## 6. Principles built into the package

1. Three process paths instead of one heavy one, so small tasks don't drown in bureaucracy.
2. The method is in skills, the mechanics in extensions, the entry points are thin. The definition-of-done rules live in one place.
3. No narrow vendor skills: the domain essence without being tied to a specific provider or library. Project specifics go in the project's AGENTS.md.
4. Subagents come through `pi-subagents` if it is installed. Otherwise the work runs inline, with no made-up tool calls.
5. The agent pushes its own convention-named work branch without a question; every other push confirms, and merging, pushing to the base and rewriting pushed history stay yours. A project with another branch convention adds a narrow `allow` in `.pi/guard.json`, for example `^git push( -u)? origin (story|task)/[a-z0-9._-]+$`. `allow` skips all of the guard's questions for the matching command, so keep patterns anchored.
6. Skills are in English: they trigger more precisely that way. Documentation is in English, with a Russian version of each file (`*.ru.md`).
7. Each document keeps only its current version: task files are deleted when the work is done, and decision records are rewritten in place. Git holds the history, so the context the agent reads stays small and consistent.

---

## 7. How it is verified

- **`npm test`**:
  - guard (the own-branch push classifier: the silent forms, every confirmation and block, config, environment and remote checks; block, confirm, allow, config, paths, task files on the base branch, review gate: verdict record from reviewer-only `subagent` results, a failed run as Inconclusive for its commit, verdict merging, parallel runs, code after review, remote base, rebase, worktree and `cd`, chained landings, PR/MR merges, shell writes, `reviewGate` in trusted projects only, a review of unverified edits as Inconclusive, the range chain, review-log, open-PR pushes, a guard check that throws, a symlinked project);
  - the command parser and the evidence rule;
  - bootstrap in every request;
  - the verify gate (one reminder, cleared after a green run), the approval and working-docs gates;
  - model routing;
  - `scripts/test-hygiene.ts` (rules in 7 languages, ratchet with renames, no merge base, JUnit reports only, config, CLI);
  - `/kit-init` (including the test-hygiene item: offered, copied with `--test-hygiene`, an older copy reported and replaced with the flag, a CI that doesn't run it reported in the same run; completion of several flags; Turbo-aware CI coverage: a `turbo run` that includes the verify command's tasks in any order or with harmless flags covers it, `--filter`, `-F` and `--dry-run` don't, and a chain or a flagged verify command is matched as text);
  - the verify state shared with the guard across extensions loaded in separate module graphs;
  - the package manifest and the linter for all skills and prompts.
  - the `ts-monorepo` template (no versions, `scaffold.json` names real workspaces, pinned action SHAs) and the scaffold script (refuses a non-empty folder, the planned installs, `.nvmrc` and `packageManager`);
- **`npm run typecheck`** against pi's real types.
- **`template-smoke`** (`.github/workflows/template-smoke.yml` in the kit's own CI, weekly and on PRs that touch the template or the scaffold script): scaffolds `ts-monorepo` with `--postgres 18` into a clean folder, starts Postgres with `pnpm db:up`, runs `pnpm turbo run typecheck lint test`, `prisma migrate deploy`, `migrate:down` to an empty schema and `prisma migrate deploy` again against Postgres. It is outside `gate` and the release: red means the ecosystem moved and the template needs a fix.
- **An end-to-end pi run** with a local mock LLM on a copy of `examples/demo`: bootstrap in all requests, guard blocks reading `.env`, `rm -rf ~/…` and `git push --force`, the verify gate fires on "Done!", `run_verification` runs the project's tests.

**Not verified:** the own-branch push has no live run yet, its live check is the first push of the branch that ships it; guard for `powershell` on Windows (the logic is the same, but it has not been run); a live `worker` run with its reporting contract (the contract is text in executing-plans); the review gate with real pi-subagents (the result format is verified only on a fake; background and workflow runs don't write a verdict record).

**Known limits of the own-branch push:** a command guard can't see everything. It does not see indirect execution: quote-obfuscated shell strings (`sh -c 'g""it …'`), interpreter one-liners (`python -c "os.system('git …')"`), shells it doesn't list (`fish -c`), sourced scripts and script files, a setup command behind a wrapper the guard doesn't list (`find -exec`, `caffeinate`, `watch`), git under another name (a symlink or a copied binary) or through a relative path (`bin/git`), a variable exported in an earlier command (the hook's own environment is still checked for pushes), a variable placed before a program that runs git itself (`gh`, `npm install` with git dependencies, `make`, scripts), a variable already exported by the user's shell profile, proxy variables (`HTTPS_PROXY`, `ALL_PROXY`), `GIT_ALLOW_PROTOCOL`, and `export EDITOR=…` (by design), a `gh api` method set by a header override, and shell writes into `.git/config` or `.git/refs`. Any of these can configure a remote or push. Like `curl`, exfiltration is not something the guard prevents. Server-side CI, review and branch protection carry the rest.

**Known limits of the review gate:** an interpreter one-liner can still hide a path from the shell checks; the gate protects against a forgotten review, not against an agent that deliberately feeds the reviewer a verdict; it sees only PRs this agent opened; it trusts the range the reviewer names; remote-tracking refs are local, so `git update-ref` can fake a merged PR or an already-landed commit; the command parser doesn't follow heredocs or `#` comments, so a landing after one of them may go unseen; the reviewer's read-only rule is an instruction, because pi doesn't tell the guard which agent runs a call; with no resolvable base branch (no `origin/HEAD`, no `main`/`master`) it does nothing.

---

## 8. How to extend it

- A new skill is written with `writing-skills`: first a scenario without the skill (RED), then a minimal skill. Then `npm test` and a line in this document.
- A rule that can be checked mechanically lives in guard, verify or CI, not in a skill's text.
- A template holds no versions: they are installed from the registry at scaffold, and `template-smoke` shows when the ecosystem has moved.
- Domain packages for a specific company (a specific acquirer, fiscal data operator) are better built as a separate pi package on top of this one.
