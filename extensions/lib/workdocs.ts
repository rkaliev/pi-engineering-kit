/**
 * Task files (one per piece of work: its description, plan and progress) live only on a work branch
 * and never reach the base branch. Git keeps the history.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { commandName, quotedHeredoc, splitSegments, tokenize, unwrapToken, type GuardDecision } from "./patterns.ts";
import { repoOf } from "./repos.ts";
import { safeRealpath, segmentFolders } from "./shell.ts";

/** Where the kit keeps task files. */
export const WORK_DOC_DIRS = ["docs/tasks"];

const PLAN = /^## Plan[ \t]*$/m;
const NEXT_SECTION = /^## /m;
const OPEN_BOX = /^\s*[-*]\s+\[ \]/m;
const DONE_BOX = /^\s*[-*]\s+\[[xX]\]/m;

/**
 * What one command segment would land: a PR/MR (`merge`: merging one; `target`: the branch, number or URL
 * it names; `repo`: `-R/--repo` points elsewhere), a merge, a push, or a commit. `dir` is the `git -C` directory.
 */
export type Landing =
	| { kind: "pr"; merge: boolean; target?: string; repo?: boolean }
	| { kind: "merge"; refs: string[]; dir?: string }
	| { kind: "push"; remote?: string; refspecs: string[]; all: boolean; tags?: boolean; dir?: string }
	| { kind: "commit"; dir?: string };

/** `git merge` options that take a value, so the value is not a ref. */
const MERGE_VALUE_FLAGS = new Set(["-m", "-F", "-s", "-X", "--message", "--file", "--strategy", "--strategy-option", "--into-name"]);
/** git push options whose value is the next word: it is neither the remote nor a refspec. */
const PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/**
 * Block a command that would put working documents on the base branch: opening or merging a PR/MR,
 * merging into the base, pushing to the base, or committing them on the base. Pushing a work branch is fine.
 * In a workspace (`workspace` given), each landing is judged in the folder it runs in, with that repository's
 * task-file folders; a PR, merge or push whose repository the guard can't tell is blocked, and a commit it can't place
 * is judged in every repository.
 */
