/**
 * Token usage per branch: a JSONL ledger per repository of subagent runs and session increments, read by the
 * status line and the finish summary. A convenience, not evidence: anything unreadable is skipped, nothing throws.
 * Like the review records it lives in a private folder in the temp dir that only its owner's records are read from.
 */
import { closeSync, constants, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownDir, reviewsDir, writeAtomic } from "./reviews.ts";

export type Tokens = { input: number; output: number; cacheWrite: number; cacheRead: number };

/** A subagent run (its whole use), or what a session used on a branch since its previous snapshot (`total`: its running total). */
export type UsageRecord =
	| { kind: "subagent"; id: string; agent: string; model: string; tokens: Tokens; branch: string; at: number }
	| { kind: "session"; id: string; tokens: Tokens; total?: Tokens; branch: string; at: number };

export interface BranchSummary {
	/** Tokens by agent type; the main session is `main`. */
	byAgent: Record<string, number>;
	subagents: number;
	total: number;
}

/** Past this size, and twice the size the last compaction left, the ledger is compacted on the next write. */
const COMPACT_BYTES = 256 * 1024;
/** Records older than this are dropped when the ledger is compacted, like the review records. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const KEYS = ["input", "output", "cacheWrite", "cacheRead"] as const;

/**
 * Tokens per model in a Claude Code transcript. The format is internal, so only `message.id`, `message.model` and
 * the `message.usage` token counts are read. A message written more than once (it grows while it streams) counts
 * once, from its last copy.
 */
export function readTranscriptUsage(path: string): Array<{ model: string; tokens: Tokens }> {
	const messages = new Map<string, { model: string; usage: Record<string, unknown> }>();
	for (const line of readLines(path)) {
		if (!line.includes('"usage"')) continue;
		const message = (parse(line) as { message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } } | undefined)?.message;
		if (!message?.usage || typeof message.model !== "string") continue;
		messages.set(typeof message.id === "string" ? message.id : `#${messages.size}`, { model: message.model, usage: message.usage });
	}
	const byModel = new Map<string, Tokens>();
	for (const { model, usage } of messages.values()) {
		const sum = byModel.get(model) ?? zero();
		sum.input += count(usage.input_tokens);
		sum.output += count(usage.output_tokens);
		sum.cacheWrite += count(usage.cache_creation_input_tokens);
		sum.cacheRead += count(usage.cache_read_input_tokens);
		byModel.set(model, sum);
	}
	return [...byModel].map(([model, tokens]) => ({ model, tokens }));
}

/** Appends a record. Never follows a link planted in the ledger's place and never writes into a folder it doesn't own. */
export function appendUsage(projectDir: string, record: UsageRecord, root?: string): void {
	try {
		const dir = ledgerDir(projectDir, root);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (!ownDir(dir)) return;
		const path = join(dir, "ledger.jsonl");
		const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
		try {
			writeSync(fd, `${JSON.stringify(record)}\n`);
		} finally {
			closeSync(fd);
		}
		const compacted = Number(readLines(join(dir, "ledger.compacted"))[0]) || 0;
		if (statSync(path).size > Math.max(COMPACT_BYTES, 2 * compacted)) compactLedger(projectDir, root);
	} catch {
		// The ledger is optional.
	}
}

/** Records what session `id` used since its previous snapshot (on any branch) as spent on `branch`. */
export function appendSessionSnapshot(projectDir: string, id: string, now: Tokens, branch: string, root?: string): void {
	const previous = latestTotal(readLedger(projectDir, root), id) ?? zero();
	if (KEYS.every((k) => now[k] === previous[k])) return;
	// A total that went down (a rewound session) adds nothing and becomes the new baseline.
	const tokens = Object.fromEntries(KEYS.map((k) => [k, Math.max(0, count(now[k]) - count(previous[k]))])) as Tokens;
	appendUsage(projectDir, { kind: "session", id, tokens, total: now, branch, at: Date.now() }, root);
}

