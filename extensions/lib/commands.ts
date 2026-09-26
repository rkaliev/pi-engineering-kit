import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readProjectJson } from "./config.ts";
import { splitSegments, tokenize } from "./patterns.ts";

export interface VerifyConfig {
	commands: string[];
	timeoutSec?: number;
	/** Globs (relative to the project) whose edits don't make the workspace unverified. */
	ignore?: string[];
}

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
	source: ".pi/verify.json" | "AGENTS.md" | "none";
	error?: string;
}

const SECTION = /command|команд|verif|провер|check|scripts/i;
const VERIFYING =
	/\b(test|tests|typecheck|type-check|tsc|lint|build|check|vet|clippy|assemble\w*|analyze|verify|vitest|jest|pytest|mocha|rspec|phpunit|ctest)\b/i;
const LONG_RUNNING = /\b(dev|start|serve|watch|preview)\b/i;

/** Verification commands: `.pi/verify.json` first, then the Commands section of AGENTS.md. */
export function resolveVerifyCommands(cwd: string): ResolvedCommands {
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
	return { commands: [], source: "none" };
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