export function checkWorkDocs(
	command: string,
	projectDir: string,
	dirs = WORK_DOC_DIRS,
	workspace?: { cwd: string; repos: string[]; dirsFor: (repo: string) => string[]; powershell?: boolean; slow?: string[] },
): GuardDecision | undefined {
	if (!workspace) return judge(splitSegments(tokenize(command)).flatMap(allLandings), projectDir, dirs);
	const folders = workspace.repos.map((name) => join(projectDir, name));
	// `"workDocs": []` everywhere turns the rule off, even where a landing can't be placed.
	const watched = folders.some((repo) => workspace.dirsFor(repo).length > 0);
	const cantTell: GuardDecision = {
		action: "block",
		reason: `Task-file guard: can't tell which repository this command lands in (a folder the guard can't follow, a repository named by -R, GH_REPO or a URL, a folder outside git, or a repository too slow to check). ${workspace.powershell ? "Run it with the Bash tool from the repository's folder (`cd <repo> && …`)" : "Run it from the repository's folder (`cd <repo> && …`)"} without naming the repository.`,
	};
	// A GH_REPO set anywhere in the command picks the repository for every gh call after it.
	const ghRepo = /\bGH_REPO\b/.test(command) || process.env.GH_REPO !== undefined;
	// A heredoc body is text only when the command as a whole just writes it to a file; any other heredoc may run it.
	const write = quotedHeredoc(command);
	for (const { raw, dir } of segmentFolders(write?.target !== undefined ? write.head : command, workspace.cwd, workspace.powershell)) {
		for (const l of allLandings(raw.map((t) => t.replace(/^\(+|\)+$/g, "")))) {
			// A commit lands where it runs: one that can't be placed is judged in every repository, within one deadline.
			if (l.kind === "commit" && dir === undefined) {
				if (!watched) continue;
				const until = Date.now() + UNPLACED_BUDGET_MS;
				for (const repo of folders) {
					const own = workspace.dirsFor(repo);
					if (own.length === 0) continue;
					if ((workspace.slow ?? []).includes(basename(repo)) || Date.now() >= until) return cantTell;
					const found = judgeCommit(repo, own, until);
					if (found === "late") return cantTell;
					if (found) return found;
				}
				continue;
			}
			// A folder outside the workspace repositories is judged as it is; one that isn't git lands nothing, unless a PR
			// names its repository another way (`-R`, `GH_REPO`, a URL) or starts there.
			const repo = dir === undefined ? undefined : repoOf(projectDir, workspace.repos, dir);
			const selector = l.kind === "pr" && (l.repo === true || ghRepo || /^https?:\/\//.test(l.target ?? ""));
			// A checkout in a repository's folder is that repository when it shares its git common dir (its own worktree,
			// judged in the worktree) and another one otherwise (a clone, another repository's worktree).
			const top = dir === undefined || repo === undefined ? undefined : git(dir, ["rev-parse", "--show-toplevel"]);
			const nested = top !== undefined && commonOf(top) !== commonOf(repo!);
			const checkout = dir === undefined ? undefined : repo === undefined ? dir : (top ?? repo);
			const unplaced = checkout === undefined || selector || nested || (l.kind === "pr" && git(checkout, ["rev-parse", "--git-dir"]) === undefined);
			if (unplaced) {
				if (!watched) continue;
				return cantTell;
			}
			const found = judge([l], checkout!, workspace.dirsFor(repo ?? checkout!));
			if (found) return found;
		}
	}
	return undefined;
}

/** The real path of a checkout's git common dir: a repository and its worktrees share it. */
function commonOf(dir: string): string | undefined {
	const out = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return out === undefined ? undefined : safeRealpath(out);
}

/** How long a commit the guard can't place may spend checking the workspace repositories. */
const UNPLACED_BUDGET_MS = 3000;

/** A commit in `checkout`: staged task files first (one git call), then whether it is on its base; "late" past `until`. */
function judgeCommit(checkout: string, dirs: string[], until: number): GuardDecision | "late" | undefined {
	if (dirs.length === 0) return undefined;
	const left = until - Date.now();
	if (left <= 0) return "late";
	const r = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "--", ...dirs], { cwd: checkout, encoding: "utf8", timeout: Math.min(5000, left) });
	if (r.error || r.signal) return "late";
	const staged = markdown(lines(r.status === 0 ? r.stdout.trim() : undefined));
	if (staged.length === 0) return undefined;
	const base = onBaseBranch(checkout, until);
	if (base === undefined) return Date.now() >= until ? "late" : undefined;
	return {
		action: "block",
		reason: `Task files are staged on ${base} in ${basename(checkout)}: ${staged.join(", ")}. Task files are committed only on a work branch: create one (\`git -C ${basename(checkout)} switch -c <type>/<topic>\`) and commit there.`,
	};
}

/** The landings of one checkout, judged with its task-file folders. */
function judge(landings: Landing[], checkout: string, dirs: string[]): GuardDecision | undefined {
	if (dirs.length === 0 || landings.length === 0 || git(checkout, ["rev-parse", "--git-dir"]) === undefined) return undefined;

	const base = baseBranch(checkout);
	const onBase = base !== undefined && currentBranch(checkout) === base;
	for (const l of landings) {
		if (l.kind === "commit") {
			if (!onBase) continue;
			const staged = markdown(stagedPaths(checkout, dirs));
			if (staged.length > 0) {
				return {
					action: "block",
					reason: `Task files are staged on ${base}: ${staged.join(", ")}. Task files are committed only on a work branch: create one (\`git switch -c <type>/<topic>\`) and commit there.`,
				};
			}
			continue;
		}
		const refs = l.kind === "pr" ? ["HEAD"] : l.kind === "merge" ? (onBase ? l.refs : []) : pushedToBase(l, base, onBase);
		for (const ref of refs) {
			const files = markdown(trackedPaths(checkout, ref, dirs));
			if (files.length > 0) return { action: "block", reason: leakReason(files, base) };
		}
	}
	return undefined;
}

