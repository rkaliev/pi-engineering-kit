/**
 * Which git repositories a project folder is: the repository it sits in, or, for a folder outside git that holds
 * repositories side by side (a polyrepo workspace), each of them. The gates fingerprint and record per repository.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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
 * a folder or a linked worktree's file, minus the ignored ones; 1..MAX_REPOS of them make a workspace. Deeper levels
 * aren't searched, and discovery runs no git.
 */
export function projectRepos(projectDir: string, ignore: string[] = []): ProjectRepos {
	const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectDir, encoding: "utf8", timeout: 3000 });
	if (inside.status === 0 && inside.stdout.trim() === "true") return { kind: "repo", repos: [""] };
	let names: string[];
	try {
		names = readdirSync(projectDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && existsSync(join(projectDir, e.name, ".git")) && !ignoredFolder(e.name, ignore))
			.map((e) => e.name)
			.sort();
	} catch {
		return { kind: "none", repos: [] };
	}
	return names.length > 0 && names.length <= MAX_REPOS ? { kind: "workspace", repos: names } : { kind: "none", repos: [] };
}

/** A folder a glob names itself or everything under (`name/**`). */
export function ignoredFolder(rel: string, ignore: string[]): boolean {
	return isIgnored(rel, ignore) || ignore.some((g) => g.endsWith("/**") && isIgnored(rel, [g.slice(0, -3)]));
}

/** The workspace repository folder that holds `path`, or `projectDir` itself (inside a repository, or outside them all). */
export function repoOf(projectDir: string, path: string): string {
	const { kind, repos } = projectRepos(projectDir);
	if (kind !== "workspace") return projectDir;
	const rel = relative(projectDir, path);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return projectDir;
	const top = rel.split(/[\\/]/)[0]!;
	return repos.includes(top) ? join(projectDir, top) : projectDir;
}
