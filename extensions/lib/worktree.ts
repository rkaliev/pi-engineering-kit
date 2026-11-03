/**
 * What changed in the project's files, whatever wrote them: the verify gate compares fingerprints of the git
 * working tree before and after a shell command, and falls back to the command's text outside git.
 */
import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isIgnored, resolveIgnore } from "./commands.ts";
import { ignoredFolder, projectRepos } from "./repos.ts";
import { splitSegments, tokenize } from "./patterns.ts";
import { blankQuoted, heredocs, MOVES, reachable, safeRealpath, stripRedirects, writes } from "./shell.ts";

const GIT_TIMEOUT_MS = 3000;
/** More listed paths than this and the session falls back to the command text. */
export const MAX_ENTRIES = 5000;

/** A fingerprint of the working tree: the commit checked out, and each listed file's content identity. */
export interface Tree {
	/** `HEAD`, or `""` before the first commit. */
	head: string;
	/** Project-relative path → `"<size> <mtimeMs>"`, or `"deleted"`. */
	files: Record<string, string>;
	/** In a workspace: each repository folder's `HEAD`, or `""` before its first commit. */
	heads?: Record<string, string>;
	/**
	 * In a workspace: the parts not fingerprinted in this call, sorted: a repository folder, `""` for the files outside
	 * the repositories, or a symlink the walk met that leads out of the project or to a folder. A part fingerprinted
	 * before keeps the paths it listed and its HEAD (see `treeFingerprint`).
	 */
	blind?: string[];
	/** In a workspace: the blind parts never fingerprinted, so with no entries to compare (a subset of `blind`). */
	unseen?: string[];
	/** In a workspace: the parts that ran out of their share of the time in this call (a subset of `blind`). */
	late?: string[];
	/** In a workspace: the blind parts that are symlinks the walk met (a subset of `blind`). */
	links?: string[];
}

const MAX_BUFFER = 16 * 1024 * 1024;
/** How long one workspace fingerprint may take, all repositories and the walk together. */
export const WORKSPACE_BUDGET_MS = 2000;

function git(projectDir: string, args: string[], timeout = GIT_TIMEOUT_MS): string {
	return execFileSync("git", ["--no-optional-locks", ...args], {
		cwd: projectDir,
		encoding: "utf8",
		timeout,
		maxBuffer: MAX_BUFFER,
		stdio: ["ignore", "pipe", "ignore"],
	});
}

/**
 * Files a workspace's own walk never counts, whatever `ignore` says: what the OS, an editor, a dependency install or a
 * local tool writes on its own. Inside a repository, git's ignore rules do this.
 */
const WALK_EXCLUDES = ["**/.DS_Store", "**/Thumbs.db", ".claude/settings.local.json", ".claude/*.lock", ".pi/git/**", ".pi/npm/**", "**/.idea/**", "**/.vscode/**", "**/node_modules/**"];

/**
 * The files `git status` lists under `projectDir` (changed, new or deleted), by content identity only, so staging or
 * committing them is not a change; gitignored files and paths matching `ignore` are left out. `undefined` outside git,
 * on an error, after the timeout or over `MAX_ENTRIES` paths, so the caller can fall back to the command's text.
 * `why.slow` says the repository is too big or slow to fingerprint (a timeout or the cap), as opposed to not being a
 * repository (yet).
 *
 * A folder outside git that holds repositories (a workspace, see `projectRepos`) gets each repository's entries under
 * its folder, matched against its own ignore globs by the path inside it and against `ignore` by the workspace path,
 * and every file outside them, against `ignore`. Each part has an equal share of the time left before
 * `limits.deadline`. A part over the limit, failing, out of its share, named in `limits.skip`, or a symlink the walk
 * meets that leads out of the project or to a folder is listed in `blind`. A part fingerprinted in `limits.previous`
 * keeps the paths it listed there and its HEAD: their identity is read again, except for a part in `limits.skip`,
 * which keeps the stored one. One over the limit, or out of its share in this call and in `previous` too, is added to
 * `why.slowParts`, for the caller to skip for the session.
 */
