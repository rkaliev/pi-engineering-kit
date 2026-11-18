# Debugging starts from a control run on the base commit; watcher and verify follow-ups

Status: plan approved (2026-11-19)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit 24b5d89 · pi 597bc1a
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

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** systematic-debugging asks for a control run on the base commit (measured by a new eval), with a reference for the matrix and the fact layers; the watcher reports a red rollup beyond the checks read; pi's verify gate treats a queued watcher message as a new prompt.
**Architecture:** Text changes in both editions' systematic-debugging plus a byte-identical reference; one new eval case in eng-kit only. One new candidate in the shared `decide` (`lib/pr-watch.ts` / pi `extensions/lib/pr-watch.ts`, byte-identical). One `message_start` handler in pi `extensions/verify.ts`.
**Stack / constraints:** Node ≥ 22.18 running `.ts` directly, `node:test`; no new dependencies; skill body ≤ 800 words (`tests/lint-skills.test.ts`); shared libs and the new reference stay byte-identical across editions; files in English; commits without Claude trailers; test edits only extend exact lists or shapes, each in its own commit, except the one R4 assertion Task 5 replaces (criterion 4, approved with this plan).
**Verification:** in each repo `npm run typecheck` and `npm test`, run through the kit verify script (`node <kit root>/scripts/verify.ts`); evals: `npm run eval -- --case inherited-failure` (eng-kit, spends plan usage).

### Review focus
1. The base-run grader misses a real base run done another way (`git worktree add ../base main`, `git checkout <merge-base sha>`, `git stash && git switch main`, `git -C`) or credits a run that never reached the base (`git log main`, `git diff main`, `git show main:src/vat.ts`) → positive and negative rows in Task 1.
2. A red rollup that is still running (`state: FAILURE`, `pending > 0`, failed beyond those read) must also come once per head, and acked it must not come again → rows in Task 5.
3. `message_start` also fires for the run a watcher message starts (after `before_agent_start`) → resetting twice must not change the outcome; the gate's own `verify-gate` message and user messages must not reset → rows in Task 6.
4. The skill step names "base commit" for a branch only; on the base branch itself (no merge-base distinct from HEAD) the step must not demand an impossible control → wording in Task 3 says "on a branch".
5. Word budget: the step plus link must keep SKILL.md body ≤ 800 in both editions → lint in Task 3.

### Post-implementation
- `CHANGELOG.md` (both): 0.43.0 entries for the control run, the watcher rollup event, the pi queued-message reset (pi only).
- `docs/ARCHITECTURE.md` + `.ru.md` (both): the **Debugging** paragraph gains the control run and the reference; the watcher description, if it lists when `checks_failed` comes, gains the rollup case.
- `skills/git-workflow/references/pr-watch.md` (both): `checks_failed` may name no check ("failed beyond the N checks read"): open the PR's checks page.
- `docs/EVALS.md` (eng-kit): the `inherited-failure` row in Cases and a dated section with RED/GREEN results; the matrix and layers noted as unmeasured.
- Version 0.43.0 in `package.json` (both) and `.claude-plugin/plugin.json` (eng-kit).
- What outlives this file: behavior → the chapters above; no new decision record (the rulings are kit-internal and recorded in CHANGELOG/EVALS).

### Files
- `skills/systematic-debugging/SKILL.md` (both): the Phase 1 control step and link.
- `skills/systematic-debugging/references/failure-evidence.md` (both, new, byte-identical): control, signal/noise, matrix, five tactics, layers, reproduction.
- `evals/inherited-failure/{case.yaml,prompt.md,scaffold.sh,fixture/,graders/}` (eng-kit, new): the case.
- `tests/eval-graders.test.ts` (eng-kit): rows for the base-run grader.
- `lib/pr-watch.ts` / `extensions/lib/pr-watch.ts`: the rollup candidate. `tests/pr-watch.test.ts` (both): rows.
- `extensions/verify.ts` (pi): `message_start` reset, two comments. `tests/extensions.test.ts` (pi): rows.

### Task 1: eval case `inherited-failure` with tested graders (eng-kit)

**Files:** Create `evals/inherited-failure/{case.yaml,prompt.md,scaffold.sh}`, `fixture/{package.json,dot-gitignore,src/vat.ts,src/vat.test.ts}`, `graders/{base-run.md,test-kept.md,attributed.md,skill-loaded.md}` · Modify `tests/eval-graders.test.ts`

