/**
 * What changed in the project's files, whatever wrote them: the verify gate compares fingerprints of the git
 * working tree before and after a shell command, and falls back to the command's text outside git.
 */
import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isIgnored } from "./commands.ts";
import { ignoredFolder, projectRepos } from "./repos.ts";
import { splitSegments, tokenize } from "./patterns.ts";
import { blankQuoted, heredocs, safeRealpath, stripRedirects, writes } from "./shell.ts";

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
	/** In a workspace: the parts not fingerprinted, a repository folder or `""` for the files outside them, sorted. */
	blind?: string[];
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
const WALK_EXCLUDES = ["**/.DS_Store", "**/Thumbs.db", ".claude/settings.local.json", ".pi/git/**", ".pi/npm/**", "**/.idea/**", "**/.vscode/**", "**/node_modules/**"];

/**
 * The files `git status` lists under `projectDir` (changed, new or deleted), by content identity only, so staging or
 * committing them is not a change; gitignored files and paths matching `ignore` are left out. `undefined` outside git,
 * on an error, after the timeout or over `MAX_ENTRIES` paths, so the caller can fall back to the command's text.
 * `why.slow` says the repository is too big or slow to fingerprint (a timeout or the cap), as opposed to not being a
 * repository (yet). A folder outside git that holds repositories (a workspace, see `projectRepos`) gets each
 * repository's entries under its folder and every file outside them. A part over the limit, failing, out of its share
 * of the deadline, named in `limits.skip`, or a symlink the walk meets is listed in `blind` instead; one that timed out
 * or went over the limit is also added to `why.slowParts`, for the caller to skip for the rest of the session.
 */
export function treeFingerprint(projectDir: string, ignore: string[], why: { slow?: boolean; slowParts?: string[] } = {}, limits: { deadline?: number; maxEntries?: number; skip?: string[] } = {}): Tree | undefined {
	const maxEntries = limits.maxEntries ?? MAX_ENTRIES;
	try {
		const tree = repoTree(projectDir, "", ignore, maxEntries, Number.POSITIVE_INFINITY);
		if (tree === "slow") why.slow = true;
		return tree === "slow" ? undefined : tree;
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
	const slow = (part: string) => (why.slowParts = [...(why.slowParts ?? []), part]);
	const files: Record<string, string> = {};
	const heads: Record<string, string> = {};
	const blind: string[] = [...skip].filter((part) => part === "" || repos.includes(part));
	// Each part gets an equal share of the time left, so one slow repository can't starve the others.
	const parts = [...repos.filter((r) => !skip.has(r)), ...(skip.has("") ? [] : [""])];
	parts.forEach((part, i) => {
		const share = Date.now() + (deadline - Date.now()) / (parts.length - i);
		if (part === "") {
			const outside = walkOutside(projectDir, repos, [...ignore, ...WALK_EXCLUDES], maxEntries, share);
			if (outside === "slow") slow("");
			if (typeof outside === "string") blind.push("");
			else {
				Object.assign(files, outside.files);
				blind.push(...outside.links);
			}
			return;
		}
		let tree: Tree | "slow" | undefined;
		try {
			tree = share > Date.now() ? repoTree(join(projectDir, part), `${part}/`, ignore, maxEntries, share) : undefined;
		} catch (err) {
			if (timedOut(err)) tree = "slow";
		}
		if (tree === "slow") slow(part);
		if (tree === undefined || tree === "slow") blind.push(part);
		else {
			Object.assign(files, tree.files);
			heads[part] = tree.head;
		}
	});
	return { head: "", files, heads, blind: blind.sort() };
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
 * One repository's listed files, each path prefixed with `label` (its folder in a workspace), matched against `ignore`
 * by that path and, in a workspace, by its path inside the repository too; throws outside git.
 */
function repoTree(dir: string, label: string, ignore: string[], maxEntries: number, deadline: number): Tree | "slow" {
	const prefix = git(dir, ["rev-parse", "--show-prefix"], timeLeft(deadline)).trim();
	const records = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], timeLeft(deadline)).split("\0");
	if (records.length > maxEntries + 1) return "slow";
	const files: Record<string, string> = {};
	const add = (repoPath: string) => {
		if (!repoPath.startsWith(prefix)) return;
		const path = repoPath.slice(prefix.length);
		if (!isIgnored(label + path, ignore) && !(label !== "" && isIgnored(path, ignore))) files[label + path] = identity(join(dir, path));
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
	} catch {
		// no commit yet
	}
	return { head, files };
}

