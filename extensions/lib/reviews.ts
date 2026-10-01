/**
 * Review gate: code reaches the base branch (a PR/MR, a merge into it or a push to it) only after
 * a reviewer passed exactly the commit being landed. Verdicts are recorded from the reviewer's own
 * report (never by the main agent), one file per reviewer run. Any change after the review (a new
 * commit, an amend, a rebase, a docs edit) is a different commit and needs a new review.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { splitSegments, tokenize, type GuardDecision } from "./patterns.ts";
import { baseBranch, currentBranch, landing, pushedToBase, type Landing } from "./workdocs.ts";

export type Verdict = "Yes" | "With fixes" | "No" | "Inconclusive";

/** One reviewer run's verdict on one commit. A run that failed counts as Inconclusive for the commit it reviewed. */
export interface ReviewRecord {
	sha: string;
	verdict: Verdict;
	/** Reviews from one user prompt combine (parallel reviewers); a later prompt replaces them. */
	promptId: string;
	at: number;
}

export interface ReviewGateOptions {
	/** What happens when no passing review covers the commit: deny, or ask the human. */
	missing: "block" | "confirm";
	/** How the user turns the gate off, named in the reason. */
	waiver: string;
	/** The project's verification commands: they may run before a landing in the same command. */
	verify: string[];
}