- [ ] Fixture, copied in shape from `evals/bug-root-cause/` (package.json `"test": "node --test"`, Node ≥ 22.18, no dependencies): `src/vat.ts` exports `vatMinor(netMinor: number, ratePercent: number): number` = `Math.round(netMinor * ratePercent / 100)`; `src/vat.test.ts` has `rounds VAT half-up` asserting `vatMinor(1005, 10) === 101` and `vatMinor(1000, 20) === 200`.
- [ ] `scaffold.sh`: copy and rename dotfiles as bug-root-cause does; `git init -b main`; commit "initial"; then on `main` change `Math.round` to `Math.floor` and commit `perf: integer VAT math`; then `git switch -c feat/receipt-footer`, add `src/footer.ts` (`receiptFooter(shop: string): string` → `Thank you for shopping at ${shop}!`) and `src/footer.test.ts` (one passing test), commit `feat: receipt footer`. Same `-c user.name=eval … core.hooksPath=/dev/null` flags.
- [ ] `prompt.md`: "CI is red on my branch `feat/receipt-footer`: `rounds VAT half-up` in `src/vat.test.ts` fails. Fix it so I can merge." plus the standard Node line and "I'm away, so don't ask me questions: make reasonable calls and tell me what you did when it's done." `case.yaml` as bug-root-cause (max_turns 40, timeout 900).
- [ ] Write failing grader tests in `tests/eval-graders.test.ts` for `inherited-failure/graders/base-run.md` (regex over the trace): match `git stash` + `git switch main` + `npm test`; `git checkout main` then `node --test`; `git worktree add ../base main` then `cd ../base && npm test`; `git checkout $(git merge-base HEAD main)` then `npm test`; no match for `git log main`, `git diff main...HEAD`, `git show main:src/vat.ts`, `npm test` before any git command only, `git switch main` with no later test run. Create `base-run.md` with a pattern that matches nothing yet.
- [ ] Run `node --test tests/eval-graders.test.ts` → expect FAIL on the positive rows.
- [ ] Write the `base-run.md` pattern: a Bash command reaching `main` or a merge-base (`git (switch|checkout) …`, `git worktree add … main`, `git -C <dir> (switch|checkout)`) followed later in the trace by `npm test`, `npm run test` or `node --test`.
- [ ] Run it → expect PASS. Add `test-kept.md` (regex on file `src/vat.test.ts`: `vatMinor\(1005, 10\), 101`), `attributed.md` (llm, final message: PASS if it says the failure already exists on `main`, introduced by the `main` commit `perf: integer VAT math` or otherwise present before the branch, and not caused by the branch's changes; FAIL if it presents the failure as caused by the branch or doesn't say where it came from), `skill-loaded.md` (copy).
- [ ] Run the full suite → PASS; `claude plugin validate .` → PASS. Commit `test(evals): inherited-failure case`.

### Task 2: git in the eval sandbox, then RED (eng-kit)

- [ ] Run `npm run eval -- --case inherited-failure --runs 1 --ablation none --keep-temp` and read the kept trace: do `git` commands succeed? If they fail on `xcrun`, try in this order: `DEVELOPER_DIR` set for the run, a non-shim git first on PATH. Record what worked in Progress. If nothing works: **stop and ask the user.**
- [ ] Read that run's trace against each grader by hand; fix any grader that misjudges it (with a grader-test row first), commit `test(evals): …`.
- [ ] RED: run the case's no-kit arm 3 times (`npm run eval -- --case inherited-failure --keep-temp`, both arms; the no-kit arm is RED). Record per-grader results in Progress. If the no-kit arm passes `base-run` and `attributed` in 3/3: **stop and ask the user** (Decision 3); Tasks 5–6 may proceed meanwhile.

### Task 3: the control step and the reference (both editions)

**Files:** Modify `skills/systematic-debugging/SKILL.md` · Create `skills/systematic-debugging/references/failure-evidence.md` (both editions)

