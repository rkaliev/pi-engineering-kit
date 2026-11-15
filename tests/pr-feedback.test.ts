import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, type PrData } from "../extensions/lib/pr-feedback.ts";

const human = (login: string) => ({ login, __typename: "User" });
const bot = (login: string) => ({ login, __typename: "Bot" });
type Author = ReturnType<typeof human>;

function thread(id: string, opts: { resolved?: boolean; path?: string; line?: number; last: { id: string; author: Author; body?: string } }) {
	const c = { id: opts.last.id, author: opts.last.author, body: opts.last.body ?? "Please rename this.", url: `https://x/${opts.last.id}`, createdAt: "2026-11-15T10:00:00Z" };
	return { id, isResolved: opts.resolved ?? false, path: opts.path ?? "a.ts", line: opts.line ?? 12, comments: { totalCount: 1, nodes: [c] } };
}
function review(id: string, author: Author, body: string, at: string, state = "COMMENTED") {
	return { id, author, body, state, url: `https://x/${id}`, submittedAt: at };
}
function comment(id: string, author: Author, body: string, at: string) {
	return { id, author, body, url: `https://x/${id}`, createdAt: at };
}
function pr(parts: Partial<Pick<PrData, "reviewThreads" | "reviews" | "latestOpinionatedReviews" | "comments">> = {}): PrData {
	return {
		number: 7,
		url: "https://x/pr/7",
		reviewThreads: { totalCount: parts.reviewThreads?.nodes.length ?? 0, nodes: [] },
		reviews: { totalCount: parts.reviews?.nodes.length ?? 0, nodes: [] },
		latestOpinionatedReviews: { totalCount: parts.latestOpinionatedReviews?.nodes.length ?? 0, nodes: [] },
		comments: { totalCount: parts.comments?.nodes.length ?? 0, nodes: [] },
		...parts,
	};
}
const conn = <T>(nodes: T[], totalCount = nodes.length) => ({ totalCount, nodes });

test("thread: open unless resolved or our login has the last word", () => {
	const r = classify(
		pr({
			reviewThreads: conn([
				thread("T1", { resolved: true, last: { id: "c1", author: human("alice") } }),
				thread("T2", { last: { id: "c2", author: human("me") } }),
				thread("T3", { path: "b.ts", line: 3, last: { id: "c3", author: human("alice") } }),
			]),
		}),
		"me",
	);
	assert.deepEqual(r.open.map((i) => ({ kind: i.kind, author: i.author, path: i.path, line: i.line })), [{ kind: "thread", author: "alice", path: "b.ts", line: 3 }]);
	assert.equal(r.closed, 2);
});

test("thread: a reply after ours re-opens it with a new id", () => {
	const before = classify(pr({ reviewThreads: conn([thread("T1", { last: { id: "c1", author: human("alice") } })]) }), "me");
	const after = classify(pr({ reviewThreads: conn([thread("T1", { last: { id: "c9", author: human("alice") } })]) }), "me");
	assert.equal(before.open[0]?.id, "T1:c1");
	assert.equal(after.open[0]?.id, "T1:c9");
});

test("review body: open until a later comment by us", () => {
	const body = review("R1", bot("coderabbitai"), "Nitpicks: 1. rename x", "2026-11-15T10:00:00Z");
	const earlier = classify(pr({ reviews: conn([body]), comments: conn([comment("I1", human("me"), "ok", "2026-11-15T09:00:00Z")]) }), "me");
	assert.deepEqual(earlier.open.map((i) => [i.kind, i.id, i.author]), [["review", "R1", "coderabbitai"]]);
	const later = classify(pr({ reviews: conn([body]), comments: conn([comment("I1", human("me"), "1. renamed", "2026-11-15T11:00:00Z")]) }), "me");
	assert.equal(later.open.length, 0);
	assert.equal(later.closed, 1);
	const empty = classify(pr({ reviews: conn([review("R2", human("alice"), "  ", "2026-11-15T10:00:00Z")]) }), "me");
	assert.equal(empty.open.length + empty.closed, 0);
	const ours = classify(pr({ reviews: conn([review("R3", human("me"), "self note", "2026-11-15T10:00:00Z")]) }), "me");
	assert.equal(ours.open.length + ours.closed, 0);
});

test("review body: a later review body of ours answers it too", () => {
	const r = classify(
		pr({ reviews: conn([review("R1", human("alice"), "Why sync?", "2026-11-15T10:00:00Z"), review("R2", human("me"), "Because X.", "2026-11-15T11:00:00Z")]) }),
		"me",
	);
	assert.equal(r.open.length, 0);
	assert.equal(r.closed, 1);
});

test("top-level comment: human open, bot never an item", () => {
	const r = classify(
		pr({
			comments: conn([
				comment("I1", bot("vercel"), "Preview deployed", "2026-11-15T10:00:00Z"),
				comment("I2", human("bob"), "Does this handle EUR?", "2026-11-15T10:05:00Z"),
				comment("I3", human("me"), "Will check", "2026-11-15T10:01:00Z"),
			]),
		}),
		"me",
	);
	assert.deepEqual(r.open.map((i) => [i.kind, i.id, i.author]), [["comment", "I2", "bob"]]);
	assert.equal(r.closed, 0);
});

