/**
 * Review gate: code reaches the base branch (a PR/MR, a merge into it or a push to it) only after
 * a reviewer passed exactly the commit being landed. Verdicts are recorded from the reviewer's own
 * report (never by the main agent), one file per reviewer run. Any change after the review (a new
 * commit, an amend, a rebase, a docs edit) is a different commit and needs a new review.
 *
 * A verdict covers the range its reviewer names (`Reviewed BASE:`..`Reviewed HEAD:`). A commit is covered
 * when that range reaches back to the remote base, directly or through earlier rounds whose own ranges do:
 * a repeat round reviews only the new commits, and the chain keeps the whole branch reviewed.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { splitSegments, tokenize, type GuardDecision } from "./patterns.ts";
import { blankQuoted, follow, heredocs, MOVES, moveSegments, parseMove, plainShell, quotedSubstitutions, reachable, safeRealpath, segmentsOf, stripRedirects, Subshells, writes } from "./shell.ts";
import { projectRepos } from "./repos.ts";
import { baseBranch, currentBranch, landing, pushedToBase, type Landing } from "./workdocs.ts";

export type Verdict = "Yes" | "With fixes" | "No" | "Inconclusive";

/** One reviewer run's verdict on one commit. A run that failed counts as Inconclusive for the commit it reviewed. */
export interface ReviewRecord {
	sha: string;
	/** Where the reviewed range starts. Missing for a failed run and for records from before ranges were recorded. */
	base?: string;
	verdict: Verdict;
	/** Reviews from one user prompt combine (parallel reviewers); a later prompt replaces them. */
	promptId: string;
	at: number;
	/** The reviewer's report, so a repeat round reads the open findings from the store, not from the author. */
	report?: string;
}

/** What `recordVerdict` returns: the first record written, and why a verdict short of Yes missed a repository, if it did. */
export type RecordResult = ReviewRecord & { missed?: string };