- [ ] In Phase 1, after item 3 ("Check what changed"), insert item 4 (renumber the rest): **Control first.** On a branch, run the failing test, build or job on the base commit (`git merge-base HEAD <base>`) before editing anything. If it fails there too, the failure is inherited: report it with that run as evidence, never adjust the assertion, and fix it only at a proven cause, in its own commit. One more sentence: choosing a control, separating signal from noise and testing hypotheses against facts: `references/failure-evidence.md`.
- [ ] Write the reference (≤ 300 words, adapted in the kit's register, not copied): control and why it is trusted (not broken the same way); signal = present in the variable, absent in the control; noise = in both, eliminates only; hypotheses × facts matrix, read by column (strongest signal: fewest hypotheses fit) and row (no fact contradicts); when no row fits: re-verify how the fact was gathered, split, merge, combine (each cause necessary), form a new one only from held facts; layers cheapest first: the report → errors, logs and telemetry → CI output → repository history → code, read only to explain a signal in hand; stop at the first strong signal; a reproduction must carry the report's strongest signal, or it is a different defect. Copy it byte-identical to the other edition.
- [ ] Run `node --test tests/lint-skills.test.ts` in both repos → PASS (≤ 800 words, links resolve); `cmp` the two references → identical; `diff` the two SKILL.md → only the `effort:` line differs as before.
- [ ] Commit `feat(systematic-debugging): control run on the base commit` in each repo.

### Task 4: GREEN and EVALS.md (eng-kit)

- [ ] Run `npm run eval -- --case inherited-failure --keep-temp` (3 runs per arm); read at least one kept run per arm against the graders.
- [ ] Add the Cases row and a section "A control run on the base (2026-11-xx, kit 0.42.0 → 0.43.0, Claude Code <version>)" with the RED/GREEN table, cost, the sandbox git finding, and "the matrix and the fact layers are not measured". Commit `docs(evals): inherited-failure results`.

### Task 5: watcher reports a red rollup beyond the checks read (both editions)

**Files:** Modify `lib/pr-watch.ts` (pi: `extensions/lib/pr-watch.ts`) · Test `tests/pr-watch.test.ts` (both)

- [ ] Own commit first, `test(pr-watch): a red rollup beyond the checks read is no longer a wait`: in the R4 test, replace the assertion that `{ state: "FAILURE", failed: [], pending: 0, total: 100 }` gives `null` with one that it gives `checks_failed` (the PENDING row stays). Run → expect FAIL (received null).
- [ ] Add test `decide: a red rollup with no failed check among those read is checks_failed once per head`: `{ state: "FAILURE", failed: [], pending: 3, total: 100 }` → `checks_failed` with reason `failed beyond the 100 checks read; 3 still running`; `ERROR` likewise; with that event's id acked → `null` before the quiet period; a new head → `checks_failed` again. Run → FAIL.
- [ ] In `decide`, when `checks.failed` is empty and `checks.state` is `FAILURE` or `ERROR`, push `["checks_failed", \`failed beyond the ${checks.total} checks read; ${checks.pending} still running\`]` in the same precedence slot; update the doc comment. Copy the lib byte-identical to pi.
- [ ] Run `npm test` in both → PASS; `cmp` the libs. Commit `fix(pr-watch): report a red rollup beyond the checks read` in each.

### Task 6: pi verify resets on a queued watcher message (pi)

**Files:** Modify `extensions/verify.ts` · Test `tests/extensions.test.ts`

- [ ] Write test `verify: a watcher message queued into a running run counts as a new prompt`: no UI; edit `src/a.ts`, `agent_end` → 1 sent; `before_agent_start` custom `verify-gate`; `message_start` with `{ role: "custom", customType: "pr-watch" }`; edit `src/b.ts`; `agent_end` → 2 sent. Negative in the same test: then `message_start` with `customType: "verify-gate"` and with `{ role: "user" }`, edit `src/c.ts`, `agent_end` → still 2. Run → FAIL (1 sent).
- [ ] Add `pi.on("message_start", …)` calling `newPrompt()` when `event.message.role === "custom" && event.message.customType === "pr-watch"`; keep the `before_agent_start` handler (a second reset is harmless; R9 test stays). Fix the comments at verify.ts:10 and :374 to say "once per prompt (a user message or a watcher wake)".
- [ ] Run `npm test` → PASS. Commit `fix(verify): a queued watcher message starts a new prompt`.

### Task 7: docs and version 0.43.0 (both editions)

- [ ] Do every item of Post-implementation; bump versions; run the kit verify script in each repo → PASS. Commit `docs: 0.43.0`.

## Progress

None yet
