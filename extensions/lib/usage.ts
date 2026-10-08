/**
 * Token usage per branch: a JSONL ledger per repository of subagent runs and session snapshots, read by the
 * status line and the finish summary. A convenience, not evidence: anything unreadable is skipped, never thrown.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewsDir } from "./reviews.ts";

export type Tokens = { input: number; output: number; cacheWrite: number; cacheRead: number };

export type UsageRecord =
	| { kind: "subagent"; id: string; agent: string; model: string; tokens: Tokens; branch: string; at: number }
	| { kind: "session"; id: string; tokens: Tokens; branch: string; at: number };

export interface BranchSummary {
	/** Tokens by agent type; the main session is `main`. */
	byAgent: Record<string, number>;
	subagents: number;
	total: number;
}

/**
 * Tokens per model in a Claude Code transcript. The format is internal, so only `message.id`, `message.model` and
 * the `message.usage` token counts are read; a message repeated in the file counts once.
 */
export function readTranscriptUsage(path: string): Array<{ model: string; tokens: Tokens }> {
	const byModel = new Map<string, Tokens>();
	const seen = new Set<string>();
	for (const line of readLines(path)) {
		const message = (parse(line) as { message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } } | undefined)?.message;
		if (!message?.usage || typeof message.model !== "string") continue;
		if (typeof message.id === "string") {
			if (seen.has(message.id)) continue;
			seen.add(message.id);
		}
		const sum = byModel.get(message.model) ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
		sum.input += count(message.usage.input_tokens);
		sum.output += count(message.usage.output_tokens);
		sum.cacheWrite += count(message.usage.cache_creation_input_tokens);
		sum.cacheRead += count(message.usage.cache_read_input_tokens);
		byModel.set(message.model, sum);
	}
	return [...byModel].map(([model, tokens]) => ({ model, tokens }));
}

export function appendUsage(projectDir: string, record: UsageRecord, root?: string): void {
	const dir = ledgerDir(projectDir, root);
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify(record)}\n`);
}

/** A branch's tokens: the latest snapshot of each session plus every subagent run. */
export function branchSummary(projectDir: string, branch: string, root?: string): BranchSummary {
	const latest = new Map<string, UsageRecord>();
	for (const line of readLines(join(ledgerDir(projectDir, root), "ledger.jsonl"))) {
		const record = parse(line) as UsageRecord | undefined;
		if (record?.branch !== branch || typeof record.id !== "string" || !record.tokens) continue;
		latest.set(`${record.kind}:${record.id}`, record);
	}
	const byAgent: Record<string, number> = {};
	let subagents = 0;
	for (const record of latest.values()) {
		const n = total(record.tokens);
		const agent = record.kind === "session" ? "main" : record.agent;
		byAgent[agent] = (byAgent[agent] ?? 0) + n;
		if (record.kind === "subagent") subagents += n;
	}
	return { byAgent, subagents, total: Object.values(byAgent).reduce((a, b) => a + b, 0) };
}

/** 950 → "950", 12 345 → "12k", 1 234 567 → "1.2M". */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

export function total(tokens: Tokens): number {
	return count(tokens.input) + count(tokens.output) + count(tokens.cacheWrite) + count(tokens.cacheRead);
}

function ledgerDir(projectDir: string, root = join(tmpdir(), "eng-kit", "usage")): string {
	return reviewsDir(projectDir, root);
}

function readLines(path: string): string[] {
	try {
		return readFileSync(path, "utf8").split("\n");
	} catch {
		return [];
	}
}

function parse(line: string): unknown {
	try {
		return line.trim() ? JSON.parse(line) : undefined;
	} catch {
		return undefined;
	}
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `main 3.4M · reviewer 2.1M · implementer 800k · total 6.3M`, agents by size. */
export function summaryLine(summary: BranchSummary): string {
	const agents = Object.entries(summary.byAgent).sort((a, b) => b[1] - a[1]);
	if (agents.length === 0) return "no token use recorded for this branch";
	return [...agents.map(([agent, n]) => `${agent} ${formatTokens(n)}`), `total ${formatTokens(summary.total)}`].join(" · ");
}
