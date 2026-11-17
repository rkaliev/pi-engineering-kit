# Verify gate waits for working subagents and credits verified content

Status: design approved (2026-11-17)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: eng-kit cc02841f0fca30ad7901285ec9127a3f9227df05 · pi de2724c7f77bfb0dd291a00d2e4b357445025b31
Links: None (workspace analysis of six verify-gate send-backs from life-bpms and agentic-coding, 2026-11-15)

<details><summary>Original request</summary>

(A paste of six verify-gate send-backs from two projects, no words of the user's own.) → After the analysis: «давай все три» (1: wait for background agents, 2: credit by content, 3: `paths` for life-bpms). Design choice: while the main agent waits for the kit reviewer, the gate still sends back — "a".

</details>

## Intent

The verify gate sends the agent back only when a check is actually owed at that moment: not while an agent that may edit the same files is still working in the background, and not for files that are back to content the checks already passed on.

## Context

Of six send-backs in the paste (kit 0.39.1), four came when the main agent dispatched a background subagent (`status: "async_launched"`) and ended its turn to wait: the agent then ran the full suite in the background while an implementer edited the same tree, or ran a partial check. One came after `git pull` of a squash-merged PR whose content had been verified on its branch: the fingerprint (`"<size> <mtimeMs>"` per changed file, lib/worktree.ts) sees the pull as edits. The sixth was doc edits in a project without `paths` (handled in life-bpms, outside this task).

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | Live: an async Agent launch's PostToolUse input carries `tool_response.status === "async_launched"` and `tool_response.agentId`, and the agent's SubagentStop carries the same `agent_id`; what SendMessage (resume) and TaskStop inputs carry is recorded | live check with `claude -p --plugin-dir src_claude`, findings in Progress |
| 2 | PostToolUse of an async Agent launch whose `subagent_type` is not the kit reviewer records its `agentId` with the launch time in the session state; a foreground Agent call or a reviewer launch records nothing | hook tests |
| 3 | SubagentStop with a recorded `agent_id` removes it | hook test |
| 4 | Stop while a recorded agent younger than 2 hours runs: the verify gate neither sends back nor notes, and `judged` stays unchanged, so the next Stop judges those edits; the approval, working-docs and PR feedback gates behave as before | hook tests |
| 5 | A recorded agent older than 2 hours is dropped at Stop and no longer holds the gate | hook test with an old timestamp |
| 6 | If criterion 1 shows the fields: SendMessage to a known `agentId` records it again, TaskStop of a recorded one removes it; otherwise both go to Follow-ups | hook tests, or a Follow-ups line |
| 7 | Whenever the state becomes verified (every configured command green), the session stores a content key of the tree: each repository's `HEAD^{tree}` plus the git blob hash of every listed changed path (`deleted` for a deletion), ignore globs applied; no key when the tree has a blind or unseen part, in a folder outside git, with `gitOff`, for a folder label (submodule), past the size cap or the time budget | unit tests of the key function; hook tests |
| 8 | Stop with unverified edits whose current content key equals the stored one: the state becomes verified (`edited` cleared, every command green) and there is no send-back | hook test: edit, verify, change a file, restore its content with a new mtime, Stop |
| 9 | Squash-merge flow: verified on a branch, `git checkout main && git merge --squash` of the same tree committed → no send-back; a different tree → send-back as before | hook test in a temp repository |
| 10 | Any difference (one byte, an extra untracked file, another HEAD tree) keeps the gate as before | hook tests |
| 11 | The kit reviewer's SubagentStop applies the same check before deciding Inconclusive: a review on content equal to the verified key is recorded as its verdict | hook test |
| 12 | Computing the key never writes into `.git` (no `-w`, no index writes) and stays within its budget; on error or timeout there is no key and the gate behaves as before | unit test (objects count unchanged); timeout test |
| 13 | pi: the same content key at `agent_end` and for the review gate's `verifyState`; `lib/worktree.ts` stays byte-identical between editions | pi tests mirroring 7–12; `cmp` |
| 14 | README, ARCHITECTURE (en, ru) and CHANGELOG 0.41.0 describe both rules and their limits in both editions | prose review |

## Scope

**In scope:**
- eng-kit: background-agent tracking (PostToolUse Agent, SubagentStop, Stop), content key and its use at Stop and reviewer SubagentStop.
- pi: content key at `agent_end` and in the review gate.
- Docs, CHANGELOG, release 0.41.0 in both editions.

**Out of scope:**
- pi background subagents: the kit's pi skills run subagents in the foreground; pi-subagents' detached background runs are another process the gate can't observe.
- Background Bash jobs other than the verify script (a dev server, a long build).
- Per-command content keys (`--only` subsets, `paths`): the key covers the whole tree and is taken only when everything is green.
- The life-bpms `paths` map: a separate change in that repository.

## Decisions

1. While the main agent waits for the kit reviewer, the gate sends back as before (user, 2026-11-15, "a"): verification then runs beside a read-only agent, and the review counts if it finishes first. Only agents that may edit hold the gate.
2. Agents are tracked by hook events (PostToolUse Agent, SubagentStop), not by reading the transcript, whose format is internal.
3. A recorded agent expires after 2 hours (**assumed**): the longest implementer task in the transcripts ran about 37 minutes; a killed agent must not hold the gate for the session.
4. The content key uses blob hashes of the content, not size and mtime: a pull or checkout rewrites mtimes. It is computed in Node (`sha1("blob <len>\0" + content)`), so nothing is written into `.git`; `HEAD^{tree}` comes from one `git rev-parse` per repository.
5. Fail closed: anything the key can't prove (blind parts, submodules, no git, cap, timeout) means no key, and the gate behaves as before.
6. Release 0.41.0, not a patch: a fail-closed gate gains two ways to stay silent, so it gets full review rounds (F+S per edition).

## Design

**Agent tracking (eng-kit, lib/hooks.ts, lib/state.ts).** `SessionState.agents?: Record<string, number>` (agentId → launch ms). PostToolUse for tool `Agent` with `tool_response.status === "async_launched"` and a string `agentId`, unless `tool_input.subagent_type` matches `REVIEWER`, adds it. SubagentStop deletes `input.agent_id`. `stopGates` drops entries older than `AGENT_MAX_AGE_MS` (2 h) and treats a remaining one like a running verify: the verify branch is skipped and `judged` is left alone. `HookInput` gains `tool_response?: Record<string, unknown>`.

**Content key (both editions, lib/worktree.ts, shared byte-identical).** `contentKey(projectDir, tree, ignore, deadline): string | undefined` → a sha256 over sorted `repo\0headTree` lines and `path\0blobHash` lines. Called at the point a state turns verified (`credited`, `settleLaunch` in eng-kit; the green paths in pi's verify.ts), stored as `verifiedKey`; cleared state stays as is. At Stop, when unverified and a key is stored, the current key is computed from the fresh fingerprint; equal → the state becomes verified (`unverified: false`, `edited: []`, `green` = all commands). The reviewer's SubagentStop (eng-kit) and the guard's review check (pi) use the same comparison before calling a review Inconclusive. Caps: 2 s and 64 MB of file content per key.

## Rollout

None: hooks only, no config. The session state gains optional fields; a state without them behaves as 0.40.0.

## Risks and open questions

- An agent launch the hook never sees end (killed, crashed) silences the gate for up to 2 hours → the final Stop after it expires still gates; TaskStop handled if criterion 1 allows.
- Equal content with a different environment (dependencies installed since, env vars) gets credited → same as today: the gate never tracked ignored files such as `node_modules`.
- Hashing large changed files at Stop costs time → the cap and budget; past them there's no key.

## Follow-ups

- pi: hold the gate while a pi-subagents background run that may edit is active.
- Re-run the transcript friction study after 0.41.0 to measure the drop in send-backs.

## Plan

> Execute with the executing-plans skill. Only this section uses `- [ ]` checkboxes.

**Goal:** the verify gate stays silent while an agent that may edit is still working, and credits a tree whose content equals the content the checks last passed on.
**Architecture:** eng-kit tracks async agent launches in the session state (PostToolUse `Agent` adds, SubagentStop removes, Stop expires after 2 h) and skips the verify branch while one is live. Both editions get `contentKey` in the shared `lib/worktree.ts`; the key is stored when the state turns verified and compared at Stop / `agent_end` and before a review is called Inconclusive.
**Stack / constraints:** Node ≥ 22.18, TypeScript 5.9.3, no new dependencies; `lib/worktree.ts` byte-identical between editions (`cmp`). Files written in English. Commits without Claude trailers (public-release rule). Versions: both `package.json` and `src_claude/.claude-plugin/plugin.json` → 0.41.0, README/docs pins → `@v0.41.0`.
**Verification:** `node "<kit root>/scripts/verify.ts"` from the workspace root, i.e. `npm run typecheck --prefix src`, `npm test --prefix src`, `npm run typecheck --prefix src_claude`, `npm test --prefix src_claude`.

### Review focus
1. SubagentStop arrives before the async launch's PostToolUse (a very short agent): the entry must not be added afterwards and hold the gate for 2 h → `agentsEnded` (Task 2).
2. A listed file changes between its fingerprint and its hashing (a background writer): the key must not cover content nobody verified → identity re-check, no key (Task 4).
3. A stale fingerprint (`gitOff`, a fingerprint that failed this call) must never yield a key → only the fingerprint taken in the same hook call is used (Tasks 5, 6).
4. Workspace edge parts: a blind part, a submodule folder label, a symlinked file, files outside the repositories (Task 4).
5. The verification commands changed while the files stayed the same: the old key must not credit the new commands (Task 4).

### Post-implementation
- `README.md` (both editions), section "verify gate": the wait for background agents (eng-kit only) and the content credit, with their limits (2 h expiry, reviewer still sends back, fail-closed cases).
- `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.ru.md` (both editions), §3 Hooks: the new events (PostToolUse `Agent`/`SendMessage`/`TaskStop`), the session-state fields and why transcripts aren't read.
- `CHANGELOG.md` 0.41.0 (both editions); versions and pins as in Stack.
- Topic chapter: the README "verify gate" section is the chapter for this behavior; lasting rulings (decisions 1–6) go to the workspace record `docs/FRAMEWORK-SOURCES.ru.md` §11.56, outside both repos. This task file is then deleted.

### Files

| File | Responsibility |
|---|---|
| `src_claude/hooks/hooks.json` | PostToolUse matcher gains `Agent\|SendMessage\|TaskStop` |
| `src_claude/lib/state.ts` | `agents`, `agentsEnded`, `verifiedKey` fields, loaded defensively |
| `src_claude/lib/hooks.ts` | agent tracking, Stop wait, key stored on turning verified, content credit at Stop and reviewer SubagentStop |
| `src*/lib/worktree.ts` (shared) | `contentKey` |
| `src/extensions/verify.ts` | pi: key on turning verified, credit at `agent_end`, `creditByContent` for the guard |
| `src/extensions/lib/verify-state.ts` | pi: shares `creditByContent` with the guard |
| `src/extensions/guard.ts` | pi: credit by content before a review is called Inconclusive |
| tests: `src_claude/tests/hooks.test.ts`, `src*/tests/worktree.test.ts`, `src/tests/extensions.test.ts` | as each task says |

### Task 1: Live hook inputs (criterion 1)

No code. A scratch project in the session scratchpad with `.claude/settings.json` hooks (PostToolUse matcher `Agent|SendMessage|TaskStop`, SubagentStop) that append their stdin to a log file.

- [ ] `claude -p` there, asking it to launch a `general-purpose` agent in the background that runs `sleep 30`, then SendMessage to it, then stop it with TaskStop; a second run with a foreground agent
- [ ] Read the log → record in Progress: the tool name (`Agent`), `tool_response.status`, `tool_response.agentId`, `tool_input.subagent_type`, the SubagentStop `agent_id`, and what SendMessage (`to`?) and TaskStop (`task_id`?) inputs and responses carry, and whether a foreground call's response differs
- [ ] If a field named in criteria 2–3 is missing or named differently: stop and bring the findings to the user before Task 2

### Task 2: eng-kit records background agents (criteria 2, 3, 6)

**Files:** Modify `src_claude/hooks/hooks.json`, `src_claude/lib/state.ts`, `src_claude/lib/hooks.ts` · Test `src_claude/tests/hooks.test.ts`
**Interfaces:** Produces `SessionState.agents?: Record<string, number>` (agentId → launch ms), `SessionState.agentsEnded?: string[]` (newest last, at most 16), `HookInput.tool_response?: Record<string, unknown>`

- [ ] Write failing tests (with `setup()` and `call`): `an async agent launch is recorded` (PostToolUse `Agent`, `tool_input.subagent_type: "eng-kit:implementer"`, `tool_response: { status: "async_launched", agentId: "a1" }` → state `agents` has key `a1`); `a foreground agent or a reviewer launch records nothing` (status `completed`; and `subagent_type: "eng-kit:reviewer"` async → `agents` absent); `SubagentStop removes the agent` (`agent_id: "a1"` → `agents` empty, `agentsEnded` `["a1"]`); `an agent that ended before its launch was reported isn't recorded` (SubagentStop `a2`, then the launch of `a2` → no `a2`); state round-trip test: a malformed `agents` value (`{a: "x"}`) loads as `undefined`
- [ ] Run `npm test --prefix src_claude -- --test-name-pattern="agent"` → expect FAIL on the `agents` assertions (received `undefined`)
- [ ] Implement: `loadState` reads both fields (numbers only / strings only); in `postToolUse`, before the shell branch, `if (tool === "Agent") return trackAgent(input, env)`; `trackAgent` adds when `tool_response.status === "async_launched"`, `typeof agentId === "string"`, `!REVIEWER.test(subagent_type)` and the id isn't in `agentsEnded`; `subagentStop` first calls `endAgent(input, env)` (deletes `agent_id`, appends it to `agentsEnded`, keeps the last 16), then the reviewer logic as now; hooks.json PostToolUse matcher `Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Agent|SendMessage|TaskStop`
- [ ] Per Task 1: if SendMessage carries the agent id, test `resuming a known agent records it again` (id in `agentsEnded` → back in `agents` with a new time, out of `agentsEnded`) and if TaskStop carries it, `TaskStop removes the agent`; implement both in `trackAgent`. Otherwise add the Follow-ups line `SendMessage resume / TaskStop don't name the agent in hook input` and no code
- [ ] Run `npm test --prefix src_claude` → PASS
- [ ] Commit `feat(verify-gate): record background agents that may edit`

### Task 3: eng-kit Stop waits for them (criteria 4, 5)

**Files:** Modify `src_claude/lib/hooks.ts` · Test `src_claude/tests/hooks.test.ts`
**Interfaces:** Consumes `agents` from Task 2 · Produces `const AGENT_MAX_AGE_MS = 2 * 60 * 60 * 1000`

- [ ] Write failing tests (with `setupGit()`): `Stop waits while a background agent may edit` (edit a file, launch `a1` async, Stop → output `undefined`, state `judged` unchanged; SubagentStop `a1`, Stop → `decision: "block"` naming the file); `an agent older than two hours no longer holds the gate` (state `agents: { a1: Date.now() - AGENT_MAX_AGE_MS - 1 }` → Stop blocks, `agents` empty after); `the other gates don't wait` (an approved task file uncommitted while `a1` runs → the approval reason is still there, without the verify reason)
- [ ] Run `npm test --prefix src_claude -- --test-name-pattern="background agent|two hours|don't wait"` → expect FAIL: `decision: "block"` where `undefined` was expected
- [ ] Implement in `stopGates`, after the settled state: drop entries older than `AGENT_MAX_AGE_MS` (save when any dropped); `waiting = Object.keys(agents).length > 0`; both verify branches require `!running && !waiting`
- [ ] Run `npm test --prefix src_claude` → PASS
- [ ] Commit `feat(verify-gate): wait for background agents that may edit`

### Task 4: `contentKey` (criteria 7 unit, 12; both editions)

**Files:** Modify `src_claude/lib/worktree.ts`, copy to `src/extensions/lib/worktree.ts` · Test `src_claude/tests/worktree.test.ts`, `src/tests/worktree.test.ts` (same cases)
**Interfaces:** Produces `contentKey(projectDir: string, tree: Tree, commands: string[], limits?: { deadline?: number; maxBytes?: number }): string | undefined`, `KEY_BUDGET_MS = 2000`, `KEY_MAX_BYTES = 64 * 1024 * 1024`

- [ ] Write failing tests (with `repo()` and `fingerprint()`; a stub `contentKey` returning `undefined`): `equal content gives an equal key` (edit `src/a.ts`, key; rewrite the same bytes with a later mtime, fresh fingerprint → same key); `any difference changes the key` (one byte; an extra untracked file; a commit with another tree; another `commands` list); `a squash of the same tree keeps the key` (branch with a commit, key; `checkout main`, `merge --squash`, commit → equal key); `no key it can't prove` (a blind workspace part, a folder label, `maxBytes: 1`, a past `deadline`, a listed file whose size/mtime no longer match the fingerprint); `the key writes nothing into .git` (`git count-objects -v` output equal before and after)
- [ ] Run `npm test --prefix src_claude -- tests/worktree.test.ts` → expect FAIL: `undefined` vs a string key
- [ ] Implement: undefined when `tree.blind?.length`; per repository (`""` for a plain repo, else each key of `tree.heads`) `git rev-parse --verify -q <head>^{tree}` in its folder (`""` head → `""`), within `timeLeft(deadline)`; each listed path in sorted order: `lstat` missing → `deleted`, a folder → undefined, a symlink → sha1 of `link\0` + its text, a file → its `identity` must equal `tree.files[path]` (else undefined), counted against `maxBytes`, hashed as `sha1("blob <len>\0" + content)`; a deadline check per file; any throw → undefined. Result: sha256 over `commands\0<JSON of commands>`, then `repo\0<treeHash>` and `path\0<hash>` lines
- [ ] Run both editions' `worktree.test.ts` → PASS; `cmp src/extensions/lib/worktree.ts src_claude/lib/worktree.ts` → no output
- [ ] Commit in each repository `feat(worktree): content key of a verified tree`

### Task 5: eng-kit stores and credits the key (criteria 7 hook, 8–11)

**Files:** Modify `src_claude/lib/state.ts`, `src_claude/lib/hooks.ts` · Test `src_claude/tests/hooks.test.ts`
**Interfaces:** Consumes `contentKey` (Task 4) · Produces `SessionState.verifiedKey?: string`; `trackTree` also returns `fresh: Tree | undefined` (the fingerprint taken in this call); `creditByContent(env, sessionId, state, fresh, deadline): SessionState`

- [ ] Write failing tests (with `setupGit()` and the run-record helpers): `a green run stores the content key` (edit, a passing `npm test` and `npm run typecheck` → `verifiedKey` is a string); `restored content is credited at Stop` (edit, verify, change a file, restore its bytes, Stop → output `undefined`, `unverified: false`, `edited: []`); `a squash merge of the verified tree is credited` (verify on a branch with its commit, `checkout main && merge --squash && commit` as Bash calls → Stop silent); `different content still sends back` (one byte; an extra untracked file → `decision: "block"`); `the reviewer's verdict counts on credited content` (restored content, reviewer SubagentStop with a Yes report → the recorded verdict is `Yes`, not `Inconclusive`); `no key from a stale fingerprint` (state `gitOff: true` → no `verifiedKey`)
- [ ] Run `npm test --prefix src_claude -- --test-name-pattern="content|squash|stale"` → expect FAIL: `verifiedKey` `undefined`, then `decision: "block"` where `undefined` was expected
- [ ] Implement: `loadState` reads `verifiedKey`; a helper `withKey(env, before, after, fresh)` sets `verifiedKey = contentKey(projectDir, fresh, commands)` (or deletes it) when `before.unverified && !after.unverified`, and only with a `fresh` tree and `!after.gitOff`; used where `credited` turns the state verified in `creditCall` and `settleLaunch` (thread `fresh` from `trackTree`). `creditByContent`: when `unverified && verifiedKey && fresh && !gitOff` and `contentKey(...)` equals → `credited(state, commands, commands)` saved. Stop calls it after `settleLaunch`, deadline `Math.min(Date.now() + KEY_BUDGET_MS, started + 3500)`; `reviewerStop`, when the loaded state is unverified with a key, runs `trackTree` and then it, deadline `Math.min(Date.now() + KEY_BUDGET_MS, deadline - 3000)`, before deciding Inconclusive
- [ ] Run `npm test --prefix src_claude` → PASS
- [ ] Commit `feat(verify-gate): credit content the checks already passed on`

### Task 6: pi content key (criterion 13)

**Files:** Modify `src/extensions/verify.ts`, `src/extensions/lib/verify-state.ts`, `src/extensions/guard.ts` · Test `src/tests/extensions.test.ts`
**Interfaces:** Consumes `contentKey` · Produces `verifyState.creditByContent?: (ctx: ExtensionContext) => void`

- [ ] Write failing tests mirroring Task 5 with the existing extension harness: `a green run stores the content key and restored content is credited at agent_end` (no follow-up message); `a squash merge of the verified tree is credited`; `different content still follows up`; `a reviewer run on credited content records its verdict` (subagent tool_result with a reviewer Yes → verdict `Yes`); `no key once git is off`
- [ ] Run `npm test --prefix src -- tests/extensions.test.ts` → expect FAIL: a follow-up where none was expected
- [ ] Implement: a closure `verifiedKey`; `markGreen` sets it when it turns the state verified, from the `tree` the same handler just took and only while `!gitOff`; `creditByContent(ctx)` takes its own fresh `treeFingerprint` (without replacing `tree`) and, when unverified with a key and the keys match, marks every command green; installed on `verifyState` at load, called in `agent_end` after `track(ctx)` and by the guard before its Inconclusive check
- [ ] Run `npm test --prefix src` → PASS
- [ ] Commit `feat(verify-gate): credit content the checks already passed on`

### Task 7: Docs and release prep (criterion 14)

**Files:** Modify both editions' `README.md`, `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE.ru.md`, `CHANGELOG.md`, `package.json`; `src_claude/.claude-plugin/plugin.json`

- [ ] Write the Post-implementation items; CHANGELOG 0.41.0 leads with the two rules and lists the limits (2 h, reviewer still sends back, fail-closed cases, pi without background agents)
- [ ] Run the full verification → all four PASS (the release test checks the pins)
- [ ] Commit `docs: verify gate waits and content credit (0.41.0)`

## Progress

None yet
