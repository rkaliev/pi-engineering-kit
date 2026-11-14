import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readProjectJson } from "./config.ts";
import { splitSegments, tokenize } from "./patterns.ts";

export interface VerifyConfig {
	commands: string[];
	timeoutSec?: number;
	/** Globs (relative to the project) whose edits don't make the workspace unverified. */
	ignore?: string[];
	/** Per command, the globs of the files it checks; a command without an entry checks every file. */
	paths?: unknown;
}

/** The project's verification config file, relative to the project. */
export const VERIFY_FILE = ".pi/verify.json";

export interface VerifyPaths {
	/** The globs of each command with a valid entry. */
	scopes: Map<string, string[]>;
	/** What is wrong with `paths`, one line each; the commands concerned check every file. */
	problems: string[];
}

/** The `paths` map of verify.json for `commands` (configured ones only). */
export function resolveVerifyPaths(cwd: string, commands: string[]): VerifyPaths {
	const scopes = new Map<string, string[]>();
	if (resolveVerifyCommands(cwd).source !== VERIFY_FILE) return { scopes, problems: [] };
	const paths = readProjectJson<VerifyConfig>(cwd, "verify").paths;
	if (paths === undefined) return { scopes, problems: [] };
	if (typeof paths !== "object" || paths === null || Array.isArray(paths)) return { scopes, problems: ["paths must be an object"] };
	const problems: string[] = [];
	for (const [command, globs] of Object.entries(paths)) {
		if (!commands.includes(command)) problems.push(`paths: ${JSON.stringify(command)} is not one of the commands`);
		else if (!Array.isArray(globs) || globs.length === 0 || !globs.every((g) => typeof g === "string" && g !== "")) {
			problems.push(`paths: ${JSON.stringify(command)} needs a non-empty list of globs`);
		} else {
			const problem = globs.map((g) => globProblem(cwd, g)).find((m) => m !== undefined);
			if (problem !== undefined) problems.push(`paths: ${JSON.stringify(command)} ${problem}`);
			else scopes.set(command, globs);
		}
	}
	return { scopes, problems };
}

/**
 * Why a `paths` glob can never match a changed file, or undefined. Globs are `isIgnored` globs (`*`, `**`, `?`) matched
 * against project-relative paths: other tools' syntax, a path outside the project or a bare folder name never match.
 */
function globProblem(cwd: string, glob: string): string | undefined {
	const p = glob.replaceAll("\\", "/");
	if (glob.includes("\\") || glob.startsWith("./") || /^[~/]/.test(p) || /^[A-Za-z]:/.test(p) || p.endsWith("/") || p.split("/").includes("..")) {
		return `has a glob that can never match a project path: ${JSON.stringify(glob)} (write it relative to the project, like "src/**")`;
	}
	if (/[{}[\]()]/.test(glob) || glob.startsWith("!")) return `has a glob with syntax paths doesn't support: ${JSON.stringify(glob)} (only *, ** and ? work)`;
	if (!/[*?]/.test(glob) && isFolder(join(cwd, glob))) return `has a glob that names a folder, not its files: ${JSON.stringify(glob)} (write "${glob}/**")`;
	// `apps/*`, copied from a workspaces list, names the packages, not their files.
	const parent = glob.endsWith("/*") ? glob.slice(0, -2) : undefined;
	if (parent !== undefined && !/[*?]/.test(parent) && onlyFolders(join(cwd, parent))) {
		return `has a glob whose * matches only folders here: ${JSON.stringify(glob)} (* stays within one folder; write "${parent}/**")`;
	}
	return undefined;
}

/** A folder that holds at least one folder and no files. */
function onlyFolders(path: string): boolean {
	try {
		const entries = readdirSync(path, { withFileTypes: true });
		return entries.some((e) => e.isDirectory()) && entries.every((e) => e.isDirectory());
	} catch {
		return false;
	}
}

