/**
 * What changed in the project's files, whatever wrote them: the verify gate compares fingerprints of the git
 * working tree before and after a shell command, and falls back to the command's text outside git.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isIgnored } from "./commands.ts";
import { splitSegments, tokenize } from "./patterns.ts";
import { blankQuoted, heredocs } from "./shell.ts";

const GIT_TIMEOUT_MS = 3000;
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
 * Each changed, new or deleted file under `projectDir` (project-relative path) mapped to `"<XY> <size> <mtimeMs>"`,
 * or `"deleted"`; gitignored files and paths matching `ignore` are left out. `undefined` outside git, on an error or
 * after the timeout, so the caller can fall back to the command's text.
 */
export function treeFingerprint(projectDir: string, ignore: string[]): Record<string, string> | undefined {
	try {
		const prefix = git(projectDir, ["rev-parse", "--show-prefix"]).trim();
		const records = git(projectDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]).split("\0");
		const tree: Record<string, string> = {};
		const add = (status: string, repoPath: string) => {
			if (!repoPath.startsWith(prefix)) return;
			const path = repoPath.slice(prefix.length);
			if (isIgnored(path, ignore)) return;
			try {
				const { size, mtimeMs } = statSync(join(projectDir, path));
				tree[path] = `${status} ${size} ${mtimeMs}`;
			} catch {
				tree[path] = "deleted";
			}
		};
		for (let i = 0; i < records.length; i++) {
			const record = records[i]!;
			if (record.length < 4) continue;
			const status = record.slice(0, 2);
			add(status, record.slice(3));
			// A rename or copy is followed by its source path: both count.
			if (status[0] === "R" || status[0] === "C") add(status, records[++i] ?? "");
		}
		return tree;
	} catch {
		return undefined;
	}
}

/** The paths whose entry was added, removed or differs, sorted; empty means nothing changed. */
export function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
	const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...paths].filter((p) => before[p] !== after[p]).sort();
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