export function treeFingerprint(projectDir: string, ignore: string[], why: { slow?: boolean; slowParts?: string[] } = {}, limits: { deadline?: number; maxEntries?: number; skip?: string[]; previous?: Tree } = {}): Tree | undefined {
	const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
	try {
		const tree = repoTree(projectDir, "", ignore, ignore, maxEntries, Number.POSITIVE_INFINITY);
		if (tree === "cap") why.slow = true;
		return tree === "cap" ? undefined : tree;
	} catch (err) {
		if (timedOut(err)) {
			why.slow = true;
			return undefined;
		}
	}
	const { kind, repos } = projectRepos(projectDir, ignore);
	if (kind !== "workspace") return undefined;
	const deadline = limits.deadline ?? Date.now() + WORKSPACE_BUDGET_MS;
	const skip = new Set(limits.skip ?? []);
	const previous = limits.previous?.heads !== undefined ? limits.previous : undefined;
	const files: Record<string, string> = {};
	const heads: Record<string, string> = {};
	const blind: string[] = [...skip].filter((part) => part === "" || repos.includes(part));
	const late: string[] = [];
	const links: string[] = [];
	const remember = (part: string) => (why.slowParts = [...(why.slowParts ?? []), part]);
	const missed = (part: string, outcome: "cap" | "late" | "fail") => {
		blind.push(part);
		if (outcome === "late") late.push(part);
		if (outcome === "cap" || (outcome === "late" && previous?.late?.includes(part))) remember(part);
	};
	// Each part gets an equal share of the time left, so one slow repository can't starve the others.
	const parts = [...repos.filter((r) => !skip.has(r)), ...(skip.has("") ? [] : [""])];
	parts.forEach((part, i) => {
		const share = Date.now() + (deadline - Date.now()) / (parts.length - i);
		if (part === "") {
			const outside = walkOutside(projectDir, repos, [...ignore, ...WALK_EXCLUDES], maxEntries, share);
			if (typeof outside === "string") return missed("", outside);
			Object.assign(files, outside.files);
			blind.push(...outside.links);
			links.push(...outside.links);
			return;
		}
		let tree: Tree | "cap" | "late" | "fail";
		try {
			tree = share > Date.now() ? repoTree(join(projectDir, part), `${part}/`, ignore, resolveIgnore(join(projectDir, part)), maxEntries, share) : "late";
		} catch (err) {
			tree = timedOut(err) ? "late" : "fail";
		}
		if (typeof tree === "string") return missed(part, tree);
		Object.assign(files, tree.files);
		heads[part] = tree.head;
	});
	// A blind part keeps the paths it listed, so the next comparison measures from a real baseline without noise.
	const unseen: string[] = [];
	const parts2 = [...repos, ...outsideParts(repos, blind)];
	for (const part of blind) {
		if (part !== "" && !repos.includes(part)) continue;
		const had = previous !== undefined && !(previous.unseen ?? []).includes(part) && (part === "" || previous.heads![part] !== undefined);
		if (!had) {
			unseen.push(part);
			continue;
		}
		// The paths are carried. A part blind in this call has their identity read now, so a change to a listed file
		// still counts; a part remembered for the session keeps the stored one and costs no I/O.
		for (const [path, id] of Object.entries(previous!.files)) {
			if (partOf(path, parts2) === part) files[path] = skip.has(part) ? id : identity(join(projectDir, path));
		}
		if (part !== "") heads[part] = previous!.heads![part]!;
	}
	return { head: "", files, heads, blind: blind.sort(), unseen: unseen.sort(), late: late.sort(), links: links.sort() };
}

/** The non-repository parts named in `blind` (folder symlinks); `""` is always one. */
function outsideParts(repos: string[], blind: string[]): string[] {
	return blind.filter((p) => p !== "" && !repos.includes(p));
}

/** The part a workspace path belongs to: the longest part folder it is in, or `""` for none. */
function partOf(path: string, parts: string[]): string {
	return parts.filter((r) => r !== "" && (path === r || path.startsWith(`${r}/`))).sort((x, y) => y.length - x.length)[0] ?? "";
}

function timedOut(err: unknown): boolean {
	return (err as { code?: string }).code === "ETIMEDOUT" || (err as { signal?: string }).signal === "SIGTERM";
}

