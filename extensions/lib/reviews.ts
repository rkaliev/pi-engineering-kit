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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { splitSegments, tokenize, type GuardDecision } from "./patterns.ts";
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
const READ_ONLY_GIT = new Set(["diff", "show", "log", "status", "blame"]);
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REPORT = 200_000;
/** The PRs/MRs the agent opened: `{ "<branch>": <ms> }`, next to the verdict records. */
const PRS_FILE = "prs.json";
/** PR/MR creations seen before their call finished: `{ "<tool call id>": { branch, at } }`. */
const PENDING_FILE = "prs-pending.json";
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Rounds a chain may pass through back to the remote base. */
const MAX_CHAIN = 20;
/** git calls one coverage check may spend, well inside the hook's 10 s timeout. */
const MAX_CHAIN_CALLS = 300;

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
export function recordReview(projectDir: string, text: string, ids: { promptId: string; run: string }, root?: string): ReviewRecord | string {
	const parsed = parseReview(text);
	if (!parsed) return "the report needs one `Reviewed BASE: <sha>` line, one `Reviewed HEAD: <sha>` line and one `Ready to merge:` verdict";
	return recordVerdict(projectDir, parsed.sha, parsed.verdict, ids, root, { base: parsed.base, report: text });
}

/** Record a verdict for a commit directly: a reviewer run that failed counts as Inconclusive for the commit it reviewed. */
export function recordVerdict(projectDir: string, rev: string, verdict: Verdict, ids: { promptId: string; run: string }, root?: string, extra: { base?: string; report?: string } = {}): ReviewRecord | string {
	const sha = git(projectDir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
	if (!sha) return `Reviewed HEAD ${rev} is not a commit in this repository`;
	const base = extra.base === undefined ? undefined : git(projectDir, ["rev-parse", "--verify", "--quiet", `${extra.base}^{commit}`]);
	if (extra.base !== undefined && !base) return `Reviewed BASE ${extra.base} is not a commit in this repository`;
	const record: ReviewRecord = { sha, base, verdict, promptId: ids.promptId, at: Date.now(), report: extra.report?.slice(0, MAX_REPORT) };
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
 * the command starts, following `cd` like checkReview). settlePr registers it once the call has succeeded; a later
 * push to that branch updates the PR, so it is a landing too.
 */
export function notePr(projectDir: string, callId: string, command: string, cwd: string, root?: string): void {
	const shell = new Subshells(cwd, command);
	const segments = segmentsOf(tokenize(stripRedirects(command)));
	segments.forEach(({ raw, alone, before }, index) => {
		shell.enter(raw, before);
		const tokens = raw.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean);
		const l = landing(tokens);
		const dir = shell.dir;
		if (shell.move(raw, alone, before) === undefined && l?.kind === "pr" && !l.merge && !l.repo && dir !== undefined) {
			// `gh pr create --head owner:branch` (a fork) pushes to `branch`.
			const branch = l.target?.replace(/^[^:]+:/, "") ?? currentBranch(dir);
			if (branch) {
				const pending = readJson(projectDir, PENDING_FILE, root);
				// Not the last step: a later step may fail after the PR exists, so a failed call still registers it.
				pending[callId] = { branch, at: Date.now(), last: index === segments.length - 1 };
				writeJson(projectDir, PENDING_FILE, pending, root);
			}
		}
	});
}

/** After the call: register its noted PR branch if it succeeded (or failed after the PR step), forget it if not. */
export function settlePr(projectDir: string, callId: string, ok: boolean, root?: string): void {
	const pending = readJson(projectDir, PENDING_FILE, root);
	const noted = pending[callId] as { branch?: unknown; last?: unknown } | undefined;
	if (!noted) return;
	delete pending[callId];
	for (const [id, entry] of Object.entries(pending)) {
		if (Date.now() - Number((entry as { at?: unknown }).at ?? 0) > PENDING_MAX_AGE_MS) delete pending[id];
	}
	writeJson(projectDir, PENDING_FILE, pending, root);
	if ((!ok && noted.last !== false) || typeof noted.branch !== "string") return;
	const prs = readPrs(projectDir, root);
	prs[noted.branch] = Date.now();
	writePrs(projectDir, prs, root);
}

/**
 * Branches of the PRs the agent opened that are still open. A merged one is dropped once the PR's head as the
 * remote last showed it (`<remote>/<branch>`, else the local branch) is on `anchor`; so is one older than 30 days.
 */
