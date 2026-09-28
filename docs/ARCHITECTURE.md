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

1. **The process scales with the size of the task.** A small fix takes the short path, an architectural change takes the full path from spec to review. When in doubt, the heavier path is chosen.
2. **The model does not decide on its own that the work is done.** The project's checks decide that. A gate in an extension sends the agent back to work if there was no green run after its edits.
3. **Irreversible and outward-facing actions go through a human.** The guard extension blocks dangerous commands and asks for confirmation on push, deploy, migrations and publishing.

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
│ skills/   27 skills (process, start, platforms, domains), by description        │
│ prompts/  9 entry points: /brainstorm /plan /implement /review …                │
│ templates/ AGENTS.md, task.md, settings.json, guard.json, verify.json           │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**The work loop:**

```
idea ──/brainstorm──▶ classification: Spike | Bounded | Architectural
  Spike ─────────▶ probe → recommendation (throwaway code)
  Bounded ───────▶ design in chat → "yes" → /implement (TDD) → verify → report
  Architectural ─▶ spec → "yes" → /plan → "yes" → /implement (executing-plans)
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
| `brainstorming` | Design before code: work classification, one question at a time, 2–3 approaches, spec, self-review | Domain questions (money, POS, OS) are asked up front, because changing things later is expensive |
| `writing-plans` | A plan as the set of decisions the executor won't make on its own: files, signatures, Interfaces, Review focus | A plan longer than the code means the code is already written in the plan. Execution is inline or one subagent per task |
| `executing-plans` | Plan execution with a ledger file, "rulings, not stalls", a task completion contract, the "subagent per task" mode | The ledger is plain markdown: it survives compaction and needs no scripts |
| `test-driven-development` | Iron Law, RED→GREEN→REFACTOR | "A test that was never red proves nothing" and "don't weaken tests to get green". For legacy, characterization tests come first |
| `systematic-debugging` | 4 phases, root-cause tracing, "3 failed fixes means a question about the architecture" | System boundaries with examples for POS and mobile, a rule on flaky tests |
| `verification-before-completion` | The IDENTIFY→RUN→READ→VERIFY→CLAIM gate and the format of an honest report | local / commit / push / CI / deploy / live are kept separate. A pipe into `tail` hides the exit code |
| `requesting-code-review` | Review in a fresh context over a SHA range, a reviewer prompt template, a checklist | **Confirmed / Assumptions / Questions**; every finding has a trigger, a consequence and evidence. A failure is compared against the base revision. AI review does not replace human approval |
| `receiving-code-review` | Verify before implementing; YAGNI via grep | A comment is rejected only with a concrete justification |
| `git-workflow` | Isolation, baseline, commits, 4 ways to finish a branch | Never `--no-verify`, force only as `--force-with-lease`, discard only on explicit input |
| `dispatching-parallel-agents` | Grouping by independent domains, self-contained prompts | Writers with non-overlapping files; without subagents, sequentially |
| `writing-documentation` | Where things live (README, docs/, ADR, CHANGELOG, agent manifest, API reference, comments), rules for text and comments, what goes stale when code changes | Documentation is part of the change: in the same commit and about the current state. Before "docs updated", commands are run and links are checked. If the project has its own format, that one is used. It rests on four layers: the rule in this skill; the "Post-implementation" block in every plan and the docs update step in `/implement` and `executing-plans`; stale docs in review are Important; mechanical checks (`references/checks.md`) are offered for the project's verify and CI |
| `ci-quality-gates` | Checks in the project's CI | CI runs at least everything from verify.json; one required `gate` job; per-stack layers are added only with a "yes": test hygiene, e2e without retries and with a count of executed tests, secrets and dependency audit, migrations and drift, contracts, coverage as a floor on a schedule; branch protection only with a "yes" |
| `updating-dependencies` | Updating, adding and removing dependencies, SDKs and toolchains | One at a time; changelog read, breaking changes written down; a major version or a new dependency only with a "yes"; vulnerabilities first; only the package manager changes the lockfile; a full run of the checks |
| `writing-skills` | How to write and test skills | The description is triggers only. A skill is tested with a scenario run without it (RED) |

### Starting point: new or existing code

| Skill | Why |
|---|---|
| `choosing-a-stack` | The stack is chosen for reliability in the domain. A table of defaults per platform. **Choosing a stack is always a fork for the user.** Versions are checked against official sources, not memory |
| `onboarding-existing-codebase` | CI is the truth; commands are proven by running them. The output is an AGENTS.md from the template and `.pi/verify.json` |
| `changing-legacy-code` | Characterization tests, seams, sprout/wrap, strangler fig. Delete only your own orphans: a strange branch may be a requirement |

### Platforms

| Skill | Why |
|---|---|
| `web-frontend` | Semantics and baseline a11y, loading / empty / error / success states, races and stale responses, performance, security, review items |
| `backend-services` | Config in one module validated at startup, one artifact for all environments, stateless processes, readiness and liveness, graceful shutdown on SIGTERM, dev ≈ prod, one-off tasks from the release, the API contract as the source of truth (12-factor without duplicating observability and database-changes) |
| `mobile-development` | Lifecycle, permissions, security, a verification ladder (unit → release build → emulator → device). Android and iOS are in `references/` |
| `desktop-development` | UI thread, per-platform paths, IPC, signing, auto-update, installation on a clean VM. Windows and Linux are in `references/` |

### High-risk domains

| Skill | Why |
|---|---|
| `payments-and-money` | Minor units or decimal, ISO 4217, idempotency, state machine, a timeout means "unknown", webhooks, outbox, double-entry, reconciliation, PCI DSS scope |
| `pos-systems` | Offline-first, sync queue, immutable receipts, fiscalization (54-FZ; for other countries, "ask for the jurisdiction"), X/Z shifts, peripherals behind interfaces |
| `observability` | Logs (levels, static messages, fields, no PII even masked), request/trace id correlation, metrics (RED/USE, bounded labels, histograms), deadlines on every wait, alerts with a runbook and on telemetry loss, investigation from logs with bounded queries |
| `database-changes` | Migrations via expand/contract (work with both old and new code), reversibility, locks, backfill as a separate task, deploy order and drift checks, transactions and outbox, safeguards for queries, data lifecycle, on-device database migrations |
| `security-review` | STRIDE over data flows, a checklist (injection, authN/Z, secrets, crypto, supply chain, prompt injection), tools, finding format |

---

A **spec** is written from the `templates/spec.md` template:
- sections Intent / Context / Success criteria / Scope / Decisions / Design / Rollout / Risks;
- each has an exact heading and one question; an empty section is marked "None".

Before asking questions, the agent builds a **context map** (`brainstorming/references/context-map.md`) and writes down the intent, assumptions and open questions. A plan has a `Base:` with the commit SHA; during execution it is checked whether the code has drifted. A PR has a description format, and one topic per PR.

---

## 4. Extensions

| Extension | How it works | Why this way |
|---|---|---|
| `bootstrap.ts` | On the `context` event, inserts `using-skills` as a **user** message after compactionSummary, deduplicated by a marker | Without bootstrap, skills are inert: the model sees only their descriptions. Changes made in `context` are not saved to history, so the rules are injected into **every** request. The message sits at a stable position with the same timestamp and lands in the prompt cache |
| `guard.ts` | A tokenizer aware of quotes and chains (`&&`, `\|`, `;`). Three decisions: block, confirm or allow. Project `.pi/guard.json` | `allow` works only in a trusted project: someone else's repository must not weaken the protection. Without a UI, confirmation is impossible, so such calls are blocked |
| `verify.ts` | Commands from `.pi/verify.json` or from `## Commands` in AGENTS.md. `/verify` and the `run_verification` tool. After an `edit`/`write`, the working copy counts as unverified. On `agent_end`, the agent gets a follow-up, **no more than one per user message** | Only an exact run of the command counts as evidence: no pipe (it hides the exit code), no `cd`, no filter |
| `init.ts` | `/kit-init` creates the missing `.pi/verify.json`, `guard.json`, `model-routing.json` and adds `pi-subagents` to `settings.json`. It does not overwrite existing files | AGENTS.md is deliberately not written from a template: a file the agent builds from the code and verified commands is better than a stub full of placeholders |
| `models.ts` | `model-routing.json`: modes (`deep`, `fast`, `cheap`) and a mapping of commands to modes. `/review` switches the model and thinking before the turn starts. `/mode` does it manually. A model can be a list | The strongest model is for reviews and plans, a mid-tier one for execution. The project file applies only in a trusted project. The gate's follow-up does not change the model |

