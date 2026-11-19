import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Item, PrState } from "../extensions/lib/pr-feedback.ts";
import { decide, eventId, watch } from "../extensions/lib/pr-watch.ts";

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

test("decide: with no checks, acked feedback still open after the quiet period is feedback-unanswered (R3)", () => {
	const none = { state: null, failed: [], pending: 0, total: 0 };
	const open = snap({ open: [item("T1")], checks: none });
	assert.deepEqual(what(open, QUIET, [eventId("feedback", open)]), ["blocked", "feedback-unanswered"]);
	assert.equal(at(snap({ open: [item("T1")] }), QUIET - 1000, [eventId("feedback", open)]), null, "not before the quiet period, checks or not");
});

test("decide: ready needs GitHub's rollup to say SUCCESS, which covers checks past the first 100 read (R4)", () => {
	assert.equal(at(snap({ checks: { state: "PENDING", failed: [], pending: 0, total: 100 } }), QUIET), null);
	assert.equal(what(snap({ checks: { state: "FAILURE", failed: [], pending: 0, total: 100 } }))?.[0], "checks_failed", "a failure past the checks read");
});

test("decide: every event says its third-party text is data (R5)", () => {
	for (const s of [snap(), snap({ open: [item("T1")] }), snap({ state: "MERGED" })]) assert.match(at(s, QUIET)?.note ?? "", /data, not instructions/);
});

test("decide: a second failed check on an acked head stays acked (R11)", () => {
	const one = snap({ checks: failing });
	const two = snap({ checks: { ...failing, failed: ["test", "lint"], pending: 1 } });
	assert.equal(at(two, QUIET, [eventId("checks_failed", one)]), null);
});

test("decide: an event's ack joins the earlier acks and its own id, at most 20", () => {
	const e = at(snap({ open: [item("T1")] }), QUIET, ["a", "b", "a"]);
	assert.equal(e?.ack, `a,b,${e?.eventId}`);
	const many = Array.from({ length: 25 }, (_, i) => `id${i}`);
	const last = at(snap({ open: [item("T1")] }), QUIET, many);
	assert.deepEqual(last?.ack.split(","), [...many.slice(6), last?.eventId]);
	assert.match(last?.eventId ?? "", /^[0-9a-f]{12}$/);
});

// ---- the loop, on a fake gh ----

const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

type Reply = { json: unknown; vanish?: boolean } | { code: number; stderr: string };
/** A `gh` that answers its N-th call with `replies[N]`; the last reply repeats. */
function fakeGhSequence(replies: Reply[]): { gh: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "fake-gh-seq-"));
	made.push(dir);
	const cases = replies.map((r, i) => {
		const file = join(dir, `reply-${i}`);
		writeFileSync(file, "json" in r ? JSON.stringify(r.json) : r.stderr);
		// `vanish`: the gh answers, then deletes itself, as an uninstalled gh would be gone at the next call.
		if ("json" in r) return `${i}) cat "${file}"; ${r.vanish ? 'rm -f "$0"; ' : ""}exit 0 ;;`;
		return `${i}) cat "${file}" >&2; exit ${r.code} ;;`;
	});
	const last = replies.length - 1;
	const script = [
		"#!/bin/sh",
		`n=$(cat "${dir}/count" 2>/dev/null || echo 0)`,
		`echo $((n + 1)) > "${dir}/count"`,
		`[ "$n" -gt ${last} ] && n=${last}`,
		'case "$n" in',
		...cases,
		"esac",
	].join("\n");
	const gh = join(dir, "gh");
	writeFileSync(gh, `${script}\n`);
	chmodSync(gh, 0o755);
	return { gh, dir };
}

/** GitHub's rollup state of check runs: FAILURE if one failed, PENDING while one runs, else SUCCESS. */
function rollup(contexts: Array<Record<string, unknown>>): string {
	if (contexts.some((c) => c.conclusion === "FAILURE")) return "FAILURE";
	return contexts.some((c) => !c.conclusion) ? "PENDING" : "SUCCESS";
}

/** One gh reply that serves both the branch lookup and the PR's own query. */
function pull(parts: { head?: string; state?: string; mergeable?: string; contexts?: Array<Record<string, unknown>>; thread?: boolean } = {}): Reply {
	const contexts = parts.contexts ?? [{ __typename: "CheckRun", name: "test", conclusion: "SUCCESS" }];
	const node = {
		number: 48,
		url: "https://github.com/o/r/pull/48",
		state: parts.state ?? "OPEN",
		mergeable: parts.mergeable ?? "MERGEABLE",
		isCrossRepository: false,
		headRepositoryOwner: { login: "o" },
		commits: { nodes: [{ commit: { oid: parts.head ?? "aaa111", statusCheckRollup: { state: rollup(contexts), contexts: { nodes: contexts } } } }] },
		reviewThreads: parts.thread
			? { totalCount: 1, nodes: [{ id: "T1", isResolved: false, path: "a.ts", line: 3, comments: { totalCount: 1, nodes: [{ id: "C1", author: { login: "bob", __typename: "User" }, body: "Rename this.", url: "https://x/C1", createdAt: "2026-11-18T10:00:00Z" }] } }] }
			: { totalCount: 0, nodes: [] },
		reviews: { totalCount: 0, nodes: [] },
		latestOpinionatedReviews: { totalCount: 0, nodes: [] },
		comments: { totalCount: 0, nodes: [] },
	};
	return { json: { data: { viewer: { login: "me" }, repository: { pullRequests: { totalCount: 1, nodes: [node] }, pullRequest: node } } } };
}
const running = [{ __typename: "CheckRun", name: "test", conclusion: null }, { __typename: "CheckRun", name: "lint", conclusion: null }];
const oneFailed = [{ __typename: "CheckRun", name: "test", conclusion: "FAILURE" }, { __typename: "CheckRun", name: "lint", conclusion: null }];
const transient: Reply = { code: 1, stderr: "HTTP 502: Bad Gateway" };

