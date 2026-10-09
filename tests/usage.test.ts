import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendSessionSnapshot, appendUsage, branchSummary, compactLedger, formatTokens, readTranscriptUsage, summaryLine, type Tokens } from "../extensions/lib/usage.ts";
import { reviewsDir } from "../extensions/lib/reviews.ts";

const tokens = (input: number, output = 0, cacheWrite = 0, cacheRead = 0): Tokens => ({ input, output, cacheWrite, cacheRead });

function project() {
	const dir = mkdtempSync(join(tmpdir(), "usage-"));
	spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
	return { dir, root: mkdtempSync(join(tmpdir(), "usage-ledger-")) };
}

test("a transcript's usage counts each message once, from its last copy (a streamed message grows), by model", () => {
	const path = join(mkdtempSync(join(tmpdir(), "usage-tx-")), "agent.jsonl");
	const message = (id: string, model: string, input: number, output = 2) =>
		JSON.stringify({ type: "assistant", message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } });
	writeFileSync(path, [message("m1", "haiku", 10, 2), message("m1", "haiku", 10, 209), message("m2", "haiku", 5), JSON.stringify({ type: "user", message: { content: "x" } }), "not json", message("m3", "opus", 1)].join("\n"));
	assert.deepEqual(readTranscriptUsage(path), [
		{ model: "haiku", tokens: tokens(15, 211, 6, 8) },
		{ model: "opus", tokens: tokens(1, 2, 3, 4) },
	]);
	assert.deepEqual(readTranscriptUsage(join(tmpdir(), "no-such-transcript.jsonl")), [], "an unreadable transcript gives nothing");
});

test("a session's tokens count on the branch where they were spent; subagents add up by agent", () => {
	const { dir, root } = project();
	appendSessionSnapshot(dir, "s1", tokens(100), "main", root);
	appendSessionSnapshot(dir, "s1", tokens(300), "feat/a", root);
	appendSessionSnapshot(dir, "s1", tokens(300), "feat/a", root);
	appendSessionSnapshot(dir, "s2", tokens(50), "feat/a", root);
	appendUsage(dir, { kind: "subagent", id: "r1", agent: "reviewer", model: "opus", tokens: tokens(1000, 10), branch: "feat/a", at: 4 }, root);
	appendUsage(dir, { kind: "subagent", id: "r2", agent: "reviewer", model: "opus", tokens: tokens(500), branch: "feat/a", at: 5 }, root);
	appendUsage(dir, { kind: "subagent", id: "r2", agent: "reviewer", model: "opus", tokens: tokens(500), branch: "feat/a", at: 6 }, root);
	appendUsage(dir, { kind: "subagent", id: "i1", agent: "implementer", model: "sonnet", tokens: tokens(200), branch: "feat/a", at: 7 }, root);
	writeFileSync(join(reviewsDir(dir, root), "ledger.jsonl"), `${readFileSync(join(reviewsDir(dir, root), "ledger.jsonl"), "utf8")}garbage line\n`);
	assert.deepEqual(branchSummary(dir, "main", root), { byAgent: { main: 100 }, subagents: 0, total: 100 }, "spent on main before the branch: stays on main");
	assert.deepEqual(branchSummary(dir, "feat/a", root), { byAgent: { main: 250, reviewer: 1510, implementer: 200 }, subagents: 1710, total: 1960 });
	assert.deepEqual(branchSummary(dir, "none", root), { byAgent: {}, subagents: 0, total: 0 });
});

test("the ledger folder is private, and a planted ledger symlink is never written through", () => {
	const { dir, root } = project();
	appendUsage(dir, { kind: "subagent", id: "a", agent: "x", model: "m", tokens: tokens(1), branch: "main", at: 1 }, root);
	assert.equal(statSync(reviewsDir(dir, root)).mode & 0o777, 0o700);
	const other = project();
	mkdirSync(reviewsDir(other.dir, other.root), { recursive: true, mode: 0o700 });
	const victim = join(mkdtempSync(join(tmpdir(), "usage-victim-")), "settings.json");
	writeFileSync(victim, "{}\n");
	symlinkSync(victim, join(reviewsDir(other.dir, other.root), "ledger.jsonl"));
	appendUsage(other.dir, { kind: "subagent", id: "a", agent: "x", model: "m", tokens: tokens(1), branch: "main", at: 1 }, other.root);
	assert.equal(readFileSync(victim, "utf8"), "{}\n");
});