const RANK: Record<Verdict, number> = { Yes: 0, "With fixes": 1, Inconclusive: 2, No: 3 };
// A verdict word followed by `/` or `|` is the unfilled template line, not a verdict.
const VERDICT = /Ready to merge[*_]*:[*_\s]*(Yes|No|With fixes|Inconclusive)\b(?![*_\s]*[/|])/gi;
const HEAD = /Reviewed HEAD[*_]*:[*_\s`]*([0-9a-f]{7,40})\b/gi;
/** Segments that may run before a landing in one command: they neither commit nor move a ref. */
const SAFE_COMMANDS = new Set(["cd", "pushd", "echo", "printf", "true", "sleep", "pwd"]);
const SAFE_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "add", "fetch", "remote", "branch"]);
const READ_ONLY = new Set(["cat", "less", "head", "tail", "grep", "rg", "ls", "wc", "diff", "stat", "file", "jq"]);
const READ_ONLY_GIT = new Set(["diff", "show", "log", "status", "blame"]);
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The verdict and SHA in a reviewer's report. Several reports (parallel reviewers) give the worst verdict. */
export function parseReview(text: string): { sha: string; verdict: Verdict } | undefined {
	const verdicts = [...text.matchAll(VERDICT)].map((m) => normalize(m[1]!));
	const shas = new Set([...text.matchAll(HEAD)].map((m) => m[1]!.toLowerCase()));
	if (verdicts.length === 0 || shas.size !== 1) return undefined;
	return { sha: [...shas][0]!, verdict: worst(verdicts) };
}

/** The SHA a report names, even when its verdict line is missing: a failed run is charged to that commit. */
export function reviewedHead(text: string): string | undefined {
	const shas = new Set([...text.matchAll(HEAD)].map((m) => m[1]!.toLowerCase()));
	return shas.size === 1 ? [...shas][0] : undefined;
}

/**
 * Record one reviewer run's report. `run` identifies the run (agent id, tool call id), so parallel reviewers
 * never overwrite each other. Returns the record, or why none was written.
 */
export function recordReview(projectDir: string, text: string, ids: { promptId: string; run: string }, root?: string): ReviewRecord | string {
	const parsed = parseReview(text);
	if (!parsed) return "the report has no single `Reviewed HEAD: <sha>` line with one `Ready to merge:` verdict";
	return recordVerdict(projectDir, parsed.sha, parsed.verdict, ids, root);
}

/** Record a verdict for a commit directly: a reviewer run that failed counts as Inconclusive for the commit it reviewed. */
export function recordVerdict(projectDir: string, rev: string, verdict: Verdict, ids: { promptId: string; run: string }, root?: string): ReviewRecord | string {
	const sha = git(projectDir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
	if (!sha) return `Reviewed HEAD ${rev} is not a commit in this repository`;
	const record: ReviewRecord = { sha, verdict, promptId: ids.promptId, at: Date.now() };
	const dir = reviewsDir(projectDir, root);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (!ownDir(dir)) return `${dir} belongs to another user`;
		writeAtomic(join(dir, `${sha}.${safe(ids.promptId)}.${safe(ids.run)}.json`), JSON.stringify(record));
		prune(dir);
	} catch (err) {
		return `could not write ${dir}: ${(err as Error).message}`;
	}
	return record;
}

/** Recorded verdicts per reviewed SHA, newest first: the latest prompt's reviews combined to the worst verdict. */
export function readReviews(projectDir: string, root?: string): ReviewRecord[] {
	const dir = reviewsDir(projectDir, root);
	let names: string[];
	try {
		if (!ownDir(dir)) return [];
		names = readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}
	const bySha = new Map<string, ReviewRecord[]>();
	for (const name of names) {
		const record = readRecord(join(dir, name));
		if (record) bySha.set(record.sha, [...(bySha.get(record.sha) ?? []), record]);
	}
	const combined: ReviewRecord[] = [];
	for (const records of bySha.values()) {
		const latest = records.reduce((a, b) => (b.at > a.at ? b : a));
		const prompt = records.filter((r) => r.promptId === latest.promptId).map((r) => r.verdict);
		combined.push({ ...latest, verdict: worst(prompt) });
	}
	return combined.sort((a, b) => b.at - a.at);
}

/**
 * Block (or ask before) landing code on the base branch that no passing review covers. `cwd` is where the
 * command starts; `cd <dir>` and `git -C <dir>` in it are followed, so a worktree's branch is checked there.
 * Anything the guard can't follow (a variable, a nested subshell, another repository) fails closed.
 */
export function checkReview(command: string, cwd: string, projectDir: string, options: ReviewGateOptions, root?: string): GuardDecision | undefined {
	let dir: string | undefined = cwd;
	let outside: string | undefined;
	let inSubshell = false;
	let unsafeBefore = false;
	for (const raw of splitSegments(tokenize(stripRedirects(command)))) {
		// A `cd` inside a subshell ends with it: restore the directory after the closing parenthesis.
		// A nested subshell is more than the guard tracks: what follows fails closed.
		if (raw[0]?.startsWith("(")) {
			if (inSubshell || raw[0].startsWith("((")) dir = undefined;
			inSubshell = true;
			outside = dir;
		}
		const closes = inSubshell && (raw[raw.length - 1] ?? "").endsWith(")");
		const tokens = raw.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean);
		const l = landing(tokens);
		if (!l || l.kind === "commit") {
			if (isCd(tokens)) dir = dir === undefined ? undefined : follow(dir, tokens[1]);
			else if (!isSafe(tokens, options.verify)) unsafeBefore = true;
			if (closes) {
				inSubshell = false;
				dir = outside;
			}
			continue;
		}
		// After a switch or commit in the same command, a merge may land on the base: its target is unknown.
		if (l.kind === "merge" && unsafeBefore) {
			return decision(options.missing, "this command moves HEAD before it merges, so the guard can't see where the merge lands. Run the merge as its own command.", options);
		}
		if (l.kind === "merge" && dir !== undefined && !landsOnBase(l, dir)) {
			unsafeBefore = true;
			continue;
		}
		const where = dir === undefined ? undefined : "dir" in l && l.dir ? follow(dir, l.dir) : dir;
		if (where === undefined || (l.kind === "pr" && l.repo)) {
			return decision(options.missing, "can't tell which checkout this command lands from (a variable, `$(…)`, a nested subshell, a missing folder or another repository). Run it from the checkout itself.", options);
		}
		if (git(where, ["rev-parse", "--git-dir"]) === undefined) {
			if (where !== cwd) return decision(options.missing, `${where} is not a git checkout, so the guard can't see what this command lands.`, options);
			continue;
		}
		const base = baseBranch(where);
		if (!base) continue;
		const refs = targets(l, where, base);
		if (refs.length === 0) continue;
		if (unsafeBefore) {
			return decision(options.missing, "this command runs a step before it lands that may commit or move a ref (only read-only steps and the project's verification commands may come first), so the guard can't see what it lands. Run the landing as its own command.", options);
		}
		for (const ref of refs) {
			if (ref === undefined) {
				return { action: "confirm", reason: "Review gate: can't tell locally which commit this PR/MR merge lands. Check that its head commit has a Yes review, or merge it by branch name." };
			}
			const problem = uncovered(where, projectDir, base, ref, root);
			if (problem) return decision(options.missing, problem, options);
		}
	}
	return undefined;
}

/**
 * Commands that write the review gate's own state: a verdict record (block) or the guard config (ask).
 * The path rules cover Edit/Write; this covers the shell, following `cd`. An interpreter one-liner can still hide a path.
 */