export function openPrBranches(projectDir: string, where: string, remote: string, anchor: string, root?: string, now = Date.now()): string[] {
	const prs = readPrs(projectDir, root);
	let changed = false;
	for (const [branch, at] of Object.entries(prs)) {
		const tip = git(where, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}^{commit}`]) ?? git(where, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
		if (now - at > MAX_AGE_MS || (tip !== undefined && isAncestor(where, tip, anchor))) {
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
		const refs = targets(land, where, base, land.kind === "push" ? openPrBranches(projectDir, where, remote, anchorRef(where, remote, base), root) : []);
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
 * Writing redirections (`>`, `>>`, `>|`, `&>`, `&>>`, `>& file`) and `tee` make any command a writer;
 * `2>/dev/null`, `2>&1` and `>&-` don't. A `>` in quotes is text, unless the command has a substitution, which
 * runs inside double quotes too.
 */
function writes(command: string): boolean {
	if (!/\$\(|`/.test(command)) command = blankQuoted(command);
	return (
		[...command.matchAll(/(&>>?|\d*>[>|&]?)\s*([^\s;&|()<>]*)/g)].some(([, op, target]) => target !== "/dev/null" && !(op!.endsWith("&") && /^(\d+|-)$/.test(target!))) ||
		/\btee\b/.test(command)
	);
}

/** The command with the text inside quotes replaced by spaces; the quotes stay, so a quoted target is still a word. */
function blankQuoted(command: string): string {
	let out = "";
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote) {
			// A backslash escapes the next character in "…" and $'…', never in '…'.
			if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
				out += "  ";
				i++;
			} else if (ch === (quote === "$'" ? "'" : quote)) {
				quote = null;
				out += ch;
			} else out += " ";
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			out += command.slice(i, i + 2);
			i++;
		} else if (ch === "$" && command[i + 1] === "'") {
			quote = "$'";
			out += "$'";
			i++;
		} else {
			if (ch === "'" || ch === '"') quote = ch;
			out += ch;
		}
	}
	return out;
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
	let ask: GuardDecision | undefined;
	for (const { full, words, redirected } of moveSegments(command)) {
		const tokens = full.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean);
		// A plain move writes nothing; a move with a redirection on it is checked like any command.
		const move = parseMove(words.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean));
		if (move !== undefined && move !== "other" && !redirected) continue;
		const sub = tokens.find((t, i) => i > 0 && !t.startsWith("-"));
		// A substitution runs its own command, and `--output` makes git write a file.
		const runs = tokens.some((t) => /\$\(|`|[<>]\(/.test(t) || t.startsWith("--output"));
		const readOnly = !redirects && !runs && (READ_ONLY.has(tokens[0] ?? "") || (tokens[0] === "git" && READ_ONLY_GIT.has(sub ?? "")));
		if (readOnly) continue;
		// A path may follow `=` (`of=…`, `--output=…`) or `$(`.
		const candidates = tokens.flatMap((t) => [t, t.slice(t.indexOf("=") + 1), t.replace(/^.*?(\$\(|`)/, "")]);
		const paths = dirs.flatMap((dir) => candidates.map((t) => resolve(dir, t.replace(/^~(?=\/)/, homedir())).replaceAll("\\", "/")));
		const named = candidates.some((t) => /^\$\{?TMPDIR\}?\/*eng-kit\/reviews(\/|$)/.test(t));
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

/**
 * Every folder the shell may be in during the command: the start folder and any folder a `cd`, `pushd` or
 * `popd` may reach from any of them. The set only grows, so a failed move or a subshell never hides a folder;
 * `cd -`, `~-` and `popd` return to one already in it, and a write may create a folder first, so a folder need
 * not exist. `unknown` when a move isn't plain (see parseMove) or the set would pass 256 folders: then any write
 * asks.
 */
function reachable(command: string, cwd: string): { dirs: string[]; unknown: boolean } {
	const dirs = new Set([cwd]);
	let unknown = false;
	const simple = plainShell(command);
	for (const { words: raw, alone, redirected } of moveSegments(command)) {
		const words = raw.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean);
		const move = parseMove(words);
		if (move === undefined) continue;
		const plain = move !== "other" && alone && simple && !redirected && !(move.physical && move.arg?.split("/").includes(".."));
		if (!plain) unknown = true;
		// A move the guard doesn't follow still adds its literal words: more candidates only block more.
		const args = move === "other" ? words.filter((w) => !MOVES.has(w)) : move.arg === undefined ? (move.cmd === "cd" ? ["~"] : []) : [move.arg];
		for (const arg of args) {
			if (arg === "-" || arg === "") continue;
			const path = expandDir(arg.replace(/^~[+-](?=\/|$)/, "."), true);
			if (path === undefined) {
				unknown = true;
				continue;
			}
			for (const dir of isAbsolute(path) ? [cwd] : [...dirs]) {
				if (dirs.size >= 256) unknown = true;
				else dirs.add(resolve(dir, path));
			}
		}
	}
	return { dirs: [...dirs], unknown };
}