/** The time a git call may take before `deadline`, at most the usual timeout; throws a timeout once it has passed. */
function timeLeft(deadline: number): number {
	const left = Math.floor(Math.min(GIT_TIMEOUT_MS, deadline - Date.now()));
	if (left <= 0) throw Object.assign(new Error("out of time"), { code: "ETIMEDOUT" });
	return left;
}

/**
 * One repository's listed files, each path prefixed with `label` (its folder in a workspace), left out when `ignore`
 * matches that path or `own` matches the path inside the repository; throws outside git. In a workspace a HEAD read
 * that runs out of time throws too, so the repository is blind rather than taken for one without commits.
 */
function repoTree(dir: string, label: string, ignore: string[], own: string[], maxEntries: number, deadline: number): Tree | "cap" {
	const prefix = git(dir, ["rev-parse", "--show-prefix"], timeLeft(deadline)).trim();
	const records = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], timeLeft(deadline)).split("\0");
	if (records.length > maxEntries + 1) return "cap";
	const files: Record<string, string> = {};
	const add = (repoPath: string) => {
		if (!repoPath.startsWith(prefix)) return;
		const path = repoPath.slice(prefix.length);
		if (!isIgnored(label + path, ignore) && !isIgnored(path, own)) files[label + path] = identity(join(dir, path));
	};
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (record.length < 4) continue;
		add(record.slice(3));
		// A rename or copy (in either column) is followed by its source path: both count.
		if (/[RC]/.test(record.slice(0, 2))) add(records[++i] ?? "");
	}
	let head = "";
	try {
		head = git(dir, ["rev-parse", "--verify", "-q", "HEAD"], timeLeft(deadline)).trim();
	} catch (err) {
		if (label !== "" && timedOut(err)) throw err;
		// no commit yet
	}
	return { head, files };
}

/**
 * Every file of a workspace outside its repositories, by content identity, without `.git` or ignored paths. A symlink
 * to a file inside the project counts by that file; one to a folder, or one that leads out of the project, is not
 * followed but returned in `links`. `"cap"` over `maxEntries` files, `"late"` past the deadline.
 */
function walkOutside(projectDir: string, repos: string[], ignore: string[], maxEntries: number, deadline: number): { files: Record<string, string>; links: string[] } | "cap" | "late" {
	const files: Record<string, string> = {};
	const links: string[] = [];
	let count = 0;
	const pending = [""];
	while (pending.length > 0) {
		if (Date.now() > deadline) return "late";
		const rel = pending.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(join(projectDir, rel), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.name === ".git" || (rel === "" && repos.includes(entry.name))) continue;
			// A symlink is followed only while every hop stays in the project: a target elsewhere may be a mount that
			// hangs on stat.
			const link = entry.isSymbolicLink() ? targetInside(projectDir, join(projectDir, path)) : undefined;
			if (link === null) {
				if (!isIgnored(path, ignore) && !ignoredFolder(path, ignore)) links.push(path);
				continue;
			}
			const folder = entry.isDirectory() || (link !== undefined && isFolder(link));
			if (folder) {
				if (ignoredFolder(path, ignore)) continue;
				if (entry.isSymbolicLink()) links.push(path);
				else pending.push(path);
			} else if ((entry.isFile() || entry.isSymbolicLink()) && !isIgnored(path, ignore)) {
				if (++count > maxEntries) return "cap";
				files[path] = identity(join(projectDir, path));
			}
		}
	}
	return { files, links };
}

/**
 * Where a symlink leads when every hop, and every symlinked folder on the way, stays inside the project; `null` when
 * one leaves it, can't be read or the chain is too long. Only `lstat` and `readlink` run, never a stat of the target.
 */
