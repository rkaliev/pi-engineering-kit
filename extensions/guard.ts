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
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readProjectJson } from "./lib/config.ts";
import { checkCommand, checkPath, type GuardConfig, type GuardDecision } from "./lib/patterns.ts";
import { resolveVerifyCommands } from "./lib/commands.ts";
import { checkGateFiles, checkReview, parseReview, recordReview, notePr, recordVerdict, reviewedHead, settlePr, holdBack } from "./lib/reviews.ts";
import { canonical } from "./lib/repos.ts";
import { guardBaseline, guardScope, hooksPaths, isGuardBaseline, repoIn, scopedConfig, scopedPath, strictest, type GuardBaseline } from "./lib/scope.ts";
import { verifyState } from "./lib/verify-state.ts";
import { appendSessionSnapshot, appendUsage, branchSummary, formatTokens, summaryLine, type Tokens } from "./lib/usage.ts";
import { checkWorkDocs, currentBranch, WORK_DOC_DIRS } from "./lib/workdocs.ts";

/** The part of a pi-subagents result the review gate reads. */
interface SubagentRun {
	agent?: string;
	exitCode?: number;
	finalOutput?: string;
	error?: string;
	timedOut?: boolean;
	interrupted?: boolean;
	stopped?: boolean;
	model?: string;
	usage?: Partial<Tokens>;
}