/** The command without redirections that write nothing (`2>/dev/null`, `>/dev/null`, `&>/dev/null`, `2>&1`, `>&-`), so they don't make a move look unusual. */
function quiet(command: string): string {
	return command.replace(/(^|[\s;&|()])(?:\d*>&(?:\d+|-)|&>>?\s*\/dev\/null|\d*>>?\s*\/dev\/null)(?=[\s;&|()]|$)/g, "$1");
}

/**
 * The command's segments with harmless redirections removed: `full` keeps the other redirections' targets, `words`
 * drops them, `redirected` says the segment had one. When the two splits don't line up, every segment counts as
 * redirected.
 */
function moveSegments(command: string): Array<{ full: string[]; words: string[]; alone: boolean; redirected: boolean }> {
	const q = quiet(command);
	const full = segmentsOf(tokenize(q));
	const bare = segmentsOf(tokenize(stripRedirects(q)));
	const aligned = full.length === bare.length;
	return full.map((segment, i) => {
		const words = aligned ? bare[i]!.raw : segment.raw;
		const redirected = !aligned || words.length !== segment.raw.length || words.some((w, j) => w !== segment.raw[j]);
		return { full: segment.raw, words, alone: segment.alone, redirected };
	});
}

/**
 * Whether the command's shape lets the guard follow its moves at all: no comment, command or process substitution,
 * backtick, brace group, `|&` or `case`. In any of these a `cd` may sit where the segments can't place it.
 */
