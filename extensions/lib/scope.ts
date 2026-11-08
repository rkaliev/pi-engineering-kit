/**
 * The guard configs in force: the session folder's and, in a workspace, each repository's own, and how they combine.
 * Restrictions add up, each measured from its own root; loosening (`allow`) counts only where it is written: the
 * session folder's everywhere, a repository's only for a command that runs in that repository alone.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { checkPath, foldPath, type GuardConfig, type GuardDecision } from "./patterns.ts";
import { canonical, placeIn, projectRepos, repoOf } from "./repos.ts";
import { blankQuoted, segmentFolders } from "./shell.ts";

export interface GuardScope {
	projectDir: string;
	/** What the session folder is (see `projectRepos`). */
	kind: "repo" | "workspace" | "none";
	/** The guard config's path inside a root (`.claude/guard.json`, `.pi/guard.json`). */
	guardFile: string;
	config: GuardConfig;
	/** Each workspace repository's own config, by absolute folder; empty outside a workspace. */
	repos: Map<string, GuardConfig>;
	/** The workspace repositories that were there when the session started (all of them without a baseline). */
	owners: string[];
}

/**
 * The session folder's config and, in a workspace, each repository's, read by `load` from that root. With a
 * `baseline`, a repository or a config that isn't the one the session started with (a clone, a folder replaced, an
 * edited config) keeps its restrictions and loses its loosening; what a repository restricted at the start still
 * holds; and the repositories of the start still count after `git init` at the root or past MAX_REPOS.
 */
export function guardScope(projectDir: string, load: (root: string) => GuardConfig, guardFile: string, baseline?: GuardBaseline): GuardScope {
	const found = projectRepos(projectDir);
	// A repository of the start keeps its restrictions while its folder exists, with or without `.git`.
	const kept = baseline === undefined ? [] : Object.keys(baseline).filter((name) => existsSync(join(projectDir, name)));
	const names = [...new Set([...(found.kind === "workspace" ? found.repos : []), ...kept])].sort();
	const kind = found.kind === "workspace" || kept.length === 0 ? found.kind : "workspace";
	const configs = new Map<string, GuardConfig>();
	const owners: string[] = [];
	for (const name of names) {
		const dir = join(projectDir, name);
		const config = load(dir);
		const id = repoId(dir);
		const byName = baseline !== undefined && Object.hasOwn(baseline, name) ? baseline[name] : undefined;
		const same = byName !== undefined && byName.id !== null && byName.id === id;
		// A repository renamed since the start is found by its `.git`: its restrictions follow it, nothing else does;
		// after a swap of two folders both entries' restrictions hold.
		const byId = baseline === undefined || id === null ? undefined : Object.values(baseline).find((entry) => entry.id === id);
		const was = byName === undefined ? byId : byId === undefined || byId === byName ? byName : { ...byName, block: [...byName.block, ...byId.block], confirm: [...byName.confirm, ...byId.confirm], protectedPaths: [...byName.protectedPaths, ...byId.protectedPaths] };
		const known = baseline === undefined || (same && byName.config === configHash(join(dir, guardFile)));
		const own = known ? config : { ...config, allow: [], workDocs: undefined, reviewGate: true };
		const union = (now: string[] | undefined, then: string[]) => [...new Set([...(now ?? []), ...then])];
		configs.set(dir, was === undefined ? own : { ...own, block: union(own.block, was.block), confirm: union(own.confirm, was.confirm), protectedPaths: union(own.protectedPaths, was.protectedPaths) });
		if (baseline === undefined || same) owners.push(dir);
	}
	return { projectDir, kind, guardFile, config: load(projectDir), repos: configs, owners };
}

/** The stricter of two decisions: block, then confirm, then allow; a tie keeps `a`. */
export function strictest(a: GuardDecision, b: GuardDecision): GuardDecision {
	return RANK[b.action] > RANK[a.action] ? b : a;
}

const RANK: Record<GuardDecision["action"], number> = { allow: 0, confirm: 1, block: 2 };

/** A path judged from the session folder with its config and, inside a workspace repository, from it with its own. */
export function scopedPath(tool: "read" | "write" | "edit", path: string, scope: GuardScope): GuardDecision {
	const own = checkPath(tool, path, scope.projectDir, scope.config);
	// Placed as written and by its real location: a symlink may lead into a repository or out of one.
	const places = [placeIn(scope.projectDir, names(scope), path, false), placeIn(scope.projectDir, names(scope), path)];
	// Where it really leads, also outside a workspace: a symlink to `.husky`, or a letter the file system folds (`.huſky`).
	const real = strictest(own, checkPath(tool, canonical(path), canonical(scope.projectDir), scope.config));
	const placed = places.reduce((d, inside) => (inside === undefined ? d : strictest(d, checkPath(tool, inside.path, inside.repo, scope.repos.get(inside.repo)!))), real);
	// Outside git, a first-level folder's guard config is a repository's, or will be one after `git init`.
	const rel = relative(scope.projectDir, resolve(path)).replaceAll("\\", "/");
	const slash = rel.indexOf("/");
	if (tool === "read" || scope.kind === "repo" || slash <= 0 || rel.startsWith("../") || foldPath(rel.slice(slash + 1)) !== scope.guardFile) return placed;
	return strictest(placed, { action: "confirm", reason: `${path} is the guard config of ${rel.slice(0, slash)}: it decides what the guard blocks there. Loosening it is the user's call; show them the change first.` });
}