---

## 5. Prompts and templates

**Two kinds of documents.**
- **Working** documents: spec, plan, ledger, roadmap, legacy map. They are created along the way (`brainstorming`, `writing-plans`, `executing-plans`) and record intent and progress.
- **System** documents: README, `docs/NN-topic.md` chapters with a `docs/README.md` index, ADR, CHANGELOG. They describe what exists now. `/docs` creates them, and the Post-implementation block and the docs step during plan execution keep them up to date.

Once a spec is implemented, its long-lived part moves into the chapter about that feature, and the spec itself gets a link to the chapter.

- **Prompts** are thin entry points into skills: `/brainstorm`, `/plan`, `/implement`, `/review`, `/debug`, `/onboard`, `/finish`, `/new-task`, `/docs`. The method lives only in skills.
- **`templates/AGENTS.md`**: structure, commands, rules, "ask / never" boundaries, DoD. Versions are given as a link to the source, not as a number.
- **`templates/task.md`**: numbered testable criteria, constraints, Out of scope.
- **`templates/settings.json`, `guard.json`, `verify.json`, `model-routing.json`** are examples of project settings.

---

## Review and after push

**Review** (`requesting-code-review`, the `reviewer` agent):
- **fixed severity** from the table in the checklist. Critical: secrets, injections and authZ, loss of money or data, weakened tests, stub code, type or linter errors suppressed without a reason. Important: a criterion without a test, stale docs, an unflagged breaking change, a function longer than ~100 lines or a file longer than ~1000 lines;
- **rules against persuasion:** "it's like that everywhere in the project" is debt, not permission; severity is not lowered under the pressure of arguments; what is judged is the changed lines and what they break;
- **rule changes in the diff itself:** if the diff changes the rules (agent manifest, linter config, standards), it is judged by the rules of the base branch;
- **repeat round:** only what is new since the last review is checked, and every earlier finding is re-checked;
- **no noise:** no praise and no made-up references.