/** The latest round of reviews of one commit: its reviewers' verdicts combined, and the ranges they covered. */
export interface ReviewRound {
	sha: string;
	verdict: Verdict;
	promptId: string;
	at: number;
	bases: string[];
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
const BASE = /Reviewed BASE[*_]*:[*_\s`]*([0-9a-f]{7,40})\b/gi;
/** Segments that may run before a landing in one command: they neither commit nor move a ref. */
const SAFE_COMMANDS = new Set(["cd", "pushd", "echo", "printf", "true", "sleep", "pwd"]);
const SAFE_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "add", "fetch", "remote", "branch"]);
const READ_ONLY = new Set(["cat", "less", "head", "tail", "grep", "rg", "ls", "wc", "diff", "stat", "file", "jq"]);
/** Options of READ_ONLY commands that write a file: `file -C` compiles a magic file, `less -o` keeps a log. */
const WRITING = { file: /^(-[a-zA-Z]*C|--compile)/, less: /^(-[a-zA-Z]*[oO]|--log-file|--LOG-FILE)/ } as Record<string, RegExp>;
const READ_ONLY_GIT = new Set(["diff", "show", "log", "status", "blame"]);
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REPORT = 200_000;
/** The PRs/MRs the agent opened: `{ "<branch>": <ms> }`, next to the verdict records. */
const PRS_FILE = "prs.json";
/** PR/MR creations seen before their call finished: `{ "<tool call id>": { prs: [{ branch, dir }], at, last } }`. */
const PENDING_FILE = "prs-pending.json";
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Rounds a chain may pass through back to the remote base. */
const MAX_CHAIN = 20;
/** git calls one coverage check may spend, well inside the hook's 10 s timeout. */
const MAX_CHAIN_CALLS = 300;
const GIT_TIMEOUT_MS = 5000;

/** The range and verdict in a reviewer's report. Several reports (parallel reviewers) give the worst verdict. */
export function parseReview(text: string): { base: string; sha: string; verdict: Verdict } | undefined {
	const verdicts = [...text.matchAll(VERDICT)].map((m) => normalize(m[1]!));
	const shas = new Set([...text.matchAll(HEAD)].map((m) => m[1]!.toLowerCase()));
	const bases = new Set([...text.matchAll(BASE)].map((m) => m[1]!.toLowerCase()));
	if (verdicts.length === 0 || shas.size !== 1 || bases.size !== 1) return undefined;
	return { base: [...bases][0]!, sha: [...shas][0]!, verdict: worst(verdicts) };
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
export function recordReview(projectDir: string, text: string, ids: { promptId: string; run: string }, root?: string, deadline?: number): RecordResult | string {
	const parsed = parseReview(text);
	if (!parsed) return "the report needs one `Reviewed BASE: <sha>` line, one `Reviewed HEAD: <sha>` line and one `Ready to merge:` verdict";
	return recordVerdict(projectDir, parsed.sha, parsed.verdict, ids, root, { base: parsed.base, report: text, deadline });
}

/** Record a verdict for a commit directly: a reviewer run that failed counts as Inconclusive for the commit it reviewed. */
export function recordVerdict(projectDir: string, rev: string, verdict: Verdict, ids: { promptId: string; run: string }, root?: string, extra: { base?: string; report?: string; deadline?: number } = {}): RecordResult | string {
	const { found, complete } = lookup(projectDir, rev, extra.deadline);
	// A repository that gave no answer may have the commit: that is a miss, not a commit that doesn't exist.
	if (found.length === 0) return `Reviewed HEAD ${rev} ${complete ? "is not a commit" : "could not be searched in time"} in ${here(projectDir)}`;
	// A SHA the reviewer wrote names one commit: different commits under one abbreviation get no verdict at all.
	if (HEX.test(rev) && new Set(found.map((f) => f.sha)).size > 1) return `Reviewed HEAD ${rev} names different commits in different repositories; give the full SHA`;
	// Each repository that has the commit (clones of one history share it) gets the record, with BASE resolved there.
	const bases = found.map(({ dir }) => (extra.base === undefined ? undefined : (resolveCommit(dir, extra.base, timeoutBefore(extra.deadline)) ?? undefined)));
	if (extra.base !== undefined && bases.every((b) => b === undefined)) return `Reviewed BASE ${extra.base} is not a commit in ${here(projectDir)}`;
	// One store that can't be written doesn't keep the record from the others.
	let first: ReviewRecord | undefined;
	let failure: string | undefined;
	for (const [i, { dir: repo, sha }] of found.entries()) {
		const base = bases[i];
		// A Yes counts only with its range; a verdict short of Yes holds a landing back without one (a shallow clone).
		if (extra.base !== undefined && !base && verdict === "Yes") continue;
		const record: ReviewRecord = { sha, base, verdict, promptId: ids.promptId, at: Date.now(), report: extra.report?.slice(0, MAX_REPORT) };
		const dir = repoStore(repo, root, extra.deadline);
		// The folder's own key is where nothing reads this repository's records: no answer is a miss.
		if (dir === undefined) {
			failure ??= `the store of ${repo} could not be resolved in time`;
			continue;
		}
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			if (!ownDir(dir)) {
				failure ??= `${dir} belongs to another user`;
				continue;
			}
			writeAtomic(join(dir, `${sha}.${safe(ids.promptId)}.${safe(ids.run)}.json`), JSON.stringify(record));
			prune(dir);
		} catch (err) {
			failure ??= `could not write ${dir}: ${(err as Error).message}`;
			continue;
		}
		first ??= record;
	}
	// A verdict that holds a landing back should reach every repository that has the commit, or a parallel Yes there
	// stands alone: the caller is told which way it missed, and the records written stay as they are.
	const missed = verdict !== "Yes" && (failure !== undefined || !complete) ? (failure ?? "a repository could not be searched in time") : undefined;
	if (first) return missed === undefined ? first : { ...first, missed };
	return failure ?? `Reviewed BASE ${extra.base} is not a commit in ${here(projectDir)}`;
}

/**
 * Hold a commit back where a verdict short of Yes may have missed it: Inconclusive for `rev` (callers pass their own
 * run id, so the reviewer's record keeps its report). Only when `rev` is missing, names no commit here or couldn't be
 * searched for in time does it fall back to each repository's HEAD, so unrelated repositories keep their verdicts.
 * `failed` is the caller's own `recordVerdict` result for `rev`: a lookup that already failed isn't repeated. Every
 * lookup ends by `deadline`. Returns why it could not hold the commit back everywhere, if so.
 */
export function holdBack(projectDir: string, rev: string | undefined, ids: { promptId: string; run: string }, root?: string, deadline?: number, failed?: string): string | undefined {
	// A lookup keeps the reserve for the stores: with less than that and a lookup's minimum left, none can answer.
	const late = () => deadline !== undefined && deadline - Date.now() < MIN_LOOKUP_MS + STORE_RESERVE_MS;
	let unsearched: string | undefined;
	if (rev !== undefined) {
		let held: RecordResult | string | undefined = failed?.startsWith(`Reviewed HEAD ${rev} `) ? failed : undefined;
		if (held === undefined) {
			if (late()) return "no time was left to hold it back";
			held = recordVerdict(projectDir, rev, "Inconclusive", ids, root, { deadline });
		}
		if (typeof held !== "string") return held.missed;
		// A record that couldn't be written is a miss; only a SHA that names no single commit here falls back to HEAD.
		if (!held.startsWith(`Reviewed HEAD ${rev} `)) return held;
		// The commit may be in the repository that didn't answer: holding each HEAD back doesn't cover it there.
		if (held.includes("could not be searched in time")) unsearched = held;
	}
	if (late()) return [unsearched, "no time was left to hold each repository's HEAD back"].filter(Boolean).join("; ");
	const heads = recordVerdict(projectDir, "HEAD", "Inconclusive", ids, root, { deadline });
	const missed = typeof heads === "string" ? heads : heads.missed;
	return [unsearched, missed].filter(Boolean).join("; ") || undefined;
}

/** Below this much time left a lookup isn't started: it couldn't answer and would only delay the warning. */
const MIN_LOOKUP_MS = 300;

/** A git timeout that ends by `deadline`, at most the usual one. */
function timeoutBefore(deadline: number | undefined): number {
	return deadline === undefined ? GIT_TIMEOUT_MS : Math.max(1, Math.floor(Math.min(GIT_TIMEOUT_MS, deadline - Date.now())));
}

/** A reviewer's hex abbreviation (or full SHA), as opposed to a ref name such as `HEAD`. */
const HEX = /^[0-9a-f]{4,40}$/i;
/** How long resolving a commit across a workspace's repositories may take, inside the hook's 10 s. */
const LOOKUP_BUDGET_MS = 4000;
/** What a lookup with a deadline leaves of it for resolving the stores it writes to. */
const STORE_RESERVE_MS = 1000;

/**
 * The commit `rev` names in `dir`, `undefined` when git says there is none, `null` when git gave no answer (a timeout).
 * A hex `rev` must abbreviate it: a branch or tag that happens to be named so doesn't count.
 */
function resolveCommit(dir: string, rev: string, timeout = GIT_TIMEOUT_MS): string | undefined | null {
	const r = spawnSync("git", ["-c", "core.quotePath=false", "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: dir, encoding: "utf8", timeout });
	if (r.status === null || r.error) return null;
	const sha = r.status === 0 ? r.stdout.trim() : "";
	return sha && (!HEX.test(rev) || sha.startsWith(rev.toLowerCase())) ? sha : undefined;
}

/**
 * The repositories where `rev` names a commit, with its SHA there: the project's own repository, or each repository
 * of a workspace (see `projectRepos`) that has it, as far as the lookup's time allows (a repository not reached
 * records nothing, so a landing from it is refused). Empty outside git and where no repository has it.
 */
export function commitRepos(projectDir: string, rev: string): Array<{ dir: string; sha: string }> {
	return lookup(projectDir, rev).found;
}

/** `commitRepos`, and whether every repository was searched within the time. */
function lookup(projectDir: string, rev: string, until?: number): { found: Array<{ dir: string; sha: string }>; complete: boolean } {
	const { kind, repos } = projectRepos(projectDir);
	const dirs = kind === "repo" ? [projectDir] : repos.map((r) => join(projectDir, r));
	// The time after the lookup is left for resolving and writing the stores of what it found.
	const deadline = Math.min(Date.now() + LOOKUP_BUDGET_MS, (until ?? Number.POSITIVE_INFINITY) - STORE_RESERVE_MS);
	let complete = true;
	// Each repository gets an equal share of the time left, so one slow repository can't starve the others.
	const found = dirs.flatMap((dir, i) => {
		const left = Math.floor((deadline - Date.now()) / (dirs.length - i));
		const sha = left > 0 ? resolveCommit(dir, rev, Math.min(GIT_TIMEOUT_MS, left)) : null;
		if (sha === null) complete = false;
		return sha ? [{ dir, sha }] : [];
	});
	return { found, complete };
}

/**
 * Where a landing's review records live: the project's store inside a repository; otherwise the store of the
 * repository the folder is a checkout of (keyed by its git common directory, so a worktree elsewhere or another
 * spelling of the path finds the same one); else the folder's own. Verdicts are read there only in a workspace, the
 * only place they are written to; PR branches, which only add landings to check, are read there whatever the folder is.
 */
function storeFor(projectDir: string, dir: string, records: "verdicts" | "prs"): string {
	const { kind } = projectRepos(projectDir);
	if (kind === "repo" || (records === "verdicts" && kind !== "workspace")) return projectDir;
	return git(dir, ["rev-parse", "--git-dir"]) !== undefined ? dir : projectDir;
}

/** Where a commit was looked for, for a message: this repository, or the workspace's repositories by name. */
function here(projectDir: string): string {
	const { kind, repos } = projectRepos(projectDir);
	return kind === "workspace" ? `any repository here (${repos.join(", ")})` : "this repository";
}

/** Recorded rounds per reviewed SHA, newest first: the latest prompt's reviews combined to the worst verdict. */
export function readReviews(projectDir: string, root?: string): ReviewRound[] {
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
	const combined: ReviewRound[] = [];
	for (const records of bySha.values()) {
		const latest = records.reduce((a, b) => (b.at > a.at ? b : a));
		const prompt = records.filter((r) => r.promptId === latest.promptId);
		const bases = [...new Set(prompt.flatMap((r) => (r.base ? [r.base] : [])))];
		combined.push({ sha: latest.sha, verdict: worst(prompt.map((r) => r.verdict)), promptId: latest.promptId, at: latest.at, bases });
	}
	return combined.sort((a, b) => b.at - a.at);
}

/**
 * Before a shell call runs: note the branch of a PR/MR it would open (`--head`/`-s`, else the current branch where
 * the command runs, following `cd` like checkReview). Where the guard can't follow the folder, or the segments
 * don't show the PR (a hidden landing the user confirmed), it notes the branch of every folder the command may
 * reach or names. settlePr registers them once the call has succeeded; a later push to such a branch updates the
 * PR, so it is a landing too.
 */
export function notePr(projectDir: string, callId: string, command: string, cwd: string, root?: string): void {
	const branches: Array<{ branch: string | undefined; dir: string }> = [];
	// Not the last step: a later step may fail after the PR exists, so a failed call still registers it.
	let last = true;
	// `gh pr create --head owner:branch` (a fork) pushes to `branch`. A PR from one of several folders is noted in
	// each, so the repository it lands in has it.
	const head = (l: Extract<Landing, { kind: "pr" }>) => l.target?.replace(/^[^:]+:/, "");
	const prBranches = (l: Extract<Landing, { kind: "pr" }>, dirs: string[]) =>
		(dirs.length > 0 ? dirs : head(l) !== undefined ? [cwd] : []).map((dir) => ({ branch: head(l) ?? currentBranch(dir), dir }));
	// Every folder the texts' moves may reach, and any folder a move names where the guard can't follow it.
	const anywhere = (texts: string[]) => [...texts.flatMap((t) => reachable(t, cwd).dirs), ...namedFolders(command, cwd)];
	if (hiddenLanding(command)) {
		// The segments may miss a PR (the user confirmed it): read the texts that show it, from any folder they may reach.
		const { text, substitutions } = heredocs(command);
		const subs = [...quotedSubstitutions(text), ...substitutions];
		const prs = [text, ...subs].flatMap((t) => segmentsOf(tokenize(stripRedirects(t))).map(({ raw }) => landing(raw.map((w) => w.replace(/^\(+|\)+$/g, "")).filter(Boolean))));
		const dirs = anywhere([text, ...subs]);
		for (const l of prs) if (l?.kind === "pr" && !l.merge && !l.repo) branches.push(...prBranches(l, dirs));
		last = false;
	}
	const shell = new Subshells(cwd, command);
	const segments = segmentsOf(tokenize(stripRedirects(command)));
	segments.forEach(({ raw, alone, before }, index) => {
		shell.enter(raw, before);
		const tokens = raw.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean);
		const l = landing(tokens);
		const dir = shell.dir;
		if (shell.move(raw, alone, before) === undefined && l?.kind === "pr" && !l.merge && !l.repo) {
			// After a move the guard doesn't follow (the user confirmed it), the PR may come from any folder the command may reach.
			const dirs = dir !== undefined ? [dir] : anywhere([command]);
			branches.push(...prBranches(l, dirs));
			if (index !== segments.length - 1) last = false;
		}
	});
	const unique = [...new Map(branches.filter((b) => b.branch !== undefined).map((b) => [`${b.dir}\0${b.branch}`, b])).values()];
	if (unique.length === 0) return;
	const pending = readJson(projectDir, PENDING_FILE, root);
	pending[callId] = { prs: unique, at: Date.now(), last };
	writeJson(projectDir, PENDING_FILE, pending, root);
}

/** After the call: register its noted PR branches if it succeeded (or failed after the PR step), forget them if not. */
export function settlePr(projectDir: string, callId: string, ok: boolean, root?: string): void {
	const pending = readJson(projectDir, PENDING_FILE, root);
	const noted = pending[callId] as { prs?: unknown; branches?: unknown; branch?: unknown; last?: unknown } | undefined;
	if (!noted) return;
	delete pending[callId];
	for (const [id, entry] of Object.entries(pending)) {
		if (Date.now() - Number((entry as { at?: unknown }).at ?? 0) > PENDING_MAX_AGE_MS) delete pending[id];
	}
	writeJson(projectDir, PENDING_FILE, pending, root);
	// An entry noted before 0.34.0 has `branches` (before 0.21.2 one `branch`), from the project folder.
	const legacy = (Array.isArray(noted.branches) ? noted.branches : [noted.branch]).map((branch: unknown) => ({ branch, dir: projectDir }));
	const entries = (Array.isArray(noted.prs) ? noted.prs : legacy) as Array<{ branch?: unknown; dir?: unknown }>;
	if (!ok && noted.last !== false) return;
	// A PR branch belongs to the repository it was opened from: in a workspace, its own store.
	const stores = new Map<string, string[]>();
	for (const { branch, dir } of entries) {
		if (typeof branch !== "string" || branch === "" || typeof dir !== "string") continue;
		const store = storeFor(projectDir, dir, "prs");
		stores.set(store, [...(stores.get(store) ?? []), branch]);
	}
	for (const [store, names] of stores) {
		const prs = readPrs(store, root);
		for (const branch of names) prs[branch] = Date.now();
		writePrs(store, prs, root);
	}
}

/**
 * The open PR branches a landing in `where` checks: its repository's, and in a workspace the folder's own store's too,
 * which holds PRs registered before 0.34.0 and ones whose folder the guard couldn't tell.
 */
function prBranches(projectDir: string, where: string, remote: string, anchor: string, root?: string): string[] {
	const store = storeFor(projectDir, where, "prs");
	const own = openPrBranches(store, where, remote, anchor, root);
	// The folder's entries may be another repository's: only their age, not this repository's refs, retires them.
	return store === projectDir ? own : [...new Set([...own, ...openPrBranches(projectDir, where, remote, anchor, root, Date.now(), false)])];
}

/**
 * Branches of the PRs the agent opened that are still open. A merged one is dropped once the PR's head as the
 * remote last showed it (`<remote>/<branch>`, else the local branch) is on `anchor` (unless `merged` is false: the
 * entries may be another repository's); so is one older than 30 days.
 */
export function openPrBranches(projectDir: string, where: string, remote: string, anchor: string, root?: string, now = Date.now(), merged = true): string[] {
	const prs = readPrs(projectDir, root);
	let changed = false;
	for (const [branch, at] of Object.entries(prs)) {
		const tip = git(where, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}^{commit}`]) ?? git(where, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
		if (now - at > MAX_AGE_MS || (merged && tip !== undefined && isAncestor(where, tip, anchor))) {
			delete prs[branch];
			changed = true;
		}
	}
	if (changed) writePrs(projectDir, prs, root);
	return Object.keys(prs);
}