function plainShell(command: string): boolean {
	if (/\$\(|`/.test(command)) return false;
	const text = blankQuoted(command).replace(/\\./g, "").replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "");
	return !/#|[{}]|[<>]\(|\|&|(^|[\s;&|(])case\s/.test(text);
}

/** zsh's `chdir` is a move too; the guard never follows it. */
const MOVES = new Set(["cd", "pushd", "popd", "chdir"]);
/** Prefixes whose own options come before the command: `command -p cd`, `time -p cd`. */
const OPTION_PREFIXES = new Set(["command", "time", "exec"]);
/** Words that may stand before a command in the same segment. */
const PREFIXES = new Set(["{", "}", "!", "then", "do", "else", "elif", "if", "while", "until", "time", "builtin", "command", "exec"]);

/** A move the guard follows exactly. */
type Move = { cmd: "cd" | "pushd" | "popd"; arg?: string; physical: boolean };

/**
 * The move a segment's words make: undefined when they name no `cd`, `pushd` or `popd`; "other" for any form
 * the guard doesn't follow exactly. A plain move is the segment's first word with at most `-L`/`-P` (cd only) and
 * `--`, then one folder for `pushd`, none for `popd`, at most one for `cd`, written without a glob or brace.
 */
function parseMove(words: string[]): Move | "other" | undefined {
	// The command word comes after reserved words, `builtin`-style prefixes and assignments.
	const at = words.findIndex((w, i) => !PREFIXES.has(w) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !(w.startsWith("-") && OPTION_PREFIXES.has(words[i - 1] ?? "")));
	if (at === -1 || !MOVES.has(words[at]!)) return undefined;
	if (at > 0 || words[at] === "chdir") return "other";
	const cmd = words[0] as Move["cmd"];
	let i = 1;
	let physical = false;
	while (cmd === "cd" && /^-[LP]+$/.test(words[i] ?? "")) physical ||= words[i++]!.includes("P");
	const dashes = words[i] === "--";
	if (dashes) i++;
	const operands = words.slice(i);
	const arg = operands[0];
	if (operands.length > 1 || (arg !== undefined && /[*?[{]/.test(arg))) return "other";
	// Without `--`, a word that starts with a dash is an option the guard doesn't follow (`-e`, `-@`, `+1`).
	if (arg !== undefined && !dashes && arg !== "-" && /^[-+]/.test(arg)) return "other";
	if (cmd === "popd" ? arg !== undefined : cmd === "pushd" && arg === undefined) return "other";
	return { cmd, arg, physical };
}

/**
 * Segments with whether a move in them runs in the current shell (not in a pipeline, after `||` or in the
 * background) and the separator before them. A newline or `&` right after another separator (`||⏎`, `|&`) keeps
 * the first one.
 */
function segmentsOf(tokens: string[]): Array<{ raw: string[]; alone: boolean; before: string }> {
	const out: Array<{ raw: string[]; before: string; after: string }> = [];
	let raw: string[] = [];
	let before = "";
	for (const token of tokens) {
		if (!SEPARATORS.has(token)) {
			raw.push(token);
			continue;
		}
		if (raw.length > 0) {
			out.push({ raw, before, after: token });
			before = token;
		} else if (before === "" || (token !== "\n" && token !== "&")) before = token;
		raw = [];
	}
	if (raw.length > 0) out.push({ raw, before, after: "" });
	// A list (up to `;`, a newline or `&`) that ends in `&` runs in the background as a whole: `cd x && make &`.
	let start = 0;
	const background = out.map(() => false);
	out.forEach(({ after }, i) => {
		if (after === "&&" || after === "||" || after === "|") return;
		if (after === "&") for (let j = start; j <= i; j++) background[j] = true;
		start = i + 1;
	});
	return out.map(({ raw, before, after }, i) => ({ raw, before, alone: !background[i] && before !== "||" && before !== "|" && after !== "|" }));
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);

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
			// A backslash escapes the next character in "…" and $'…', never in '…'.
			if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
				out += command.slice(i, i + 2);
				i += 2;
				continue;
			}
			if (ch === (quote === "$'" ? "'" : quote)) quote = null;
			out += ch;
			i++;
			continue;
		}
		if (ch === "\\") {
			out += command.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === "$" && command[i + 1] === "'") {
			quote = "$'";
			out += "$'";
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			out += ch;
			i++;
			continue;
		}
		const boundary = i === 0 || /[\s;&|()]/.test(command[i - 1]!);
		// `[n]>`, `>>`, `>|`, `<`, `<>`, `>&` and `<&` (an fd, `-` or a word follows), `&>`, `&>>`. A `&` before
		// anything else is a background separator: `a &< f b` runs `a` in the background, then `b` reads f.
		let op = /^(?:\d*(?:>>|>\||>&|<&|<>|>|<)|&>>?)/.exec(command.slice(i))?.[0];
		const isRedirect = op !== undefined && (ch === ">" || ch === "<" || ch === "&" || (boundary && op.length > 1));
		if (!isRedirect || op === undefined) {
			out += ch;
			i++;
			continue;
		}
		if (op.endsWith("&")) op += /^(?:\d+|-)(?=[\s;&|()<>]|$)/.exec(command.slice(i + op.length))?.[0] ?? "";
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

/**
 * The folder a command runs in, segment by segment, for the review gate. A `cd` inside one `( … )` ends with it,
 * once the segment that closes it has run. A nested subshell, a closing `)` inside `$(…)`, or any parenthesis in
 * quotes or after a backslash (the tokens can't tell it from a real one) makes the folder unknown for the rest of
 * the command, so what follows fails closed.
 */
class Subshells {
	private state: DirState;
	private outside: DirState;
	private inside = false;
	private closing = false;
	private lost = false;
	private conditional = false;
	private readonly textParens: boolean;
	private readonly simple: boolean;

	constructor(cwd: string, command: string) {
		this.state = this.outside = at(cwd);
		const count = (s: string) => s.match(/[()]/g)?.length ?? 0;
		this.textParens = count(command) !== count(blankQuoted(command).replace(/\\./g, ""));
		this.simple = plainShell(command);
	}

	get dir(): string | undefined {
		return this.lost ? undefined : here(this.state);
	}

	/**
	 * Starts a segment: ends the subshell the previous segment closed, opens one this segment starts. A move after
	 * `&&` may have been skipped, so once the `&&` chain breaks (`;`, a newline, `||`) the folder is unknown.
	 */
	enter(raw: string[], before: string): void {
		if (this.closing) {
			this.closing = false;
			this.inside = false;
			this.state = this.outside;
		}
		if (this.conditional && before !== "&&") {
			this.conditional = false;
			this.state = { dirs: [], prev: [], stack: [] };
		}
		if (raw[0]?.startsWith("(")) {
			if (this.inside || raw[0].startsWith("((") || this.textParens) this.lost = true;
			this.inside = true;
			this.outside = this.state;
		}
		const last = (raw[raw.length - 1] ?? "").replace(/^\(+/, "");
		if (this.inside && last.endsWith(")")) {
			if (last.replace(/\)+$/, "").includes("(")) this.lost = true;
			this.closing = true;
		}
	}

	/** Follows a plain move ("plain"); a move the guard doesn't follow makes the folder unknown ("other"); undefined for any other command. */
	move(raw: string[], alone: boolean, before = ""): "plain" | "other" | undefined {
		// A subshell's parentheses are not words; an empty quoted operand (`cd ""`) is.
		const words = raw.flatMap((t) => {
			const word = t.replace(/^\(+|\)+$/g, "");
			return word === "" && t !== "" ? [] : [word];
		});
		const move = parseMove(words);
		if (move === undefined) return undefined;
		const next = move !== "other" && alone && this.simple ? changeDir(this.state, move) : undefined;
		this.state = next ?? { dirs: [], prev: [], stack: [] };
		if (next && before === "&&") this.conditional = true;
		return next ? "plain" : "other";
	}
}

/** The folders a command may be in, as far as the guard follows `cd`, `pushd` and `popd`; none means unknown. */
type DirState = { dirs: string[]; prev: string[]; stack: string[][] };

function at(dir: string): DirState {
	return { dirs: [dir], prev: [], stack: [] };
}

/** The one folder a command is in, or undefined when the guard can't tell. */
function here(state: DirState): string | undefined {
	return state.dirs.length === 1 ? state.dirs[0] : undefined;
}

/**
 * The state after a plain move, or undefined when the guard can't confirm it (a missing folder, a variable, `..`
 * after `-P`, `popd` or `cd -` with nothing to return to). `cd -` and `~-` are the previous folder, `cd ""`
 * stays, `cd` alone goes home, and `pushd` and `popd` keep a stack.
 */
function changeDir(state: DirState, move: Move): DirState | undefined {
	const { cmd, arg } = move;
	if (cmd === "popd") {
		const [top, ...rest] = state.stack;
		return top === undefined ? undefined : { dirs: top, prev: state.dirs, stack: rest };
	}
	if (arg === "" && cmd === "cd") return state;
	// `-P` resolves symlinks before `..`; the guard resolves paths as written.
	if (move.physical && arg?.split("/").includes("..")) return undefined;
	let target: string[];
	if (arg === "-") target = state.prev;
	else if (arg !== undefined && /^~[+-](?=\/|$)/.test(arg)) target = (arg[1] === "-" ? state.prev : state.dirs).map((d) => resolve(d, arg.slice(3)));
	else {
		const path = expandDir(arg ?? "~", false);
		if (path === undefined) return undefined;
		target = isAbsolute(path) ? [resolve(path)] : state.dirs.map((d) => resolve(d, path));
	}
	if (target.length === 0 || !target.every(isDir)) return undefined;
	// `-P` resolves symlinks: the shell is in the real folder, and a later `..` leaves that.
	if (move.physical) target = target.map(safeRealpath);
	return { dirs: target, prev: state.dirs, stack: cmd === "pushd" ? [state.dirs, ...state.stack] : state.stack };
}

/** A `cd` operand with `~` expanded, and `$HOME` and `$TMPDIR` when `vars`; undefined when anything else would expand. */
function expandDir(arg: string, vars: boolean): string | undefined {
	let path = arg.replace(/^~(?=\/|$)/, homedir());
	// The shell's TMPDIR keeps its trailing slash (macOS), so `${TMPDIR}eng-kit` resolves as the shell sees it.
	if (vars) path = path.replace(/^\$(?:\{HOME\}|HOME\b)/, homedir()).replace(/^\$(?:\{TMPDIR\}|TMPDIR\b)/, process.env.TMPDIR || `${tmpdir()}/`);
	return /[$`(]/.test(path) ? undefined : path;
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** The directory `cd <arg>` moves to, or undefined when the guard can't know it. */
function follow(dir: string, arg: string | undefined): string | undefined {
	if (arg === undefined || /[$`(]/.test(arg)) return undefined;
	const target = resolve(dir, arg.replace(/^~(?=\/|$)/, homedir()));
	return existsSync(target) ? target : undefined;
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
	if (l.refspecs.length > 0 || l.all) return l;
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

	// A verdict covers exactly the commit the reviewer reviewed: anything else is a change it didn't see.
	const reviews = readReviews(projectDir, root);
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
export function reviewsDir(projectDir: string, root = join(tmpdir(), "eng-kit", "reviews")): string {
	const dir = resolve(projectDir);
	const common = git(dir, ["rev-parse", "--git-common-dir"]);
	return join(root, hash(safeRealpath(common ? resolve(dir, common) : dir)));
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

/** git output as is. Paths are never quoted. */
function gitRaw(cwd: string, args: string[]): string | undefined {
	const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
	return r.status === 0 ? r.stdout : undefined;
}
