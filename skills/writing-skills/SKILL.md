---
name: writing-skills
description: Use when creating a new skill or subagent, editing an existing skill, agent or prompt template, or checking that a skill actually changes agent behavior
---

# Writing skills

A skill is reusable know-how that the agent loads on demand: a technique, a discipline, or a domain reference. It is not a story about one task, and not something a linter or a script can enforce. Put mechanical rules in the guard or verify extensions, or in CI.

## Format (Agent Skills spec, as pi loads it)

```
skills/<name>/SKILL.md        required
skills/<name>/references/*.md optional heavy reference, loaded only when needed
skills/<name>/scripts/*       optional tools; invoke as `bash scripts/x.sh` (the exec bit can be lost)
```

```yaml
---
name: <name>            # = folder name; lowercase, digits, hyphens; ≤ 64 chars
description: Use when … # ≤ 1024 chars; third person; triggers only
---
```

Add `disable-model-invocation: true` for skills that should run only through `/skill:<name>`.

## The description decides whether the skill fires

- Start with "Use when…" and list the situations and symptoms that should trigger it. Use the words a user or an error message would contain.
- **Do not summarize the process.** The agent will follow the summary instead of reading the body. A description saying "reviews between tasks" produced one review instead of the two the body required.
- Aim for under 300 characters. The descriptions of every installed skill share the context window.

## The body

- Stay under about 500 words; move heavy reference into `references/`. A loaded skill costs context for the rest of the session.
- Name *actions*, not harness tools ("load the skill", "dispatch a reviewer"), so the skill survives a tool rename.
- Start with the core principle; use an Iron Law only for real discipline rules.
- **Match the form to the failure:**
  - When agents skip steps under pressure, use a hard rule, a red-flags table of the rationalizations you observed, and an explicit closing of loopholes.
  - When they produce the wrong shape, use a positive template or example, not prohibitions (prohibitions can backfire).
- Give one excellent example rather than many mediocre ones. Refer to other skills by name ("REQUIRED: test-driven-development"), not by force-loading their files.
- Relative paths resolve against the skill directory.

## Subagents

An agent is a role with its own context, tools and report; write one when isolation is the point (review, search, narrower permissions). When to choose one, its format, the prompt rules and how to test it: `references/agents.md`.

## Test it like code

1. **RED:** run a realistic pressure scenario *without* the skill, using a subagent or a fresh session. Mix pressures: time, sunk cost, authority. End with "This is real. Choose and act." Record the agent's rationalizations verbatim.
2. **GREEN:** write the minimal skill that addresses those failures. Re-run the scenario and confirm the behavior changed.
3. **REFACTOR:** each new rationalization becomes an explicit counter. Re-run until it holds.

Also check that the description triggers: ask for the task in plain words and see whether the skill loads.

Before shipping, run `npm test` in this package. It lints frontmatter, names, word budgets and relative links. Then add what you changed and why to `docs/ARCHITECTURE.ru.md`.
