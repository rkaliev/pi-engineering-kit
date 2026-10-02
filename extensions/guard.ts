/**
 * Guard: blocks irreversible or secret-leaking tool calls and task files reaching the base
 * branch, asks before code reaches it without a passing review, and asks the human before
 * outward-facing ones. Tightening rules from `.pi/guard.json` always apply; `allow`, `workDocs`
 * and `reviewGate` (which relax the defaults) apply only in trusted projects.
 *
 * The review verdict comes from a `subagent` tool result: each child run of the `reviewer` agent
 * whose final output carries `Reviewed BASE:`, `Reviewed HEAD:` and `Ready to merge:`; a failed
 * reviewer run counts as Inconclusive, and so does a report without one of the three lines. A successful
 * `gh pr create` makes later pushes to its branch landings. A check that throws makes pi block the call. A background run may never report back here, so a missing verdict asks the
 * human rather than blocking.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readProjectJson } from "./lib/config.ts";
import { checkCommand, checkPath, type GuardConfig, type GuardDecision } from "./lib/patterns.ts";
import { resolveVerifyCommands } from "./lib/commands.ts";
import { checkGateFiles, checkReview, parseReview, recordReview, notePr, recordVerdict, reviewedHead, settlePr } from "./lib/reviews.ts";
import { verifyState } from "./lib/verify-state.ts";
import { checkWorkDocs, WORK_DOC_DIRS } from "./lib/workdocs.ts";

/** The part of a pi-subagents result the review gate reads. */
interface SubagentRun {
	agent?: string;
	exitCode?: number;
	finalOutput?: string;
	error?: string;
	timedOut?: boolean;
	interrupted?: boolean;
	stopped?: boolean;
}

