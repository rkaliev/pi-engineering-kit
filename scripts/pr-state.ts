#!/usr/bin/env node
/**
 * Prints the review feedback facts of the open GitHub PR for a branch as JSON (lib/pr-feedback.ts `PrState`).
 * Usage: node pr-state.ts [--repo <dir>] [--branch <name>] [--no-config]
 * Exit: 0 no open items, 1 open items, 2 the facts couldn't be collected (the reason is in `error`).
 * `prFeedback.ignore` is read from the repository's `.claude/guard.json`, else `.pi/guard.json`; `--no-config` skips
 * it (a gate that doesn't apply the project's rules passes it, so both list the same items).
 */
import { resolve } from "node:path";
import { collectPrState, projectFeedbackConfig } from "../extensions/lib/pr-feedback.ts";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i === -1 ? undefined : process.argv[i + 1];
}

const dir = resolve(arg("--repo") ?? process.cwd());
const state = collectPrState({ dir, branch: arg("--branch"), deadlineMs: 30_000, config: process.argv.includes("--no-config") ? {} : projectFeedbackConfig(dir) });
console.log(JSON.stringify(state, null, 2));
process.exit(state.error ? 2 : state.open.length > 0 ? 1 : 0);
