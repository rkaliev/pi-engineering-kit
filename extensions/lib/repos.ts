/**
 * Which git repositories a project folder is: the repository it sits in, or, for a folder outside git that holds
 * repositories side by side (a polyrepo workspace), each of them. The gates fingerprint and record per repository.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isIgnored } from "./commands.ts";

/** More first-level repositories than this and the folder is treated as holding none. */
export const MAX_REPOS = 32;

export interface ProjectRepos {
	/** `repo`: inside a git working tree; `workspace`: outside git, with repositories as direct subfolders; `none`: neither. */
	kind: "repo" | "workspace" | "none";
	/** `[""]` for `repo`; the repository folders' names, sorted, for `workspace`; `[]` for `none`. */
	repos: string[];
}

/**
 * Inside a git working tree, one repository. Otherwise the direct subfolders (not symlinks) that hold a `.git` entry,
 * a folder or a linked worktree's file: up to MAX_REPOS of them, at least one not ignored, make a workspace of the ones
 * not ignored. Deeper levels aren't searched, and discovery runs no git.
 */
export function projectRepos(projectDir: string, ignore: string[] = []): ProjectRepos {
	const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectDir, encoding: "utf8", timeout: 3000 });
	if (inside.status === 0 && inside.stdout.trim() === "true") return { kind: "repo", repos: [""] };
	let found: string[];
	try {
		found = readdirSync(projectDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && existsSync(join(projectDir, e.name, ".git")))
			.map((e) => e.name)
			.sort();
	} catch {
		return { kind: "none", repos: [] };
	}
	// The limit counts before ignoring, so callers with and without `ignore` agree on the kind.
	const names = found.filter((name) => !ignoredFolder(name, ignore));
	return names.length > 0 && found.length <= MAX_REPOS ? { kind: "workspace", repos: names } : { kind: "none", repos: [] };
}

/** A folder a glob names with everything under it (`<folder>/**`); a glob for files never prunes a folder. */
export function ignoredFolder(rel: string, ignore: string[]): boolean {
	return ignore.some((g) => g.endsWith("/**") && isIgnored(rel, [g.slice(0, -3)]));
}

/** The workspace repository (one of `repos`, folder names under `projectDir`) holding `path`, as an absolute folder; undefined outside them. */
export function repoOf(projectDir: string, repos: string[], path: string): string | undefined {
	const abs = resolve(path);
	return repos.map((r) => join(projectDir, r)).find((dir) => abs === dir || abs.startsWith(dir + sep));
}