test("changes requested stands until that reviewer reviews again", () => {
	const r = classify(
		pr({
			latestOpinionatedReviews: conn([
				{ id: "R1", author: human("carol"), state: "CHANGES_REQUESTED", url: "https://x/R1" },
				{ id: "R2", author: human("dave"), state: "APPROVED", url: "https://x/R2" },
			]),
			reviews: conn([review("R2", human("dave"), "", "2026-11-15T10:00:00Z", "APPROVED")]),
		}),
		"me",
	);
	assert.deepEqual(r.open.map((i) => [i.kind, i.id, i.author]), [["changes-requested", "changes-requested:carol", "carol"]]);
});

test("ignore drops by author, by pattern, by both", () => {
	const data = pr({
		comments: conn([
			comment("I1", human("sonar-user"), "Quality gate passed", "2026-11-15T10:00:00Z"),
			comment("I2", human("bob"), "/deploy staging", "2026-11-15T10:00:00Z"),
			comment("I3", human("eve"), "/deploy prod", "2026-11-15T10:00:00Z"),
			comment("I4", human("eve"), "Is this safe?", "2026-11-15T10:00:00Z"),
		]),
	});
	const r = classify(data, "me", { ignore: [{ author: "sonar-user" }, { pattern: "^/deploy staging" }, { author: "eve", pattern: "^/deploy" }] });
	assert.deepEqual(r.open.map((i) => i.id), ["I4"]);
	assert.deepEqual(r.problems, []);
});

test("an invalid ignore pattern is a problem and drops nothing", () => {
	const r = classify(pr({ comments: conn([comment("I1", human("bob"), "(", "2026-11-15T10:00:00Z")]) }), "me", { ignore: [{ pattern: "(" }] });
	assert.deepEqual(r.open.map((i) => i.id), ["I1"]);
	assert.deepEqual(r.problems, ['prFeedback.ignore pattern "(" is not a valid regular expression']);
});

test("more than one page is a problem", () => {
	const r = classify(pr({ reviewThreads: conn([thread("T1", { last: { id: "c1", author: human("alice") } })], 140) }), "me");
	assert.deepEqual(r.problems, ["reviewThreads: 1 of 140 read"]);
});

test("excerpt is one line, at most 200 characters", () => {
	const long = `First line\n\nsecond ${"x".repeat(300)}`;
	const [item] = classify(pr({ comments: conn([comment("I1", human("bob"), long, "2026-11-15T10:00:00Z")]) }), "me").open;
	assert.ok(item);
	assert.equal(item.excerpt.length, 200);
	assert.ok(!/\n/.test(item.excerpt));
	assert.ok(item.excerpt.startsWith("First line second x"));
	assert.ok(item.excerpt.endsWith("…"));
});

test("an author GitHub deleted counts as someone else", () => {
	const r = classify(pr({ comments: conn([{ id: "I1", author: null, body: "hm", url: "https://x/I1", createdAt: "2026-11-15T10:00:00Z" }]) }), "me");
	assert.deepEqual(r.open.map((i) => i.author), ["ghost"]);
});

// ---- collector and CLI (a fake `gh`) ----

import { after } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collectPrState, type PrState } from "../extensions/lib/pr-feedback.ts";

const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** A `gh` that records its arguments, then prints `response` (or `stderr`) and exits with `code`. */
function fakeGh(response: unknown, opts: { code?: number; stderr?: string; sleep?: number } = {}): { gh: string; dir: string; calls: () => string[] } {
	const dir = temp("fake-gh-");
	writeFileSync(join(dir, "response.json"), JSON.stringify(response));
	const lines = ["#!/bin/sh", `printf '%s\\n' "$*" | tr '\\n' ' ' >> "${dir}/calls.txt"`, `printf '\\n' >> "${dir}/calls.txt"`];
	if (opts.sleep) lines.push(`sleep ${opts.sleep}`);
	if (opts.stderr) lines.push(`printf '%s\\n' '${opts.stderr}' >&2`);
	if (!opts.stderr) lines.push(`cat "${dir}/response.json"`);
	lines.push(`exit ${opts.code ?? 0}`);
	const gh = join(dir, "gh");
	writeFileSync(gh, `${lines.join("\n")}\n`);
	chmodSync(gh, 0o755);
	const callsFile = join(dir, "calls.txt");
	return { gh, dir, calls: () => (existsSync(callsFile) ? readFileSync(callsFile, "utf8").split("\n").filter(Boolean) : []) };
}

