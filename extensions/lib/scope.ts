/**
 * The guard configs in force: the session folder's and, in a workspace, each repository's own, and how they combine.
 * Restrictions add up, each measured from its own root; loosening (`allow`) counts only where it is written: the
 * session folder's everywhere, a repository's only for a command that runs in that repository alone.
 */
import { basename, join } from "node:path";
import { checkPath, type GuardConfig, type GuardDecision } from "./patterns.ts";
import { projectRepos, repoOf } from "./repos.ts";
import { segmentFolders } from "./shell.ts";

export interface GuardScope {
	projectDir: string;
	config: GuardConfig;
	/** Each workspace repository's own config, by absolute folder; empty outside a workspace. */
	repos: Map<string, GuardConfig>;
}

/** The session folder's config and, in a workspace, each repository's, read by `load` from that root. */
export function guardScope(projectDir: string, load: (root: string) => GuardConfig): GuardScope {
	const { kind, repos } = projectRepos(projectDir);
	const configs = new Map<string, GuardConfig>();
	if (kind === "workspace") for (const name of repos) configs.set(join(projectDir, name), load(join(projectDir, name)));
	return { projectDir, config: load(projectDir), repos: configs };
}

/** The stricter of two decisions: block, then confirm, then allow; a tie keeps `a`. */
export function strictest(a: GuardDecision, b: GuardDecision): GuardDecision {
	return RANK[b.action] > RANK[a.action] ? b : a;
}

const RANK: Record<GuardDecision["action"], number> = { allow: 0, confirm: 1, block: 2 };

/** A path judged from the session folder with its config and, inside a workspace repository, from it with its own. */
export function scopedPath(tool: "read" | "write" | "edit", path: string, scope: GuardScope): GuardDecision {
	const own = checkPath(tool, path, scope.projectDir, scope.config);
	const repo = repoIn(scope, path);
	return repo === undefined ? own : strictest(own, checkPath(tool, path, repo, scope.repos.get(repo)!));
}

/** The config a shell command is judged by: see the module comment. Outside a workspace, the session folder's. */
export function scopedConfig(command: string, cwd: string, scope: GuardScope): GuardConfig {
	if (scope.repos.size === 0) return scope.config;
	const segments = segmentFolders(command, cwd);
	const unknown = segments.some((s) => s.dir === undefined);
	// Where each working segment runs; a move only leads there.
	const ran = segments.filter((s) => !s.move).map((s) => (s.dir === undefined ? undefined : repoIn(scope, s.dir)));
	const touched = unknown ? [...scope.repos.keys()] : [...new Set(ran.filter((r) => r !== undefined))];
	const only = !unknown && ran.length > 0 && ran.every((r) => r !== undefined && r === ran[0]) ? ran[0] : undefined;
	const rules = touched.map((dir) => scope.repos.get(dir)!);
	return {
		...scope.config,
		block: [...(scope.config.block ?? []), ...rules.flatMap((c) => c.block ?? [])],
		confirm: [...(scope.config.confirm ?? []), ...rules.flatMap((c) => c.confirm ?? [])],
		allow: [...(scope.config.allow ?? []), ...(only === undefined ? [] : (scope.repos.get(only)!.allow ?? []))],
	};
}

/** The workspace repository holding `path`, as the absolute folder `scope.repos` keys it by. */
export function repoIn(scope: GuardScope, path: string): string | undefined {
	return repoOf(scope.projectDir, [...scope.repos.keys()].map((dir) => basename(dir)), path);
}