export default function guardExtension(pi: ExtensionAPI, options: { reviewsRoot?: string; usageRoot?: string } = {}) {
	// Reviews from one user message combine to the worst verdict; the next message starts a new round.
	const session = randomUUID();
	let prompt = 0;
	// The workspace repositories that may loosen the guard: those there when this process, or the pi process that
	// started it (a subagent, in this folder or inside it), first started a session (lib/scope.ts).
	let record: BaselineRecord | undefined;
	// Any record left in the environment counts as a parent's: a subagent, wherever it starts, loosens only with its
	// parent's trust. A later session of this process reads its own record that way too, which fails closed.
	let parentTrusted = true;
	const take = (ctx: ExtensionContext): BaselineRecord => {
		if (!record) {
			const parent = inherited();
			const inside = parent !== undefined && (parent.cwd === ctx.cwd || within(parent.cwd, ctx.cwd));
			parentTrusted = parent?.trusted ?? true;
			const trusted = ctx.isProjectTrusted() && parentTrusted;
			record = inside ? { ...parent, hooks: parent.hooks ?? hooksPaths(parent.cwd) } : { cwd: ctx.cwd, trusted, baseline: guardBaseline(ctx.cwd, GUARD_FILE, (root) => loadConfig(ctx, root, ctx.cwd, trusted)), hooks: hooksPaths(ctx.cwd) };
			// A record of another folder stays for the processes this one starts: a grandchild back in the workspace keeps it.
			if (!inside) process.env[BASELINE_ENV] = JSON.stringify(record);
		}
		verifyState.guardBaseline = record.cwd === ctx.cwd ? record.baseline : {};
		return record;
	};
	pi.on("session_start", async (_event, ctx) => {
		take(ctx);
		return undefined;
	});
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

	/**
	 * The guard's decision for one tool call, or undefined for tools it doesn't check. A subagent started inside the
	 * recorded folder is judged as that session started in a subfolder and, when it works in another git checkout
	 * (a worktree, a repository below the folder pi started in), also as a session started in that checkout; the
	 * stricter decision wins. Loosening needs this session's trust and, for a subagent, its parent's.
	 */
	function check(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): { decision: GuardDecision; subject: string } | undefined {
		if (toolName !== "bash" && toolName !== "powershell" && toolName !== "read" && toolName !== "write" && toolName !== "edit") return undefined;
		const subject = String(toolName === "bash" || toolName === "powershell" ? (input.command ?? "") : (input.path ?? ""));
		const rec = record ?? take(ctx);
		const trusted = ctx.isProjectTrusted() && parentTrusted;
		const decision = judge(toolName, subject, ctx, rec.cwd, rec.baseline, trusted, rec.hooks);
		const top = rec.cwd === ctx.cwd ? undefined : toplevel(ctx.cwd);
		if (top === undefined || canonical(top) === canonical(rec.cwd)) return { decision, subject };
		if (!checkoutHooks.has(top)) checkoutHooks.set(top, hooksPaths(top));
		return { decision: join(decision, judge(toolName, subject, ctx, top, undefined, trusted, checkoutHooks.get(top)!)), subject };
	}
	// A subagent's own checkout's hooks folders, read once per checkout, as a session there would at its start.
	const checkoutHooks = new Map<string, Record<string, string>>();

	/** One tool call judged as a session whose project is `project`, with the configs in force there (lib/scope.ts). */
	function judge(toolName: string, subject: string, ctx: ExtensionContext, project: string, baseline: GuardBaseline | undefined, trusted: boolean, hooks: Record<string, string>): GuardDecision {
		const load = (root: string) => {
			const config = loadConfig(ctx, root, project, trusted);
			return Object.hasOwn(hooks, root) ? { ...config, hooksPath: hooks[root] } : config;
		};
		const scope = guardScope(project, load, GUARD_FILE, baseline);
		const config = scope.config;
		if (toolName !== "bash" && toolName !== "powershell") {
			// The secret rules also see where the path really leads (a symlink to `.env`).
			const target = resolve(ctx.cwd, subject);
			const tool = toolName as "read" | "write" | "edit";
			return strictest(scopedPath(tool, target, scope), checkPath(tool, canonical(target), canonical(project), config));
		}
		const powershell = toolName === "powershell";
		let decision = checkCommand(subject, project, scopedConfig(subject, ctx.cwd, scope, powershell), ctx.cwd, process.env, (target) => scopedPath("write", target, scope));
		const workDocs = config.workDocs ?? WORK_DOC_DIRS;
		// A workspace repository's own task-file folders, else the session folder's.
		const workspace = scope.repos.size === 0 ? undefined : { cwd: ctx.cwd, repos: [...scope.repos.keys()].map((dir) => basename(dir)), dirsFor: (repo: string) => scope.repos.get(repo)?.workDocs ?? workDocs, powershell, slow: verifyState.slowParts };
		if (decision.action !== "block") decision = checkWorkDocs(subject, project, workDocs, workspace) ?? decision;
		if (decision.action !== "block") decision = join(decision, checkGateFiles(subject, ctx.cwd, project, GUARD_FILE, scope.kind !== "repo"));
		if (decision.action !== "block" && config.reviewGate !== false) {
			const waived = (checkout: string) => scope.repos.get(repoIn(scope, checkout) ?? "")?.reviewGate === false;
			const gate = { missing: "confirm" as const, waiver: 'by confirming, or "reviewGate": false in .pi/guard.json', verify: resolveVerifyCommands(project, { detect: false }).commands, waived, workspace: scope.repos.size > 0, powershell, repoOf: (dir: string) => repoIn(scope, dir) };
			decision = join(decision, checkReview(subject, ctx.cwd, project, gate, options.reviewsRoot));
		}
		return decision;
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
			if (run.usage) recordUsage(ctx, { kind: "subagent", id: `${event.toolCallId}-${index}`, agent: run.agent ?? "subagent", model: run.model ?? "unknown", tokens: tokensOf(run.usage) });
		});
		runs.forEach((run, index) => {
			if (run.agent !== "reviewer") return;
			const ids = { promptId: `${session}-${prompt}`, run: `${event.toolCallId}-${index}` };
			const failed = event.isError || run.exitCode !== 0 || typeof run.finalOutput !== "string" || !!run.error || run.timedOut || run.interrupted || run.stopped;
			// A review counts only for code that passed the checks: one that ran on unverified edits is Inconclusive.
			const parsed = failed ? undefined : parseReview(run.finalOutput!);
			// Every lookup for this run shares one deadline, so pi isn't held up for long by a repository that hangs.
			const deadline = Date.now() + LOOKUP_DEADLINE_MS;
			if (parsed && verifyState.unverified && resolveVerifyCommands(ctx.cwd, { detect: false }).commands.length > 0) {
				const held = recordVerdict(ctx.cwd, parsed.sha, "Inconclusive", ids, options.reviewsRoot, { base: parsed.base, report: run.finalOutput, deadline });
				// Not recorded as written (its BASE or HEAD is no commit, or couldn't be searched in time): the named commit, else
				// each HEAD, so it is never lost; the failed lookup is passed on, not repeated.
				const still = typeof held === "string" ? holdBack(ctx.cwd, parsed.sha, ids, options.reviewsRoot, deadline, held) : held.missed === undefined ? undefined : holdBack(ctx.cwd, parsed.sha, heldIds(ids), options.reviewsRoot, deadline);
				if (ctx.hasUI) ctx.ui.notify("Review gate: the review ran while edits were unverified, so it counts as Inconclusive. Run /verify, then review again.", "warning");
				notifyMissed(ctx, typeof held === "string" ? undefined : held.missed, still);
				return;
			}
			const result = failed ? "the reviewer run failed" : recordReview(ctx.cwd, run.finalOutput!, ids, options.reviewsRoot, deadline);
			if (typeof result !== "string") {
				// The reviewer's lines were fine: hold the commit back where the verdict may not have reached, keep its report.
				if (result.missed !== undefined) notifyMissed(ctx, result.missed, holdBack(ctx.cwd, result.sha, heldIds(ids), options.reviewsRoot, deadline));
				return;
			}
			// A run with no verdict counts as Inconclusive for the commit it reviewed, so a parallel reviewer's Yes on
			// that commit can't stand alone; a review of a later commit is unaffected. A SHA that isn't a commit here (a
			// typo) or couldn't be searched for in time falls back to HEAD, so the failure is never lost.
			const still = holdBack(ctx.cwd, reviewedHead(run.finalOutput ?? ""), ids, options.reviewsRoot, deadline, result);
			if (ctx.hasUI) ctx.ui.notify(`Review gate: no verdict recorded (${result}); this commit's review counts as Inconclusive for this round.`, "warning");
			notifyMissed(ctx, undefined, still);
		});
		return undefined;
	});

	// Token use per branch (lib/usage.ts): after each agent run, what the session added, shown with the subagents' in the
	// status. Only an interactive run records it: a run without a UI is usually a subagent's own process, which the
	// parent already counts from the subagent result.
	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return undefined;
		try {
			const branch = currentBranch(ctx.cwd);
			if (!branch) return undefined;
			const tokens: Tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message" && entry.message.role === "assistant") addTokens(tokens, entry.message.usage);
			}
			appendSessionSnapshot(ctx.cwd, ctx.sessionManager.getSessionId(), tokens, branch, options.usageRoot);
			const summary = branchSummary(ctx.cwd, branch, options.usageRoot);
			ctx.ui.setStatus("eng-kit", `sub ${formatTokens(summary.subagents)} · branch ${formatTokens(summary.total)}`);
		} catch {
			// The ledger is optional.
		}
		return undefined;
	});

	pi.registerCommand("usage", {
		description: "Show the tokens this branch used: the main session and each subagent type",
		handler: async (_args, ctx) => {
			const branch = currentBranch(ctx.cwd);
			ctx.ui.notify(branch ? `Tokens on ${branch}: ${summaryLine(branchSummary(ctx.cwd, branch, options.usageRoot))}` : "Not on a branch: no token ledger to show.", "info");
		},
	});

	/** Adds a record to the branch's ledger. A convenience: it never fails the tool call or the agent run. */
	function recordUsage(ctx: ExtensionContext, record: { kind: "subagent"; id: string; agent: string; model: string; tokens: Tokens }): void {
		try {
			const branch = currentBranch(ctx.cwd);
			if (branch) appendUsage(ctx.cwd, { ...record, branch, at: Date.now() }, options.usageRoot);
		} catch {
			// The ledger is optional.
		}
	}
}

