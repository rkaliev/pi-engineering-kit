# Changelog

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
