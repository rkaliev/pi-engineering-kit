/**
 * The PR watcher: which event a pull request's snapshot calls for, and the loop that waits for one.
 * It imports only Node built-ins and the PR feedback collector.
 */

import { createHash } from "node:crypto";
import type { Item, PrState } from "./pr-feedback.ts";

export type EventName = "merged" | "closed" | "conflict" | "checks_failed" | "feedback" | "ready" | "blocked";

export interface WatchEvent {
	schemaVersion: 1;
	event: EventName;
	eventId: string;
	ack: string;
	reason: string;
	pr: number | null;
	url: string | null;
	head: string | null;
	checks: { state: string | null; failed: string[]; pending: number; total: number };
	open: Item[];
	problems: string[];
}

/** At most this many acknowledged ids travel in an event's `ack`. */
const ACK_MAX = 20;
const TERMINAL = new Set<EventName>(["merged", "closed", "ready", "blocked"]);

/**
 * The event's id: what it is about, so the same evidence gives the same id. `checks_failed` and `conflict` are about
 * the head, `feedback` about the set of open items, the terminal events about the PR.
 */
export function eventId(event: EventName, state: PrState): string {
	const about = event === "checks_failed" || event === "conflict" ? state.head : event === "feedback" ? state.open.map((i) => i.id).sort().join("\n") : state.url;
	return createHash("sha256").update(`${event}\n${about ?? ""}`).digest("hex").slice(0, 12);
}

function event(name: EventName, state: PrState, acked: string[], reason: string): WatchEvent {
	const id = eventId(name, state);
	const ack = [...new Set([...acked, id])].slice(-ACK_MAX).join(",");
	return { schemaVersion: 1, event: name, eventId: id, ack, reason, pr: state.pr, url: state.url, head: state.head, checks: state.checks, open: state.open, problems: state.problems };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The event a successful snapshot (`state.error` null) calls for, or null to keep waiting. Candidates in order:
 * merged or closed, conflict, failed checks, open feedback; the first whose id isn't in `ctx.acked` wins (a terminal
 * one always does). Without one: `ready` when the head's checks are all finished and passed, nothing is open or
 * unread, mergeability is known and clean, and the head was seen for `quietMs` (checks register only after a push);
 * `blocked` when acked feedback is still open after the checks passed (feedback-unanswered), when the head has no
 * checks at all after the quiet period (no-checks), or when the feedback wasn't all read (partial).
 */
export function decide(state: PrState, ctx: { acked: string[]; headSeenAt: number; now: number; quietMs: number }): WatchEvent | null {
	const { acked } = ctx;
	const checks = state.checks;
	const candidates: Array<[EventName, string]> = [];
	if (state.state === "MERGED") candidates.push(["merged", "the PR was merged"]);
	else if (state.state === "CLOSED") candidates.push(["closed", "the PR was closed without merging"]);
	if (state.mergeable === "CONFLICTING") candidates.push(["conflict", "the PR conflicts with its base branch"]);
	if (checks.failed.length > 0) candidates.push(["checks_failed", `failed: ${checks.failed.join(", ")}; ${checks.pending} still running`]);
	if (state.open.length > 0) candidates.push(["feedback", `${plural(state.open.length, "open review item")}`]);
	for (const [name, reason] of candidates) {
		if (TERMINAL.has(name) || !acked.includes(eventId(name, state))) return event(name, state, acked, reason);
	}

	const settledGreen = checks.total > 0 && checks.pending === 0 && checks.failed.length === 0;
	if (settledGreen && state.open.length > 0) return event("blocked", state, acked, "feedback-unanswered");
	const quiet = ctx.now - ctx.headSeenAt >= ctx.quietMs;
	if (!quiet || candidates.length > 0) return null;
	if (checks.total === 0) return event("blocked", state, acked, "no-checks");
	if (!settledGreen || state.mergeable === "UNKNOWN") return null;
	if (state.problems.length > 0) return event("blocked", state, acked, `partial: ${state.problems.join("; ")}`);
	return event("ready", state, acked, `${plural(checks.total, "check")} passed on ${state.head?.slice(0, 7) ?? "the head"}, no open review items`);
}