function isFolder(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The commands, in config order, whose files include one of `changed` (project-relative files a fingerprint or an edit
 * confirmed; callers owe every command for paths they only guessed).
 */
export function owedCommands(changed: string[], commands: string[], scopes: Map<string, string[]>): string[] {
	// Letter case is folded everywhere: a Linux process can work on a case-insensitive mount (a devcontainer, WSL), and
	// folding only owes more.
	const norm = (s: string) => s.toLowerCase();
	// An edit of the config may change any command or its paths; an unknown file or a whole folder may be any file.
	if (changed.some((p) => p === UNKNOWN_FILE || p.endsWith("/") || norm(p.replaceAll("\\", "/")) === norm(VERIFY_FILE))) return [...commands];
	return commands.filter((c) => {
		const globs = scopes.get(c);
		return !globs || changed.some((p) => isIgnored(norm(p), globs.map(norm)));
	});
}

/**
 * The commands with a glob inside `folder` (letter case folded): what a folder that is gone (a deleted submodule, which git
 * lists by its bare path) may have held.
 */
export function commandsUnder(folder: string, commands: string[], scopes: Map<string, string[]>): string[] {
	const prefix = `${folder.replaceAll("\\", "/").toLowerCase()}/`;
	return commands.filter((c) => scopes.get(c)?.some((g) => g.toLowerCase().startsWith(prefix)));
}

export const UNKNOWN_FILE = "(unknown file)";

/** Docs don't change what the checks verify. A project that lints them sets `"ignore": []`. */
export const DEFAULT_IGNORE = ["**/*.md", "**/*.mdx", "**/*.txt", "docs/**"];

/** The ignore globs from verify.json, or the defaults. */
export function resolveIgnore(cwd: string): string[] {
	const config = readProjectJson<VerifyConfig>(cwd, "verify");
	if (Array.isArray(config.ignore)) return config.ignore.filter((g): g is string => typeof g === "string");
	return DEFAULT_IGNORE;
}

/** Minimal glob: `**` spans directories, `*` and `?` stay within one path segment. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i]!;
		if (ch === "*" && glob[i + 1] === "*") {
			i++;
			if (glob[i + 1] === "/") {
				i++;
				re += "(?:.*/)?";
			} else re += ".*";
		} else if (ch === "*") re += "[^/]*";
		else if (ch === "?") re += "[^/]";
		else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

export function isIgnored(relPath: string, globs: string[]): boolean {
	const p = relPath.replaceAll("\\", "/");
	return globs.some((g) => globToRegExp(g).test(p));
}

export interface ResolvedCommands {
	commands: string[];
	source: ".pi/verify.json" | "AGENTS.md" | "detected" | "none";
	error?: string;
}

const SECTION = /command|команд|verif|провер|check|scripts/i;
const VERIFYING =
	/\b(test|tests|typecheck|type-check|tsc|lint|build|check|vet|clippy|assemble\w*|analyze|verify|vitest|jest|pytest|mocha|rspec|phpunit|ctest)\b/i;
const LONG_RUNNING = /\b(dev|start|serve|watch|preview)\b/i;

/**
 * Verification commands: `.pi/verify.json` first, then the Commands section of AGENTS.md, then the ones the manifests
 * imply (`detect: false` leaves those out: the review gate trusts configured commands only).
 */
export function resolveVerifyCommands(cwd: string, options: { detect?: boolean } = {}): ResolvedCommands {
	const config = readProjectJson<VerifyConfig>(cwd, "verify");
	if (config.error) return { commands: [], source: "none", error: config.error };
	if (Array.isArray(config.commands)) {
		const commands = config.commands.filter((c): c is string => typeof c === "string" && c.trim() !== "");
		return { commands, source: ".pi/verify.json" };
	}
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		try {
			const commands = parseAgentsCommands(readFileSync(join(cwd, name), "utf8"));
			if (commands.length > 0) return { commands, source: "AGENTS.md" };
		} catch {
			// file absent: try the next one
		}
	}
	if (options.detect === false) return { commands: [], source: "none" };
	const detected = manifestCommands(cwd);
	return detected.length > 0 ? { commands: detected, source: "detected" } : { commands: [], source: "none" };
}