/**
 * The config a shell command is judged by: see the module comment. A working segment that doesn't run inside one
 * workspace repository (the workspace root, or a folder the guard can't tell) may reach any of them, so it gets every
 * repository's restrictions; a repository whose folder name the command text mentions as a path (`--prefix a`,
 * `../a/x`) adds its restrictions, never its loosening. Outside a workspace, the session folder's.
 */
export function scopedConfig(command: string, cwd: string, scope: GuardScope, powershell = false): GuardConfig {
	if (scope.repos.size === 0) return scope.config;
	const segments = segmentFolders(command, cwd, powershell);
	// Where each working segment runs; a move only leads there.
	const working = segments.filter((s) => !s.move);
	const ran = working.map((s) => (s.dir === undefined ? undefined : repoIn(scope, s.dir)));
	const anywhere = ran.some((r) => r === undefined) || segments.some((s) => s.dir === undefined);
	// A path word placed by its real location (a symlink, a case-swapped name) from the folder its segment runs in.
	const reached = new Set<string>();
	for (const { raw, dir } of anywhere ? [] : working) {
		for (const word of raw.flatMap((t) => [t, t.slice(t.indexOf("=") + 1)]).map((t) => t.replace(/^['"(]+|['")]+$/g, ""))) {
			if (!pathLike(word, dir!, scope)) continue;
			const repo = placeIn(scope.projectDir, names(scope), resolve(dir!, word))?.repo;
			if (repo !== undefined) reached.add(repo);
		}
	}
	// The text match only adds restrictions: a repository's name in a message is no reason to drop the allow.
	const named = [...scope.repos.keys()].filter((dir) => mentions(command, basename(dir)));
	const touched = anywhere ? [...scope.repos.keys()] : [...new Set([...ran.filter((r) => r !== undefined), ...reached, ...named])];
	// A repository named outside quotes is a target, so it takes the allow away; a name in a quoted message isn't.
	const said = [...scope.repos.keys()].filter((dir) => mentions(blankQuoted(command), basename(dir)));
	const only = !anywhere && ran.length > 0 && ran.every((r) => r === ran[0]) && [...reached, ...said].every((r) => r === ran[0]) ? ran[0] : undefined;
	const rules = touched.map((dir) => scope.repos.get(dir)!);
	// Which file each rule came from, for the reason; the session folder's first.
	const sources: Record<string, string> = {};
	for (const c of [scope.config, ...rules]) for (const rule of [...(c.block ?? []), ...(c.confirm ?? [])]) if (!Object.hasOwn(sources, rule)) sources[rule] = c.label ?? scope.guardFile;
	return {
		...scope.config,
		sources,
		pushOwners: scope.owners,
		block: [...(scope.config.block ?? []), ...rules.flatMap((c) => c.block ?? [])],
		confirm: [...(scope.config.confirm ?? []), ...rules.flatMap((c) => c.confirm ?? [])],
		allow: [...(scope.config.allow ?? []), ...(only === undefined ? [] : (scope.repos.get(only)!.allow ?? []))],
	};
}

/** Whether `text` names the folder `name` as a path segment (`a`, `a/x`, `../a`, `--prefix=a`, `-Ca`), in any case. */
function mentions(text: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[\\s'"=:/(\`]|-C)${escaped}($|[\\s'"/)\`;|&])`, "i").test(text);
}

/** A word that may be a path into another repository: it has a `/`, starts with `..`, is a repository's name, or is a symlink in `dir`. */
function pathLike(word: string, dir: string, scope: GuardScope): boolean {
	if (word === "" || word.startsWith("-") || /[$`]/.test(word)) return false;
	if (word.includes("/") || word.startsWith("..") || names(scope).some((n) => n.toLowerCase() === word.toLowerCase())) return true;
	try {
		return lstatSync(join(dir, word)).isSymbolicLink();
	} catch {
		return false;
	}
}

/** The workspace repository holding `path`, as the absolute folder `scope.repos` keys it by. */
export function repoIn(scope: GuardScope, path: string): string | undefined {
	return repoOf(scope.projectDir, names(scope), path);
}

function names(scope: GuardScope): string[] {
	return [...scope.repos.keys()].map((dir) => basename(dir));
}

/** A workspace repository as the session started with it: its `.git` entry's identity, its guard config's hash and restrictions. */
export interface BaselineRepo {
	id: string | null;
	config: string | null;
	block: string[];
	confirm: string[];
	protectedPaths: string[];
}

/** The workspace repositories when the session started, by folder name. */
export type GuardBaseline = Record<string, BaselineRepo>;

/** The workspace repositories now, as `guardScope` compares them later: taken once, when the session starts. */
export function guardBaseline(projectDir: string, guardFile: string, load: (root: string) => GuardConfig): GuardBaseline {
	const { kind, repos } = projectRepos(projectDir);
	const baseline: GuardBaseline = {};
	for (const name of kind === "workspace" ? repos : []) {
		const dir = join(projectDir, name);
		const config = load(dir);
		baseline[name] = { id: repoId(dir), config: configHash(join(dir, guardFile)), block: config.block ?? [], confirm: config.confirm ?? [], protectedPaths: config.protectedPaths ?? [] };
	}
	return baseline;
}

/** Whether `value` has a baseline's shape (read back from a session state or a parent process). */
export function isGuardBaseline(value: unknown): value is GuardBaseline {
	const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
	const repo = (v: unknown) => {
		const r = v as Partial<BaselineRepo> | null;
		return !!r && typeof r === "object" && (r.id === null || typeof r.id === "string") && (r.config === null || typeof r.config === "string") && strings(r.block) && strings(r.confirm) && strings(r.protectedPaths);
	};
	return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(repo);
}

/** The identity of a repository's `.git` entry: a folder replaced by a clone under the same name has another. */
function repoId(dir: string): string | null {
	try {
		// The birth time tells a new `.git` from an old one whose freed inode number a file system reused.
		const stat = lstatSync(join(dir, ".git"));
		// Only a real birth time: where it isn't kept, Node reports 0 or the change time, which every git write moves.
		const born = stat.birthtimeMs > 0 && stat.birthtimeMs !== stat.ctimeMs ? stat.birthtimeMs : "";
		return `${stat.dev}:${stat.ino}:${born}`;
	} catch {
		return null;
	}
}

function configHash(file: string): string | null {
	try {
		return createHash("sha1").update(readFileSync(file)).digest("hex");
	} catch {
		return null;
	}
}

/**
 * The folder `core.hooksPath` names in the session folder's repository, or in each workspace repository, keyed by the
 * root as `guardScope` names it and relative to it (`""` for the root itself). A folder outside that root, an unset key
 * or a git that fails adds nothing: the known hook paths still ask (lib/patterns.ts).
 */
export function hooksPaths(projectDir: string, budgetMs = HOOKS_BUDGET_MS, status?: { complete: boolean }): Record<string, string> {
	const deadline = Date.now() + budgetMs;
	const found = projectRepos(projectDir);
	const roots = found.kind === "repo" ? [projectDir] : found.kind === "workspace" ? found.repos.map((name) => join(projectDir, name)) : [];
	const paths: Record<string, string> = {};
	// A read that timed out or couldn't run, or a repository left unread: the map is incomplete, and the caller may read again.
	const missed = () => {
		if (status) status.complete = false;
	};
	for (const root of roots) {
		if (Date.now() >= deadline) {
			missed();
			break;
		}
		try {
			// One hanging repository takes at most HOOKS_CALL_MS of the budget, so the others are still read.
			const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: Math.max(1, Math.min(HOOKS_CALL_MS, deadline - Date.now())) });
			const value = git("config", "--type=path", "--get", "core.hooksPath");
			if (value.error) missed();
			if (value.status !== 0 || value.stdout.trim() === "") continue;
			// Git resolves a relative hooks path from the top of the working tree (a workspace repository's root is its top).
			const top = found.kind === "workspace" ? root : git("rev-parse", "--show-toplevel").stdout?.trim();
			if (!top) {
				missed();
				continue;
			}
			// The guard measures from the root it is given, by real paths; a folder outside it adds nothing.
			const rel = relative(canonical(root), canonical(resolve(top, value.stdout.trim()))).replaceAll("\\", "/");
			if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
			paths[root] = rel;
		} catch {
			// an unreadable repository adds nothing: the known hook paths still ask
			missed();
		}
	}
	return paths;
}

/** All `core.hooksPath` reads of one session start share this budget (the SessionStart hook times out at 10 s). */
const HOOKS_BUDGET_MS = 3000;
/** The longest one `core.hooksPath` read may take of that budget. */
const HOOKS_CALL_MS = 1000;
