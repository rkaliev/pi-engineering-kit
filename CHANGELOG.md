# Changelog

## 0.2.0

First public release.

- 21 skills:
  - a process core: design, plan, TDD, debugging, verification, review, git;
  - domains: web frontend, payments, POS, security, mobile, desktop, legacy code, stack choice.
- 8 prompt templates: `/brainstorm`, `/plan`, `/implement`, `/review`, `/debug`, `/onboard`, `/finish`, `/new-task`.
- Extensions:
  - `bootstrap` loads the skill rules into every request;
  - `guard` blocks irreversible or secret-leaking tool calls and asks before outward-facing ones;
  - `verify` adds `/verify`, the `run_verification` tool and the unverified-edits gate;
  - `models` switches model and thinking level per command and adds `/mode`;
  - `init` adds `/kit-init`.
- `examples/demo`: a dependency-free project with one task, for trying the loop.