/** Task files whose Plan section has every checkbox ticked: implemented, so due for deletion. */
export function finishedWorkDocs(projectDir: string, dirs = WORK_DOC_DIRS): string[] {
	const files: string[] = [];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = readdirSync(join(projectDir, dir), { recursive: true, encoding: "utf8" });
		} catch {
			continue;
		}
		for (const name of names) {
			const path = `${dir}/${name.replaceAll("\\", "/")}`;
			if (!path.endsWith(".md")) continue;
			try {
				if (finished(readFileSync(join(projectDir, path), "utf8"))) files.push(path);
			} catch {
				// a directory or unreadable: skip
			}
		}
	}
	return files;
}

export function workDocsReminder(files: string[]): string {
	return `Working-docs gate: implemented task files are still in the tree: ${files.join(", ")}. Move what lasts into the topic chapter (docs/NN-topic.md) and docs/decisions/, show the user each file's Follow-ups, then delete the files in one commit (\`git rm …\`). Opening a PR or landing on the base branch is blocked while they exist.`;
}

/** The branch work lands on: `origin/HEAD`, else an existing `main` or `master`. Its git calls end by `until` (epoch ms). */
export function baseBranch(projectDir: string, until?: number): string | undefined {
	const run = (args: string[]) => {
		const left = until === undefined ? 5000 : Math.min(5000, until - Date.now());
		return left > 0 ? git(projectDir, args, left) : undefined;
	};
	const remote = run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (remote) return remote.replace(/^origin\//, "");
	return ["main", "master"].find((b) => run(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]) !== undefined);
}

/** The base branch's name when it is checked out, else undefined. Its git calls end by `until` (epoch ms). */
export function onBaseBranch(projectDir: string, until?: number): string | undefined {
	const base = baseBranch(projectDir, until);
	const left = until === undefined ? undefined : until - Date.now();
	if (base === undefined || (left !== undefined && left <= 0)) return undefined;
	return currentBranch(projectDir, left === undefined ? undefined : Math.min(5000, left)) === base ? base : undefined;
}

export function currentBranch(projectDir: string, timeout?: number): string | undefined {
	return git(projectDir, ["branch", "--show-current"], timeout) || undefined;
}

/**
 * Every commit, merge, push or PR call in one segment, in the order they appear: `find … -exec git commit … \; -exec git
 * merge …` runs both. gh, glab and git run in any letter case on macOS and Windows, and every word that names one is a
 * candidate, so an argument or assignment with such a base name (`HOME=/srv/git git push`) hides nothing.
 */
export function allLandings(raw: string[]): Landing[] {
	// A group or substitution around the command does not hide it.
	const tokens = raw.map(unwrapToken).filter(Boolean);
	const isWord = (t: string) => !t.includes("=") || t.startsWith("-");
	const found: Landing[] = [];
	tokens.forEach((t, at) => {
		if (!isWord(t)) return;
		const name = commandName(t);
		const l = name === "gh" || name === "glab" ? prLanding(name, tokens.slice(at + 1), isWord) : name === "git" ? gitLanding(tokens.slice(at + 1)) : undefined;
		if (l) found.push(l);
	});
	return found;
}

/** `gh pr create|merge` or `glab mr create|merge` from the tokens after the tool. */
function prLanding(tool: "gh" | "glab", args: string[], isWord: (t: string) => boolean): Landing | undefined {
	const [noun, verb, first] = args.filter((t) => isWord(t) && !t.startsWith("-"));
	if ((noun !== "pr" && noun !== "mr") || (verb !== "create" && verb !== "merge")) return undefined;
	const repo = args.some((t) => t === "-R" || /^-R./.test(t) || t === "--repo" || t.startsWith("--repo="));
	if (verb === "merge") return { kind: "pr", merge: true, target: first, repo };
	const flags = tool === "gh" ? ["--head", "-H"] : ["--source-branch", "-s"];
	const head = args.findIndex((t) => flags.includes(t) || flags.some((f) => f.startsWith("--") && t.startsWith(`${f}=`)));
	if (head === -1) return { kind: "pr", merge: false, repo };
	const flag = args[head]!;
	return { kind: "pr", merge: false, target: flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : args[head + 1], repo };
}

