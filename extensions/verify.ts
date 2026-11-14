/**
 * Verify gate: the model does not decide that work is done — the project's checks do.
 *
 * - `/verify` and the `run_verification` tool run the project's verification commands
 *   (`.pi/verify.json`, else the Commands section of AGENTS.md, else the ones the manifests imply).
 * - Files edited since the last green run make the workspace "unverified" (by `edit`/`write`, or by a shell call,
 *   found from a git working-tree fingerprint taken before and after it, lib/worktree.ts), owing the commands whose
 *   verify.json `paths` cover them (every command without an entry, and every command for a path that isn't certain).
 * - When the agent stops with unverified edits, it gets one follow-up asking for evidence and its whole
 *   report (at most once per user message, so it can never loop, and with a UI once per set of edits: edits
 *   already followed up get one notice to the user instead); with no commands at all the user gets
 *   one notice per session instead. The same follow-up carries the approval
 *   gate (an approved design or plan must be committed) and the working-docs gate (implemented task
 *   files must be deleted).
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readProjectJson } from "./lib/config.ts";
import { approvalReminder, taskFileReminders, taskFileWarning } from "./lib/approvals.ts";
import { WORK_DOC_DIRS, workDocsReminder } from "./lib/workdocs.ts";
import { commandMatches, owedCommands, resolveIgnore, resolveVerifyCommands, resolveVerifyPaths, UNKNOWN_FILE, type VerifyConfig } from "./lib/commands.ts";
import { guardScope } from "./lib/scope.ts";
import { verifyState } from "./lib/verify-state.ts";
import { callChangesSplit, ignoredPath, ignoreFilter, treeFingerprint, verificationOnly, type Tree } from "./lib/worktree.ts";

const TAIL_CHARS = 4000;
const DEFAULT_TIMEOUT_SEC = 600;
const MAX_LISTED = 5;
const MAX_PENDING = 8;
/** The task-file reminders stop visiting workspace repositories after this long. */
const TASK_FILE_BUDGET_MS = 3000;

interface CheckResult {
	command: string;
	code: number;
	killed: boolean;
	/** pi stopped the check because its output passed pi's cap (pi 1.5 and later; older pi has no field). */
	truncated: boolean;
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
	/** Workspace parts over the entry limit or out of their share twice running: not fingerprinted again this session. */
	let slowParts = new Set<string>();
	let skippedNoted: string | undefined;
	/** Project-relative paths changed since the last green run, newest last. */
	let edited: string[] = [];
	/** The user was already told this session that there are no verification commands. */
	let notified = false;
	/** The user was already told this session what is wrong with verify.json `paths`. */
	let pathsNoted = false;
	/** Counted edits so far; `judged` is the count an agent_end last judged, `noted` the one the user was told about. */
	let editCount = 0;
	let judged = -1;
	let noted = -1;
	/** The verify gate's follow-up went out at the last agent_end: the next agent_end ends its turn. */
	let answering = false;

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

	/**
	 * Counts edited `paths`: each owes the commands whose verify.json `paths` cover it (every command without an entry),
	 * and those leave the green ones. Paths no command covers change nothing; without commands every edit counts.
	 */
	const markEdited = (exact: string[], ctx: ExtensionContext, guessed: string[] = [], passed: string[] = []) => {
		const { commands } = resolveVerifyCommands(ctx.cwd);
		const { scopes } = resolveVerifyPaths(ctx.cwd, commands);
		// `passed` ran in the call that made these changes: they aren't owed again for them. A guessed path (read from a
		// command's text, or an edit that isn't the file itself) may be any file: it owes every command.
		const owing = commands.filter((c) => !passed.includes(c));
		const owedBy = (paths: string[]) => owedCommands(paths, owing, scopes);
		const counted = commands.length === 0 ? [...exact, ...guessed] : [...exact.filter((p) => owedBy([p]).length > 0), ...(owing.length > 0 ? guessed : [])];
		if (counted.length === 0) return;
		const owed = guessed.length > 0 ? owing : owedBy(counted);
		// Before the first counted edit, or after a green run, every command stands green.
		greenSinceEdit = new Set((unverified ? [...greenSinceEdit] : commands).filter((c) => !owed.includes(c)));
		unverified = verifyState.unverified = true;
		editCount++;
		edited = [...edited.filter((e) => !counted.includes(e)), ...counted].slice(-MAX_LISTED);
		setStatus(ctx);
	};