function readPrs(projectDir: string, root?: string): Record<string, number> {
	const raw = readJson(projectDir, PRS_FILE, root);
	return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
}

function writePrs(projectDir: string, prs: Record<string, number>, root?: string): void {
	writeJson(projectDir, PRS_FILE, prs, root);
}

function readJson(projectDir: string, file: string, root?: string): Record<string, unknown> {
	try {
		const dir = reviewsDir(projectDir, root);
		if (!ownDir(dir)) return {};
		const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function writeJson(projectDir: string, file: string, value: Record<string, unknown>, root?: string): void {
	const dir = reviewsDir(projectDir, root);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (ownDir(dir)) writeAtomic(join(dir, file), JSON.stringify(value));
	} catch {
		// best effort: a lost entry only means a later push to that PR is not gated
	}
}

/**
 * The rounds of the chain that ends at `sha`, newest first: from the round recorded for `sha`, each round's base
 * (of parallel reviewers' bases, one that continues the chain) back to the round whose range starts on the remote
 * base. A failed run (no range), an empty range or a repeat ends it, and so do MAX_CHAIN links.
 */
export function reviewChain(projectDir: string, sha: string, root?: string): Array<{ sha: string; base: string | undefined; verdict: Verdict }> {
	const rounds = new Map(readReviews(projectDir, root).map((r) => [r.sha, r]));
	const base = baseBranch(projectDir);
	const anchor = base === undefined ? undefined : anchorRef(projectDir, "origin", base);
	const chain: Array<{ sha: string; base: string | undefined; verdict: Verdict }> = [];
	const seen = new Set<string>();
	for (let round = rounds.get(sha); round && !seen.has(round.sha) && chain.length < MAX_CHAIN; ) {
		seen.add(round.sha);
		const current = round;
		const ends = (b: string) => b === current.sha || (anchor !== undefined && isAncestor(projectDir, b, anchor));
		const next = round.bases.find((b) => rounds.has(b) && !ends(b)) ?? round.bases[0];
		chain.push({ sha: round.sha, base: next, verdict: round.verdict });
		if (next === undefined || ends(next)) break;
		round = rounds.get(next);
	}
	return chain;
}

/** The number of the round that follows `chain` (newest first), counted from the last Yes: a Yes closes a converged scope. */
export function roundNumber(chain: Array<{ verdict: Verdict }>): number {
	const yes = chain.findIndex((r) => r.verdict === "Yes");
	return (yes === -1 ? chain.length : yes) + 1;
}

/** The highest finding number per prefix (`F`, `S`, `T`, `C`) in the reports of the chain's rounds, so a new finding never reuses an old ID. */
export function highestFindingIds(projectDir: string, chain: Array<{ sha: string }>, root?: string): Record<string, number> {
	const highest: Record<string, number> = {};
	for (const { sha } of chain) {
		for (const { report } of readReports(projectDir, sha, root)) {
			for (const m of report.matchAll(/(?<![\w-])([FSTC])(\d{1,3})(?![\w-])/g)) highest[m[1]!] = Math.max(highest[m[1]!] ?? 0, Number(m[2]));
		}
	}
	return highest;
}

/** The reports of the latest round of reviews of `sha`, for a repeat round to re-check (see scripts/review-log.ts). */
export function readReports(projectDir: string, sha: string, root?: string): Array<{ run: string; verdict: Verdict; report: string }> {
	const dir = reviewsDir(projectDir, root);
	let names: string[];
	try {
		if (!ownDir(dir)) return [];
		names = readdirSync(dir).filter((n) => n.startsWith(`${sha}.`) && n.endsWith(".json"));
	} catch {
		return [];
	}
	const records = names.flatMap((name) => {
		const record = readRecord(join(dir, name));
		return record ? [{ run: name.split(".")[2] ?? "none", record }] : [];
	});
	const latest = records.reduce<(typeof records)[number] | undefined>((a, b) => (!a || b.record.at > a.record.at ? b : a), undefined);
	if (!latest) return [];
	return records
		.filter((r) => r.record.promptId === latest.record.promptId)
		.map((r) => ({ run: r.run, verdict: r.record.verdict, report: r.record.report ?? "(no report stored for this run)" }));
}

/**
 * Block (or ask before) landing code on the base branch that no passing review covers. `cwd` is where the
 * command starts; `cd <dir>` and `git -C <dir>` in it are followed, so a worktree's branch is checked there.
 * Anything the guard can't follow (a variable, a nested subshell, another repository) fails closed.
 */
export function checkReview(command: string, cwd: string, projectDir: string, options: ReviewGateOptions, root?: string): GuardDecision | undefined {
	const visible = checkSegments(command, cwd, projectDir, options, root);
	if (hiddenLanding(command)) {
		// A question must still say why a landing the guard can see isn't covered.
		const also = visible?.reason ? ` Also: ${visible.reason}` : "";
		return decision(options.missing, `the guard can't read where this command lands: a heredoc body hides a landing, or one sits in a substitution in double quotes or in an unquoted heredoc body. Run the landing as its own command, outside any substitution.${also}`, options);
	}
	return visible;
}

/** The review gate over the landings the command's segments show. */
function checkSegments(command: string, cwd: string, projectDir: string, options: ReviewGateOptions, root?: string): GuardDecision | undefined {
	const shell = new Subshells(cwd, command);
	let unsafeBefore = false;
	for (const { raw, alone, before } of segmentsOf(tokenize(stripRedirects(command)))) {
		shell.enter(raw, before);
		const tokens = raw.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean);
		const l = landing(tokens);
		if (!l || l.kind === "commit") {
			if (shell.move(raw, alone, before) !== "plain" && !isSafe(tokens, options.verify)) unsafeBefore = true;
			continue;
		}
		const dir = shell.dir;
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
		const land = l.kind === "push" ? withDestination(l, where) : l;
		const remote = land.kind === "push" && land.remote ? land.remote : "origin";
		const refs = targets(land, where, base, land.kind === "push" ? prBranches(projectDir, where, remote, anchorRef(where, remote, base), root) : []);
		if (refs.length === 0) continue;
		if (unsafeBefore) {
			return decision(options.missing, "this command runs a step before it lands that may commit or move a ref (only read-only steps and the project's verification commands may come first), so the guard can't see what it lands. Run the landing as its own command.", options);
		}
		for (const ref of refs) {
			if (ref === undefined) {
				return { action: "confirm", reason: "Review gate: can't tell locally which commit this PR/MR merge lands. Check that its head commit has a Yes review, or merge it by branch name." };
			}
			const problem = uncovered(where, projectDir, base, ref, remote, root);
			if (problem) return decision(options.missing, problem, options);
		}
	}
	return undefined;
}

