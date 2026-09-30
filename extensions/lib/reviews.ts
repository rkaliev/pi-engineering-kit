/**
 * Review gate: code reaches the base branch (a PR/MR, a merge into it or a push to it) only after
 * a reviewer passed the commit being landed. The stamp is written from the reviewer's own report
 * (never by the main agent), and a later commit that changes more than task files or ignored
 * paths needs a new review.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isIgnored } from "./commands.ts";
import type { GuardDecision } from "./patterns.ts";
import { landingRefs } from "./workdocs.ts";

export type Verdict = "Yes" | "With fixes" | "No" | "Inconclusive";

export interface ReviewStamp {
	/** The full SHA the reviewer reviewed. */
	sha: string;
	verdict: Verdict;
	/** Reviews from one user prompt merge (parallel reviewers); a later prompt replaces the stamp. */
	promptId?: string;
	at: number;
}

export interface ReviewGateOptions {
	/** Paths that need no review (verify.json `ignore`, docs by default). */
	ignore: string[];
	/** Task-file directories: deleting task files after a review doesn't invalidate it. */
	workDocs: string[];
	/** What happens when no passing review covers the commit: deny, or ask the human. */
	missing: "block" | "confirm";
}

const RANK: Record<Verdict, number> = { Yes: 0, "With fixes": 1, Inconclusive: 2, No: 3 };
const VERDICT = /Ready to merge[*_]*:[*_\s]*(Yes|No|With fixes|Inconclusive)\b/gi;
const HEAD = /Reviewed HEAD[*_]*:[*_\s`]*([0-9a-f]{7,40})\b/gi;

/** The verdict and SHA in a reviewer's report. Several reports (parallel reviewers) give the worst verdict. */
export function parseReview(text: string): { sha: string; verdict: Verdict } | undefined {
	const verdicts = [...text.matchAll(VERDICT)].map((m) => normalize(m[1]!));
	const shas = new Set([...text.matchAll(HEAD)].map((m) => m[1]!.toLowerCase()));
	if (verdicts.length === 0 || shas.size !== 1) return undefined;
	return { sha: [...shas][0]!, verdict: worst(verdicts) };
}

/** Record a reviewer's report as the project's review stamp. Returns the stamp, or why none was written. */
export function recordReview(projectDir: string, text: string, promptId?: string, root?: string): ReviewStamp | string {
	const parsed = parseReview(text);
	if (!parsed) return "the report has no single `Reviewed HEAD: <sha>` line with a `Ready to merge:` verdict";
	const sha = git(projectDir, ["rev-parse", "--verify", "--quiet", `${parsed.sha}^{commit}`]);
	if (!sha) return `Reviewed HEAD ${parsed.sha} is not a commit in this repository`;
	const previous = readReview(projectDir, root);
	const merge = previous && promptId && previous.promptId === promptId && previous.sha === sha;
	const stamp: ReviewStamp = { sha, verdict: merge ? worst([previous.verdict, parsed.verdict]) : parsed.verdict, promptId, at: Date.now() };
	writeAtomic(reviewFile(projectDir, root), JSON.stringify(stamp));
	return stamp;
}

/** Block (or ask before) landing code on the base branch that no passing review covers. */
export function checkReview(command: string, projectDir: string, options: ReviewGateOptions, root?: string): GuardDecision | undefined {
	const target = landingRefs(command, projectDir);
	if (!target) return undefined;
	const stamp = readReview(projectDir, root);
	for (const ref of target.refs) {
		const sha = git(projectDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		if (!sha) continue;
		const fork = git(projectDir, ["merge-base", target.base, sha]);
		if (fork && onlyExempt(projectDir, fork, sha, options)) continue;
		const problem = uncovered(projectDir, sha, stamp, options);
		if (problem) return { action: options.missing, reason: `Review gate: ${problem} Run requesting-code-review on the branch and fix its findings first. A waiver is the user's call.` };
	}
	return undefined;
}

function uncovered(projectDir: string, sha: string, stamp: ReviewStamp | undefined, options: ReviewGateOptions): string | undefined {
	if (!stamp) return `no reviewer verdict recorded for ${short(sha)}.`;
	if (stamp.sha !== sha) {
		const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", stamp.sha, sha], { cwd: projectDir, timeout: 5000 }).status === 0;
		if (!ancestor || !onlyExempt(projectDir, stamp.sha, sha, options)) return `the last review covers ${short(stamp.sha)}, but ${short(sha)} changed code after it.`;
	}
	// "With fixes" passes only after the fixes and a re-review of them, which gives a new verdict.
	if (stamp.verdict !== "Yes") return `the review of ${short(stamp.sha)} returned "${stamp.verdict}".`;
	return undefined;
}

/** Every path changed between two commits is a task file or ignored, so it needs no review. */
function onlyExempt(projectDir: string, from: string, to: string, options: ReviewGateOptions): boolean {
	const out = git(projectDir, ["diff", "--name-only", from, to]);
	if (out === undefined) return false;
	const dirs = options.workDocs.map((d) => `${d.replace(/\/+$/, "")}/`);
	return out
		.split("\n")
		.filter(Boolean)
		.every((p) => dirs.some((d) => p.startsWith(d)) || isIgnored(p, options.ignore));
}

/** Where the review stamp for a project lives. Needs no environment, so every hook process agrees. */
export function reviewFile(projectDir: string, root = join(tmpdir(), "eng-kit", "reviews")): string {
	return join(root, `${createHash("sha1").update(resolve(projectDir)).digest("hex")}.json`);
}

export function readReview(projectDir: string, root?: string): ReviewStamp | undefined {
	try {
		const raw = JSON.parse(readFileSync(reviewFile(projectDir, root), "utf8")) as Partial<ReviewStamp>;
		if (typeof raw.sha !== "string" || typeof raw.at !== "number" || !(raw.verdict! in RANK)) return undefined;
		return { sha: raw.sha, verdict: raw.verdict!, promptId: typeof raw.promptId === "string" ? raw.promptId : undefined, at: raw.at };
	} catch {
		return undefined;
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

function writeAtomic(path: string, text: string): void {
	mkdirSync(resolve(path, ".."), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

function git(cwd: string, args: string[]): string | undefined {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
	return r.status === 0 ? r.stdout.trim() : undefined;
}