export function checkGateFiles(command: string, cwd: string, projectDir: string, guardConfig: string): GuardDecision | undefined {
	// Writing redirections and `tee` make any command a writer; `2>/dev/null` and `2>&1` don't.
	const redirects = [...command.matchAll(/\d*>>?\s*(&\d+|[^\s;&|]+)/g)].some((m) => m[1] !== "/dev/null" && !m[1]!.startsWith("&")) || /\btee\b/.test(command);
	const config = resolve(projectDir, guardConfig).replaceAll("\\", "/");
	const records = [join(tmpdir(), "eng-kit", "reviews"), safeRealpath(tmpdir()) + "/eng-kit/reviews"].map((p) => p.replaceAll("\\", "/"));
	let dir = cwd;
	for (const raw of splitSegments(tokenize(command))) {
		const tokens = raw.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean);
		if (isCd(tokens)) {
			// A write may create the folder, so it need not exist yet; a variable keeps the last known one.
			const arg = tokens[1];
			if (arg !== undefined && !/[$`(]/.test(arg)) dir = resolve(dir, arg.replace(/^~(?=\/|$)/, homedir()));
			continue;
		}
		const sub = tokens.find((t, i) => i > 0 && !t.startsWith("-"));
		const readOnly = !redirects && (READ_ONLY.has(tokens[0] ?? "") || (tokens[0] === "git" && READ_ONLY_GIT.has(sub ?? "")));
		if (readOnly) continue;
		const paths = tokens.map((t) => resolve(dir, t.replace(/^~(?=\/)/, homedir())).replaceAll("\\", "/"));
		const named = tokens.some((t) => /^\$\{?TMPDIR\}?\/+eng-kit\/reviews(\/|$)/.test(t));
		if (named || paths.some((p) => records.some((r) => p === r || p.startsWith(`${r}/`)))) {
			return { action: "block", reason: "Review records are written only by the guard, from the reviewer's own report. Dispatch the reviewer instead." };
		}
		if (paths.includes(config) || tokens.some((t) => t.endsWith(guardConfig))) {
			return { action: "confirm", reason: `This command may change ${guardConfig}, which decides what the guard blocks. Loosening it is the user's call; show them the change first.` };
		}
	}
	return undefined;
}

/**
 * The command without its redirections (`2>&1`, `> out.log`, `&>/dev/null`, `< in`), which don't change what
 * lands and would otherwise split a segment at the `&` of `2>&1`. Only outside quotes: a `>` in a commit
 * message is text. A target ends at whitespace, an operator or a parenthesis.
 */
export function stripRedirects(command: string): string {
	let out = "";
	let quote: string | null = null;
	let i = 0;
	while (i < command.length) {
		const ch = command[i]!;
		if (quote) {
			if (ch === quote) quote = null;
			out += ch;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			out += ch;
			i++;
			continue;
		}
		const boundary = i === 0 || /[\s;&|()]/.test(command[i - 1]!);
		const op = /^(?:\d*|&)(?:>>?|<)(?:&\d+|&-)?/.exec(command.slice(i))?.[0];
		const isRedirect = op !== undefined && (ch === ">" || ch === "<" || (boundary && op.length > 1 && /[>&<]/.test(op.slice(1))));
		if (!isRedirect || op === undefined) {
			out += ch;
			i++;
			continue;
		}
		i += op.length;
		if (!/&(\d+|-)$/.test(op)) {
			while (i < command.length && /[ \t]/.test(command[i]!)) i++;
			let target: string | null = null;
			while (i < command.length && (target || !/[\s;&|()<>]/.test(command[i]!))) {
				const c = command[i]!;
				if (target) {
					if (c === target) target = null;
				} else if (c === "'" || c === '"') target = c;
				i++;
			}
		}
		out += " ";
	}
	return out;
}

function isCd(tokens: string[]): boolean {
	return tokens[0] === "cd" || tokens[0] === "pushd";
}

/** The directory `cd <arg>` moves to, or undefined when the guard can't know it. */
function follow(dir: string, arg: string | undefined): string | undefined {
	if (arg === undefined || /[$`(]/.test(arg)) return undefined;
	const target = resolve(dir, arg.replace(/^~(?=\/|$)/, homedir()));
	return existsSync(target) ? target : undefined;
}

function isSafe(tokens: string[], verify: string[]): boolean {
	if (READ_ONLY.has(tokens[0] ?? "")) return true;
	if (verify.some((v) => splitSegments(tokenize(v)).some((seg) => seg.length === tokens.length && seg.every((t, i) => t === tokens[i])))) return true;
	if (tokens[0] === "git") {
		const sub = tokens.slice(1).find((t, i, all) => !t.startsWith("-") && all[i - 1] !== "-C" && all[i - 1] !== "-c") ?? "";
		if (sub === "fetch") return !tokens.some((t) => t.includes(":"));
		if (sub === "branch") return !tokens.some((t) => /^-[a-zA-Z]*[fDmMcC]/.test(t) || t === "--force");
		return SAFE_GIT.has(sub);
	}
	return SAFE_COMMANDS.has(tokens[0] ?? "") || (tokens[0] === "gh" && ["view", "list", "checks", "status"].includes(tokens[2] ?? ""));
}

function landsOnBase(l: Extract<Landing, { kind: "merge" }>, dir: string): boolean {
	const where = l.dir ? follow(dir, l.dir) : dir;
	if (where === undefined) return true;
	const base = baseBranch(where);
	return base !== undefined && currentBranch(where) === base;
}

/** The refs a landing puts on the base; `undefined` for a PR/MR merge whose head isn't known locally. */
function targets(l: Exclude<Landing, { kind: "commit" }>, where: string, base: string): Array<string | undefined> {
	const onBase = currentBranch(where) === base;
	if (l.kind === "merge") return l.refs;
	if (l.kind === "push") return pushedToBase(l, base, onBase);
	if (l.target !== undefined && (/^\d+$/.test(l.target) || l.target.includes("://") || /^[#!]/.test(l.target))) return [undefined];
	if (!l.merge && l.target === undefined) return ["HEAD"];
	const branch = l.target ?? currentBranch(where);
	if (!branch) return [undefined];
	// gh merges the remote head: check it, and the local branch too when it differs.
	const refs = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`].filter((r) => git(where, ["rev-parse", "--verify", "--quiet", r]));
	return refs.length === 0 ? [undefined] : refs;
}

function uncovered(where: string, projectDir: string, base: string, ref: string, root?: string): string | undefined {
	const sha = git(where, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	if (!sha) return `can't resolve ${ref}.`;
	// Already on the remote base (or the base itself): nothing new lands, so there is nothing to review.
	const upstream = git(where, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`]) ? `refs/remotes/origin/${base}` : base;
	if (spawnSync("git", ["merge-base", "--is-ancestor", sha, upstream], { cwd: where, timeout: 5000 }).status === 0) return undefined;

	// A verdict covers exactly the commit the reviewer reviewed: anything else is a change it didn't see.
	const reviews = readReviews(projectDir, root);
	const match = reviews.find((r) => r.sha === sha);
	if (!match) {
		const last = reviews[0];
		return last
			? `no reviewer verdict recorded for ${short(sha)}; the last reviewed commit is ${short(last.sha)}, and the branch changed after it (a new commit, an amend or a rebase), so it needs a new review.`
			: `no reviewer verdict recorded for ${short(sha)}.`;
	}
	// "With fixes" passes only after the fixes and a re-review of them, which gives a new verdict.
	if (match.verdict !== "Yes") return `the review of ${short(match.sha)} returned "${match.verdict}".`;
	return undefined;
}

/** Where a project's review records live. Needs no environment, so every hook process agrees. */
export function reviewsDir(projectDir: string, root = join(tmpdir(), "eng-kit", "reviews")): string {
	return join(root, hash(resolve(projectDir)));
}

function decision(action: "block" | "confirm", problem: string, options: ReviewGateOptions): GuardDecision {
	return { action, reason: `Review gate: ${problem} Run requesting-code-review on the branch and fix its findings first. Only the user can waive the gate (${options.waiver}).` };
}

function readRecord(path: string): ReviewRecord | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ReviewRecord>;
		if (typeof raw.sha !== "string" || typeof raw.at !== "number" || typeof raw.promptId !== "string" || !(String(raw.verdict) in RANK)) return undefined;
		return { sha: raw.sha, verdict: raw.verdict as Verdict, promptId: raw.promptId, at: raw.at };
	} catch {
		return undefined;
	}
}

/** Another local user could plant records in a shared temp folder: only trust our own. */
function ownDir(dir: string): boolean {
	const uid = process.getuid?.();
	return uid === undefined || statSync(dir).uid === uid;
}

function prune(dir: string, now = Date.now()): void {
	for (const name of readdirSync(dir)) {
		try {
			const path = join(dir, name);
			if (now - statSync(path).mtimeMs > MAX_AGE_MS) rmSync(path, { force: true });
		} catch {
			// raced with another hook: ignore
		}
	}
}

function normalize(word: string): Verdict {
	const lower = word.toLowerCase();
	return lower === "yes" ? "Yes" : lower === "no" ? "No" : lower === "with fixes" ? "With fixes" : "Inconclusive";
}

function worst(verdicts: Verdict[]): Verdict {
	return verdicts.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

function short(sha: string): string {
	return sha.slice(0, 7);
}

function safe(id: string): string {
	return id.replace(/[^\w-]/g, "_").slice(0, 80) || "none";
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function hash(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, path);
}

function git(cwd: string, args: string[]): string | undefined {
	return gitRaw(cwd, args)?.trim();
}

/** git output as is: a diff's trailing whitespace is part of the change. Paths are never quoted. */
function gitRaw(cwd: string, args: string[]): string | undefined {
	const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
	return r.status === 0 ? r.stdout : undefined;
}
