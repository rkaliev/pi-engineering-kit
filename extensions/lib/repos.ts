/**
 * Which git repositories a project folder is: the repository it sits in, or, for a folder outside git that holds
 * repositories side by side (a polyrepo workspace), each of them. The gates fingerprint and record per repository.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
	return placeIn(projectDir, repos, path)?.repo;
}

/**
 * `path` placed in the workspace repository holding it by its real location (symlinks followed, each name as the
 * volume stores it, so a case-swapped name on a case-insensitive volume counts): the repository's folder, and the path
 * as it is inside that folder. Undefined outside the repositories. `byRealPath: false` places the path as written.
 */
export function placeIn(projectDir: string, repos: string[], path: string, byRealPath = true): { repo: string; path: string } | undefined {
	if (!byRealPath) {
		const abs = resolve(path);
		const repo = repos.map((name) => join(projectDir, name)).find((dir) => abs === dir || abs.startsWith(dir + sep));
		return repo === undefined ? undefined : { repo, path: abs };
	}
	const real = canonical(path);
	for (const name of repos) {
		const repo = join(projectDir, name);
		const root = canonical(repo);
		if (real === root || real.startsWith(root + sep)) return { repo, path: join(repo, relative(root, real)) };
	}
	return undefined;
}

/** The real path of the deepest folder of `path` that exists, with the rest appended as written. */
function canonical(path: string): string {
	let head = resolve(path);
	const rest: string[] = [];
	while (!existsSync(head) && dirname(head) !== head) {
		rest.unshift(basename(head));
		head = dirname(head);
	}
	try {
		head = realpathSync.native(head);
	} catch {
		// unreadable: as written
	}
	return join(head, ...rest);
}
