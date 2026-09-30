/**
 * Review gate: code reaches the base branch (a PR/MR, a merge into it or a push to it) only after
 * a reviewer passed it. Verdicts are recorded from the reviewer's own report (never by the main
 * agent), one file per reviewer run, and match a commit by the branch's own diff: deleting task
 * files, changing docs or rebasing onto a newer base keeps a review valid; changing code doesn't.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { splitSegments, tokenize, type GuardDecision } from "./patterns.ts";
import { baseBranch, currentBranch, landing, pushedToBase } from "./workdocs.ts";

export type Verdict = "Yes" | "With fixes" | "No" | "Inconclusive";

/** One reviewer run's verdict on one commit. */
export interface ReviewRecord {
	/** The full SHA the reviewer reviewed. */
	sha: string;
	verdict: Verdict;
	/** Reviews from one user prompt combine (parallel reviewers); a later prompt replaces them. */
	promptId: string;
	at: number;
}

export interface ReviewGateOptions {
	/** Task-file directories: deleting task files after a review doesn't invalidate it. */
	workDocs: string[];
	/** What happens when no passing review covers the commit: deny, or ask the human. */
	missing: "block" | "confirm";
	/** How the user turns the gate off, named in the reason. */
	waiver: string;
}

const RANK: Record<Verdict, number> = { Yes: 0, "With fixes": 1, Inconclusive: 2, No: 3 };
// A verdict word followed by `/` or `|` is the unfilled template line, not a verdict.
const VERDICT = /Ready to merge[*_]*:[*_\s]*(Yes|No|With fixes|Inconclusive)\b(?![*_\s]*[/|])/gi;
const HEAD = /Reviewed HEAD[*_]*:[*_\s`]*([0-9a-f]{7,40})\b/gi;
/** Markdown in these steers the agent (manifests, rules, skills, prompts), so it is code for the gate. */
const RULE_FILES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "SKILL.md"]);
const RULE_DIRS = new Set([".claude", ".pi", "rules", "skills", "agents", "prompts"]);
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CANDIDATES = 20;

/** The verdict and SHA in a reviewer's report. Several reports (parallel reviewers) give the worst verdict. */
export function parseReview(text: string): { sha: string; verdict: Verdict } | undefined {
	const verdicts = [...text.matchAll(VERDICT)].map((m) => normalize(m[1]!));
	const shas = new Set([...text.matchAll(HEAD)].map((m) => m[1]!.toLowerCase()));
	if (verdicts.length === 0 || shas.size !== 1) return undefined;
	return { sha: [...shas][0]!, verdict: worst(verdicts) };
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

/** Record a verdict directly (a reviewer run that failed counts as Inconclusive). */
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
		const prompt = records.filter((r) => r.promptId === latest.promptId);
		combined.push({ ...latest, verdict: worst(prompt.map((r) => r.verdict)) });
	}
	return combined.sort((a, b) => b.at - a.at);
}

/**
 * Block (or ask before) landing code on the base branch that no passing review covers. `cwd` is where the
 * command starts; `cd <dir>` and `git -C <dir>` in it are followed, so a worktree's branch is checked there.
 */
export function checkReview(command: string, cwd: string, projectDir: string, options: ReviewGateOptions, root?: string): GuardDecision | undefined {
	let dir = cwd;
	let moved = false;
	for (const tokens of splitSegments(tokenize(command))) {
		if ((tokens[0] === "cd" || tokens[0] === "pushd") && tokens[1]) {
			dir = resolve(dir, tokens[1]);
			continue;
		}
		const l = landing(tokens);
		if (!l) continue;
		const where = "dir" in l && l.dir ? resolve(dir, l.dir) : dir;
		if (git(where, ["rev-parse", "--git-dir"]) === undefined) continue;
		const base = baseBranch(where);
		if (!base) continue;
		const onBase = currentBranch(where) === base;
		// After a switch or commit in the same command, a merge may land on the base: its target is unknown.
		if (moved && l.kind === "merge") {
			return decision(options.missing, "this command moves HEAD before it merges, so the guard can't see where the merge lands. Run the merge as its own command.", options);
		}
		if (l.kind === "commit" || l.kind === "head" || (l.kind === "merge" && !onBase)) {
			moved = true;
			continue;
		}
		const refs = l.kind === "pr" ? prRefs(where, l.target) : l.kind === "merge" ? l.refs : pushedToBase(l, base, onBase);
		if (refs.length === 0) continue;
		if (moved) {
			return decision(options.missing, "this command commits or moves HEAD before it lands, so the guard can't see what it lands. Run the landing as its own command.", options);
		}
		for (const ref of refs) {
			if (ref === undefined) {
				return { action: "confirm", reason: `Review gate: can't tell locally which commit this PR/MR merge lands (${l.kind === "pr" ? l.target : ""}). Check that its head commit has a Yes review, or switch to its branch and merge from there.` };
			}
			const problem = uncovered(where, projectDir, base, ref, options, root);
			if (problem) return decision(options.missing, problem, options);
		}
	}
	return undefined;
}

