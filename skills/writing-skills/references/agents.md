# Writing subagents

A subagent is a role with its own context window, its own tools and a fixed report. Write one when isolation is the point; write a skill when the main agent should learn a technique.

## Agent or skill

| Need | Use |
|---|---|
| Know-how the main agent applies in its own context | a skill |
| Work whose transcript would flood the main context (search, review, a long investigation) | an agent |
| A fresh view that must not see the author's reasoning (review) | an agent |
| Narrower permissions than the session (read-only review, no network) | an agent |
| A self-contained task that returns one result | an agent |

## Format

With the `pi-subagents` package, an agent is a markdown file: `.pi/agents/<name>.md` in a project, `~/.pi/agent/agents/` for the user, or a pi package that declares `"pi-subagents": {"agents": ["./agents"]}` in its `package.json`. Frontmatter, then the system prompt:

```yaml
---
name: api-auditor
description: Read-only API auditor. Use after … to …
tools: read, grep, find, ls, bash   # strict allowlist; omitted = pi's builtin tools
model: <provider/id>                # omitted = the parent's default model, unless settings set one
thinking: xhigh                     # off | minimal | low | medium | high | xhigh | max
inheritProjectContext: true         # custom agents start without AGENTS.md unless set
---
```

- A custom agent starts narrow: no project instructions unless `inheritProjectContext: true`, and no skills catalog unless `inheritSkills: true`; `skills` names specific skills to load.
- A file named like a builtin (`worker`, `reviewer`, `scout`) replaces it whole. To change one field of a builtin, use `subagents.agentOverrides` in `.pi/settings.json` instead.
- Check the field list in the pi-subagents docs for the version you install before using a field not shown here.

## The prompt

- **One responsibility.** "Review a git range against its requirements", not "review and fix".
- **Least privilege.** Grant only the tools the role needs. A reviewer gets no edit tools; a researcher gets no shell. A shell can write files, so a read-only role that needs one also needs a hook or guard rule that limits its commands. Nesting (an agent dispatching agents) stays off unless the role is an orchestrator: leave `subagent` out of `tools` and `allowNestedSubagents` unset.
- **Model by stakes:** the most capable model for review, security and design judgment; a fast one for search and mechanical work.
- **Self-contained input.** The agent never sees the conversation. Its prompt says what it receives (task text, paths, ranges, commands) and what to do when something is missing: report `NEEDS_CONTEXT`, don't guess.
- **A fixed report.** End with machine-readable lines the caller or a hook can parse (a status word, a verdict, the SHAs reviewed) and a short human summary. Say what counts as evidence (commands run with their output, `file:line`).
- **Boundaries.** What it must never do (push, edit outside the task, weaken tests) and when it stops and returns.

## Test it

1. Dispatch it on a real task from this repo and on one with missing input. Check that the report has every required line and that missing input produces the stop status, not a guess.
2. Check the tool limits hold: ask the read-only agent to edit a file and confirm it can't.
3. Check delegation: describe the task in plain words and see whether the main agent picks this agent. Rewrite the description if it doesn't.
4. A change to an agent's prompt or tools is reviewed like code; a hook that parses its report has a test with a sample report.