/** A branch's tokens: every session increment spent on it plus each subagent run's latest record. */
export function branchSummary(projectDir: string, branch: string, root?: string): BranchSummary {
	const byAgent: Record<string, number> = {};
	const runs = new Map<string, Extract<UsageRecord, { kind: "subagent" }>>();
	for (const record of readLedger(projectDir, root)) {
		if (record.branch !== branch) continue;
		if (record.kind === "subagent") runs.set(record.id, record);
		else byAgent.main = (byAgent.main ?? 0) + total(record.tokens);
	}
	let subagents = 0;
	for (const record of runs.values()) {
		const n = total(record.tokens);
		byAgent[record.agent] = (byAgent[record.agent] ?? 0) + n;
		subagents += n;
	}
	return { byAgent, subagents, total: Object.values(byAgent).reduce((a, b) => a + b, 0) };
}

/**
 * Rewrites the ledger with one record per session and branch and one per subagent run, dropping records older than
 * 30 days; the other totals don't change. A ledger it can't read is left as it is.
 */
export function compactLedger(projectDir: string, root?: string, now = Date.now()): void {
	try {
		const records = readLedger(projectDir, root);
		if (records.length === 0) return;
		const kept = new Map<string, UsageRecord>();
		for (const record of records) {
			if (typeof record.at !== "number" || now - record.at > MAX_AGE_MS) continue;
			if (record.kind === "subagent") {
				kept.set(`subagent:${record.id}`, record);
				continue;
			}
			const key = `session:${record.id}:${record.branch}`;
			const merged = kept.get(key);
			if (merged?.kind !== "session") kept.set(key, { ...record, tokens: { ...record.tokens } });
			else {
				for (const k of KEYS) merged.tokens[k] += count(record.tokens[k]);
				if (record.at >= merged.at) Object.assign(merged, { at: record.at, total: record.total });
			}
		}
		// Oldest first, so the latest snapshot of each session stays last.
		const lines = [...kept.values()].sort((a, b) => a.at - b.at).map((r) => JSON.stringify(r));
		const text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
		const dir = ledgerDir(projectDir, root);
		writeAtomic(join(dir, "ledger.jsonl"), text);
		writeAtomic(join(dir, "ledger.compacted"), `${Buffer.byteLength(text)}\n`);
	} catch {
		// The ledger is optional.
	}
}

/** `main 3.4M · reviewer 2.1M · implementer 800k · total 6.3M`, agents by size. */
export function summaryLine(summary: BranchSummary): string {
	const agents = Object.entries(summary.byAgent).sort((a, b) => b[1] - a[1]);
	if (agents.length === 0) return "no token use recorded for this branch";
	return [...agents.map(([agent, n]) => `${agent} ${formatTokens(n)}`), `total ${formatTokens(summary.total)}`].join(" · ");
}

/** 950 → "950", 12 345 → "12k", 999 600 → "1.0M", 1 234 567 → "1.2M". */
export function formatTokens(n: number): string {
	if (n >= 1_000_000 || Math.round(n / 1_000) >= 1_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

export function total(tokens: Tokens): number {
	return KEYS.reduce((sum, k) => sum + count(tokens[k]), 0);
}

function readLedger(projectDir: string, root?: string): UsageRecord[] {
	try {
		const dir = ledgerDir(projectDir, root);
		if (!ownDir(dir)) return [];
		return readLines(join(dir, "ledger.jsonl"))
			.map((line) => parse(line) as UsageRecord | undefined)
			.filter((r): r is UsageRecord => !!r && typeof r.id === "string" && typeof r.branch === "string" && typeof r.tokens === "object" && r.tokens !== null);
	} catch {
		return [];
	}
}

/** The running total of session `id` at its latest snapshot; ties go to the later line. */
function latestTotal(records: UsageRecord[], id: string): Tokens | undefined {
	let best: Extract<UsageRecord, { kind: "session" }> | undefined;
	for (const r of records) if (r.kind === "session" && r.id === id && r.total && (!best || r.at >= best.at)) best = r;
	return best?.total;
}

function ledgerDir(projectDir: string, root = join(tmpdir(), "eng-kit", "usage")): string {
	return reviewsDir(projectDir, root);
}

function zero(): Tokens {
	return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
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