	/**
	 * Compares the working tree with the last fingerprint and counts what changed, then keeps the new one. With
	 * `callId` alone (a shell call starting) it also keeps the tree for that call; with `after` (its result) it compares
	 * with the tree taken before the call and counts it unless `exempt`, and outside git, without a fingerprint or once
	 * git has failed, reads the files the command writes from its text, as it does inside a workspace part the
	 * fingerprint is blind to (`callChanges`). A change between calls (the user's editor, a
	 * background process) counts only in a process with a UI: one without is usually a subagent's own process, and
	 * its siblings' writes aren't its own.
	 */
	const track = (ctx: ExtensionContext, callId?: string, after?: { command: string; exempt: boolean; powershell?: boolean }): { marked: string[]; own: { exact: string[]; guessed: string[] } } => {
		const cwd = ctx.cwd;
		const ignore = resolveIgnore(cwd);
		const why: { slow?: boolean; slowParts?: string[] } = {};
		const now = gitOff ? undefined : treeFingerprint(cwd, ignore, why, { skip: [...slowParts], previous: tree });
		if (why.slow) gitOff = true;
		for (const part of why.slowParts ?? []) slowParts.add(part);
		verifyState.slowParts = [...slowParts];
		// A call's own snapshot (by id; `run_verification` takes the last tree just before it runs).
		const own = after ? (callId !== undefined ? pending.get(callId) : tree) : undefined;
		const before = own ?? tree;
		const ignored = ignoreFilter(cwd, ignore);
		const split = callChangesSplit(before, now, cwd, after && { command: after.command, cwd, powershell: after.powershell });
		const exact = split.exact.filter((p) => !ignored(p));
		const guessed = split.guessed.filter((p) => !ignored(p) && !exact.includes(p));
		const paths = [...exact, ...guessed];
		// Only a call compared with its own snapshot can claim the changes as a verification run's own.
		const exempted = !!(after?.exempt && own);
		const counts = after ? !exempted : ctx.hasUI;
		const marked = paths.length > 0 && counts ? paths : [];
		if (marked.length > 0) markEdited(exact, ctx, guessed);
		if (callId !== undefined) {
			pending.delete(callId);
			if (!after && now) pending.set(callId, now);
			while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
		}
		if (now) tree = now;
		return { marked, own: exempted ? { exact, guessed } : { exact: [], guessed: [] } };
	};

