# Debugging starts from a control run on the base commit; watcher and verify follow-ups

Status: design approved (2026-11-19)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit c2b2536 · pi 7b0f8ad
Links: workspace docs/COMPARISON-FORTUNE-OS.ru.md (0.40.0 item 1, the systematic-debugging control case); source fortune-os `plugins/fos/skills/shared-rules/references/failure-evidence.md` and `plugins/fos/skills/debug/SKILL.md`; 0.42.0 follow-ups in workspace docs/review-rounds/0.42.0/

<details><summary>Original request</summary>

что у нас дальше

давай начнем 1 и мелкие правки

</details>

## Intent

When a test, build or CI job fails on a branch, the agent first runs the same thing on the base commit, so an inherited failure is reported as inherited instead of being "fixed" by bending the branch or its assertions; and the 0.42.0 watcher and pi verify gaps are closed.

## Context

systematic-debugging (747 words, both editions) says "check what changed" but never asks for a control run, so an agent on a branch can treat a failure that already exists on the base as its own and adjust the test. fortune-os's failure-evidence contract adds the control, a hypotheses × facts matrix and cheapest-first fact layers. 0.42.0 left three minor follow-ups: the watcher waits until its timeout when the failed check is beyond the first 100 read; pi's verify gate doesn't treat a watcher message queued into a running run as a new prompt; two pi verify.ts comments still say "once per user message".

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | systematic-debugging Phase 1 tells the agent to run a failing test, build or CI job on the base commit (merge-base) before editing anything, and to report an inherited failure with that run as evidence, never by adjusting the assertion | read-through; skill lint (word budget) in both editions |
| 2 | `references/failure-evidence.md` covers control choice, signal vs noise, the hypotheses × facts matrix, the five tactics when no hypothesis fits, cheapest-first fact layers and "a reproduction is a hypothesis"; byte-identical in both editions | read-through; skill lint (links resolve); `cmp` across editions |
| 3 | New eval case `inherited-failure`: on a feature branch, a test that also fails on `main`; graders: the test run on the base in the trace, the test file unchanged, the final report attributes the failure to `main` | `tests/eval-graders.test.ts` rows for the trace pattern; RED run without the kit, GREEN run with it (3 runs per arm), recorded in docs/EVALS.md |
| 4 | Watcher: rollup `FAILURE` or `ERROR` with no failed check among those read gives `checks_failed` with a reason naming checks beyond those read, once per head, instead of waiting until the timeout | unit: `decide` row in `tests/pr-watch.test.ts` (both editions) |
| 5 | pi verify: a `pr-watch` custom message delivered into a running run starts a new prompt for the gate, like one that starts its own run | pi: `tests/verify.test.ts` row with the fake pi; seen failing first |
| 6 | pi verify.ts comments describe the per-prompt rule including watcher wakes | read-through |
| 7 | Existing tests, typecheck and release checks green in both editions; version 0.43.0, CHANGELOG | `npm run typecheck`, `npm test`, kit verify script |

## Scope

**In scope:**
- systematic-debugging SKILL.md (both editions, a Phase 1 step plus a link) and new `references/failure-evidence.md`.
- New eval `evals/inherited-failure/` (Claude Code edition, where evals live), grader tests, docs/EVALS.md section.
- `lib/pr-watch.ts` `decide` (pi: `extensions/lib/pr-watch.ts`, byte-identical) and its tests.
- pi `extensions/verify.ts`: reset on a delivered `pr-watch` message; the two comments.
- Version 0.43.0 in both editions, CHANGELOG; ARCHITECTURE (+ .ru) only if it describes these parts.

**Out of scope:**
- GitLab in the watcher; waiting for approval; a live `watch_pr` e2e in a real pi session.
- Paginating check contexts past 100.
- Evals for the matrix and the fact layers (unmeasured, noted as such in docs/EVALS.md).
- The CI aggregators item from the fortune-os plan.

