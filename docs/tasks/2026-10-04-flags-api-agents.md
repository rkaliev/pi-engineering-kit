# Feature flags, API and query rules, test helpers, subagent authoring, learning from corrections

Status: in progress
Base: 0917590b03623b4831b64792a4a59a5a624503e1
Links: None

<details><summary>Original request</summary>

Study skills for creating skills and agents and for self-improvement; tRPC; a feature-flag and experiments service; TanStack Query; shared test helpers and BDD helpers. Then: add feature flags, API and TanStack Query, test helpers, agent authoring; self-improvement as a rule in existing skills.

</details>

## Intent

Agents using the kit get current guidance for feature flags and experiments, internal RPC contracts and the server cache, shared test helpers, writing subagents, and turning a recurring correction into a lasting rule.

## Context

The kit has no feature-flag guidance, `writing-skills` covers skills but not subagents, and nothing tells the agent what to do when a review finding or a user correction reveals a gap that will recur. `state-and-data.md`, `backend-services` and `test-standard.md` cover most of the ground, with a few gaps listed in Design.

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | `backend-services/references/feature-flags.md` exists and the skill links to it; the TS profile has a Flags row | lint-skills (links, budgets) + review |
| 2 | backend-services API contracts cover stale web clients for internal RPC, machine-readable error codes, resource scope checks after input parsing | review |
| 3 | `state-and-data.md` has server-cache rules: one place for staleness and retry, no retry on 4xx, shared query options, invalidate after mutation, a client per SSR request, one error path, dev tools in dev only | review |
| 4 | `test-standard.md` adds: cleanup reports every failure, setup checks migrated and seeded, provider fakes refused in production at startup, parametrized contract suites, personas in one module with a seed check | review |
| 5 | `writing-skills` covers subagents (when, format per edition, prompt rules, how to test) in `references/agents.md`; its description triggers on agents | lint-skills + review |
| 6 | `receiving-code-review` turns a recurring correction into a proposed check or rule, strongest level first, the user decides; open proposals join the Follow-ups at the finish | review |
| 7 | Both editions say the same, adjusted to the platform; every SKILL.md body stays ≤ 800 words | `npm test`, compare-editions |

## Scope

**In scope:** the skills and references above, the reviewer checklist line for flags, README, ARCHITECTURE (EN+RU), CHANGELOG 0.19.0, versions.

**Out of scope:** template code (no flags package, no tRPC in the template), guard or hook changes, a new skill.

## Decisions

1. Flags: the application uses OpenFeature; the provider is a stack choice; a homegrown service only with a recorded reason (user, 2026-10-04).
2. Self-improvement is a rule in existing skills, not a new skill or a retro step (user, 2026-10-04).
3. Agent authoring lives in `writing-skills` as a reference, not a new skill (user, 2026-10-04).
4. Execution inline, a review after the work and a final review of the branch (user, 2026-10-04).

## Design

Docs only. New files: `skills/backend-services/references/feature-flags.md`, `skills/backend-services/references/api-contracts.md`, `skills/writing-skills/references/agents.md`. Edited: `backend-services/SKILL.md`, `web-frontend/references/state-and-data.md`, `test-driven-development/references/test-standard.md`, `writing-skills/SKILL.md`, `receiving-code-review/SKILL.md`, `choosing-a-stack/references/ts-fullstack-profile.md`, `requesting-code-review/references/checklist.md`.

## Rollout

None: a minor release of the kit.

## Risks and open questions

- Agent frontmatter fields drift between tool versions → the reference shows only the stable fields and points to the official docs.
- SKILL.md word budgets → new material goes to references.

## Follow-ups

- Guard: `declare &>/dev/null -x GIT_DIR=…` is quiet because the tokenizer treats `&` as a separator (pre-existing).

## Plan

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** add the five pieces of guidance to both editions.
**Architecture:** new material in references; one-line links from the skills.
**Verification:** `npm test`, `npx tsc --noEmit -p .`, `node .github/release.ts check`, the workspace's compare-editions.

### Review focus
- A SKILL.md over 800 words.
- A statement about a tool's file format that the official docs don't support.
- Drift between the editions.

### Post-implementation
README (skills table), docs/ARCHITECTURE.md and .ru.md (skills rows), CHANGELOG 0.19.0, versions.

### Task 1: references and skill edits
- [x] Add `feature-flags.md` and `agents.md`; link them from backend-services and writing-skills
- [x] Edit state-and-data, test-standard, backend-services API contracts (new rules in `references/api-contracts.md`), receiving-code-review, the profile and the checklist
- [x] Run `npm test` → expect PASS (lint-skills budgets and links)

### Task 2: docs and release
- [x] README, ARCHITECTURE (EN+RU), CHANGELOG 0.19.0, versions
- [x] Run `node .github/release.ts check` → expect `release metadata ok: 0.19.0`

## Progress

- Ruling: the finish rule moved from executing-plans into receiving-code-review — executing-plans in the pi edition would exceed the 800-word budget — the rule is still read at review time and at the finish.
- Ruling: the new API rules went to `backend-services/references/api-contracts.md` — the skill body would exceed 800 words.
- Task 1: complete (`npm test` → all pass in both editions)
- Task 2: complete (`node .github/release.ts check` → release metadata ok: 0.19.0)
