# Context map

Gather this before asking the user anything, so that questions are about decisions, not about facts the repo already answers. Keep every section; write `none` instead of dropping one. At most ten items per section, each with a path.

- **Request:** the user's words, linked issue or task, any spec or roadmap piece it belongs to.
- **Relevant files:** entry points, the modules the change touches, their tests.
- **Patterns to follow:** how similar features are built here (one example path each).
- **Key types and interfaces:** the contracts the change consumes or changes.
- **Test conventions:** framework, layout, levels in use, fixtures, how to run a single test.
- **In-flight work:** open branches, uncommitted changes, recent commits in these files.
- **Standards:** the agent manifest (CLAUDE.md or AGENTS.md) and the path rules that match these files, decision records, linters that apply.
- **Stack:** versions from their source files, not from memory.

Tickets, old plans and docs are hypotheses: check each claim you rely on against the code and its tests. Then write back: **Intent** (one sentence), **Assumptions** (at most five, each one the user can reject) and **Open questions** (only decisions the code cannot answer).