function targetInside(projectDir: string, link: string): string | null {
	const root = resolve(projectDir);
	let path = link;
	for (let hops = 0; hops < 16; hops++) {
		// The first component on the way that is a symlink, if any.
		const rel = relative(root, path);
		if (rel.startsWith("..") || isAbsolute(rel)) return null;
		const parts = rel.split(/[\\/]/);
		let next: string | undefined;
		for (let i = 1; i <= parts.length; i++) {
			const at = join(root, ...parts.slice(0, i));
			let isLink: boolean;
			try {
				isLink = lstatSync(at).isSymbolicLink();
			} catch {
				return path; // a dangling path: nothing further to follow
			}
			if (!isLink) continue;
			let text: string;
			try {
				text = readlinkSync(at);
			} catch {
				return null;
			}
			// `sub/../x` climbs after `sub`, which may itself be a symlink the text hides: don't fold it lexically.
			const steps = text.split(/[\\/]/).filter((step) => step !== "" && step !== ".");
			if (steps.some((step, k) => step === ".." && steps.slice(0, k).some((before) => before !== ".."))) return null;
			next = join(resolve(dirname(at), text), ...parts.slice(i));
			break;
		}
		if (next === undefined) return path;
		path = next;
	}
	return null;
}

function isFolder(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The project files whose content changed between two fingerprints, sorted; empty means nothing changed. A path that
 * left the list (staged and committed, or restored) counts only if its size or time now differ; when `HEAD` moved, the
 * files its commits touched that were clean before count too (an edit committed in the same command, a checkout). In
 * a workspace that holds per repository, in its folder, and a repository whose commits can't be compared before
 * `deadline` (default: the workspace budget from now) counts as its folder, `<repo>/`.
 */
export function changedPaths(before: Tree, after: Tree, projectDir: string, ignore: string[] = [], deadline?: number): string[] {
	const changed = new Set<string>();
	for (const path of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
		const now = after.files[path] ?? identity(join(projectDir, path));
		if (before.files[path] !== now) changed.add(path);
	}
	const workspace = before.heads !== undefined && after.heads !== undefined;
	const until = deadline ?? Date.now() + WORKSPACE_BUDGET_MS;
	const moved: Array<[string, string, string]> = workspace
		? Object.entries(after.heads!).flatMap(([repo, head]) => (before.heads![repo] !== undefined ? [[repo, before.heads![repo]!, head] as [string, string, string]] : []))
		: [["", before.head, after.head]];
	for (const [repo, from, to] of moved) {
		if (!from || !to || from === to) continue;
		const label = repo === "" ? "" : `${repo}/`;
		try {
			const touched = git(join(projectDir, repo), ["diff", "--name-only", "--relative", "-z", from, to, "--", "."], workspace ? timeLeft(until) : GIT_TIMEOUT_MS).split("\0");
			for (const path of touched) if (path && !(label + path in before.files) && !isIgnored(label + path, ignore)) changed.add(label + path);
		} catch (err) {
			// An unreachable commit (a rewritten history): the listed files above still count. Out of time in a
			// workspace: the commits went unread, so the repository itself counts.
			if (workspace && timedOut(err)) changed.add(label);
		}
	}
	return [...changed].sort();
}

/**
 * What a call changed: the fingerprints compared, plus the files its text writes inside a part either fingerprint is
 * blind to (a workspace repository, a symlink the walk met, or `""` for the files outside them). A part never
 * fingerprinted before has no baseline, so its listed files don't count; its text targets do. With a blind part, a
 * command that moves the shell has its targets placed from every folder it may reach. One whose moves can't be
 * followed (a variable, `chdir`, `CDPATH`, any PowerShell command) or that may bind names it doesn't show (`source`,
 * `.`, `eval` or a declaration in a command position, see `bindsAsCommand`) has every text
 * target count while a repository or the outside files are blind, and those under a symlink while only symlinks are.
 * Without both fingerprints, only its text.
 */
export function callChanges(before: Tree | undefined, now: Tree | undefined, projectDir: string, after?: { command: string; cwd: string; powershell?: boolean }): string[] {
	const written = (cwd = after?.cwd ?? projectDir) => (after ? shellWriteTargets(after.command, cwd, projectDir, process.env, after.powershell) : []);
	if (!before || !now) return written();
	const blind = new Set([...(before.blind ?? []), ...(now.blind ?? [])]);
	if (blind.size === 0) return changedPaths(before, now, projectDir);
	const parts = [...new Set([...Object.keys(before.heads ?? {}), ...Object.keys(now.heads ?? {}), ...blind])].filter((r) => r !== "");
	const unseenBefore = new Set(before.unseen ?? []);
	const paths = changedPaths(before, now, projectDir).filter((p) => !unseenBefore.has(partOf(p, parts)));
	let targets: string[] = [];
	if (after !== undefined) {
		const where = hidesPlace(after.command, after.powershell) ? placesOf(after.command, after.cwd, after.powershell) : [after.cwd];
		// Targets that can't be placed all count while a repository or the outside files are blind; with only symlinks
		// blind, those written under a symlink do.
		const links = new Set([...(before.links ?? []), ...(now.links ?? [])]);
		const wide = [...blind].some((part) => !links.has(part));
		targets =
			where === undefined
				? written().filter((p) => wide || blind.has(partOf(p, parts)))
				: [...new Set(where.flatMap((cwd) => written(cwd)))].filter((p) => blind.has(partOf(p, parts)));
	}
	return [...new Set([...paths, ...targets])].sort();
}

/** The folders a command's writes may start from, or `undefined` when its moves or names can't be followed. */
function placesOf(command: string, cwd: string, powershell = false): string[] | undefined {
	if (powershell || /\bcdpath\b/i.test(command) || process.env.CDPATH) return undefined;
	// Names a command may bind out of sight: `source`, `.`, `eval` or a declaration, in a command position only
	// (`npx eslint .` binds nothing), including inside a group, a subshell, a function body or a `case` arm.
	for (const seg of splitSegments(tokenize(stripRedirects(heredocs(command).text)))) if (bindsAsCommand(seg)) return undefined;
	const { dirs, unknown } = reachable(command, cwd);
	return unknown ? undefined : dirs;
}

/**
 * Whether `ignore` excludes a project-relative path: by that path, or, for a file inside a workspace repository, by its
 * path inside the repository against that repository's own ignore globs, as a session in that repository matches it.
 */
export function ignoredPath(projectDir: string, rel: string, ignore: string[]): boolean {
	return ignoreFilter(projectDir, ignore)(rel);
}

/** `ignoredPath` for many paths: the workspace's repositories and their globs are read once. */
export function ignoreFilter(projectDir: string, ignore: string[]): (rel: string) => boolean {
	let repos: string[] | undefined;
	const own = new Map<string, string[]>();
	return (path) => {
		const rel = path.replaceAll("\\", "/");
		if (isIgnored(rel, ignore)) return true;
		const slash = rel.indexOf("/");
		if (slash < 0 || !existsSync(join(projectDir, rel.slice(0, slash), ".git"))) return false;
		const repo = rel.slice(0, slash);
		repos ??= ((r) => (r.kind === "workspace" ? r.repos : []))(projectRepos(projectDir, ignore));
		if (!repos.includes(repo)) return false;
		if (!own.has(repo)) own.set(repo, resolveIgnore(join(projectDir, repo)));
		return isIgnored(rel.slice(slash + 1), own.get(repo)!);
	};
}

function identity(file: string): string {
	try {
		const { size, mtimeMs } = statSync(file);
		return `${size} ${mtimeMs}`;
	} catch {
		return "deleted";
	}
}

/**
 * The project-relative files a command writes, read from its text: targets of `>`, `>>`, `>|`, `&>` and `&>>`
 * (not `/dev/null` or an fd), `tee` operands and the file of `sed -i`. Heredoc bodies and quoted text are not
 * commands. A plain redirection target has `~` and known variables expanded where that places the write (see `placed`). Only for when the working tree can't be compared: a script
 * in another language is not seen.
 */
export function shellWriteTargets(command: string, cwd: string, projectDir: string, env: NodeJS.ProcessEnv = process.env, powershell = false): string[] {
	const text = heredocs(command).text;
	const segments = splitSegments(tokenize(text));
	// Each target, and whether it may be expanded: only a redirection's plain word, in bash, in a command that neither
	// moves nor runs code the text doesn't show (a sourced file or `eval` may bind any name).
	const found: Array<[string, boolean]> = [];
	const moves = movesOrBinds(segments);
	// Operators are found where quotes are blanked out; the target is read from the same place in the real text.
	for (const m of blankQuoted(text).matchAll(/(&>>?|\d*>[>|&]?)[ \t]*/g)) {
		const rest = text.slice(m.index + m[0].length);
		const target = /^("[^"]*"|'[^']*'|[^\s;&|()<>]+)/.exec(rest)?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
		if (!target || target === "/dev/null" || (m[1]!.endsWith("&") && /^(\d+|-)$/.test(target))) continue;
		const word = /^[^\s;&|()<>]*/.exec(rest)![0];
		found.push([target, !powershell && !moves && PLAIN_WORD.test(word)]);
	}
	for (const seg of segments) {
		if (seg[0] === "tee") found.push(...seg.slice(1).filter((t) => !t.startsWith("-")).map((t): [string, boolean] => [t, false]));
		if (seg[0] === "sed" && seg.some((t) => /^-i|^--in-place/.test(t)) && seg.length > 2) found.push([seg[seg.length - 1]!, false]);
	}
	const vars = knownVars(text, segments, env);
	const inside = found
		.map(([t, plain]) => (plain ? placed(t, vars, cwd, projectDir) : t))
		.filter((t): t is string => t !== undefined)
		.map((t) => relative(projectDir, resolve(cwd, t)))
		.filter((rel) => rel !== "" && !rel.startsWith("..") && !isAbsolute(rel))
		.map((rel) => rel.replaceAll("\\", "/"));
	return [...new Set(inside)];
}

/** Whether a command's text moves the shell or may bind names it doesn't show (see `hidesBinding`); in PowerShell, any move word. */
function hidesPlace(command: string, powershell = false): boolean {
	// PowerShell isn't parsed here, and a script it runs may move the caller's location: never place its targets.
	if (powershell) return true;
	const segments = splitSegments(tokenize(heredocs(command).text));
	return movesOrBinds(segments) || segments.some(bindsAsCommand);
}

function movesOrBinds(segments: string[][]): boolean {
	return segments.some((seg) => seg.some((t, i) => hidesBinding(t.replace(/^[({!]+/, ""), seg.slice(i + 1))));
}

/** Words that, as a command word, make the next word a command: reserved words and command prefixes. */
const STARTERS = new Set(["then", "do", "else", "elif", "if", "while", "until", "time", "builtin", "command", "exec"]);
/** Prefixes whose dash options come before the command they run. */
const OPTION_PREFIXES = new Set(["time", "command", "exec"]);
/** Tokens that open or close a group, a subshell, a function body or a `case` pattern: a command follows them anywhere. */
const OPENERS = new Set(["{", "(", "()", ")"]);

/**
 * Whether a segment runs `source`, `.`, `eval` or a declaration of unseen names as a command: its first word, or a word
 * after a reserved word or prefix (and its options), assignments (to the end of a substitution they open), a
 * `function NAME` or `name()` header, a `case` pattern, or a lone `{`, `(`, `()` or `)` wherever it stands. Another
 * word in an argument position starts nothing, so `grep "time" .` and `rg "(A|B)" .` don't bind.
 */
function bindsAsCommand(seg: string[]): boolean {
	let start = true;
	// After `case WORD`, the words up to `in`; after `in`, the pattern, up to the word that ends it with `)`.
	let inCase = false;
	let pattern = false;
	let prefix: string | undefined;
	// The function name after `function`, and the open substitutions of an assignment's value.
	let name = false;
	let open = 0;
	for (const [i, token] of seg.entries()) {
		if (open > 0) {
			open += depth(token);
			continue;
		}
		if (OPENERS.has(token)) {
			// A lone `)` also ends a `case` pattern.
			if (token === ")") pattern = false;
			start = true;
			continue;
		}
		if (inCase) {
			if (token === "in") {
				inCase = false;
				pattern = true;
			}
			continue;
		}
		if (pattern) {
			if (token.endsWith(")")) {
				pattern = false;
				start = true;
			}
			continue;
		}
		if (name) {
			name = false;
			continue;
		}
		if (!start) continue;
		if (prefix !== undefined && (token === "--" || /^-/.test(token))) {
			// `command -v`/`-V` only names the command; other options keep the position.
			if (prefix === "command" && /^-[a-zA-Z]*[vV]/.test(token)) start = false;
			continue;
		}
		prefix = undefined;
		if (/^[A-Za-z_]\w*=/.test(token)) {
			open = Math.max(0, depth(token));
			continue;
		}
		const word = wordOf(token);
		if (word === "" || /[({)]$/.test(token)) continue;
		if (STARTERS.has(word)) {
			if (OPTION_PREFIXES.has(word)) prefix = word;
			continue;
		}
		if (word === "function") {
			name = true;
			continue;
		}
		if (word === "case") {
			inCase = true;
			start = false;
			continue;
		}
		if (word === "in") {
			// `in` that begins a line of a `case` split over lines.
			pattern = true;
			continue;
		}
		if (!MOVES.has(word) && hidesBinding(word, seg.slice(i + 1))) return true;
		start = false;
	}
	return false;
}

/** A token's word after the last `(` or `{` it holds and any leading `!`: `(source`, `f()(source`, `!eval`. */
function wordOf(token: string): string {
	return token.slice(Math.max(token.lastIndexOf("("), token.lastIndexOf("{")) + 1).replace(/^!+/, "");
}

/** How many substitutions or groups a token opens and doesn't close: `$(git` 1, `x)` −1, `${PATH}:bin` 0; a backtick toggles. */
function depth(token: string): number {
	const count = (c: string) => token.split(c).length - 1;
	return count("(") - count(")") + count("{") - count("}") + (count("`") % 2);
}

/**
 * A word after which the text no longer shows where the shell is or what its names hold, wherever it stands: a move,
 * a sourced file, `eval`, or a declaration of anything but plain `NAME=v` words (`export $(…)`, `local X`).
 */
function hidesBinding(word: string, rest: string[]): boolean {
	if (MOVES.has(word) || ["source", ".", "eval"].includes(word)) return true;
	return ["export", "declare", "typeset", "local", "readonly"].includes(word) && !rest.every((w) => /^[A-Za-z_]\w*=/.test(w));
}

const NAME_REF = String.raw`\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})`;
/** A word the shell expands only as read here: `~` first, then plain path characters and `$NAME`/`${NAME}`. */
const PLAIN_WORD = new RegExp(String.raw`^(?:~(?=/|$))?(?:[\w./@+,:%=-]|${NAME_REF})+$|^~$`);

/** Environment variables a target may name. The shell sets others itself (`$_`, `$PWD`, `$OLDPWD`), or earlier calls may. */
const ENV_NAMES = ["HOME", "TMPDIR", "TMP", "TEMP"];

/**
 * Variables with one known value. A name the command writes bare anywhere but in a plain assignment (`for d`,
 * `read X`, `then X=…`, `local X=…`) is unknown; so is one assigned two values, or a value other than the environment's
 * (where the assignment doesn't run, that one does). `ENV_NAMES` keep the environment's value unless the command names
 * them bare at all; without HOME, `~` is unknown. A plain assignment is a segment of
 * `NAME=v` words, optionally after `export`; `NAME=v cmd` isn't one.
 */
function knownVars(text: string, segments: string[][], env: NodeJS.ProcessEnv): Map<string, string> {
	const assigned = new Map<string, Set<string>>();
	const count = new Map<string, number>();
	for (const seg of segments) {
		const words = seg[0] === "export" ? seg.slice(1) : seg;
		if (words.length === 0 || !words.every((w) => /^[A-Za-z_]\w*=/.test(w))) continue;
		for (const w of words) {
			const name = w.slice(0, w.indexOf("="));
			assigned.set(name, (assigned.get(name) ?? new Set()).add(w.slice(w.indexOf("=") + 1)));
			count.set(name, (count.get(name) ?? 0) + 1);
		}
	}
	const bare = (name: string) => text.match(new RegExp(String.raw`(?<![\w$])(?<!\$\{)${name}(?!\w)`, "g"))?.length ?? 0;
	const vars = new Map<string, string>();
	for (const name of ENV_NAMES) {
		const value = env[name];
		if (value && bare(name) === 0) vars.set(name, value);
	}
	for (const [name, values] of assigned) {
		const [value] = [...values];
		if (values.size === 1 && bare(name) === count.get(name) && !ENV_NAMES.includes(name) && (env[name] ?? value) === value) vars.set(name, value!);
	}
	return vars;
}

/**
 * Where a plain target lands: with `~` and known variables expanded (once: a value's own `$` stays), the expanded
 * path when it is inside the project; otherwise, unchanged, or with a part still unknown, the target as written,
 * which counts as before. It is dropped (undefined) only when the expanded path, or the folder written before its
 * unknown part, is neither inside the project nor above it, by its literal and its real path.
 */
function placed(target: string, vars: Map<string, string>, cwd: string, projectDir: string): string | undefined {
	const home = vars.get("HOME");
	const known = (home === undefined ? target : target.replace(/^~(?=\/|$)/, home)).replace(
		/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g,
		// Only before `/` or the end: a name the assignment didn't set is empty, and `$OUT.log` would then be `.log` here.
		(whole, braced: string | undefined, bare: string | undefined, at: number, word: string) =>
			/^(\/|$)/.test(word.slice(at + whole.length)) ? (vars.get(braced ?? bare!) ?? whole) : whole,
	);
	if (known === target) return target;
	const cut = known.search(/[$`]/);
	const path = cut === -1 ? known : known.slice(0, known.lastIndexOf("/", cut) + 1);
	// A path rooted another way than the project (`/c/…` from Git Bash for `C:\…`) can't be placed.
	if (!isAbsolute(path) || DRIVE.test(path) !== DRIVE.test(projectDir)) return within(resolve(projectDir), resolve(cwd, known)) ? known : target;
	const literal = resolve(cwd, path);
	const project = resolve(projectDir);
	if (cut === -1 && within(project, literal)) return known;
	return apart(literal, project) && apart(realPath(literal), realPath(project)) ? undefined : target;
}

const DRIVE = /^[A-Za-z]:[\\/]/;

/** Whether `path` is `dir` or inside it. */
function within(dir: string, path: string): boolean {
	const rel = relative(dir, path);
	return !rel.startsWith("..") && !isAbsolute(rel);
}

/** Neither inside the other. */
function apart(a: string, b: string): boolean {
	return !within(a, b) && !within(b, a);
}

/** The real path of the longest part that exists, with the rest appended. */
function realPath(path: string): string {
	let head = path;
	let tail = "";
	while (!existsSync(head) && dirname(head) !== head) {
		tail = tail ? join(basename(head), tail) : basename(head);
		head = dirname(head);
	}
	return tail ? join(safeRealpath(head), tail) : safeRealpath(head);
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "|&", "&", "\n"]);

/**
 * A command that does nothing but verify, so its own writes (a formatter, `lint --fix`) stay off the count: no writing
 * redirection, and outside heredoc bodies only checks (`commands` exactly, or a call `isScript` accepts) joined by
 * `&&`, where a call `isScript` accepts may be piped into `tail`, `head` or `grep` (it records its own result; a check
 * piped elsewhere would hide its exit code).
 */
export function verificationOnly(shell: string, commands: string[], isScript: (words: string[]) => boolean = () => false): boolean {
	const text = heredocs(shell).text;
	if (writes(text)) return false;
	const wanted = commands.map((c) => tokenize(stripRedirects(c)));
	const isCheck = (words: string[]) => wanted.some((w) => w.length === words.length && w.every((t, i) => t === words[i]));
	let words: string[] = [];
	let joinedBy = "";
	const segments: Array<{ words: string[]; joinedBy: string }> = [];
	for (const token of [...tokenize(stripRedirects(text)), ";"]) {
		if (!SEPARATORS.has(token)) words.push(token);
		else if (words.length > 0) {
			segments.push({ words, joinedBy });
			words = [];
			joinedBy = token;
		}
	}
	let headIsScript = false;
	let piped = false;
	return (
		segments.length > 0 &&
		segments.every((seg, i) => {
			if (seg.joinedBy === "|") {
				piped = true;
				return headIsScript && ["tail", "head", "grep"].includes(seg.words[0] ?? "");
			}
			// After a pipeline, `&&` would follow the reader's exit code, not the check's.
			if (i > 0 && (seg.joinedBy !== "&&" || piped)) return false;
			headIsScript = isScript(seg.words);
			return headIsScript || isCheck(seg.words);
		})
	);
}