test("compacting the ledger keeps every branch's totals and drops superseded records", () => {
	const { dir, root } = project();
	for (let i = 1; i <= 20; i++) appendSessionSnapshot(dir, "s1", tokens(i * 10), i <= 10 ? "main" : "feat/a", root);
	for (let i = 0; i < 5; i++) appendUsage(dir, { kind: "subagent", id: "r1", agent: "reviewer", model: "m", tokens: tokens(7), branch: "feat/a", at: Date.now() }, root);
	const before = [branchSummary(dir, "main", root), branchSummary(dir, "feat/a", root)];
	appendUsage(dir, { kind: "subagent", id: "old", agent: "reviewer", model: "m", tokens: tokens(1000), branch: "feat/a", at: 1 }, root);
	compactLedger(dir, root);
	assert.deepEqual([branchSummary(dir, "main", root), branchSummary(dir, "feat/a", root)], before, "records older than 30 days are dropped; the rest keep their totals");
	assert.equal(readFileSync(join(reviewsDir(dir, root), "ledger.jsonl"), "utf8").trim().split("\n").length, 3, "one record per session and branch, one per subagent run");
	appendSessionSnapshot(dir, "s1", tokens(230), "feat/a", root);
	assert.equal(branchSummary(dir, "feat/a", root).byAgent.main, 130, "the session's running total survives compaction");
	compactLedger(dir, root, Date.now() + 365 * 24 * 60 * 60 * 1000);
	appendSessionSnapshot(dir, "s1", tokens(240), "feat/a", root);
	assert.equal(branchSummary(dir, "feat/a", root).byAgent.main, 10, "a session resumed after its records expired adds only what is new");
	const other = project();
	appendSessionSnapshot(other.dir, "s1", tokens(300), "main", root);
	assert.equal(branchSummary(other.dir, "main", root).byAgent.main, 60, "a session that moves to another repository adds only what is new there");
});

test("the ledger compacts only after it doubles, and an unreadable ledger is never emptied", () => {
	const { dir, root } = project();
	appendUsage(dir, { kind: "subagent", id: "a", agent: "x", model: "m", tokens: tokens(1), branch: "main", at: Date.now() }, root);
	const ledger = join(reviewsDir(dir, root), "ledger.jsonl");
	const garbage = `${"x".repeat(1000)}\n`.repeat(300);
	writeFileSync(ledger, readFileSync(ledger, "utf8") + garbage);
	writeFileSync(join(reviewsDir(dir, root), "ledger.compacted"), `${10 * 1024 * 1024}\n`);
	appendUsage(dir, { kind: "subagent", id: "b", agent: "x", model: "m", tokens: tokens(1), branch: "main", at: Date.now() }, root);
	assert.ok(readFileSync(ledger, "utf8").includes(garbage), "below twice the last compacted size: not compacted");
	writeFileSync(join(reviewsDir(dir, root), "ledger.compacted"), "0\n");
	appendUsage(dir, { kind: "subagent", id: "c", agent: "x", model: "m", tokens: tokens(1), branch: "main", at: Date.now() }, root);
	assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 3, "past 256 KB and twice the last size: compacted");
	writeFileSync(ledger, garbage);
	compactLedger(dir, root);
	assert.equal(readFileSync(ledger, "utf8"), garbage, "a ledger with no readable record is left as it is");
});

test("token counts read at a glance", () => {
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(12_345), "12k");
	assert.equal(formatTokens(999_600), "1.0M");
	assert.equal(formatTokens(1_234_567), "1.2M");
});

test("a branch summary lists agents by size, then the total", () => {
	assert.equal(summaryLine({ byAgent: { implementer: 800_000, main: 3_400_000, reviewer: 2_100_000 }, subagents: 2_900_000, total: 6_300_000 }), "main 3.4M · reviewer 2.1M · implementer 800k · total 6.3M");
	assert.equal(summaryLine({ byAgent: {}, subagents: 0, total: 0 }), "no token use recorded for this branch");
});