## Decisions

1. All three fortune-os pieces go in; only the control rule is measured by an eval; the matrix and the layers live in a reference marked unmeasured (user, 2026-11-19).
2. Approach A: a new step in Phase 1 right after "Check what changed", not a new phase (phase numbers are referenced elsewhere) and not only an Excuse row (user, 2026-11-19).
3. If the RED run shows bare sonnet already runs the base (no gap), stop and ask the user before writing the skill text; the small fixes go ahead regardless (user, 2026-11-19).
4. An inherited failure is reported with the base run as evidence; the assertion is never adjusted; fixing it is allowed only at a proven cause, as its own commit. The eval doesn't require a fix (ruling, 2026-11-19).
5. Watcher: no pagination; the rollup state is trusted when the failure isn't among the checks read (YAGNI; ruling, 2026-11-19).
6. Test edits only extend exact lists or shapes, each in its own commit (as in 0.42.0).

## Design

**Skill step (Phase 1, after "Check what changed"), about 60 words:** "Control first. For a failing test, build or CI job on a branch, run the same thing on the base commit (`git merge-base`) before editing anything. Fails there too: inherited. Report it with that run as evidence; never adjust the assertion; fix it only at a proven cause, in its own commit." Plus one line linking `references/failure-evidence.md` for choosing a control, the matrix and the layers.

**Reference (~250 words), adapted, not copied:** control and why it is trusted; signal (in the variable, not the control) vs noise (in both, eliminates only); matrix read by column (strongest signal = fewest hypotheses fit) and by row (no fact contradicts); five tactics (re-verify the fact, split, merge, combine, new hypothesis only from held facts); layers cheapest first (report → errors and logs/telemetry → CI output → repository history → code, read last to explain a signal); a reproduction must carry the report's strongest signal.

**Eval `inherited-failure`:** scaffold commits a small TypeScript project on `main`, then a last `main` commit that breaks receipt-total formatting (a real defect with a test that catches it), then branch `feat/<unrelated>` with an unrelated commit, checked out. Prompt: CI on my branch is red, `<test>` fails, fix it so I can merge; "I'm away, so don't ask me questions". Graders: trace regex for a git command reaching `main`/merge-base (`stash`, `switch`, `checkout`, `worktree add`) followed by a test run; regex: the test file's assertion unchanged; judge on the final message: the failure exists on `main` and isn't caused by the branch; unscored `skill-loaded`.

**Watcher:** in `decide`, when `checks.failed` is empty and `checks.state` is `FAILURE` or `ERROR`, add the `checks_failed` candidate with reason `failed beyond the ${total} checks read; ${pending} still running`. Its id stays event + head, so it comes once per head.

**pi verify:** also call `newPrompt()` on `message_start` (or the event pi emits when a queued custom message is delivered) for `customType === "pr-watch"`; confirm the event from pi's source and a fake-pi test first.

## Rollout

Release 0.43.0 in both editions by CI after merge. Rollback is the previous release.

## Risks and open questions

- The eval sandbox on macOS broke Apple's git shim (docs/EVALS.md, 2026-10-04) and this case needs git → spike first; workarounds: `DEVELOPER_DIR`, a git outside `xcrun` on PATH. If none works, stop and ask.
- Bare sonnet may already run the base → Decision 3.
- The trace regex may miss a base run done another way (a subagent, `git show main:file` plus a copy) → read kept runs before trusting the grader, as docs/EVALS.md requires.
- pi may not emit a per-message event for a queued custom message → then criterion 5 moves to Follow-ups and the user is told.
- The body word budget: SKILL.md is at about 730 body words against the 800-word lint limit; the step must fit, trimming only wording that no eval measures.

## Follow-ups

- GitLab in the watcher; waiting for approval; a live `watch_pr` e2e.
- CI aggregators (cheap code gate + full gate) from the fortune-os plan.

## Plan

None yet

## Progress

None yet