export default function guardExtension(pi: ExtensionAPI, options: { reviewsRoot?: string } = {}) {
	// Reviews from one user message combine to the worst verdict; the next message starts a new round.
	const session = randomUUID();
	let prompt = 0;
	pi.on("input", async () => {
		prompt += 1;
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		// Where the command starts decides a PR's branch; the result only confirms it (see tool_result).
		if (event.toolName === "bash" || event.toolName === "powershell") notePr(ctx.cwd, event.toolCallId, String(input.command ?? ""), ctx.cwd, options.reviewsRoot);
		// A check that throws makes pi block the call ("Extension failed, blocking execution"): no try/catch here.
		const checked = check(event.toolName, input, ctx);
		if (!checked) return undefined;
		const { decision, subject } = checked;

		if (decision.action === "allow") return undefined;
		if (decision.action === "block") return { block: true, reason: `Guard: ${decision.reason}` };

		if (!ctx.hasUI) {
			return { block: true, reason: `Guard: ${decision.reason} Needs human confirmation, which is unavailable in this mode.` };
		}
		const ok = await ctx.ui.confirm("Guard: confirm action", `${decision.reason}\n\n${event.toolName}: ${subject}`);
		return ok ? undefined : { block: true, reason: `Guard: the user declined. ${decision.reason} Ask how to proceed.` };
	});

	/** The guard's decision for one tool call, or undefined for tools it doesn't check. */
	function check(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): { decision: GuardDecision; subject: string } | undefined {
		const config = loadConfig(ctx);
		let decision: GuardDecision;
		let subject: string;

		if (toolName === "bash" || toolName === "powershell") {
			subject = String(input.command ?? "");
			decision = checkCommand(subject, ctx.cwd, config);
			const workDocs = config.workDocs ?? WORK_DOC_DIRS;
			if (decision.action !== "block") decision = checkWorkDocs(subject, ctx.cwd, workDocs) ?? decision;
			if (decision.action !== "block") decision = join(decision, checkGateFiles(subject, ctx.cwd, ctx.cwd, ".pi/guard.json"));
			if (decision.action !== "block" && config.reviewGate !== false) {
				const gate = { missing: "confirm" as const, waiver: 'by confirming, or "reviewGate": false in .pi/guard.json', verify: resolveVerifyCommands(ctx.cwd).commands };
				const review = checkReview(subject, ctx.cwd, ctx.cwd, gate, options.reviewsRoot);
				decision = join(decision, review);
			}
		} else if (toolName === "read" || toolName === "write" || toolName === "edit") {
			subject = String(input.path ?? "");
			decision = checkPath(toolName, subject, ctx.cwd, config);
		} else {
			return undefined;
		}
		return { decision, subject };
	}

	pi.on("tool_result", async (event, ctx) => {
		// A PR/MR the agent opened makes later pushes to its branch landings (review gate).
		if (event.toolName === "bash" || event.toolName === "powershell") {
			settlePr(ctx.cwd, event.toolCallId, !event.isError, options.reviewsRoot);
			return undefined;
		}
		if (event.toolName !== "subagent") return undefined;
		const runs = (event.details as { results?: SubagentRun[] } | undefined)?.results;
		if (!Array.isArray(runs)) return undefined;
		runs.forEach((run, index) => {
			if (run.agent !== "reviewer") return;
			const ids = { promptId: `${session}-${prompt}`, run: `${event.toolCallId}-${index}` };
			const failed = event.isError || run.exitCode !== 0 || typeof run.finalOutput !== "string" || !!run.error || run.timedOut || run.interrupted || run.stopped;
			// A review counts only for code that passed the checks: one that ran on unverified edits is Inconclusive.
			const parsed = failed ? undefined : parseReview(run.finalOutput!);
			if (parsed && verifyState.unverified && resolveVerifyCommands(ctx.cwd).commands.length > 0) {
				recordVerdict(ctx.cwd, parsed.sha, "Inconclusive", ids, options.reviewsRoot, { base: parsed.base, report: run.finalOutput });
				if (ctx.hasUI) ctx.ui.notify("Review gate: the review ran while edits were unverified, so it counts as Inconclusive. Run /verify, then review again.", "warning");
				return;
			}
			const result = failed ? "the reviewer run failed" : recordReview(ctx.cwd, run.finalOutput!, ids, options.reviewsRoot);
			if (typeof result === "string") {
				// A run with no verdict counts as Inconclusive for the commit it reviewed, so a parallel
				// reviewer's Yes on that commit can't stand alone; a review of a later commit is unaffected.
				const named = reviewedHead(run.finalOutput ?? "");
				// A SHA that isn't a commit here (a typo) falls back to HEAD, so the failure is never lost.
				if (named === undefined || typeof recordVerdict(ctx.cwd, named, "Inconclusive", ids, options.reviewsRoot) === "string") {
					recordVerdict(ctx.cwd, "HEAD", "Inconclusive", ids, options.reviewsRoot);
				}
				if (ctx.hasUI) ctx.ui.notify(`Review gate: no verdict recorded (${result}); this commit's review counts as Inconclusive for this round.`, "warning");
			}
		});
		return undefined;
	});
}

/** Combine two guard decisions: a block wins; two confirmations become one that names both reasons. */
function join(current: GuardDecision, next: GuardDecision | undefined): GuardDecision {
	if (!next || current.action === "block") return current;
	if (next.action === "block" || current.action === "allow") return next;
	return { action: "confirm", reason: `${next.reason} Also: ${current.reason}` };
}

function loadConfig(ctx: ExtensionContext): GuardConfig {
	const raw = readProjectJson<GuardConfig>(ctx.cwd, "guard");
	if (raw.error && ctx.hasUI) ctx.ui.notify(`Guard config ignored: ${raw.error}`, "warning");
	const trusted = ctx.isProjectTrusted();
	const regexes = (value: unknown) =>
		strings(value).filter((source) => {
			try {
				new RegExp(source);
				return true;
			} catch {
				if (ctx.hasUI) ctx.ui.notify(`Guard: invalid regex ignored in .pi/guard.json: ${source}`, "warning");
				return false;
			}
		});
	return {
		block: regexes(raw.block),
		confirm: regexes(raw.confirm),
		protectedPaths: strings(raw.protectedPaths),
		allow: trusted ? regexes(raw.allow) : [],
		workDocs: trusted && Array.isArray(raw.workDocs) ? strings(raw.workDocs) : undefined,
		reviewGate: !(trusted && raw.reviewGate === false),
	};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
