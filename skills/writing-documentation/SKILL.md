---
name: writing-documentation
description: Use when writing or updating a README, project docs, an architecture decision record, a changelog, API docs or code comments, or when a change alters behavior, setup or commands that docs describe
---

# Writing documentation

Docs are part of the change. They ship in the same commit or PR as the code they describe, and they describe the system as it is now. A doc that is wrong is worse than no doc: readers and agents act on it.

## Follow the project first

Read what the repo has: README, `docs/`, decision records or RFCs, CONTRIBUTING, the docs language, the changelog style. Extend that structure; introduce the layout below only where nothing exists, and say so.

## Where each thing goes

| Document | Answers | Place |
|---|---|---|
| README | What is this, how do I run it, where is the rest | repo root (and one per package in a monorepo) |
| Topic docs | How does X work today | `docs/NN-topic.md`, one topic per file, indexed in `docs/README.md` |
| Decision record (ADR) | Why did we choose X over Y | `docs/decisions/NNNN-title.md`: context, decision, consequences. Never edited after acceptance; a new ADR supersedes it |
| CHANGELOG | What changed for users in each version | `CHANGELOG.md`, Keep a Changelog sections, grouped from Conventional Commits |
| Agent manifest | Commands, rules and boundaries for AI agents | CLAUDE.md / AGENTS.md: short, links to docs instead of copying them |
| API reference | Exact contract of an interface | generated from the source of truth (OpenAPI from schemas or code, typedoc, KDoc, DocC); never hand-maintained in parallel |
| Code comments | Why this code is the way it is | next to the code |

**Working** documents (specs, plans, ledgers, roadmaps) record intent and progress; the **system** documents above describe what exists. When a spec is implemented, move what lasts into the topic chapter for that feature and link the chapter from the spec. Decision records explain why; topic docs describe today.

Templates: `references/templates.md`.

## Prose

- **Present tense, current state.** No history ("previously", "was changed to"), no ticket IDs, no "new" or "now". History lives in git and the changelog.
- **Say it once.** Link to the single source instead of restating it. Versions, ports and limits are pointers to the file that sets them (`.nvmrc`, `libs.versions.toml`, config), not copied numbers.
- **Write for the reader who will act.** Lead with the task. Short sentences, one idea per paragraph, one name per concept.
- **Real examples only.** Commands, paths and snippets are copied from something that ran. Mark placeholders clearly (`<project-dir>`).
- **Links resolve.** In-repo links are relative Markdown links to files that exist; references to code name the file (and symbol), not a line number that will move.

## Code comments

- An exported function, type or module gets 1–3 lines: what it guarantees and when to use it. Skip parameters the signature already explains; document units, ranges, errors and side effects.
- Inside a body, comment only the *why*: a constraint, a workaround with its reason, a non-obvious invariant. Never narrate what the next line does.
- No commented-out code, no author or date stamps, no TODO without an issue or owner.
- A comment that contradicts the code is a bug: fix one of them.

## When code changes

Before calling the change done, check what it made stale:
- setup, commands or environment variables → README and the agent manifest;
- behavior of a documented flow → its topic doc;
- a choice between real alternatives with lasting consequences → a new decision record;
- anything a user or integrator notices → a changelog entry;
- an interface → regenerate the API reference.

## Verify before saying "docs updated"

1. Run every command you wrote or changed, from a clean checkout where it matters, and read the output.
2. Check that each link and path resolves (a link checker if the repo has one, otherwise open them).
3. Compile or run the snippets, or copy them from tests that do.
4. Update the index (`docs/README.md`, the README docs section, `llms.txt` if the repo keeps one).
5. Re-read as the target reader: can they do the task with only this page?

Report which of these you did. An unverified command in a doc is an unverified claim. To enforce these rules mechanically, propose checks from `references/checks.md`.

## Red flags

| Thought | Reality |
|---|---|
| "I'll update the docs later" | Later means never; the next reader gets the stale version. Same change. |
| "I'll copy that section here too" | Two copies drift. Link to one. |
| "Describe how it will work" | Docs describe what exists. Plans go in a spec or plan file. |
| "The comment explains the code" | If it restates the code, delete it. |
