# Changelog

## 0.5.0

- New skill `observability`:
  - logs: level policy, fixed messages with values in fields, no personal or payment data even masked, and each error logged once where it is handled;
  - request and trace ids propagated through HTTP, queues and jobs;
  - RED/USE metrics with bounded labels;
  - a configured deadline on every wait;
  - alerts with runbooks, including one on lost telemetry;
  - bounded, read-only log queries when investigating.

  `references/metrics-and-alerts.md` holds naming, cardinality budgets, alert templates and query recipes.
- New skill `database-changes`:
  - migrations that work with the old and the new code (expand/contract), are reversible and take short locks, with backfills as separate jobs;
  - deploy order and a drift check;
  - transactions with an outbox, and query guardrails;
  - data lifecycle: archive, purge, retention;
  - device databases.

  `references/migration-patterns.md` holds expand/contract recipes, lock notes and a backfill template.
- The review checklist gets new fixed severities for personal data in logs, destructive migrations, missing deadlines and unbounded metric labels. Debugging starts with telemetry for problems outside your machine.

## 0.4.0

- Stricter review:
  - fixed severities: secrets, placeholder code, suppressed type or lint errors and weakened tests are Critical; a criterion without a test, stale docs, an unmarked breaking change and oversized new functions or files are Important;
  - severities don't drop for "the repo does this everywhere" or because the author argues;
  - changes to the rules themselves are judged against the base branch;
  - repeat review rounds cover only the new commits and re-check every open finding;
  - no praise, and no invented links.
- `receiving-code-review`: every comment ends fixed or answered, and nothing is called resolved while a blocker is open.
- `git-workflow`:
  - fetch before branching, and don't work on a branch that is already merged;
  - follow the project's commit linter, and order split commits so each one is green;
  - a new section, "After a push": follow CI with the host's tool, make at most two fix attempts per failing check, never merge, and rebase with `--force-with-lease=<branch>:<sha>`.
  - `finish` offers to follow CI.
- New skill `updating-dependencies`: one dependency at a time, the changelog read, majors and new dependencies only with approval, security first, the lockfile changed only by the package manager, and platform constraints for mobile and POS.
- `verification-before-completion`: long-running processes run in the background; stop only the ones you started.

## 0.3.1

- Approval gate: if a spec or plan in `docs/specs` or `docs/plans` has the status approved, implemented, superseded or done but isn't committed, the agent can't finish its turn until it commits the file. The reminder comes once per prompt; drafts and plans in progress don't count. `writing-plans` commits the plan on approval.

## 0.3.0

- Spec skeleton `templates/spec.md`: Intent, Context, Success criteria (criterion + how verified), Scope in/out, Decisions, Design, Rollout, Risks and open questions. Headings are exact, each section answers one question, and `None` replaces a deleted section. A spec over about 300 lines or 10 criteria is split through the roadmap.
- `brainstorming` builds a context map before asking anything (`references/context-map.md`), then states the intent, up to five assumptions and the open questions. Roadmap pieces are sized to one concern, one plan and one reviewable PR.
- Plans record `Base:` (the commit SHA they were written against), and `executing-plans` checks for drift before starting.
- `git-workflow` gains a PR description format and suggests splitting oversized PRs.

## 0.2.9

- Testing standard (`test-driven-development/references/test-standard.md`), covering:
  - expected values from requirements, never from the code's output; characterization tests marked as such;
  - which tests are worth writing, AAA structure and names;
  - test doubles only for unmanaged dependencies, with your own database real;
  - determinism, and flakes fixed at their cause (no retries);
  - an acceptance test for each criterion;
  - coverage as a floor, not a target;
  - test lint rules to propose.
- Plans name each criterion's acceptance test, and the review checklist checks the new rules.

## 0.2.8

- New entry point `/docs`: an inventory and documentation map (README, `docs/NN-topic.md` chapters with a `docs/README.md` index, CHANGELOG), then writing the approved documents from the code and the implemented specs. `/docs <topic>` writes one chapter, `/docs changelog` writes changelog entries from git, and `/docs adr <decision>` writes a decision record.
- `writing-documentation` separates working documents (specs, plans, ledgers) from system documents, and adds a topic chapter template. An implemented spec moves what lasts into its chapter and links to it.
- A plan's Post-implementation block names the feature's topic chapter, and onboarding offers `/docs` when a repo has no README or docs index.

## 0.2.7

- Docs are kept current on every change, not only at review. Plans carry a `Post-implementation` block listing the docs a change makes stale; `implement` and `executing-plans` update them in the same branch; the final report has a **Docs** line; reviewers rate stale docs as Important. `writing-documentation/references/checks.md` lists mechanical checks to propose for the project's verification and CI.

## 0.2.6

- Verify gate: edits outside the project (plans, memory, scratch files) and documentation edits no longer make the workspace unverified. `verify.json` gets an `ignore` list of globs (default: `**/*.md`, `**/*.mdx`, `**/*.txt`, `docs/**`); `"ignore": []` restores the strict behavior.

## 0.2.5

- Specs and plans carry a `Status:` line. Specs go `draft → approved (date) → implemented (date)`, or `superseded by <path>`; plans go `draft → approved → in progress → done`. `brainstorming`, `writing-plans` and `executing-plans` set it at their natural points. Only the user approves, and `writing-plans` refuses a draft spec.

## 0.2.4

- New skill `writing-documentation`: where each document goes (README, topic docs, decision records, changelog, agent manifest, API reference, code comments), prose and comment rules, what a code change makes stale, and a verification step before "docs updated". Templates for a README, an ADR and a changelog entry.

## 0.2.3

- `brainstorming` writes a roadmap (`docs/specs/…-roadmap.md`) when a request splits into several subsystems: pieces, order, contracts, migration, open decisions. Each piece then gets its own cycle and is ticked off when finished.
- `using-skills` resumes a large project from its roadmap.

## 0.2.2

- `brainstorming` and the reviewer prompt name platform and domain skills consistently.

## 0.2.1

- Clearer description of the scope (platform, domain, new or existing code) and of the skill groups: process, starting point, platforms, high-risk domains.
- `using-skills` routes platform work and high-risk domain work to their skills separately.

## 0.2.0

First public release.

- 21 skills:
  - process core: design, plan, TDD, debugging, verification, review, git;
  - starting point: stack choice, onboarding, legacy code;
  - platforms: web frontend, mobile, desktop;
  - high-risk domains: payments, POS, security.
- 8 prompt templates: `/brainstorm`, `/plan`, `/implement`, `/review`, `/debug`, `/onboard`, `/finish`, `/new-task`.
- Extensions:
  - `bootstrap` loads the skill rules into every request;
  - `guard` blocks irreversible or secret-leaking tool calls and asks before outward-facing ones;
  - `verify` adds `/verify`, the `run_verification` tool and the unverified-edits gate;
  - `models` switches model and thinking level per command and adds `/mode`;
  - `init` adds `/kit-init`.
- `examples/demo`: a dependency-free project with one task, for trying the loop.