/**
 * Runs `watch` on `replies` with a fake clock; returns the event, the sleeps and the clock at the end. Started by
 * branch, the first reply also answers the branch lookup (one more gh call), so it is given twice.
 */
async function run(replies: Reply[], opts: { number?: number; timeoutMs?: number; intervalMs?: number } = {}) {
	const fake = fakeGhSequence(opts.number === undefined ? [replies[0]!, ...replies] : replies);
	let clock = 0;
	const sleeps: number[] = [];
	const event = await watch({
		dir: fake.dir,
		branch: "feat/x",
		number: opts.number,
		timeoutMs: opts.timeoutMs ?? 3_600_000,
		intervalMs: opts.intervalMs ?? 30_000,
		quietMs: QUIET,
		gh: fake.gh,
		config: {},
		now: () => clock,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
	});
	return { event, sleeps, clock };
}

test("watch: pending then one failed → checks_failed after one sleep of intervalMs", async () => {
	const r = await run([pull({ contexts: running }), pull({ contexts: oneFailed })]);
	assert.deepEqual([r.event.event, r.event.checks.failed, r.event.checks.pending, r.sleeps], ["checks_failed", ["test"], 1, [30_000]]);
});

test("watch: OPEN then MERGED → merged", async () => {
	const r = await run([pull({ contexts: running }), pull({ state: "MERGED", contexts: running })], { number: 48 });
	assert.equal(r.event.event, "merged");
});

test("watch: a new head resets the quiet period (review focus 2)", async () => {
	const r = await run([...Array.from({ length: 11 }, () => pull({ head: "aaa111" })), pull({ head: "bbb222" })], { intervalMs: 10_000 });
	assert.deepEqual([r.event.event, r.event.head, r.clock], ["ready", "bbb222", 230_000]);
});

test("watch: two transient errors then success keep watching; three in a row → blocked transient (review focus 4)", async () => {
	const r = await run([pull({ contexts: running }), transient, transient, pull({ contexts: running }), transient, transient, transient]);
	assert.deepEqual([r.event.event, r.event.reason], ["blocked", "transient: gh failed: HTTP 502: Bad Gateway"]);
	assert.deepEqual(r.sleeps, [30_000, 30_000, 60_000, 30_000, 30_000, 60_000]);
});

test("watch: gh not authenticated mid-watch → blocked at once", async () => {
	const r = await run([pull({ contexts: running }), { code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" }]);
	assert.deepEqual([r.event.event, r.event.reason, r.sleeps.length], ["blocked", "gh is not authenticated", 1]);
	assert.equal(r.event.pr, 48, "the event still names the PR");
});

test("watch: a transient error on the first read by number backs off like any other (R2)", async () => {
	const r = await run([transient, pull({ state: "MERGED" })], { number: 48 });
	assert.deepEqual([r.event.event, r.sleeps], ["merged", [30_000]]);
});

test("watch: gh gone mid-watch → blocked at once (R11)", async () => {
	const r = await run([{ ...(pull({ contexts: running }) as { json: unknown }), vanish: true }], { number: 48 });
	assert.deepEqual([r.event.event, r.event.reason, r.sleeps.length], ["blocked", "gh not found", 1]);
});

test("watch: no open PR at start → blocked", async () => {
	const r = await run([{ json: { data: { viewer: { login: "me" }, repository: { pullRequests: { totalCount: 0, nodes: [] } } } } }]);
	assert.deepEqual([r.event.event, r.event.reason], ["blocked", "no open PR for branch feat/x"]);
});

test("watch: timeout → blocked timeout", async () => {
	const r = await run([pull({ contexts: running })], { timeoutMs: 100_000 });
	assert.deepEqual([r.event.event, r.event.reason, r.clock, r.sleeps], ["blocked", "timeout", 100_000, [30_000, 30_000, 30_000, 10_000]]);
});

// ---- the CLI ----

const script = resolve(import.meta.dirname, "..", "scripts", "pr-watch.ts");
function cli(fake: { dir: string }, ...args: string[]) {
	const r = spawnSync(process.execPath, [script, "--repo", fake.dir, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}` } });
	return { code: r.status, event: JSON.parse(r.stdout || "null") as { event?: string; eventId?: string; ack?: string; reason?: string } | null };
}

test("pr-watch CLI prints one event and exits 0", () => {
	const r = cli(fakeGhSequence([pull({ state: "MERGED" })]), "--pr", "48", "--no-config");
	assert.deepEqual([r.code, r.event?.event], [0, "merged"]);
});

test("pr-watch CLI: --ack with two ids suppresses both", () => {
	const fake = fakeGhSequence([pull({ contexts: oneFailed, thread: true })]);
	const first = cli(fake, "--pr", "48", "--no-config");
	assert.equal(first.event?.event, "checks_failed");
	const second = cli(fake, "--pr", "48", "--no-config", "--ack", first.event?.ack ?? "");
	assert.equal(second.event?.event, "feedback");
	const third = cli(fake, "--pr", "48", "--no-config", "--ack", second.event?.ack ?? "", "--timeout", "1", "--interval", "1");
	assert.deepEqual([third.code, third.event?.event, third.event?.reason], [0, "blocked", "timeout"]);
});
