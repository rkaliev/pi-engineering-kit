/**
 * What changed in the project's files, whatever wrote them: the verify gate compares fingerprints of the git
 * working tree before and after a shell command, and falls back to the command's text outside git.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isIgnored } from "./commands.ts";
import { splitSegments, tokenize } from "./patterns.ts";
import { blankQuoted, heredocs, stripRedirects } from "./shell.ts";

const GIT_TIMEOUT_MS = 3000;
/** More listed paths than this and the session falls back to the command text. */
export const MAX_ENTRIES = 5000;

/** A fingerprint of the working tree: the commit checked out, and each listed file's content identity. */
export interface Tree {
	/** `HEAD`, or `""` before the first commit. */
	head: string;
	/** Project-relative path → `"<size> <mtimeMs>"`, or `"deleted"`. */
	files: Record<string, string>;
}

const MAX_BUFFER = 16 * 1024 * 1024;

function git(projectDir: string, args: string[]): string {
	return execFileSync("git", ["--no-optional-locks", ...args], {
		cwd: projectDir,
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: MAX_BUFFER,
		stdio: ["ignore", "pipe", "ignore"],
	});
}

/**
 * The files `git status` lists under `projectDir` (changed, new or deleted), by content identity only, so staging or
 * committing them is not a change; gitignored files and paths matching `ignore` are left out. `undefined` outside git,
 * on an error, after the timeout or over `MAX_ENTRIES` paths, so the caller can fall back to the command's text.
 */
export function treeFingerprint(projectDir: string, ignore: string[]): Tree | undefined {
	try {
		const prefix = git(projectDir, ["rev-parse", "--show-prefix"]).trim();
		const records = git(projectDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]).split("\0");
		if (records.length > MAX_ENTRIES + 1) return undefined;
		const files: Record<string, string> = {};
		const add = (repoPath: string) => {
			if (!repoPath.startsWith(prefix)) return;
			const path = repoPath.slice(prefix.length);
			if (!isIgnored(path, ignore)) files[path] = identity(join(projectDir, path));
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
			head = git(projectDir, ["rev-parse", "--verify", "-q", "HEAD"]).trim();
		} catch {
			// no commit yet
		}
		return { head, files };
	} catch {
		return undefined;
	}
}

/**
 * The project files whose content changed between two fingerprints, sorted; empty means nothing changed. A path that
 * left the list (staged and committed, or restored) counts only if its size or time now differ; when `HEAD` moved, the
 * files its commits touched that were clean before count too (an edit committed in the same command, a checkout).
 */
export function changedPaths(before: Tree, after: Tree, projectDir: string, ignore: string[] = []): string[] {
	const changed = new Set<string>();
	for (const path of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
		const now = after.files[path] ?? identity(join(projectDir, path));
		if (before.files[path] !== now) changed.add(path);
	}
	if (before.head && after.head && before.head !== after.head) {
		try {
			const touched = git(projectDir, ["diff", "--name-only", "--relative", "-z", before.head, after.head, "--", "."]).split("\0");
			for (const path of touched) if (path && !(path in before.files) && !isIgnored(path, ignore)) changed.add(path);
		} catch {
			// an unreachable commit (a rewritten history): the listed files above still count
		}
	}
	return [...changed].sort();
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
 * commands. Only for when the working tree can't be compared: a script in another language is not seen.
 */
export function shellWriteTargets(command: string, cwd: string, projectDir: string): string[] {
	const text = heredocs(command).text;
	const found: string[] = [];
	// Operators are found where quotes are blanked out; the target is read from the same place in the real text.
	for (const m of blankQuoted(text).matchAll(/(&>>?|\d*>[>|&]?)[ \t]*/g)) {
		const target = /^("[^"]*"|'[^']*'|[^\s;&|()<>]+)/.exec(text.slice(m.index + m[0].length))?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
		if (!target || target === "/dev/null" || (m[1]!.endsWith("&") && /^(\d+|-)$/.test(target))) continue;
		found.push(target);
	}
	for (const seg of splitSegments(tokenize(text))) {
		if (seg[0] === "tee") found.push(...seg.slice(1).filter((t) => !t.startsWith("-")));
		if (seg[0] === "sed" && seg.some((t) => /^-i|^--in-place/.test(t)) && seg.length > 2) found.push(seg[seg.length - 1]!);
	}
	const inside = found
		.map((t) => relative(projectDir, resolve(cwd, t)))
		.filter((rel) => rel !== "" && !rel.startsWith("..") && !isAbsolute(rel))
		.map((rel) => rel.replaceAll("\\", "/"));
	return [...new Set(inside)];
}

/**
 * A command that does nothing but verify: every segment, outside heredoc bodies and after redirections, is one of
 * `commands` exactly, a call `isScript` accepts (the edition's own verify script), or `tail`, `head` or `grep` reading
 * the output. Only such a run keeps its own writes (a formatter, `lint --fix`, its output file) off the count.
 */
export function verificationOnly(shell: string, commands: string[], isScript: (words: string[]) => boolean = () => false): boolean {
	const readers = ["tail", "head", "grep"];
	const wanted = commands.map((c) => tokenize(stripRedirects(c)));
	const segments = splitSegments(tokenize(stripRedirects(heredocs(shell).text)));
	return (
		segments.some((seg) => !readers.includes(seg[0] ?? "")) &&
		segments.every(
			(seg) => readers.includes(seg[0] ?? "") || isScript(seg) || wanted.some((w) => w.length === seg.length && w.every((t, i) => t === seg[i])),
		)
	);
}
