---
name: brainstorming
description: Use before any creative or behavior-changing work - building a feature, component, screen, endpoint or project, adding functionality, or modifying how something behaves
---

# Brainstorming: from idea to approved design

The goal is an understanding the user can recognize and correct, and approval of it before any implementation.

<HARD-GATE>
Do not write product code, scaffold, install dependencies or invoke an implementation skill until the selected path's approval is given. Read-only exploration is allowed. An approval covers only the stage you actually presented.
</HARD-GATE>

## 1. Classify, out loud

Say which path you are taking so the user can override it: "This looks bounded, so I'll propose a short design here."

- **Spike**: a feasibility question. Present the question and the probe in 2–3 sentences, get a nod, investigate cheaply, and report a recommendation. Anything you built is throwaway.
- **Bounded**: a well-scoped change to a flow that already exists in this repo. If there is no existing flow to read, it is not bounded.
- **Architectural**: a new project or subsystem, or a change to interfaces other code depends on.

When in doubt, take the heavier path. Hidden complexity found mid-task moves you up a path, never down.

## 2. Understand

1. Explore context first: relevant files, AGENTS.md, docs, recent commits.
2. If the request contains several independent subsystems, say so and decompose it before refining any one of them. Each piece gets its own design → plan → build cycle.
3. Ask about purpose, users, constraints and success criteria. Ask **one question per message**, multiple choice where possible. Don't re-ask what the request already answers.
4. Write back your understanding: the outcome, the constraints and the success criteria, separating what the user said from your assumptions. Invite correction.

For the domain, also ask about the things that are expensive to change later. For money: currency, rounding and idempotency. For POS: offline mode and fiscal law. For mobile and desktop: target OS versions and distribution channel. Load the matching platform or domain skill if one exists.

## 3. Design

- **Bounded:** present a short design in chat: the approach, the files touched, how each criterion will be tested. Then **stop and wait for an explicit yes**. Presenting and starting in the same message skips the gate.
- **Architectural:**
  1. Propose 2–3 approaches with trade-offs, recommended one first. Apply YAGNI to every option.
  2. Present the design in sections sized to their complexity: architecture, components and interfaces, data flow, error handling, testing, rollout or migration. Confirm each section.
  3. Design small units with one purpose and clear interfaces. In existing code, follow its patterns; include only the refactors this goal needs.
  4. Write the spec to `docs/specs/YYYY-MM-DD-<topic>.md`, or wherever the project keeps specs.
  5. Self-review it: no TBDs, no contradictions, no requirement readable two ways, scope fits one plan.
  6. Ask the user to review the file. Once approved, the next step is **writing-plans**. Invoke nothing else.

Use `../../templates/task.md` when the output is a task for someone else: numbered, testable criteria plus constraints.

## Red flags

| Thought | Reality |
|---|---|
| "Too simple to need a design" | A bounded change needs two sentences and a yes. That's cheap. |
| "I'll call it bounded and skip the spec" | Reaching for a label to skip work is the doubt. Take the heavier path. |
| "I know this kind of app" | Bounded measures the repo, not your familiarity. |
| "The spike works, I'll keep it" | Keeping it is a new request. Classify it. |
| "They liked the idea, so the plan is approved" | Each stage needs its own approval. |