/**
 * Commands that write the review gate's own state: a stamp file (block) or the guard config (ask).
 * The path rules cover Edit/Write; this covers the shell. An interpreter one-liner can still hide a path.
 */
export function checkGateFiles(command: string, guardConfig: string): GuardDecision | undefined {
	for (const tokens of splitSegments(tokenize(command))) {
		if (tokens.some((t) => t.replaceAll("\\", "/").includes("eng-kit/reviews"))) {
			return { action: "block", reason: "Review stamps are written only by the guard, from the reviewer's own report. Dispatch the reviewer instead." };
		}
		const readOnly = ["cat", "less", "head", "tail", "grep", "rg", "jq", "git", "diff", "ls", "wc"].includes(tokens[0] ?? "") && !tokens.some((t) => t.startsWith(">"));
		if (!readOnly && tokens.some((t) => t.replace(/^\.\//, "").endsWith(guardConfig))) {
			return { action: "confirm", reason: `This command may change ${guardConfig}, which decides what the guard blocks. Loosening it is the user's call; show them the change first.` };
		}
	}
	return undefined;
}

/** The ref a PR/MR command lands: HEAD, or the named branch; `undefined` when it names a number or URL. */
function prRefs(where: string, target: string | undefined): Array<string | undefined> {
	if (target === undefined) return ["HEAD"];
	if (/^\d+$/.test(target) || target.includes("://") || target.startsWith("#") || target.startsWith("!")) return [undefined];
	for (const ref of [`refs/heads/${target}`, `refs/remotes/origin/${target}`]) {
		if (git(where, ["rev-parse", "--verify", "--quiet", ref])) return [ref];
	}
	return [undefined];
}

function uncovered(where: string, projectDir: string, base: string, ref: string, options: ReviewGateOptions, root?: string): string | undefined {
	const sha = git(where, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	if (!sha) return `can't resolve ${ref}.`;
	const upstream = git(where, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`]) ? `refs/remotes/origin/${base}` : base;
	const prefix = git(projectDir, ["rev-parse", "--show-prefix"]) ?? "";
	const own = ownChange(where, upstream, sha, prefix, options.workDocs);
	if (own === undefined) return `can't compare ${short(sha)} with ${upstream}.`;
	if (own === "") return undefined;

	const reviews = readReviews(projectDir, root).slice(0, CANDIDATES);
	const match = reviews.find((r) => r.sha === sha) ?? reviews.find((r) => ownChange(where, upstream, r.sha, prefix, options.workDocs) === own);
	if (!match) {
		const last = reviews[0];
		return last ? `the last review covers ${short(last.sha)}; ${short(sha)} changes code it didn't see.` : `no reviewer verdict recorded for ${short(sha)}.`;
	}
	// "With fixes" passes only after the fixes and a re-review of them, which gives a new verdict.
	if (match.verdict !== "Yes") return `the review of ${short(match.sha)} returned "${match.verdict}".`;
	return undefined;
}

/**
 * The branch's own change to reviewable files, as a patch id: "" when it changes none, undefined when git fails.
 * The same code change on a newer base, or with docs and task files changed around it, gives the same id.
 */
function ownChange(where: string, upstream: string, sha: string, prefix: string, workDocs: string[]): string | undefined {
	const fork = git(where, ["merge-base", upstream, sha]);
	if (!fork) return undefined;
	const names = git(where, ["diff", "--name-only", "--no-renames", fork, sha]);
	if (names === undefined) return undefined;
	const files = names.split("\n").filter((p) => p && !exempt(p, prefix, workDocs));
	if (files.length === 0) return "";
	const diff = git(where, ["diff", "--no-renames", "--no-ext-diff", fork, sha, "--", ...files.map((f) => `:(top)${f}`)]);
	if (diff === undefined) return undefined;
	const id = spawnSync("git", ["patch-id", "--stable"], { cwd: where, input: `${diff}\n`, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
	return id.status === 0 ? (id.stdout.split(" ")[0] ?? "").trim() || `raw:${hash(diff)}` : undefined;
}

/** Task files, `docs/` and other markdown need no review, except markdown that steers the agent. */
export function exempt(repoPath: string, prefix: string, workDocs: string[]): boolean {
	if (!repoPath.startsWith(prefix)) return false;
	const path = repoPath.slice(prefix.length);
	if (workDocs.some((d) => path.startsWith(`${d.replace(/\/+$/, "")}/`))) return true;
	const parts = path.split("/");
	const name = parts[parts.length - 1]!;
	if (RULE_FILES.has(name) || parts.slice(0, -1).some((d) => RULE_DIRS.has(d))) return false;
	return parts[0] === "docs" || /\.mdx?$/i.test(name);
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

function hash(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, path);
}

function git(cwd: string, args: string[]): string | undefined {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
	return r.status === 0 ? r.stdout.trim() : undefined;
}