/** The run id of the Inconclusive that holds a commit back after a verdict missed a repository (see `holdBack`). */
function heldIds(ids: { promptId: string; run: string }): { promptId: string; run: string } {
	return { promptId: ids.promptId, run: `${ids.run}-held` };
}

/** How long the lookups for one reviewer run may take in all. */
const LOOKUP_DEADLINE_MS = 7000;

/**
 * Tells the user when a verdict short of Yes could not be recorded in every repository that has the commit (`missed`),
 * and when the Inconclusive meant to hold the commit back could not be recorded everywhere either (`still`).
 */
function notifyMissed(ctx: ExtensionContext, missed: string | undefined, still: string | undefined): void {
	if (!ctx.hasUI || (missed === undefined && still === undefined)) return;
	const verdict = missed === undefined ? "" : `the verdict could not be recorded in every repository that has the commit (${missed})`;
	if (still === undefined) return ctx.ui.notify(`Review gate: ${verdict}; an Inconclusive now holds the commit back there.`, "warning");
	const held = `the Inconclusive meant to hold the commit back could not be recorded everywhere either (${still}): a Yes recorded there earlier or in parallel still counts. Review again once it can be recorded.`;
	ctx.ui.notify(`Review gate: ${verdict === "" ? held.charAt(0).toUpperCase() + held.slice(1) : `${verdict}, and ${held}`}`, "warning");
}

