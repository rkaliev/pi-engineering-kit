/**
 * Verify gate: the model does not decide that work is done — the project's checks do.
 *
 * - `/verify` and the `run_verification` tool run the project's verification commands
 *   (`.pi/verify.json`, else the Commands section of AGENTS.md, else the ones the manifests imply).
 * - Files edited since the last fully green run make the workspace "unverified": by `edit`/`write`, or by
 *   a shell call, found from a git working-tree fingerprint taken before and after it (lib/worktree.ts).
 * - When the agent stops with unverified edits, it gets one follow-up asking for evidence and its whole
 *   report (at most once per user message, so it can never loop); with no commands at all the user gets
 *   one notice per session instead. The same follow-up carries the approval
 *   gate (an approved design or plan must be committed) and the working-docs gate (implemented task
 *   files must be deleted).
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readProjectJson } from "./lib/config.ts";
import { approvalReminder, uncommittedApproved } from "./lib/approvals.ts";
import { finishedWorkDocs, onBaseBranch, WORK_DOC_DIRS, workDocsReminder } from "./lib/workdocs.ts";
import { commandMatches, isIgnored, resolveIgnore, resolveVerifyCommands, type VerifyConfig } from "./lib/commands.ts";
import { verifyState } from "./lib/verify-state.ts";
import { changedPaths, shellWriteTargets, treeFingerprint, verificationOnly, type Tree } from "./lib/worktree.ts";

const TAIL_CHARS = 4000;
const DEFAULT_TIMEOUT_SEC = 600;
const MAX_LISTED = 5;
const MAX_PENDING = 8;

interface CheckResult {
	command: string;
	code: number;
	killed: boolean;
	tail: string;
}

export default function verifyExtension(pi: ExtensionAPI) {
	let unverified = false;
	let greenSinceEdit = new Set<string>();
	let remindedThisPrompt = false;
	let approvalRemindedThisPrompt = false;
	let workDocsRemindedThisPrompt = false;
	/** The last fingerprint of the project's git working tree; absent until the first one (and outside git). */
	let tree: Tree | undefined;
	/** The fingerprint taken before each running shell call, by tool call id. */
	let pending = new Map<string, Tree>();
	/** git timed out or listed too many files once: the command text decides for the rest of the session. */
	let gitOff = false;
	/** Project-relative paths changed since the last green run, newest last. */
	let edited: string[] = [];
	/** The user was already told this session that there are no verification commands. */
	let notified = false;

	const setStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("verify", unverified ? "verify: unverified edits" : undefined);
	};

	const markGreen = (commands: string[], all: string[], ctx: ExtensionContext) => {
		for (const c of commands) greenSinceEdit.add(c);
		if (all.length > 0 && all.every((c) => greenSinceEdit.has(c))) {
			unverified = verifyState.unverified = false;
			edited = [];
		}
		setStatus(ctx);
	};

	const markEdited = (paths: string[], ctx: ExtensionContext) => {
		unverified = verifyState.unverified = true;
		greenSinceEdit = new Set();
		edited = [...edited.filter((e) => !paths.includes(e)), ...paths].slice(-MAX_LISTED);
		setStatus(ctx);
	};

	/**
	 * Compares the working tree with the last fingerprint and counts what changed, then keeps the new one. With
	 * `callId` alone (a shell call starting) it also keeps the tree for that call; with `after` (its result) it compares
	 * with the tree taken before the call and counts it unless `exempt`, and outside git, without a fingerprint or once
	 * git has failed, reads the files the command writes from its text. A change between calls (the user's editor, a
	 * background process) counts only in a process with a UI: one without is usually a subagent's own process, and
	 * its siblings' writes aren't its own.
	 */
	const track = (ctx: ExtensionContext, callId?: string, after?: { command: string; exempt: boolean; powershell?: boolean }): string[] => {
		const cwd = ctx.cwd;
		const ignore = resolveIgnore(cwd);
		const why: { slow?: boolean } = {};
		const now = gitOff ? undefined : treeFingerprint(cwd, ignore, why);
		if (why.slow) gitOff = true;
		// A call's own snapshot (by id; `run_verification` takes the last tree just before it runs).
		const own = after ? (callId !== undefined ? pending.get(callId) : tree) : undefined;
		const before = own ?? tree;
		let paths: string[] = [];
		if (now && before) paths = changedPaths(before, now, cwd, ignore);
		else if (after) paths = shellWriteTargets(after.command, cwd, cwd, process.env, after.powershell).filter((p) => !isIgnored(p, ignore));
		// Only a call compared with its own snapshot can claim the changes as a verification run's own.
		const counts = after ? !(after.exempt && own) : ctx.hasUI;
		const marked = paths.length > 0 && counts ? paths : [];
		if (marked.length > 0) markEdited(marked, ctx);
		if (callId !== undefined) {
			pending.delete(callId);
			if (!after && now) pending.set(callId, now);
			while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
		}
		if (now) tree = now;
		return marked;
	};

	async function runChecks(ctx: ExtensionContext, signal?: AbortSignal): Promise<{ report: string; ok: boolean; results: CheckResult[] }> {
		const resolved = resolveVerifyCommands(ctx.cwd);
		if (resolved.commands.length === 0) {
			const why = resolved.error ?? "No verification commands found.";
			return {
				ok: false,
				results: [],
				report: `${why} Add them to .pi/verify.json ({"commands": ["npm test"]}) or to a "## Commands" section in AGENTS.md.`,
			};
		}
		// Changes made before the run are counted first; only the run's own changes are its own.
		track(ctx);
		const timeoutSec = readProjectJson<VerifyConfig>(ctx.cwd, "verify").timeoutSec ?? DEFAULT_TIMEOUT_SEC;
		const results: CheckResult[] = [];
		for (const command of resolved.commands) {
			const [shell, args] = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", command]] : ["sh", ["-c", command]];
			const r = await pi.exec(shell as string, args as string[], { cwd: ctx.cwd, timeout: timeoutSec * 1000, signal });
			const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
			results.push({ command, code: r.code, killed: r.killed, tail: output.slice(-TAIL_CHARS) });
			if (r.code !== 0) break; // later checks rarely matter while an earlier one fails
		}
		const ok = results.length === resolved.commands.length && results.every((r) => r.code === 0);
		// The checks' own changes (a formatter, `lint --fix`) don't count against them.
		track(ctx, undefined, { command: "", exempt: true });
		if (ok) markGreen(resolved.commands, resolved.commands, ctx);

		const lines = results.map((r) => `${r.code === 0 ? "PASS" : r.killed ? "TIMEOUT" : "FAIL"}  ${r.command}  (exit ${r.code})`);
		const skipped = resolved.commands.slice(results.length).map((c) => `SKIP  ${c}  (earlier check failed)`);
		const failed = results.find((r) => r.code !== 0);
		const report = [
			`Verification (${resolved.source}): ${ok ? "all checks passed" : "FAILED"}`,
			...lines,
			...skipped,
			...(failed ? ["", `Output tail of \`${failed.command}\`:`, failed.tail] : []),
		].join("\n");
		return { ok, results, report };
	}

	pi.on("session_start", async (_event, ctx) => {
		unverified = verifyState.unverified = false;
		greenSinceEdit = new Set();
		remindedThisPrompt = false;
		approvalRemindedThisPrompt = false;
		workDocsRemindedThisPrompt = false;
		edited = [];
		notified = false;
		pending = new Map();
		// The baseline the verify gate compares shell commands against.
		const why: { slow?: boolean } = {};
		tree = treeFingerprint(ctx.cwd, resolveIgnore(ctx.cwd), why);
		gitOff = why.slow === true;
		setStatus(ctx);
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") {
			remindedThisPrompt = false;
			approvalRemindedThisPrompt = false;
			workDocsRemindedThisPrompt = false;
		}
		return { action: "continue" as const };
	});

	// The working tree before a shell call, so its result can name what that call changed.
	pi.on("tool_call", async (event, ctx) => {
		// A worker subagent writes from its own process: its changes are its call's, like a shell call's.
		if (["bash", "powershell", "subagent"].includes(event.toolName)) track(ctx, String(event.toolCallId ?? ""));
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			const path = String(event.input.path ?? "");
			if (!countsAsEdit(path, ctx.cwd)) return undefined;
			markEdited([path ? relative(ctx.cwd, resolve(ctx.cwd, path)).replaceAll("\\", "/") : "(unknown file)"], ctx);
			// The edit is counted; the next comparison starts after it.
			track(ctx);
			return undefined;
		}
		if (event.toolName === "subagent") {
			track(ctx, String(event.toolCallId ?? ""), { command: "", exempt: false });
			return undefined;
		}
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const shell = String(event.input.command ?? "");
			const { commands } = resolveVerifyCommands(ctx.cwd);
			const ran = commands.filter((c) => commandMatches(shell, c));
			// Files this command changed, whatever wrote them (a failed command may have written too). Only a check that
			// passed and did nothing else keeps its own changes off the count.
			const marked = track(ctx, String(event.toolCallId ?? ""), { command: shell, exempt: !event.isError && verificationOnly(shell, commands), powershell: event.toolName === "powershell" });
			// A call that changed files proves nothing about them, whatever checks it also ran.
			if (!unverified || marked.length > 0) return undefined;
			if (ran.length === 0) return undefined;
			if (event.isError) for (const c of ran) greenSinceEdit.delete(c);
			else markGreen(ran, commands, ctx);
		}
		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		const parts: string[] = [];
		// A change no command reported (the user's editor, a background process) is found here.
		track(ctx);
		if (unverified && !remindedThisPrompt) {
			const { commands, error } = resolveVerifyCommands(ctx.cwd);
			if (error) {
				remindedThisPrompt = true;
				parts.push(
					`Verify gate: files changed since the last passing verification, and the verification commands can't be read: ${error} Fix .pi/verify.json, run the checks and read the output. Your next message is the last one the user reads: make it the complete final report (what changed, what the user must do next, the checks you ran and their results), not only the verification.`,
				);
			} else if (commands.length > 0) {
				remindedThisPrompt = true;
				const changed = edited.length > 0 ? ` Changed since the last green run: ${edited.join(", ")}.` : "";
				const how = `Run the run_verification tool (or: ${commands.map((c) => `\`${c}\``).join(", ")}) and read the output.`;
				parts.push(
					`Verify gate: files changed since the last passing verification.${changed} ${how} Report only checks that actually ran in this session; if a check fails, fix the cause or say it is failing. Your next message is the last one the user reads: make it the complete final report (what changed, what the user must do next, the checks you ran and their results), not only the verification.`,
				);
			} else if (!notified) {
				// Nothing to run, so a follow-up would only repeat the agent's report: tell the user once instead.
				notified = true;
				if (ctx.hasUI) ctx.ui.notify('Verify gate: no verification commands found, so edits in this session weren\'t checked. Run /kit-init or add .pi/verify.json ({"commands": ["npm test"]}).', "warning");
			}
		}
		const dirs = workDocDirs(ctx);
		if (!approvalRemindedThisPrompt) {
			const files = uncommittedApproved(ctx.cwd, dirs);
			if (files.length > 0) {
				approvalRemindedThisPrompt = true;
				parts.push(approvalReminder(files, onBaseBranch(ctx.cwd)));
			}
		}
		if (!workDocsRemindedThisPrompt) {
			const files = finishedWorkDocs(ctx.cwd, dirs);
			if (files.length > 0) {
				workDocsRemindedThisPrompt = true;
				parts.push(workDocsReminder(files));
			}
		}
		if (parts.length === 0) return;
		pi.sendMessage({ customType: "verify-gate", display: true, content: parts.join("\n\n") }, { triggerTurn: true, deliverAs: "followUp" });
	});

	pi.registerTool({
		name: "run_verification",
		label: "Run verification",
		description:
			"Run the project's verification commands (tests, typecheck, lint, build) from .pi/verify.json, AGENTS.md or the project's manifests and return pass/fail with the failing output tail.",
		promptSnippet: "run_verification: run the project's tests/typecheck/lint/build and get evidence",
		promptGuidelines: ["Run run_verification before claiming work is complete, fixed, or passing."],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const { report, ok, results } = await runChecks(ctx, signal);
			return { content: [{ type: "text", text: report }], details: { ok, results } };
		},
	});

	pi.registerCommand("verify", {
		description: "Run the project's verification commands and share the result with the agent",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) ctx.ui.setWorkingMessage("Running verification…");
			const { report, ok } = await runChecks(ctx);
			if (ctx.hasUI) {
				ctx.ui.setWorkingMessage();
				ctx.ui.notify(ok ? "Verification passed" : "Verification failed", ok ? "info" : "error");
			}
			pi.sendMessage({ customType: "verify-result", display: true, content: report });
		},
	});
}

/** Edits outside the project, and of files matching the verify.json `ignore` globs (docs by default), don't need a check run. */
function countsAsEdit(path: string, cwd: string): boolean {
	if (!path) return true;
	const rel = relative(cwd, resolve(cwd, path));
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
	return !isIgnored(rel, resolveIgnore(cwd));
}

/** Task-file folders: the kit's defaults, or `workDocs` from `.pi/guard.json` in a trusted project. */
function workDocDirs(ctx: ExtensionContext): string[] {
	const raw = readProjectJson<{ workDocs: unknown }>(ctx.cwd, "guard").workDocs;
	if (!ctx.isProjectTrusted() || !Array.isArray(raw)) return WORK_DOC_DIRS;
	return raw.filter((v): v is string => typeof v === "string");
}