/** A git commit, merge or push from the raw tokens after git: `-c key=value` keeps its value, so options and their values pair up. */
function gitLanding(rest: string[]): Landing | undefined {
	// The subcommand is the first word after git's own options (`-C <dir>` and `-c <key=value>` take a value).
	let verb = 0;
	let dir: string | undefined;
	while (verb < rest.length && rest[verb]!.startsWith("-")) {
		if (rest[verb] === "-C") dir = rest[verb + 1];
		verb += rest[verb] === "-C" || rest[verb] === "-c" ? 2 : 1;
	}
	const args = rest.slice(verb + 1);
	// A marked subcommand (see tokenize) is judged as it most likely runs.
	const subcommand = (rest[verb] ?? "").replaceAll("\0", "");
	switch (subcommand) {
		case "commit":
			return { kind: "commit", dir };
		case "merge":
			return { kind: "merge", refs: args.filter((t, i) => !t.startsWith("-") && !MERGE_VALUE_FLAGS.has(args[i - 1] ?? "")), dir };
		case "push":
		case "send-pack":
		case "http-push": {
			// A value flag takes the next word whatever it looks like; `--repo` names the remote when no operand does.
			const operands: string[] = [];
			let repo: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i]!;
				if (PUSH_VALUE_FLAGS.has(arg)) {
					if (arg === "--repo") repo = args[i + 1];
					i++;
				} else if (arg.startsWith("--repo=")) repo = arg.slice("--repo=".length);
				else if (!arg.startsWith("-")) operands.push(arg);
			}
			return { kind: "push", remote: operands[0] ?? repo, refspecs: operands.slice(1), all: args.includes("--all") || args.includes("--branches"), tags: args.includes("--tags"), dir };
		}
		default:
			return undefined;
	}
}

/** Refs whose content a push would place on the base branch. */
export function pushedToBase(l: Extract<Landing, { kind: "push" }>, base: string | undefined, onBase: boolean): string[] {
	if (!base) return [];
	if (l.all) return [base];
	if (l.refspecs.length === 0) return onBase ? ["HEAD"] : [];
	const refs: string[] = [];
	for (const spec of l.refspecs) {
		const [src = "", dst = src] = spec.replace(/^\+/, "").split(":");
		// `HEAD` or `@` as the destination is the current branch.
		const dest: string = dst === "HEAD" || dst === "@" ? (onBase ? base : "") : dst.replace(/^refs\/heads\//, "");
		if (src && dest === base) refs.push(src === "@" ? "HEAD" : src);
	}
	return refs;
}

function trackedPaths(projectDir: string, ref: string, dirs: string[]): string[] {
	return lines(git(projectDir, ["ls-tree", "-r", "--name-only", ref, "--", ...dirs]));
}

function stagedPaths(projectDir: string, dirs: string[]): string[] {
	return lines(git(projectDir, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "--", ...dirs]));
}

/** Markdown task files among `paths`. */
function markdown(paths: string[]): string[] {
	return paths.filter((p) => p.endsWith(".md"));
}

/** The Plan section has at least one ticked box and none open. Boxes elsewhere in the file don't count. */
function finished(text: string): boolean {
	const start = text.search(PLAN);
	if (start === -1) return false;
	const body = text.slice(start).replace(PLAN, "");
	const end = body.search(NEXT_SECTION);
	const plan = end === -1 ? body : body.slice(0, end);
	return DONE_BOX.test(plan) && !OPEN_BOX.test(plan);
}

function leakReason(files: string[], base: string | undefined): string {
	return `Task files would reach ${base ?? "the base branch"}: ${files.join(", ")}. A task file lives only on its work branch. Move what lasts into the topic chapter (docs/NN-topic.md) and docs/decisions/, show the user its Follow-ups, remove it in one commit (\`git rm ${files.join(" ")}\`), then retry.`;
}

function lines(out: string | undefined): string[] {
	return (out ?? "").split("\n").filter(Boolean);
}

function git(cwd: string, args: string[], timeout = 5000): string | undefined {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout });
	return r.status === 0 ? r.stdout.trim() : undefined;
}