	async function runChecks(ctx: ExtensionContext, signal?: AbortSignal, only: string[] = []): Promise<{ report: string; ok: boolean; results: CheckResult[] }> {
		const resolved = resolveVerifyCommands(ctx.cwd);
		const unknown = only.filter((c) => !resolved.commands.includes(c));
		if (resolved.commands.length > 0 && unknown.length > 0) {
			const report = unknown.map((c) => `--only ${JSON.stringify(c)} is not one of the verification commands (${resolved.source}).`).join("\n");
			return { ok: false, results: [], report };
		}
		// A subset keeps the configured order: the cheap checks the project puts first still go first.
		const commands = only.length > 0 ? resolved.commands.filter((c) => only.includes(c)) : resolved.commands;
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
		for (const command of commands) {
			const [shell, args] = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", command]] : ["sh", ["-c", command]];
			const r = await pi.exec(shell as string, args as string[], { cwd: ctx.cwd, timeout: timeoutSec * 1000, signal });
			const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
			results.push({ command, code: r.code, killed: r.killed, truncated: r.truncated === true, tail: output.slice(-TAIL_CHARS) });
			if (r.code !== 0) break; // later checks rarely matter while an earlier one fails
		}
		const ok = results.length === commands.length && results.every((r) => r.code === 0);
		// The checks' own changes (a formatter, `lint --fix`) don't count against them, only against the checks that didn't run.
		const { own } = track(ctx, undefined, { command: "", exempt: true });
		if (ok) markGreen(commands, resolved.commands, ctx);
		if (own.exact.length + own.guessed.length > 0) markEdited(own.exact, ctx, own.guessed, ok ? commands : []);

		const lines = results.map((r) => `${r.code === 0 ? "PASS" : r.truncated ? "OUTPUT LIMIT" : r.killed ? "TIMEOUT" : "FAIL"}  ${r.command}  (exit ${r.code})`);
		const skipped = commands.slice(results.length).map((c) => `SKIP  ${c}  (earlier check failed)`);
		const failed = results.find((r) => r.code !== 0);
		const report = [
			// A subset names itself, so a report quoting the header doesn't claim checks that didn't run.
			commands.length < resolved.commands.length
				? `Verification (${resolved.source}, only: ${commands.length} of ${resolved.commands.length}): ${ok ? "selected checks passed" : "FAILED"}`
				: `Verification (${resolved.source}): ${ok ? "all checks passed" : "FAILED"}`,
			...lines,
			...skipped,
			...(failed ? ["", `Output tail of \`${failed.command}\`:`, failed.tail] : []),
			...resolveVerifyPaths(ctx.cwd, resolved.commands).problems.map((p) => `Note: ${p} (a command a broken entry names checks every file).`),
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
		pathsNoted = false;
		editCount = 0;
		judged = noted = -1;
		answering = false;
		skippedNoted = undefined;
		pending = new Map();
		// The baseline the verify gate compares shell commands against.
		const why: { slow?: boolean; slowParts?: string[] } = {};
		tree = treeFingerprint(ctx.cwd, resolveIgnore(ctx.cwd), why);
		gitOff = why.slow === true;
		slowParts = new Set(why.slowParts ?? []);
		verifyState.slowParts = [...slowParts];
		setStatus(ctx);
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") {
			answering = false;
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
			const abs = resolve(ctx.cwd, path);
			const label = path ? relative(ctx.cwd, abs).replaceAll("\\", "/") : UNKNOWN_FILE;
			// Only a path that is the file itself may narrow the commands owed (verify.json `paths`): pi's own reading of the
			// path (`@`, `~`), a symlink or another letter case owes them all.
			if (path && isFileAt(ctx.cwd, abs, label)) markEdited([label], ctx);
			else markEdited([], ctx, [label]);
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
			const { marked, own } = track(ctx, String(event.toolCallId ?? ""), { command: shell, exempt: !event.isError && verificationOnly(shell, commands), powershell: event.toolName === "powershell" });
			// A call that changed files proves nothing about them, whatever checks it also ran.
			if (marked.length > 0) return undefined;
			if (unverified && ran.length > 0) {
				if (event.isError) for (const c of ran) greenSinceEdit.delete(c);
				else markGreen(ran, commands, ctx);
			}
			// A check's own changes (a formatter, `lint --fix`) are off the count for the checks that ran, not for the others.
			if (own.exact.length + own.guessed.length > 0) markEdited(own.exact, ctx, own.guessed, ran);
		}
		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		const parts: string[] = [];
		// A change no command reported (the user's editor, a background process) is found here.
		track(ctx);
		// A follow-up goes out once per set of edits: edits an earlier agent_end judged (the agent ran no check, or
		// reported a failing one) are told to the user once instead of following up every later prompt (Claude Code
		// transcripts 2026-10..11: 40% of firings repeated the previous one's file list). The agent_end after the verify
		// gate's own follow-up judges the edits made while answering it. Without a UI no one sees a notice, so edits keep
		// getting the follow-up once per user message, as before.
		const followed = parts.length;
		if (unverified && answering) judged = editCount;
		else if (unverified && ctx.hasUI && judged === editCount) {
			const { commands, error } = resolveVerifyCommands(ctx.cwd);
			if (commands.length > 0 && !error && noted !== editCount) {
				noted = editCount;
				const files = edited.length > 0 ? `: ${edited.join(", ")}` : "";
				if (ctx.hasUI) ctx.ui.notify(`Verify gate: earlier edits are still unverified${files}. Ask for the checks to be run when you want them verified.`, "warning");
			} else if ((commands.length === 0 || error) && !notified) {
				notified = true;
				if (ctx.hasUI) ctx.ui.notify(error ? `Verify gate: edits weren't checked because the verification commands can't be read: ${error}` : 'Verify gate: no verification commands found, so edits in this session weren\'t checked. Run /kit-init or add .pi/verify.json ({"commands": ["npm test"]}).', "warning");
			}
		} else if (unverified && !remindedThisPrompt) {
			judged = editCount;
			const { commands, error } = resolveVerifyCommands(ctx.cwd);
			if (error) {
				remindedThisPrompt = true;
				parts.push(
					`Verify gate: files changed since the last passing verification, and the verification commands can't be read: ${error} Fix .pi/verify.json, run the checks and read the output. Your next message is the last one the user reads: make it the complete final report (what changed, what the user must do next, the checks you ran and their results), not only the verification.`,
				);
			} else if (commands.length > 0) {
				remindedThisPrompt = true;
				const changed = edited.length > 0 ? ` Changed since the last green run: ${edited.join(", ")}.` : "";
				// verify.json `paths` can leave some commands green: name only the owed ones.
				const owed = commands.filter((c) => !greenSinceEdit.has(c));
				const subset = owed.length > 0 && owed.length < commands.length;
				const how = subset
					? `Run the run_verification tool with only: ${JSON.stringify(owed)} (or: ${owed.map((c) => `\`${c}\``).join(", ")}) and read the output.`
					: `Run the run_verification tool (or: ${commands.map((c) => `\`${c}\``).join(", ")}) and read the output.`;
				parts.push(
					`Verify gate: files changed since the last passing verification.${changed} ${how} Report only checks that actually ran in this session; if a check fails, fix the cause or say it is failing. Your next message is the last one the user reads: make it the complete final report (what changed, what the user must do next, the checks you ran and their results), not only the verification.`,
				);
			} else if (!notified) {
				// Nothing to run, so a follow-up would only repeat the agent's report: tell the user once instead.
				notified = true;
				if (ctx.hasUI) ctx.ui.notify('Verify gate: no verification commands found, so edits in this session weren\'t checked. Run /kit-init or add .pi/verify.json ({"commands": ["npm test"]}).', "warning");
			}
		}
		if (unverified && !pathsNoted && ctx.hasUI) {
			const { problems } = resolveVerifyPaths(ctx.cwd, resolveVerifyCommands(ctx.cwd).commands);
			if (problems.length > 0) {
				pathsNoted = true;
				ctx.ui.notify(`Verify gate: ${problems.join("; ")} in .pi/verify.json; a command a broken entry names checks every file.`, "warning");
			}
		}
		answering = parts.length > followed;
		const want = { approved: !approvalRemindedThisPrompt, finished: !workDocsRemindedThisPrompt };
		// A repository's own folders only from the config the session started with (lib/scope.ts).
		const dirs = workDocDirs(ctx) ?? WORK_DOC_DIRS;
		const scope = guardScope(ctx.cwd, (root) => ({ workDocs: workDocDirs(ctx, root) }), ".pi/guard.json", verifyState.guardBaseline ?? {});
		const dirsFor = (root: string) => (root === ctx.cwd ? dirs : (scope.repos.get(root)?.workDocs ?? dirs));
		const due = taskFileReminders(ctx.cwd, dirsFor, Date.now() + TASK_FILE_BUDGET_MS, want, [...slowParts]);
		if (due.approved.length > 0) {
			approvalRemindedThisPrompt = true;
			parts.push(approvalReminder(due.approved, due.onBase, due.workspace));
		}
		if (due.finished.length > 0) {
			workDocsRemindedThisPrompt = true;
			parts.push(workDocsReminder(due.finished));
		}
		// Named once per set of skipped repositories, not after every run.
		const skipped = taskFileWarning(due.skipped);
		if (skipped && skipped !== skippedNoted && ctx.hasUI) ctx.ui.notify(skipped, "warning");
		skippedNoted = skipped;
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
		parameters: Type.Object({
			only: Type.Optional(Type.Array(Type.String(), { description: "Run only these verification commands, as the verify gate names them" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { report, ok, results } = await runChecks(ctx, signal, params.only ?? []);
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

/** Whether `abs` names the file itself at `label`: it exists, and its real path (symlinks resolved, letter case as stored) is `label`. */
function isFileAt(cwd: string, abs: string, label: string): boolean {
	try {
		return relative(realpathSync.native(cwd), realpathSync.native(abs)).replaceAll("\\", "/") === label;
	} catch {
		return false;
	}
}

/**
 * Edits outside the project, and of files matching the verify.json `ignore` globs (docs by default; in a workspace also
 * by the path inside the repository), don't need a check run.
 */
function countsAsEdit(path: string, cwd: string): boolean {
	if (!path) return true;
	const rel = relative(cwd, resolve(cwd, path));
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
	return !ignoredPath(cwd, rel, resolveIgnore(cwd));
}

/** A root's own task-file folders: `workDocs` from its `.pi/guard.json` in a trusted project, else undefined. */
function workDocDirs(ctx: ExtensionContext, root = ctx.cwd): string[] | undefined {
	const raw = readProjectJson<{ workDocs: unknown }>(root, "guard").workDocs;
	if (!ctx.isProjectTrusted() || !Array.isArray(raw)) return undefined;
	return raw.filter((v): v is string => typeof v === "string");
}
