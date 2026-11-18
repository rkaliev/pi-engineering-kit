#!/usr/bin/env node
/**
 * Waits on the GitHub PR of a branch and prints one JSON event (lib/pr-watch.ts `WatchEvent`) when it needs action:
 * merged, closed, conflict, checks_failed, feedback, ready or blocked. Only reads; run it in the background.
 * Usage: node pr-watch.ts [--repo <dir>] [--branch <name>] [--pr <number>] [--ack <token>] [--timeout <s>]
 *        [--interval <s>] [--quiet <s>] [--no-config]
 * `--ack` takes the `ack` of the event just handled, so the same evidence doesn't return. Defaults: timeout 3600,
 * interval 30, quiet 120 (a head's checks count as settled only after this). Always exits 0.
 */
import { resolve } from "node:path";
import { projectFeedbackConfig } from "../extensions/lib/pr-feedback.ts";
import { watch, type WatchEvent } from "../extensions/lib/pr-watch.ts";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i === -1 ? undefined : process.argv[i + 1];
}
function seconds(name: string, fallback: number): number {
	const value = Number(arg(name));
	return (Number.isFinite(value) && value > 0 ? value : fallback) * 1000;
}

const dir = resolve(arg("--repo") ?? process.cwd());
const pr = Number(arg("--pr"));
let event: WatchEvent;
try {
	event = await watch({
		dir,
		branch: arg("--branch"),
		number: Number.isInteger(pr) && pr > 0 ? pr : undefined,
		acked: (arg("--ack") ?? "").split(",").filter(Boolean),
		timeoutMs: seconds("--timeout", 3600),
		intervalMs: seconds("--interval", 30),
		quietMs: seconds("--quiet", 120),
		config: process.argv.includes("--no-config") ? {} : projectFeedbackConfig(dir),
	});
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	event = { schemaVersion: 1, event: "blocked", eventId: "", ack: arg("--ack") ?? "", reason: `watcher error: ${message}`, pr: null, url: null, head: null, checks: { state: null, failed: [], pending: 0, total: 0 }, open: [], problems: [] };
}
console.log(JSON.stringify(event, null, 2));
