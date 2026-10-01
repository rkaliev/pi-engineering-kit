# <Title: what the user gets, ≤ 80 characters>

Status: draft
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: <commit SHA the plan was written against (`git rev-parse HEAD`)>
Links: <issue · decision records · legacy map · or None>

<!-- One file per piece of work, standing in for a tracker issue: the sections before Plan are its description. Each section answers one question and never repeats another. Keep every heading; write "None" instead of deleting a section. -->

<details><summary>Original request</summary>

<The user's words, verbatim.>

</details>

## Intent

<One sentence: who gets what, and why it matters. Written as the strongest version of what the user asked for.>

## Context

<At most three sentences: what exists today and what is wrong or missing. Link, don't restate.>

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | <"Search ignores case and surrounding spaces"; include empty, error and limit cases> | <test name and level (unit / API / UI / scenario @C1); "manual: <step> — <why it can't be automated>, agreed <date>" only where automation is impossible> |

## Scope

**In scope:**
- <…>

**Out of scope:**
- <what will not be done, so it doesn't creep in; or "None — this is the entire change.">

## Decisions

1. <Decision made with the user, with the reason. Mark anything not confirmed as **assumed**. Constraints go here too: where the logic lives, what must not change, allowed dependencies, platform floors.>

## Design

<Only what applies: components and their single responsibility, interfaces and contracts, data and schema (database-changes), error handling, security and money rules, logs, metrics and deadlines (observability). Diagrams where they save words.>

## Rollout

<Migration (expand/contract releases), feature flag, cut-over, backfill, alerts to watch, rollback. Or "None".>

## Risks and open questions

- <Risk → mitigation. Open questions block approval until answered.>

## Follow-ups

- <An independent piece left for later, one line: goal and boundaries. Plain bullets, no checkboxes. Shown to the user when this task finishes. Or "None".>

## Plan

<Written by writing-plans after the design is approved. Until then: "None yet".>

## Progress

<Written by executing-plans: baseline, drift, rulings, `Task N: complete (…)` lines. No checkboxes. Until then: "None yet".>