function response(prNode: Record<string, unknown> | undefined, login = "me") {
	return { data: { viewer: { login }, repository: { pullRequests: { nodes: prNode ? [prNode] : [] } } } };
}
const PR_NODE = {
	...pr({ comments: conn([comment("I1", human("bob"), "Does this handle EUR?", "2026-11-15T10:00:00Z")]) }),
	number: 48,
	url: "https://github.com/o/r/pull/48",
	commits: {
		nodes: [
			{
				commit: {
					oid: "abc123",
					statusCheckRollup: {
						state: "FAILURE",
						contexts: { nodes: [{ __typename: "CheckRun", name: "test", conclusion: "FAILURE" }, { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS" }, { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" }] },
					},
				},
			},
		],
	},
};

test("collects in one gh call", () => {
	const fake = fakeGh(response(PR_NODE));
	const s = collectPrState({ dir: fake.dir, branch: "feat/x", deadlineMs: 5000, gh: fake.gh });
	const calls = fake.calls();
	assert.equal(calls.length, 1);
	assert.ok(calls[0]!.startsWith("api graphql "));
	for (const part of ["-F owner={owner}", "-F name={repo}", "-f branch=feat/x"]) assert.ok(calls[0]!.includes(part), part);
	assert.equal(s.error, null);
	assert.equal(s.github, true);
	assert.deepEqual([s.pr, s.url, s.head, s.login], [48, "https://github.com/o/r/pull/48", "abc123", "me"]);
	assert.deepEqual(s.open.map((i) => i.id), ["I1"]);
	assert.deepEqual(s.checks, { state: "FAILURE", failed: ["test", "ci/legacy"] });
});

test("branch defaults to the current branch of dir", () => {
	const fake = fakeGh(response(PR_NODE));
	const repo = temp("pr-state-repo-");
	spawnSync("git", ["init", "-q", "-b", "feat/x", repo]);
	collectPrState({ dir: repo, deadlineMs: 5000, gh: fake.gh });
	assert.ok(fake.calls()[0]?.includes("-f branch=feat/x"));
});

test("a branch name goes to gh as a raw string, never as @file", () => {
	const fake = fakeGh(response(PR_NODE));
	collectPrState({ dir: fake.dir, branch: "@notes.txt", deadlineMs: 5000, gh: fake.gh });
	assert.ok(fake.calls()[0]?.includes("-f branch=@notes.txt"));
	assert.ok(!fake.calls()[0]?.includes("-F branch="));
});

test("error cases", () => {
	const base = { branch: "feat/x", deadlineMs: 5000 };
	const missing = collectPrState({ ...base, dir: tmpdir(), gh: join(temp("no-gh-"), "gh") });
	assert.equal(missing.error, "gh not found");
	const auth = fakeGh({}, { code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" });
	assert.equal(collectPrState({ ...base, dir: auth.dir, gh: auth.gh }).error, "gh is not authenticated");
	const other = fakeGh({}, { code: 1, stderr: "HTTP 502: Bad Gateway" });
	assert.equal(collectPrState({ ...base, dir: other.dir, gh: other.gh }).error, "gh failed: HTTP 502: Bad Gateway");
	const none = fakeGh(response(undefined));
	const noPr = collectPrState({ ...base, dir: none.dir, gh: none.gh });
	assert.equal(noPr.error, "no open PR for branch feat/x");
	assert.equal(noPr.github, true);
	const slow = fakeGh(response(PR_NODE), { sleep: 3 });
	const started = Date.now();
	assert.equal(collectPrState({ ...base, dir: slow.dir, gh: slow.gh, deadlineMs: 300 }).error, "timed out after 300 ms");
	assert.ok(Date.now() - started < 2500);
});

test("not GitHub", () => {
	const fake = fakeGh({}, { code: 1, stderr: "none of the git remotes configured for this repository point to a known GitHub host" });
	const s = collectPrState({ dir: fake.dir, branch: "feat/x", deadlineMs: 5000, gh: fake.gh });
	assert.equal(s.github, false);
	assert.equal(s.error, "not a GitHub repository");
});

test("pr-state CLI exits 0, 1 or 2 and prints the state", () => {
	const script = resolve(import.meta.dirname, "..", "scripts", "pr-state.ts");
	const run = (fake: ReturnType<typeof fakeGh>) => {
		const r = spawnSync(process.execPath, [script, "--branch", "feat/x", "--repo", fake.dir], { encoding: "utf8", env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}` } });
		return { code: r.status, state: JSON.parse(r.stdout) as PrState };
	};
	const clean = run(fakeGh(response({ ...PR_NODE, comments: conn([]) })));
	assert.deepEqual([clean.code, clean.state.open.length, clean.state.pr], [0, 0, 48]);
	const open = run(fakeGh(response(PR_NODE)));
	assert.deepEqual([open.code, open.state.open.map((i) => i.id)], [1, ["I1"]]);
	const broken = run(fakeGh({}, { code: 1, stderr: "HTTP 502: Bad Gateway" }));
	assert.deepEqual([broken.code, broken.state.error], [2, "gh failed: HTTP 502: Bad Gateway"]);
});
