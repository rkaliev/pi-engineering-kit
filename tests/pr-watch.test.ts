import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item, PrState } from "../extensions/lib/pr-feedback.ts";
import { decide, eventId } from "../extensions/lib/pr-watch.ts";

const QUIET = 120_000;
const item = (id: string): Item => ({ id, kind: "thread", author: "bob", url: `https://x/${id}`, excerpt: "rename this" });

/** An open PR on head `abc123` with green checks and nothing open, changed by `parts`. */
function snap(parts: Partial<PrState> = {}): PrState {
	return {
		pr: 48,
		url: "https://github.com/o/r/pull/48",
		head: "abc123",
		login: "me",
		open: [],
		closed: 0,
		checks: { state: "SUCCESS", failed: [], pending: 0, total: 3 },
		state: "OPEN",
		mergeable: "MERGEABLE",
		problems: [],
		error: null,
		github: true,
		...parts,
	};
}
const failing = { state: "FAILURE", failed: ["test"], pending: 2, total: 4 };
const pendingChecks = { state: "PENDING", failed: [], pending: 2, total: 3 };
/** `decide` at `seen` ms after the head was first seen. */
const at = (s: PrState, seen: number, acked: string[] = []) => decide(s, { acked, headSeenAt: 0, now: seen, quietMs: QUIET });
const what = (s: PrState, seen = QUIET, acked: string[] = []) => {
	const e = at(s, seen, acked);
	return e && [e.event, e.event === "blocked" ? e.reason : ""];
};

test("decide: one event by precedence merged/closed > conflict > checks_failed > feedback", () => {
	assert.deepEqual(what(snap({ state: "MERGED", checks: failing, open: [item("T1")] })), ["merged", ""]);
	assert.deepEqual(what(snap({ state: "CLOSED", mergeable: "CONFLICTING" })), ["closed", ""]);
	assert.deepEqual(what(snap({ mergeable: "CONFLICTING", checks: failing })), ["conflict", ""]);
	assert.deepEqual(what(snap({ checks: failing, open: [item("T1")] })), ["checks_failed", ""]);
	assert.deepEqual(what(snap({ open: [item("T1")] })), ["feedback", ""]);
});

test("decide: unknown mergeability with pending checks waits", () => {
	assert.equal(at(snap({ mergeable: "UNKNOWN", checks: pendingChecks }), QUIET), null);
});

test("decide: an acked event waits on the same evidence and comes back on new evidence", () => {
	const failed = snap({ checks: failing });
	const id = eventId("checks_failed", failed);
	assert.equal(at(failed, QUIET, [id]), null);
	const moved = at(snap({ checks: failing, head: "def456" }), QUIET, [id]);
	assert.equal(moved?.event, "checks_failed");
	assert.notEqual(moved?.eventId, id);
	const both = snap({ checks: failing, open: [item("T1")] });
	assert.equal(at(both, QUIET, [id, eventId("feedback", both)]), null, "several acks on one head (review focus 1)");
	assert.equal(at(both, QUIET, [id])?.event, "feedback");
	const more = at(snap({ checks: failing, open: [item("T1"), item("T2")] }), QUIET, [id, eventId("feedback", both)]);
	assert.equal(more?.event, "feedback", "a new open item is new evidence");
});

test("decide: checks_failed comes at the first failure and lists the failed and pending checks", () => {
	const e = at(snap({ checks: failing }), 1000);
	assert.equal(e?.event, "checks_failed");
	assert.deepEqual(e?.checks, failing);
	assert.equal(e?.head, "abc123");
});

test("decide: ready needs non-empty green checks, nothing open, nothing unread and the quiet period", () => {
	assert.equal(at(snap(), QUIET - 1000), null);
	assert.equal(what(snap())?.[0], "ready");
	assert.equal(at(snap({ checks: pendingChecks }), QUIET * 10), null);
	assert.deepEqual(what(snap({ checks: { state: null, failed: [], pending: 0, total: 0 } })), ["blocked", "no-checks"]);
	assert.equal(at(snap({ checks: { state: null, failed: [], pending: 0, total: 0 } }), QUIET - 1000), null);
	assert.deepEqual(what(snap({ problems: ["reviewThreads: 100 of 140 read"] })), ["blocked", "partial: reviewThreads: 100 of 140 read"]);
});

test("decide: an acked conflict still open is never ready, and neither is unknown mergeability", () => {
	const conflicted = snap({ mergeable: "CONFLICTING" });
	assert.equal(at(conflicted, QUIET, [eventId("conflict", conflicted)]), null);
	assert.equal(at(snap({ mergeable: "UNKNOWN" }), QUIET), null);
});

test("decide: acked feedback still open once checks passed is feedback-unanswered", () => {
	const open = snap({ open: [item("T1")] });
	const e = at(open, QUIET, [eventId("feedback", open)]);
	assert.deepEqual([e?.event, e?.reason, e?.open.map((i) => i.id)], ["blocked", "feedback-unanswered", ["T1"]]);
	assert.equal(at(snap({ open: [item("T1")], checks: pendingChecks }), QUIET, [eventId("feedback", open)]), null);
});

test("decide: an event's ack joins the earlier acks and its own id, at most 20", () => {
	const e = at(snap({ open: [item("T1")] }), QUIET, ["a", "b", "a"]);
	assert.equal(e?.ack, `a,b,${e?.eventId}`);
	const many = Array.from({ length: 25 }, (_, i) => `id${i}`);
	const last = at(snap({ open: [item("T1")] }), QUIET, many);
	assert.deepEqual(last?.ack.split(","), [...many.slice(6), last?.eventId]);
	assert.match(last?.eventId ?? "", /^[0-9a-f]{12}$/);
});
