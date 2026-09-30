/**
 * Task files (one per piece of work: its description, plan and progress) live only on a work branch
 * and never reach the base branch. Git keeps the history.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitSegments, tokenize, type GuardDecision } from "./patterns.ts";

/** Where the kit keeps task files. */
export const WORK_DOC_DIRS = ["docs/tasks"];

const PLAN = /^## Plan[ \t]*$/m;
const NEXT_SECTION = /^## /m;
const OPEN_BOX = /^\s*[-*]\s+\[ \]/m;
const DONE_BOX = /^\s*[-*]\s+\[[xX]\]/m;

type Landing = { kind: "pr" } | { kind: "merge"; refs: string[] } | { kind: "push"; refspecs: string[]; all: boolean } | { kind: "commit" };

/**
 * Block a command that would put working documents on the base branch: opening or merging a PR/MR,
 * merging into the base, pushing to the base, or committing them on the base. Pushing a work branch is fine.
 */
export function checkWorkDocs(command: string, projectDir: string, dirs = WORK_DOC_DIRS): GuardDecision | undefined {
	if (dirs.length === 0) return undefined;
	const landings = splitSegments(tokenize(command)).map(landing).filter((l): l is Landing => l !== undefined);
	if (landings.length === 0 || git(projectDir, ["rev-parse", "--git-dir"]) === undefined) return undefined;

	const base = baseBranch(projectDir);
	const onBase = base !== undefined && currentBranch(projectDir) === base;
	for (const l of landings) {
		if (l.kind === "commit") {
			if (!onBase) continue;
			const staged = markdown(stagedPaths(projectDir, dirs));
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
			const files = markdown(trackedPaths(projectDir, ref, dirs));
			if (files.length > 0) return { action: "block", reason: leakReason(files, base) };
		}
	}
	return undefined;
}

/** The refs a command would land on the base branch (a PR/MR from HEAD, a merge into it, a push to it), or undefined. */
export function landingRefs(command: string, projectDir: string): { base: string; refs: string[] } | undefined {
	const landings = splitSegments(tokenize(command)).map(landing).filter((l): l is Landing => l !== undefined && l.kind !== "commit");
	if (landings.length === 0 || git(projectDir, ["rev-parse", "--git-dir"]) === undefined) return undefined;
	const base = baseBranch(projectDir);
	if (!base) return undefined;
	const onBase = currentBranch(projectDir) === base;
	const refs = landings.flatMap((l) => (l.kind === "pr" ? ["HEAD"] : l.kind === "merge" ? (onBase ? l.refs : []) : l.kind === "push" ? pushedToBase(l, base, onBase) : []));
	return refs.length > 0 ? { base, refs } : undefined;
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

/** The branch work lands on: `origin/HEAD`, else an existing `main` or `master`. */
export function baseBranch(projectDir: string): string | undefined {
	const remote = git(projectDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (remote) return remote.replace(/^origin\//, "");
	return ["main", "master"].find((b) => git(projectDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]) !== undefined);
}

/** The base branch's name when it is checked out, else undefined. */
export function onBaseBranch(projectDir: string): string | undefined {
	const base = baseBranch(projectDir);
	return base !== undefined && currentBranch(projectDir) === base ? base : undefined;
}

function currentBranch(projectDir: string): string | undefined {
	return git(projectDir, ["branch", "--show-current"]) || undefined;
}

function landing(tokens: string[]): Landing | undefined {
	const words = tokens.filter((t) => !t.includes("=") || t.startsWith("-"));
	for (const tool of ["gh", "glab"]) {
		const at = words.indexOf(tool);
		if (at === -1) continue;
		const [noun, verb] = words.slice(at + 1).filter((t) => !t.startsWith("-"));
		if ((noun === "pr" || noun === "mr") && (verb === "create" || verb === "merge")) return { kind: "pr" };
	}
	if (!words.includes("git")) return undefined;
	// Raw tokens after git: `-c key=value` keeps its value, so options and their values pair up.
	const rest = tokens.slice(tokens.indexOf("git") + 1);
	// The subcommand is the first word after git's own options (`-C <dir>` and `-c <key=value>` take a value).
	let verb = 0;
	while (verb < rest.length && rest[verb]!.startsWith("-")) verb += rest[verb] === "-C" || rest[verb] === "-c" ? 2 : 1;
	const args = rest.slice(verb + 1);
	const positional = args.filter((t) => !t.startsWith("-"));
	switch (rest[verb]) {
		case "commit":
			return { kind: "commit" };
		case "merge":
			return { kind: "merge", refs: positional };
		case "push":
			return { kind: "push", refspecs: positional.slice(1), all: args.includes("--all") };
		default:
			return undefined;
	}
}

/** Refs whose content a push would place on the base branch. */
function pushedToBase(l: Extract<Landing, { kind: "push" }>, base: string | undefined, onBase: boolean): string[] {
	if (!base) return [];
	if (l.all) return [base];
	if (l.refspecs.length === 0) return onBase ? ["HEAD"] : [];
	const refs: string[] = [];
	for (const spec of l.refspecs) {
		const [src = "", dst = src] = spec.replace(/^\+/, "").split(":");
		if (src && dst.replace(/^refs\/heads\//, "") === base) refs.push(src);
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

function git(cwd: string, args: string[]): string | undefined {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
	return r.status === 0 ? r.stdout.trim() : undefined;
}