/** The landings (not commits) of a command's segments, counted by what each lands where, so a message's text doesn't count. */
function landings(command: string): Map<string, number> {
	const found = new Map<string, number>();
	for (const { raw } of segmentsOf(tokenize(stripRedirects(command)))) {
		const words = raw.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean);
		const l = landing(words);
		if (l !== undefined && l.kind !== "commit") found.set(JSON.stringify(l), (found.get(JSON.stringify(l)) ?? 0) + 1);
	}
	return found;
}

/**
 * A landing the segments don't show: an apostrophe in a heredoc body opens a quote the shell never sees and
 * swallows the lines after it, and a substitution in double quotes stays one word although it runs.
 */
function hiddenLanding(command: string): boolean {
	const { text, substitutions } = heredocs(command);
	// Each landing as many times as it appears: a landing-like line in a heredoc body, or a repeat of a visible
	// landing, must not stand in for a hidden one.
	const seen = landings(command);
	return [...landings(text)].some(([l, n]) => n > (seen.get(l) ?? 0)) || [...quotedSubstitutions(text), ...substitutions].some((s) => landings(s).size > 0);
}

/** Folders named after any move word, `$(cd x`, `` `cd x`` and `(cd x` included, that exist from `cwd`. */
function namedFolders(command: string, cwd: string): string[] {
	const tokens = tokenize(command);
	return tokens.flatMap((t, i) => {
		if (!MOVES.has(t.split(/\$\(|`|\(/).pop()!)) return [];
		const arg = tokens.slice(i + 1).find((w) => !w.startsWith("-"))?.replace(/[)`]+$/, "");
		const dir = arg === undefined ? undefined : follow(cwd, arg);
		return dir === undefined ? [] : [dir];
	});
}

/**
 * The reviewer's shell (Claude Code tells the hook which subagent runs the call). Fail closed: only a short list
 * of inspection commands, git's read-only subcommands without their writing or program-running options, a
 * worktree at an absolute temp path for another revision, the project's verification commands and the kit's own
 * review-log. Anything the parser might misread (a backslash, `$`, backticks, parentheses, braces, `<`, a glob, `>`
 * other than the stderr and null redirections, a background `&`) is refused, so the reviewer can't change what it judges.
 */
export function checkReviewerCommand(command: string, cwd: string, verify: string[], kitRoot: string): GuardDecision | undefined {
	const refuse = (what: string): GuardDecision => ({
		action: "block",
		reason: `The reviewer is read-only: ${what} is not allowed in its shell. Use git diff/log/show/blame, \`git worktree add <absolute temp dir> <sha>\` for another revision, cat/head/tail/grep/wc/ls, the project's verification commands and review-log; read files with the Read and Grep tools.`,
	});
	// A glob (`*`, `?`, `[`) could expand into a planted file name such as `--output=a.txt`.
	if (/[\\$`(){}<*?[]/.test(command)) return refuse("a backslash, `$`, a backtick, parentheses, braces, `<` or a glob");
	const bare = command.replace(/(^|\s)(?:2>&1|2>\/dev\/null|&?>\/dev\/null)(?=\s|$)/g, " ");
	if (bare.includes(">") || /\btee\b/.test(bare)) return refuse("a writing redirection or tee");
	const all = tokenize(bare);
	if (all.includes("&")) return refuse("a background `&`");
	let dir = cwd;
	for (const tokens of splitSegments(all)) {
		if (tokens.length === 0) continue;
		if (tokens[0] === "cd") {
			const next = tokens.length === 2 && tokens[1] !== "-" ? follow(dir, tokens[1]) : undefined;
			if (next === undefined) return refuse(`\`${tokens.join(" ")}\` (a cd the guard can't follow)`);
			dir = next;
			continue;
		}
		if (!reviewerMay(tokens, dir, verify, kitRoot)) return refuse(`\`${tokens.join(" ")}\``);
	}
	return undefined;
}

/** Commands with no option that writes a file or runs a program. */
const REVIEWER_COMMANDS = new Set(["cat", "head", "tail", "grep", "wc", "ls", "pwd", "echo", "true"]);
const REVIEWER_GIT = new Set(["diff", "show", "log", "status", "blame", "rev-parse", "merge-base", "ls-files", "ls-tree", "cat-file", "shortlog", "describe"]);
/** git options that write a file or run a program; git accepts any unambiguous abbreviation of a long option. */
const GIT_WRITING_OPTIONS = ["--output", "--ext-diff"];

function reviewerMay(tokens: string[], dir: string, verify: string[], kitRoot: string): boolean {
	const [cmd = ""] = tokens;
	if (REVIEWER_COMMANDS.has(cmd)) return true;
	if (verify.some((v) => splitSegments(tokenize(v)).some((seg) => seg.length === tokens.length && seg.every((t, i) => t === tokens[i])))) return true;
	if (cmd === "node") return tokens.length === 3 && resolve(dir, tokens[1]!) === join(kitRoot, "scripts", "review-log.ts");
	if (cmd !== "git") return false;
	let i = 1;
	// Of git's own options only `-C <dir>` and `--no-pager`: `-c`, `--git-dir`, `--exec-path` and the rest are refused.
	while (tokens[i]?.startsWith("-")) {
		if (tokens[i] === "-C" && tokens[i + 1] !== undefined) i += 2;
		else if (tokens[i] === "--no-pager") i += 1;
		else return false;
	}
	const sub = tokens[i] ?? "";
	const args = tokens.slice(i + 1);
	const end = args.indexOf("--");
	const options = (end === -1 ? args : args.slice(0, end)).filter((t) => t.startsWith("--")).map((t) => t.split("=")[0]!);
	if (options.some((o) => o.length >= 4 && GIT_WRITING_OPTIONS.some((w) => w.startsWith(o)))) return false;
	if (REVIEWER_GIT.has(sub)) return true;
	if (sub !== "worktree") return false;
	const [action, ...rest] = args;
	if (action === "list") return rest.length === 0;
	const flags = rest.filter((t) => t.startsWith("-"));
	const positional = rest.filter((t) => !t.startsWith("-"));
	if (action === "add") return flags.every((f) => ["--detach", "-q", "--quiet"].includes(f)) && positional.length === 2 && inTemp(positional[0]!);
	if (action === "remove") return flags.every((f) => ["--force", "-f"].includes(f)) && positional.length === 1 && inTemp(positional[0]!);
	return false;
}

/** Whether an absolute path, written without `..`, is in the temp folder. */
function inTemp(path: string): boolean {
	if (!isAbsolute(path) || path.split(/[\\/]/).includes("..")) return false;
	const target = path.replaceAll("\\", "/");
	return [tmpdir(), safeRealpath(tmpdir()), "/tmp", "/private/tmp"].some((t) => target.startsWith(`${t.replaceAll("\\", "/")}/`));
}

/**
 * Commands that write the review gate's own state: a verdict record (block) or the guard config (ask).
 * The path rules cover Edit/Write; this covers the shell, following `cd`. An interpreter one-liner can still hide a path.
 */
export function checkGateFiles(command: string, cwd: string, projectDir: string, guardConfig: string): GuardDecision | undefined {
	const redirects = writes(command);
	const config = resolve(projectDir, guardConfig).replaceAll("\\", "/");
	const records = [join(tmpdir(), "eng-kit", "reviews"), safeRealpath(tmpdir()) + "/eng-kit/reviews"].map((p) => p.replaceAll("\\", "/"));
	const { dirs, unknown } = reachable(command, cwd);
	// The tokens lose the `<` of `<(…)`, so a process substitution is found in the text.
	const processSubst = /[<>]\(/.test(blankQuoted(command).replace(/\\./g, ""));
	// In a command the guard can't read (a comment or heredoc may swallow the next line), no step is read-only.
	const readable = plainShell(command);
	let ask: GuardDecision | undefined;
	for (const { full, words, redirected } of moveSegments(command)) {
		const tokens = full.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean);
		// A plain move writes nothing; a move with a redirection on it is checked like any command.
		const move = parseMove(words.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean));
		// A substitution runs its own command, and `--output` (or an abbreviation git accepts) makes git write a file.
		const runs = processSubst || tokens.some((t) => /\$\(|`/.test(t) || t.startsWith("--ou"));
		if (move !== undefined && move !== "other" && !redirected && !runs) continue;
		const sub = tokens.find((t, i) => i > 0 && !t.startsWith("-"));
		const readOnly = readable && !redirects && !runs && ((READ_ONLY.has(tokens[0] ?? "") && !tokens.some((t) => WRITING[tokens[0]!]?.test(t))) || (tokens[0] === "git" && READ_ONLY_GIT.has(sub ?? "")));
		if (readOnly) continue;
		// A path may follow `=` (`of=…`, `--output=…`), or be a word of a substitution kept whole by its quotes.
		const inner = (t: string) => (/\$\(|`/.test(t) ? tokenize(t.replace(/^.*?(\$\(|`)/, "").replace(/[)`]+$/, "")) : []);
		// zsh's `>!` loses only its `>` to the tokens.
		const candidates = tokens.flatMap((t) => [t, t.slice(t.indexOf("=") + 1), t.replace(/^!/, ""), ...inner(t)]);
		const paths = dirs.flatMap((dir) => candidates.map((t) => resolve(dir, t.replace(/^~(?=\/)/, homedir())).replaceAll("\\", "/")));
		const named = candidates.some((t) => [t, posix.normalize(t)].some((p) => /^\$\{?TMPDIR\}?\/*eng-kit\/reviews(\/|$)/.test(p)));
		if (named || paths.some((p) => records.some((r) => p === r || p.startsWith(`${r}/`)))) {
			return { action: "block", reason: "Review records are written only by the guard, from the reviewer's own report. Dispatch the reviewer instead." };
		}
		if (paths.includes(config) || tokens.some((t) => t.endsWith(guardConfig))) {
			ask ??= { action: "confirm", reason: `This command may change ${guardConfig}, which decides what the guard blocks. Loosening it is the user's call; show them the change first.` };
		}
		if (unknown) {
			ask ??= { action: "confirm", reason: "This command changes folders in a form the guard doesn't follow (a variable, several operands, a comment or substitution, a move inside a group, pipeline or condition), so it can't tell whether a later step writes into the review records. Use a plain `cd <folder>`, or confirm." };
		}
	}
	return ask;
}

function isSafe(tokens: string[], verify: string[]): boolean {
	// `rg --pre <program>` runs that program on every file it searches.
	if (tokens[0] === "rg" && tokens.some((t) => t.startsWith("--pre"))) return false;
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

/**
 * A push without a refspec goes where git's push config sends it (`push.default`, upstream, `pushRemote`):
 * `@{push}` names that branch. Used when the command names no remote or the same one; otherwise, or when git
 * can't tell, the push keeps the current branch's name.
 */
function withDestination(l: Extract<Landing, { kind: "push" }>, where: string): Extract<Landing, { kind: "push" }> {
	if (l.refspecs.length > 0 || l.all || l.tags) return l;
	const dest = pushDestination(where);
	if (!dest || (l.remote !== undefined && l.remote !== dest.remote)) return l;
	return { ...l, remote: dest.remote, refspecs: [`HEAD:${dest.branch}`] };
}

/**
 * Where a plain `git push` sends the current branch: the remote and the branch on it. `@{push}` is a
 * remote-tracking ref, named by the fetch refspec, so when it is the upstream (`push.default=upstream`) the remote
 * and branch come from `branch.<name>.remote` and `.merge`; otherwise the branch is the current branch's own name.
 */
function pushDestination(where: string): { remote: string; branch: string } | undefined {
	const full = git(where, ["rev-parse", "--symbolic-full-name", "@{push}"]);
	const current = currentBranch(where);
	if (!full?.startsWith("refs/remotes/") || !current) return undefined;
	if (full === git(where, ["rev-parse", "--symbolic-full-name", "@{upstream}"])) {
		const remote = git(where, ["config", `branch.${current}.remote`]);
		const merge = git(where, ["config", `branch.${current}.merge`]);
		return remote && remote !== "." && merge?.startsWith("refs/heads/") ? { remote, branch: merge.slice("refs/heads/".length) } : undefined;
	}
	// Pushing to the same name: the remote is the one whose tracking refs hold `@{push}`; a remote's name may contain `/`.
	const name = full.slice("refs/remotes/".length);
	const remote = lines(git(where, ["remote"])).filter((r) => name.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
	return remote === undefined ? undefined : { remote, branch: current };
}

function landsOnBase(l: Extract<Landing, { kind: "merge" }>, dir: string): boolean {
	const where = l.dir ? follow(dir, l.dir) : dir;
	if (where === undefined) return true;
	const base = baseBranch(where);
	return base !== undefined && currentBranch(where) === base;
}

/** The refs a landing puts on the base; `undefined` for a PR/MR merge whose head isn't known locally. */
function targets(l: Exclude<Landing, { kind: "commit" }>, where: string, base: string, prBranches: string[]): Array<string | undefined> {
	const current = currentBranch(where);
	const onBase = current === base;
	if (l.kind === "merge") return l.refs;
	// A push to the branch of an open PR updates the PR, so it lands like a push to the base.
	if (l.kind === "push") return [...pushedToBase(l, base, onBase), ...prBranches.flatMap((b) => pushedToBase(l, b, current === b))];
	if (l.target !== undefined && (/^\d+$/.test(l.target) || l.target.includes("://") || /^[#!]/.test(l.target))) return [undefined];
	if (!l.merge && l.target === undefined) return ["HEAD"];
	const branch = l.target ?? currentBranch(where);
	if (!branch) return [undefined];
	// gh merges the remote head: check it, and the local branch too when it differs.
	const refs = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`].filter((r) => git(where, ["rev-parse", "--verify", "--quiet", r]));
	return refs.length === 0 ? [undefined] : refs;
}

function uncovered(where: string, projectDir: string, base: string, ref: string, remote: string, root?: string): string | undefined {
	const sha = git(where, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	if (!sha) return `can't resolve ${ref}.`;
	// Already on the remote's base branch: nothing new lands. Only a remote-tracking ref proves that; the
	// local base branch never does, since unreviewed commits may sit on it.
	const tracking = `refs/remotes/${remote}/${base}`;
	const landed = git(where, ["rev-parse", "--verify", "--quiet", tracking]) !== undefined && isAncestor(where, sha, tracking);
	if (landed) return undefined;

	// A verdict covers exactly the commit the reviewer reviewed: anything else is a change it didn't see. In a
	// workspace the verdicts are the landing repository's.
	const reviews = readReviews(storeFor(projectDir, where, "verdicts"), root);
	const match = reviews.find((r) => r.sha === sha);
	if (!match) {
		// Name an earlier review only when it was of this branch (an ancestor): then the branch changed after it.
		const earlier = reviews.find((r) => isAncestor(where, r.sha, sha));
		return earlier
			? `no reviewer verdict recorded for ${short(sha)}; the last review of this branch covers ${short(earlier.sha)}, and the branch changed after it (a new commit, an amend or a rebase), so it needs a new review.`
			: `no reviewer verdict recorded for ${short(sha)}.`;
	}
	// "With fixes" passes only after the fixes and a re-review of them, which gives a new verdict.
	if (match.verdict !== "Yes") return `the review of ${short(match.sha)} returned "${match.verdict}".`;
	// The reviewed range must reach the remote base, directly or through earlier rounds. Without a tracking
	// ref (no remote) the local base branch is all there is.
	const chain: Chain = { where, rounds: reviews, anchor: anchorRef(where, remote, base), memo: new Map(), ancestors: new Map(), calls: 0 };
	const anchor = chain.anchor;
	if (match.bases.some((b) => chainOk(chain, b, sha, 1))) return undefined;
	if (chain.calls >= MAX_CHAIN_CALLS) return `the review of ${short(sha)} chains through more review rounds than the guard checks (${MAX_CHAIN_CALLS} git calls). Review the whole branch from its merge-base.`;
	const range = match.bases.length > 0 ? `${short(match.bases[0]!)}..${short(sha)}` : "no recorded range (a review from before ranges were recorded)";
	return `the review of ${short(sha)} does not cover the whole branch: it covers ${range}, and nothing reviewed connects it to ${anchor.replace(/^refs\/(remotes|heads)\//, "")}. Review the whole branch from its merge-base, or the commits before ${short(match.bases[0] ?? sha)}.`;
}

/**
 * What a review chain must reach: the push remote's base branch, else origin's, else any remote's. Only a
 * repository with no remote-tracking ref for the base at all anchors on the local base branch.
 */
function anchorRef(where: string, remote: string, base: string): string {
	for (const ref of [`refs/remotes/${remote}/${base}`, `refs/remotes/origin/${base}`]) {
		if (git(where, ["rev-parse", "--verify", "--quiet", ref])) return ref;
	}
	const other = lines(git(where, ["for-each-ref", "--format=%(refname)", "refs/remotes/"])).find((r) => r === `refs/remotes/${r.split("/")[2]}/${base}`);
	return other ?? `refs/heads/${base}`;
}

function lines(text: string | undefined): string[] {
	return (text ?? "").split("\n").filter(Boolean);
}

/** One coverage check: the rounds, the anchor, memoized answers and a budget of git calls. */
interface Chain {
	where: string;
	rounds: ReviewRound[];
	anchor: string;
	memo: Map<string, boolean>;
	ancestors: Map<string, boolean>;
	calls: number;
}

/**
 * Whether `base..sha` is a real range that reaches the anchor, directly or through recorded rounds (any verdict:
 * a repeat round re-checks them). A repeat round must start at the newest reviewed commit below it, so no
 * round's findings are skipped. Answers are memoized, and the git calls are budgeted: past the budget the
 * range doesn't count, so a large history can't stall the hook into its timeout.
 */
function chainOk(chain: Chain, base: string, sha: string, links: number): boolean {
	const key = `${base}..${sha}@${links}`;
	const known = chain.memo.get(key);
	if (known !== undefined) return known;
	let ok = false;
	if (links <= MAX_CHAIN && base !== sha && ancestor(chain, base, sha)) {
		if (ancestor(chain, base, chain.anchor)) ok = true;
		else {
			const round = chain.rounds.find((r) => r.sha === base);
			const inside = between(chain, base, sha);
			const skipped = inside === undefined || chain.rounds.some((r) => r.sha !== sha && inside.has(r.sha));
			ok = round !== undefined && !skipped && round.bases.some((b) => chainOk(chain, b, base, links + 1));
		}
	}
	chain.memo.set(key, ok);
	return ok;
}

/** The commits in `base..sha` (one git call), or undefined past the budget or on an error. */
function between(chain: Chain, base: string, sha: string): Set<string> | undefined {
	if (chain.calls >= MAX_CHAIN_CALLS) return undefined;
	chain.calls++;
	const out = git(chain.where, ["rev-list", `${base}..${sha}`]);
	return out === undefined ? undefined : new Set(lines(out));
}

function ancestor(chain: Chain, a: string, b: string): boolean {
	const key = `${a} ${b}`;
	const known = chain.ancestors.get(key);
	if (known !== undefined) return known;
	if (chain.calls >= MAX_CHAIN_CALLS) return false;
	chain.calls++;
	const result = isAncestor(chain.where, a, b);
	chain.ancestors.set(key, result);
	return result;
}

function isAncestor(where: string, ancestor: string, rev: string): boolean {
	return spawnSync("git", ["merge-base", "--is-ancestor", ancestor, rev], { cwd: where, timeout: 5000 }).status === 0;
}

/**
 * Where a project's review records live: keyed by the repository's git common directory (real path), so the
 * hook, a subfolder and every worktree of the repository agree. Outside a repository, by the folder itself.
 */
export function reviewsDir(projectDir: string, root?: string): string {
	return storeOf(projectDir, root) ?? join(root ?? DEFAULT_ROOT, hash(safeRealpath(resolve(projectDir))));
}

/** `reviewsDir` of a repository, resolved by `deadline`: `undefined` when git gave no answer in time. */
function repoStore(repo: string, root?: string, deadline?: number): string | undefined {
	if (deadline !== undefined && deadline - Date.now() < MIN_LOOKUP_MS) return undefined;
	return storeOf(repo, root, timeoutBefore(deadline));
}

const DEFAULT_ROOT = join(tmpdir(), "eng-kit", "reviews");

/** The store keyed by a folder's git common directory, or `undefined` when git names none (or no answer in time). */
function storeOf(folder: string, root = DEFAULT_ROOT, timeout?: number): string | undefined {
	const dir = resolve(folder);
	const common = git(dir, ["rev-parse", "--git-common-dir"], timeout);
	return common ? join(root, hash(safeRealpath(resolve(dir, common)))) : undefined;
}

function decision(action: "block" | "confirm", problem: string, options: ReviewGateOptions): GuardDecision {
	return { action, reason: `Review gate: ${problem} Run requesting-code-review on the branch and fix its findings first. Only the user can waive the gate (${options.waiver}).` };
}

function readRecord(path: string): ReviewRecord | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ReviewRecord>;
		if (typeof raw.sha !== "string" || typeof raw.at !== "number" || typeof raw.promptId !== "string" || !(String(raw.verdict) in RANK)) return undefined;
		const base = typeof raw.base === "string" ? raw.base : undefined;
		const report = typeof raw.report === "string" ? raw.report : undefined;
		return { sha: raw.sha, base, verdict: raw.verdict as Verdict, promptId: raw.promptId, at: raw.at, report };
	} catch {
		return undefined;
	}
}

/** Another local user could plant records in a shared temp folder: only trust our own. */
export function ownDir(dir: string): boolean {
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

export function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, path);
}

function git(cwd: string, args: string[], timeout?: number): string | undefined {
	return gitRaw(cwd, args, timeout)?.trim();
}

/** git output as is. Paths are never quoted. */
function gitRaw(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): string | undefined {
	const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
	return r.status === 0 ? r.stdout : undefined;
}
