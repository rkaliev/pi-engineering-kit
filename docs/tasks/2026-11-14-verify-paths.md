# Verify gate asks only for the checks that cover the changed files

Status: design approved (2026-11-14)
<!-- draft → design approved (YYYY-MM-DD) → plan approved (YYYY-MM-DD) → in progress. Lives only on its work branch at docs/tasks/YYYY-MM-DD-<slug>.md: when the work is finished, what lasts moves to docs/ and this file is deleted. -->
Base: 1ebbd1d
Links: None

<details><summary>Original request</summary>

The user pasted five verify-gate send-backs from two of their projects, most of them for Markdown edits, for example:

> Stop hook error: Verify gate: files changed since the last passing verification. Changed since the last green run: docs/backlog.md. Run `node "<kit>/scripts/verify.ts"` (its output is already short) or: `pnpm format:check`, `pnpm test:scripts`, `pnpm turbo run typecheck lint test`, `pnpm test:alone`, `pnpm bdd`, and read the output.

Asked what to do (the firings are correct for those projects' verify.json, but a one-file doc edit runs all five checks), the user chose «Пути у команд», then «Отдельная карта» for the config format, and approved design sections 1–3 («да»).

</details>

## Intent

A project whose checks cover different files can say so in verify.json, so the verify gate asks for, and the verify script runs, only the checks that cover what changed: a doc edit in a monorepo whose prettier checks Markdown costs `pnpm format:check`, not five suites with a 900 s timeout.

## Context

Every counted edit resets `green` to empty (`lib/hooks.ts` `markEdited`, Edit/Write branch of `postToolUse`), so all commands are owed again; a verify-script run clears the gate only when it ran exactly the configured list (`sameCommands`). `ignore` is all-or-nothing: a project can't ignore docs when prettier checks them, or when its own check validates Markdown. Transcripts show the gate fires once per set of edits since 0.38.3; the remaining cost is the size of each run.

## Success criteria

| # | Criterion (observable, testable) | How it is verified |
|---|---|---|
| 1 | With `paths` mapping the other commands to code folders, an edit of only `docs/x.md` makes the Stop reason name only the uncovered command(s), as `node "<kit>/scripts/verify.ts" --only "<cmd>"` plus the plain command | hooks unit test |
| 2 | A verify-script run with `--only` that passed every owed command clears the gate; one that missed an owed command does not | hooks unit tests (record with subset ⊇ owed; record missing one) |
| 3 | Owed commands accumulate: `.md` edit then `.ts` edit owes the union; a passed run of a subset removes only what it ran | hooks unit test |
| 4 | An edit that no command covers leaves the workspace verified (no send-back, `edited`/`editedAt` unchanged) | hooks unit test |
| 5 | An edit of `.claude/verify.json`, or of an unknown file, owes every command | hooks unit tests |
| 6 | Without `paths`, behavior is unchanged: every counted edit owes every command; bare verify script runs all | existing hooks/verify tests stay green unchanged |
| 7 | `verify.ts --only <cmd>` (repeatable) runs those commands in config order and records only them; an unknown command exits 2, runs nothing, writes no result record | verify script unit tests |
| 8 | Invalid `paths` entries (not a non-empty string array) make that command cover everything; unknown keys are ignored; both are reported once per session in a Stop `systemMessage` and as a line in the verify report | commands + hooks unit tests |
| 9 | The gate credits `node "<kit>/scripts/verify.ts" --only "<cmd>"` like the bare call (piped into tail is fine); `cd`, `&`, a project-dir argument still don't count | `runsVerifyScript` unit tests |
| 10 | pi: `run_verification` takes optional `only: string[]` with the same rules, and the follow-up names only owed commands | pi extension tests |
| 11 | A real Claude Code session on a temp project with `paths`: a doc edit is sent back with `--only`, the agent's run clears the gate | manual live check `claude -p` — needs a real model session, agreed 2026-11-14 |

## Scope

**In scope:**
- `paths` in `.claude/verify.json` / `.pi/verify.json`, owed-command tracking, `--only` in the verify script, `only` in pi `run_verification`, gate wording, docs (README verify.json section, ARCHITECTURE(.ru), CHANGELOG), version 0.39.0 in both editions.

**Out of scope:**
- `paths` for commands from CLAUDE.md/AGENTS.md or detected ones; kit-init generating `paths`; changing `ignore`; editing any project's verify.json.

## Decisions

1. Config is a separate map `"paths": {"<command text>": ["<glob>", …]}` (user, «Отдельная карта»): a kit that doesn't know the field owes every command, the fail-safe direction.
2. A command without an entry covers every path; `ignore` still applies first.
3. The gate names the subset to run (`--only`); the script doesn't infer it from git, because commits inside the session would hide edits the gate still owes and cause re-fires.
4. A bare verify run (user `/verify`, before a PR) still runs every command.
5. Invalid entries fail closed (command covers everything); `--only` with an unknown command runs nothing.
6. Globs match the project-relative path with the existing `isIgnored` glob syntax; in a workspace, a repository's own verify.json `paths` are not read (**assumed**: only the session folder's verify.json, like `commands`).

## Design

**`lib/commands.ts`** (both editions): `VerifyConfig.paths?: Record<string, unknown>`; `resolveVerifyPaths(cwd, commands)` returns `{ scopes: Map<string, string[]>, problems: string[] }` for commands from verify.json only; `owedCommands(changed: string[], commands, scopes)` returns, in config order, the commands some changed path matches, every command for an unknown path or `.claude/verify.json` (`.pi/verify.json`).

**State** (Claude `lib/hooks.ts`, pi `extensions/verify.ts`): `markEdited` and the Edit/Write branch compute owed commands for the paths; base green is `state.green` when unverified, else all commands; `green = base − owed`; nothing owed → state untouched. `unverified = commands.some(c => !green.has(c))` as today.

**Crediting:** a passed fresh run record (`postToolUse` verify branch, `settleLaunch`) adds `run.commands` to `green` and recomputes `unverified`, replacing `sameCommands(run.commands, commands)`; the start/`editedAt` freshness rules stay. The unpiped-exit-code fallback (no record) credits only for a bare run, since it can't tell which commands ran.

**Stop reason:** owed = commands not in `green`. If owed is all commands, the text is as today; else `Run \`node "<kit>/scripts/verify.ts" --only "<c1>" --only "<c2>"\` … or: \`<c1>\`, \`<c2>\``. Path problems → one `systemMessage` per session (`pathsNoted` flag).

**`scripts/verify.ts` / `lib/verify-run.ts`:** parse `--only <command>` pairs before the optional project-dir; `runVerification(cwd, run, only?)` filters the resolved list, keeps config order, errors (exit 2, no record) on a command not in the list; report adds path problems as a `Note:` line.

**`runsVerifyScript` / `isKitScript`:** after the script path, accept only `--only <word>` pairs.

**pi:** `run_verification` gets `only: Type.Optional(Type.Array(Type.String()))`; the follow-up names owed commands and `run_verification` with `only`.

## Rollout

Minor release 0.39.0 in both editions; additive config field, no migration. Rollback: drop `paths` from a project's verify.json.

## Risks and open questions

- An agent reruns the full script anyway → still credited (superset); only cost is lost, not correctness.
- A too-narrow `paths` lets a change skip a check → the project owns its map; README warns and CI still runs everything.
- Session state from 0.38.x (`green` = all or empty) stays valid under the new rules.

## Follow-ups

- kit-init could propose `paths` from the manifest layout (turbo workspaces, prettier globs).
- Per-repository `paths` in a workspace.

## Plan

None yet

## Progress

None yet
