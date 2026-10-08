import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendUsage, branchSummary, formatTokens, readTranscriptUsage, summaryLine, type Tokens } from "../extensions/lib/usage.ts";
import { reviewsDir } from "../extensions/lib/reviews.ts";

const tokens = (input: number, output = 0, cacheWrite = 0, cacheRead = 0): Tokens => ({ input, output, cacheWrite, cacheRead });

function project() {
	const dir = mkdtempSync(join(tmpdir(), "usage-"));
	spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
	return { dir, root: mkdtempSync(join(tmpdir(), "usage-ledger-")) };
}

test("a transcript's usage counts each message once, by model", () => {
	const path = join(mkdtempSync(join(tmpdir(), "usage-tx-")), "agent.jsonl");
	const message = (id: string, model: string, input: number) =>
		JSON.stringify({ type: "assistant", message: { id, model, usage: { input_tokens: input, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } });
	writeFileSync(path, [message("m1", "haiku", 10), message("m1", "haiku", 10), message("m2", "haiku", 5), JSON.stringify({ type: "user", message: { content: "x" } }), "not json", message("m3", "opus", 1)].join("\n"));
	assert.deepEqual(readTranscriptUsage(path), [
		{ model: "haiku", tokens: tokens(15, 4, 6, 8) },
		{ model: "opus", tokens: tokens(1, 2, 3, 4) },
	]);
	assert.deepEqual(readTranscriptUsage(join(tmpdir(), "no-such-transcript.jsonl")), [], "an unreadable transcript gives nothing");
});

test("a branch sums subagents by agent and keeps only each session's latest snapshot", () => {
	const { dir, root } = project();
	appendUsage(dir, { kind: "session", id: "s1", tokens: tokens(100), branch: "feat/a", at: 1 }, root);
	appendUsage(dir, { kind: "session", id: "s1", tokens: tokens(300), branch: "feat/a", at: 2 }, root);
	appendUsage(dir, { kind: "session", id: "s2", tokens: tokens(50), branch: "feat/a", at: 3 }, root);
	appendUsage(dir, { kind: "subagent", id: "r1", agent: "reviewer", model: "opus", tokens: tokens(1000, 10), branch: "feat/a", at: 4 }, root);
	appendUsage(dir, { kind: "subagent", id: "r2", agent: "reviewer", model: "opus", tokens: tokens(500), branch: "feat/a", at: 5 }, root);
	appendUsage(dir, { kind: "subagent", id: "i1", agent: "implementer", model: "sonnet", tokens: tokens(200), branch: "feat/a", at: 6 }, root);
	appendUsage(dir, { kind: "subagent", id: "x1", agent: "reviewer", model: "opus", tokens: tokens(9999), branch: "other", at: 7 }, root);
	mkdirSync(reviewsDir(dir, root), { recursive: true });
	appendFileSync(join(reviewsDir(dir, root), "ledger.jsonl"), "garbage line\n");
	assert.deepEqual(branchSummary(dir, "feat/a", root), { byAgent: { main: 350, reviewer: 1510, implementer: 200 }, subagents: 1710, total: 2060 });
	assert.deepEqual(branchSummary(dir, "none", root), { byAgent: {}, subagents: 0, total: 0 });
});

test("token counts read at a glance", () => {
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(12_345), "12k");
	assert.equal(formatTokens(1_234_567), "1.2M");
});

test("a branch summary lists agents by size, then the total", () => {
	assert.equal(summaryLine({ byAgent: { implementer: 800_000, main: 3_400_000, reviewer: 2_100_000 }, subagents: 2_900_000, total: 6_300_000 }), "main 3.4M · reviewer 2.1M · implementer 800k · total 6.3M");
	assert.equal(summaryLine({ byAgent: {}, subagents: 0, total: 0 }), "no token use recorded for this branch");
});