/** Combine two guard decisions: a block wins; two confirmations become one that names both reasons. */
function join(current: GuardDecision, next: GuardDecision | undefined): GuardDecision {
	if (!next || current.action === "block") return current;
	if (next.action === "block" || current.action === "allow") return next;
	return { action: "confirm", reason: `${next.reason} Also: ${current.reason}` };
}

const GUARD_FILE = ".pi/guard.json";

/** Where a pi process leaves its guard baseline for the pi processes it starts (subagents in the same folder). */
const BASELINE_ENV = "ENG_KIT_GUARD_BASELINE";

/** A pi process's guard baseline and the folder it was taken in. */
interface BaselineRecord {
	cwd: string;
	/** Whether that session's project was trusted: a subagent's loosening needs it too. */
	trusted: boolean;
	baseline: GuardBaseline;
	/** Each root's `core.hooksPath` folder, read when the record was taken (lib/scope.ts `hooksPaths`). */
	hooks: Record<string, string>;
}

/** The record a parent pi process left in the environment, if it has the right shape; `hooks` is absent in one from before 0.37.0. */
function inherited(): (Omit<BaselineRecord, "hooks"> & { hooks?: Record<string, string> }) | undefined {
	try {
		const parsed = JSON.parse(process.env[BASELINE_ENV] ?? "") as { cwd?: unknown; trusted?: unknown; baseline?: unknown; hooks?: unknown };
		const hooks = parsed.hooks && typeof parsed.hooks === "object" && Object.values(parsed.hooks).every((v) => typeof v === "string") ? (parsed.hooks as Record<string, string>) : undefined;
		return typeof parsed.cwd === "string" && isGuardBaseline(parsed.baseline) ? { cwd: parsed.cwd, trusted: parsed.trusted === true, baseline: parsed.baseline, hooks } : undefined;
	} catch {
		return undefined;
	}
}

/** The top of the git checkout holding `dir`, spelled as `dir` is (git prints the real path), or undefined outside git. */
function toplevel(dir: string): string | undefined {
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", timeout: 3000 });
	if (r.status !== 0) return undefined;
	const up = relative(r.stdout.trim(), canonical(dir));
	if (up.startsWith("..") || isAbsolute(up)) return r.stdout.trim();
	return resolve(dir, up === "" ? "." : up.split(/[\\/]/).map(() => "..").join("/"));
}

function within(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A root's guard config (the session folder's, or a workspace repository's); loosening only in a trusted project. */
/** `trusted`: whether loosening counts (this session's trust and, for a subagent, its parent's). */
function loadConfig(ctx: ExtensionContext, root = ctx.cwd, project = ctx.cwd, trusted = ctx.isProjectTrusted()): GuardConfig {
	const label = root === project ? GUARD_FILE : `${relative(project, root)}/${GUARD_FILE}`;
	const raw = readProjectJson<GuardConfig>(root, "guard");
	if (raw.error && ctx.hasUI) ctx.ui.notify(`Guard config ignored: ${raw.error}`, "warning");
	const regexes = (value: unknown) =>
		strings(value).filter((source) => {
			try {
				new RegExp(source);
				return true;
			} catch {
				if (ctx.hasUI) ctx.ui.notify(`Guard: invalid regex ignored in ${label}: ${source}`, "warning");
				return false;
			}
		});
	return {
		label,
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

function tokensOf(usage: Partial<Tokens>): Tokens {
	return addTokens({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, usage);
}

function addTokens(sum: Tokens, usage: Partial<Tokens>): Tokens {
	for (const key of ["input", "output", "cacheWrite", "cacheRead"] as const) {
		const n = usage[key];
		if (typeof n === "number" && Number.isFinite(n)) sum[key] += n;
	}
	return sum;
}