/**
 * Every file of a workspace outside its repositories, by content identity, without `.git` or ignored paths; the
 * symlinks it meets are not followed but returned in `links`. `"slow"` over `maxEntries` files, `"late"` past the
 * deadline.
 */
function walkOutside(projectDir: string, repos: string[], ignore: string[], maxEntries: number, deadline: number): { files: Record<string, string>; links: string[] } | "slow" | "late" {
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
			if (entry.isSymbolicLink()) {
				if (!isIgnored(path, ignore) && !ignoredFolder(path, ignore)) links.push(path);
			} else if (entry.isDirectory()) {
				if (!ignoredFolder(path, ignore)) pending.push(path);
			} else if (entry.isFile() && !isIgnored(path, ignore)) {
				if (++count > maxEntries) return "slow";
				files[path] = identity(join(projectDir, path));
			}
		}
	}
	return { files, links };
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
 * blind to (a workspace repository, a symlink, or `""` for the files outside them). A part blind before has no
 * baseline, so its listed files don't count; its text targets do. With a blind part, a command that moves the shell or
 * may bind names (`cd`, a subshell, `source`) has every text target count, since its targets can't be placed. Without
 * both fingerprints, only its text.
 */
export function callChanges(before: Tree | undefined, now: Tree | undefined, projectDir: string, after?: { command: string; cwd: string; powershell?: boolean }): string[] {
	const written = () => (after ? shellWriteTargets(after.command, after.cwd, projectDir, process.env, after.powershell) : []);
	if (!before || !now) return written();
	const blind = new Set([...(before.blind ?? []), ...(now.blind ?? [])]);
	if (blind.size === 0) return changedPaths(before, now, projectDir);
	const repos = [...new Set([...Object.keys(before.heads ?? {}), ...Object.keys(now.heads ?? {}), ...blind])].filter((r) => r !== "");
	const partOf = (path: string) => repos.filter((r) => path === r || path.startsWith(`${r}/`)).sort((x, y) => y.length - x.length)[0] ?? "";
	const blindBefore = new Set(before.blind ?? []);
	const paths = changedPaths(before, now, projectDir).filter((p) => !blindBefore.has(partOf(p)));
	const moves = after !== undefined && hidesPlace(after.command);
	const unseen = written().filter((p) => moves || blind.has(partOf(p)));
	return [...new Set([...paths, ...unseen])].sort();
}

/**
 * Whether `ignore` excludes a project-relative path: by that path, or, for a file inside a workspace repository, by its
 * path inside the repository, as a session in that repository would match it.
 */
export function ignoredPath(projectDir: string, rel: string, ignore: string[]): boolean {
	if (isIgnored(rel, ignore)) return true;
	const slash = rel.indexOf("/");
	if (slash < 0 || !existsSync(join(projectDir, rel.slice(0, slash), ".git"))) return false;
	const { kind, repos } = projectRepos(projectDir, ignore);
	return kind === "workspace" && repos.includes(rel.slice(0, slash)) && isIgnored(rel.slice(slash + 1), ignore);
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

/** Whether a command's text moves the shell or may bind names it doesn't show (see `hidesBinding`). */
function hidesPlace(command: string): boolean {
	return movesOrBinds(splitSegments(tokenize(heredocs(command).text)));
}

function movesOrBinds(segments: string[][]): boolean {
	return segments.some((seg) => seg.some((t, i) => hidesBinding(t.replace(/^[({!]+/, ""), seg.slice(i + 1))));
}

/**
 * A word after which the text no longer shows where the shell is or what its names hold, wherever it stands: a move,
 * a sourced file, `eval`, or a declaration of anything but plain `NAME=v` words (`export $(…)`, `local X`).
 */
function hidesBinding(word: string, rest: string[]): boolean {
	if (["cd", "pushd", "popd", "source", ".", "eval"].includes(word)) return true;
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