/** Pull verifying commands (test/typecheck/lint/build) out of a "## Commands"-style section. */
export function parseAgentsCommands(markdown: string): string[] {
	const commands: string[] = [];
	let inSection = false;
	for (const line of markdown.split(/\r?\n/)) {
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		if (heading) {
			inSection = SECTION.test(heading[1]!);
			continue;
		}
		if (!inSection) continue;
		const item = /^\s*[-*]\s+(.*)$/.exec(line);
		if (!item) continue;
		const text = item[1]!;
		const ticked = /`([^`]+)`/.exec(text);
		const command = (ticked ? ticked[1]! : text.split(/\s[—–-]\s|:\s/)[0]!).trim();
		// For `Label: `cmd`` items the label counts too ("Test: `pnpm vitest run`").
		if (command && VERIFYING.test(ticked ? text : command) && !LONG_RUNNING.test(command)) commands.push(command);
	}
	return commands;
}

/**
 * True when a shell command is proof that `verifyCommand` ran: it runs it exactly (redirections allowed,
 * extra arguments not), no pipe masks its exit code, and no `cd` moves it to another directory.
 */
export function commandMatches(shellCommand: string, verifyCommand: string): boolean {
	const strip = (s: string) => s.replace(/\s*\d*>>?\s*(&\d+|\S+)/g, "").replace(/\s*<\s*\S+/g, "");
	const wanted = tokenize(strip(verifyCommand));
	const tokens = tokenize(strip(shellCommand));
	if (tokens.includes("|")) return false;
	const segments = splitSegments(tokens);
	if (segments.some((seg) => seg[0] === "cd" || seg[0] === "pushd")) return false;
	return segments.some((seg) => seg.length === wanted.length && seg.every((t, i) => t === wanted[i]));
}

/** The verification commands the project's manifests imply, fastest first (package.json scripts, turbo, gradle, cargo, go, dotnet, pytest, make). */
export function manifestCommands(cwd: string): string[] {
	const has = (rel: string) => existsSync(join(cwd, rel));
	const pm = has("pnpm-lock.yaml") || has("pnpm-workspace.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
	// Never download a tool to verify a project: these run only a locally installed turbo
	// (`npx --no` refuses to install; `bunx --no-install` skips installation; pnpm and yarn run local bins only).
	const exec = { pnpm: "pnpm", yarn: "yarn", bun: "bunx --no-install", npm: "npx --no" }[pm];
	const turboFile = ["turbo.json", "turbo.jsonc"].find(has);
	if (turboFile) {
		try {
			// turbo.json allows comments; strip them outside strings before parsing.
			const text = readFileSync(join(cwd, turboFile), "utf8").replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "$1");
			const turbo = JSON.parse(text);
			const keys = Object.keys(turbo.tasks ?? turbo.pipeline ?? {});
			// A task counts when declared, also per package (`web#test`, `//#lint`).
			// `build` is left out on purpose: CI builds; verify stays fast.
			const tasks = ["typecheck", "type-check", "lint", "test"].filter((t) => keys.some((k) => k === t || k.endsWith(`#${t}`)));
			if (tasks.length > 0) return [`${exec} turbo run ${tasks.join(" ")}`];
		} catch {
			// unreadable turbo.json: fall through to the package.json scripts
		}
	}
	if (has("package.json")) {
		let scripts: Record<string, string> = {};
		try {
			scripts = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {};
		} catch {
			// unreadable package.json: fall through to other tools
		}
		const commands: string[] = [];
		for (const name of ["typecheck", "type-check", "lint", "test", "build"]) {
			const body = scripts[name];
			if (!body || /no test specified/.test(body)) continue;
			commands.push(name === "test" && pm !== "bun" ? `${pm} test` : `${pm} run ${name}`);
		}
		if (commands.length > 0) return commands;
	}
	if (has("gradlew")) return ["./gradlew check"];
	if (has("Cargo.toml")) return ["cargo test"];
	if (has("go.mod")) return ["go vet ./...", "go test ./..."];
	if (safeList(cwd).some((f) => f.endsWith(".sln") || f.endsWith(".csproj"))) return ["dotnet test"];
	if (has("pyproject.toml") || has("pytest.ini")) return ["pytest"];
	try {
		if (has("Makefile") && /^test:/m.test(readFileSync(join(cwd, "Makefile"), "utf8"))) return ["make test"];
	} catch {
		// an unreadable Makefile (a folder, no permission): no command from it
	}
	return [];
}

function safeList(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