**Responding to review** (`receiving-code-review`): every comment is either fixed or answered; none is silently skipped. You can't write "resolved" while a blocker is open.

**After push** (`git-workflow`):
- CI is watched with the hosting platform's tool, not with a hand-written loop;
- for each failed check, no more than two attempts with an identified cause, then a question to you;
- the agent never merges on its own;
- rebasing its own branch only with `--force-with-lease=<branch>:<sha>`.

**Processes:** dev servers and watchers run in the background; the agent stops only what it started itself.

---

## Two verification loops: session and CI

- **The agent session.** TDD, the verify gate after every edit, the approval gate, guard, review. Catches a problem right away, while the agent is working.
- **The project's CI** (`ci-quality-gates`). Runs on every change, whoever made it, and does not depend on hooks or the model:
  - at least everything from `verify.json`;
  - one required `gate`;
  - per stack and only with your "yes": test hygiene, e2e without retries and with a count of executed tests, secret scanning and dependency audit, migrations and schema drift, contracts, coverage as a floor on a schedule.
- **Linking the loops:**
  - `kit-init` mechanically checks that CI runs every verification command;
  - review treats a command missing from CI and a weakened check as Important.
- **BDD** is an optional acceptance layer (`test-driven-development/references/bdd.md`). Each user-visible spec criterion is one scenario tagged with that criterion. The result is a "criterion → scenario → CI" chain.

---

## Testing

The foundation is the iron rule of TDD: a failing test first, then the minimal code, then a run of the whole suite. Everything else is collected in the `test-driven-development/references/test-standard.md` standard:
- **expected values** come from the spec or the criterion, not from the code's output; characterization tests are marked separately;
- **a test must pay for itself:** no tests on constants, config, schema shape, "it renders", mock echo; identical cases are merged into a parameterized test;
- **structure and names:** Arrange–Act–Assert, one behavior per test, name = subject + circumstance + result;
- **mocks:** only unmanaged dependencies are faked; your own database and queues are real in integration tests;
- **determinism and flaky tests:** time and randomness are under control, no network, there is a run outside UTC; a retry does not count as a fix;
- **acceptance level:** each task criterion → a test that shows it the way the user sees it (API, UI/e2e, BDD if the project has it);
- **coverage** is a floor, not a goal.

The plan names an acceptance test for each criterion. The reviewer checks these rules against the checklist. The standard offers mechanical lint rules for tests to the project but does not impose them.

---

## 6. Principles built into the package

1. Three process paths instead of one heavy one, so small tasks don't drown in bureaucracy.
2. The method is in skills, the mechanics in extensions, the entry points are thin. The definition-of-done rules live in one place.
3. No narrow vendor skills: the domain essence without being tied to a specific provider or library. Project specifics go in the project's AGENTS.md.
4. Subagents come through `pi-subagents` if it is installed. Otherwise the work runs inline, with no made-up tool calls.
5. Confirmation on any `git push`. For your own branches, a narrow `allow` in `.pi/guard.json` removes it, for example `^git push origin feat/`.
6. Skills are in English: they trigger more precisely that way. Documentation is in English, with a Russian version of each file (`*.ru.md`).

---

## 7. How it is verified

- **`npm test`**:
  - guard (block, confirm, allow, config, paths);
  - the command parser and the evidence rule;
  - bootstrap in every request;
  - the verify gate (one reminder, cleared after a green run);
  - model routing;
  - `/kit-init`;
  - the package manifest and the linter for all skills and prompts.
- **`npm run typecheck`** against pi's real types.
- **An end-to-end pi run** with a local mock LLM on a copy of `examples/demo`: bootstrap in all requests, guard blocks reading `.env`, `rm -rf ~/…` and `git push --force`, the verify gate fires on "Done!", `run_verification` runs the project's tests.

**Not verified:** guard for `powershell` on Windows (the logic is the same, but it has not been run).

---

## 8. How to extend it

- A new skill is written with `writing-skills`: first a scenario without the skill (RED), then a minimal skill. Then `npm test` and a line in this document.
- A rule that can be checked mechanically lives in guard, verify or CI, not in a skill's text.
- Domain packages for a specific company (a specific acquirer, fiscal data operator) are better built as a separate pi package on top of this one.
