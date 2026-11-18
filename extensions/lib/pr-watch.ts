/**
 * The PR watcher: which event a pull request's snapshot calls for, and the loop that waits for one.
 * It imports only Node built-ins and the PR feedback collector.
 */

import { createHash } from "node:crypto";
import { collectPrState, type FeedbackConfig, type Item, type PrState } from "./pr-feedback.ts";

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

/** Errors no retry can fix: the watch ends with them at once. */
const FATAL = new Set(["gh not found", "gh is not authenticated", "not a GitHub repository"]);
/** Waits after the 1st and 2nd transient error in a row; the 3rd ends the watch. */
const BACKOFF_MS = [30_000, 60_000, 120_000];
const TRANSIENT_MAX = 3;
/** Each read of the PR must finish within this. */
const READ_DEADLINE_MS = 30_000;

/** A `blocked` event about the last PR seen (or none yet). */
function blocked(last: PrState | null, acked: string[], reason: string): WatchEvent {
	const base: PrState = last ?? { pr: null, url: null, head: null, login: null, open: [], closed: 0, checks: { state: null, failed: [], pending: 0, total: 0 }, state: null, mergeable: null, problems: [], error: null, github: true };
	return event("blocked", base, acked, reason);
}

/**
 * Polls the PR until `decide` returns an event, and returns it. Without `number` the PR of `branch` (default: the
 * folder's current branch) is looked up once, and any error there ends the watch; after that the PR is read by
 * number every `intervalMs`. gh missing, unauthenticated or not on GitHub ends the watch at once; other errors are
 * retried after 30 s and 60 s, and the 3rd in a row ends it (`transient: …`); `timeoutMs` ends it with `timeout`.
 * Only reads. `now` and `sleep` are for tests.
 */
export async function watch(opts: {
	dir: string;
	branch?: string;
	number?: number;
	acked?: string[];
	timeoutMs: number;
	intervalMs: number;
	quietMs: number;
	gh?: string;
	config?: FeedbackConfig;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<WatchEvent> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	const acked = opts.acked ?? [];
	const started = now();
	const read = (number?: number) => collectPrState({ dir: opts.dir, branch: opts.branch, number, deadlineMs: READ_DEADLINE_MS, gh: opts.gh, config: opts.config });

	let state = read(opts.number);
	if (state.error) return blocked(null, acked, state.error);
	const number = state.pr ?? opts.number;
	let last: PrState = state;
	let head: string | null = null;
	let headSeenAt = started;
	let errors = 0;
	for (;;) {
		let wait = opts.intervalMs;
		if (state.error) {
			if (FATAL.has(state.error)) return blocked(last, acked, state.error);
			errors++;
			if (errors >= TRANSIENT_MAX) return blocked(last, acked, `transient: ${state.error}`);
			wait = BACKOFF_MS[errors - 1]!;
		} else {
			errors = 0;
			last = state;
			if (state.head !== head) {
				head = state.head;
				headSeenAt = now();
			}
			const found = decide(state, { acked, headSeenAt, now: now(), quietMs: opts.quietMs });
			if (found) return found;
		}
		const left = opts.timeoutMs - (now() - started);
		if (left <= 0) return blocked(last, acked, "timeout");
		await sleep(Math.min(wait, left));
		if (now() - started >= opts.timeoutMs) return blocked(last, acked, "timeout");
		state = read(number);
	}
}
