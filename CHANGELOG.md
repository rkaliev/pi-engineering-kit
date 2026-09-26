# Changelog

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
