import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { baseBranch, currentBranch } from "./workdocs.ts";

export type GuardAction = "allow" | "confirm" | "block";

export interface GuardDecision {
	action: GuardAction;
	reason?: string;
}

/** Project overrides, read from `.pi/guard.json`. Regexes are JavaScript source strings. */
export interface GuardConfig {
	/** Extra commands to block outright. */
	block?: string[];
	/** Extra commands that need human confirmation. */
	confirm?: string[];
	/** Commands exempt from confirmation. Never overrides a block. */
	allow?: string[];
	/** Path prefixes (relative to the project) that must not be written or edited. */
	protectedPaths?: string[];
	/** Folders holding task files that must never reach the base branch. `[]` turns the check off. */
	workDocs?: string[];
	/** Code reaches the base branch only with a passing reviewer verdict for it. `false` turns the check off. */
	reviewGate?: boolean;
}

const ALLOW: GuardDecision = { action: "allow" };

const CONFIRM_RULES: Array<[RegExp, string]> = [
	[/\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+release\s+create\b|\bfastlane\b/, "publishes a release"],
	[/\b(npm|pnpm|yarn|bun)\s+(run\s+)?deploy\b|\b(vercel|netlify|fly|flyctl|firebase|wrangler)\b.*\b(deploy|--prod)\b/, "deploys"],
	[/\bterraform\s+(apply|destroy)\b|\bpulumi\s+(up|destroy)\b/, "changes infrastructure"],
	[/\bkubectl\s+(apply|delete|replace|rollout|scale|patch|edit)\b|\bhelm\s+(install|upgrade|uninstall|rollback)\b/, "changes a cluster"],
	[
		/\bprisma\s+(migrate\s+(deploy|reset)|db\s+push)\b|\brails\s+db:(migrate|drop|reset|rollback)\b|\balembic\s+(upgrade|downgrade)\b|\bflyway\s+(migrate|clean)\b|\bknex\s+migrate\b|\bdb:migrate\b|\bmanage\.py\s+migrate\b|\bmigrate\s+(up|deploy|reset)\b/,
		"runs a database migration",
	],
	[/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE)\b/i, "destroys database data"],
	[/\bgit\b.*\breset\s+--hard\b|\bgit\b.*\bclean\b.*\s-[a-zA-Z]*f|\bgit\b.*\bbranch\b.*\s-D\b|\bgit\b.*\bstash\s+(drop|clear)\b|\bgit\b.*\b(checkout|restore)\s+(--\s+)?\.(\s|$)|\bgit\b.*\bfilter-(branch|repo)\b/, "discards local git work"],
	[/\bsudo\b/, "runs as root"],
	[/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, "pipes a remote script into a shell"],
	[/\bchmod\s+-R\s+777\b|\bdocker\s+(system|volume)\s+prune\b|\bdd\s+if=|\bmkfs\b/, "is destructive"],
];

const SECRET_EXAMPLE = /\.env\.(example|sample|template|dist)$/;
const SECRET_PATTERNS = [
	/(^|\/)\.env(\.[\w.-]+)?$/,
	/(^|\/)\.envrc$/,
	/\.(pem|key|p12|pfx|jks|keystore)$/,
	/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
	/(^|\/)\.aws\/credentials$/,
	/(^|\/)(credentials|secrets?)\.(json|ya?ml)$/,
	/(^|\/)service-account[\w.-]*\.json$/,
];

export function isSecretPath(path: string): boolean {
	const p = path.replaceAll("\\", "/");
	if (SECRET_EXAMPLE.test(p)) return false;
	return SECRET_PATTERNS.some((re) => re.test(p));
}

/** Decide what to do with a shell command. `cwd` is the project root; `dir` is where the command runs. */
export function checkCommand(command: string, cwd: string, config: GuardConfig, dir: string = cwd, env: NodeJS.ProcessEnv = process.env): GuardDecision {
	const segments = splitSegments(tokenize(command));

	for (const segment of segments) {
		const hard = checkSegment(segment, cwd);
		if (hard) return hard;
	}
	for (const source of config.block ?? []) {
		if (new RegExp(source).test(command)) {
			return { action: "block", reason: `Blocked by project guard rule /${source}/ in .pi/guard.json.` };
		}
	}
	if ((config.allow ?? []).some((source) => new RegExp(source).test(command))) return ALLOW;

	const push = checkPushSetup(segments) ?? checkPushes(command, dir, env);
	if (push) return push;
	for (const [re, what] of CONFIRM_RULES) {
		if (re.test(command)) return { action: "confirm", reason: `This command ${what}.` };
	}
	for (const source of config.confirm ?? []) {
		if (new RegExp(source).test(command)) return { action: "confirm", reason: `Matches project confirm rule /${source}/.` };
	}
	if (segments.some((segment) => segment.some(isSecretPath))) {
		return { action: "confirm", reason: "This command touches a secret file; its contents would be sent to the model provider." };
	}
	return ALLOW;
}

/** CI and release pipelines run with repository credentials, so edits to them need a human look. */
const CI_PIPELINE = /^(\.github\/(workflows|actions)\/|\.gitlab\/ci\/|\.circleci\/|\.buildkite\/|(\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|Jenkinsfile)$)/;

/** Decide what to do with a read/write/edit of a file path. */
export function checkPath(tool: "read" | "write" | "edit", path: string, cwd: string, config: GuardConfig): GuardDecision {
	const absolute = resolve(cwd, path);
	const rel = relative(cwd, absolute).replaceAll("\\", "/");
	const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);

	if (isSecretPath(absolute)) {
		if (tool === "read") {
			return {
				action: "block",
				reason: `Reading ${path} would send secrets to the model provider. Ask the user for the specific non-secret value you need, or read the .env.example file.`,
			};
		}
		return { action: "confirm", reason: `Writing secret file ${path}.` };
	}
	if (tool === "read") return ALLOW;

	if (/(^|\/)\.git(\/|$)/.test(inside ? rel : absolute.replaceAll("\\", "/"))) {
		return { action: "block", reason: "Never edit .git internals directly; use git commands." };
	}
	if (/(^|\/)eng-kit\/reviews\//.test(absolute.replaceAll("\\", "/"))) {
		return { action: "block", reason: "Review stamps are written only by the guard, from the reviewer's own report. Dispatch the reviewer instead." };
	}
	if (inside && rel === ".pi/guard.json") {
		return { action: "confirm", reason: "The guard config decides what the guard blocks. Loosening it is the user's call; show them the change first." };
	}
	const hit = (config.protectedPaths ?? []).find((prefix) => inside && rel.startsWith(prefix.replace(/^\.\//, "")));
	if (hit) return { action: "block", reason: `${path} is protected by .pi/guard.json (${hit}). Ask the user before changing it.` };
	if (inside && CI_PIPELINE.test(rel)) {
		return { action: "confirm", reason: `${path} is a CI/release pipeline; it runs with repository credentials. Show the user the design before editing it.` };
	}
	if (!inside) return { action: "confirm", reason: `${path} is outside the project directory.` };
	return ALLOW;
}

function checkSegment(tokens: string[], cwd: string): GuardDecision | undefined {
	if (tokens.includes("--no-verify")) {
		return { action: "block", reason: "Bypassing git hooks (--no-verify) is not allowed. Fix what the hook reports instead." };
	}
	const words = tokens.filter((t) => !t.includes("=") || t.startsWith("-"));
	const gitAt = words.indexOf("git");
	if (gitAt !== -1) {
		const rest = words.slice(gitAt + 1);
		if (rest.includes("commit") && rest.some((t) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t))) {
			return { action: "block", reason: "git commit -n bypasses hooks. Fix what the hook reports instead." };
		}
		if (rest.includes("push")) {
			const forced = rest.some((t) => t === "--force" || t === "--mirror" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t) || /^\+\S/.test(t));
			if (forced) {
				return {
					action: "block",
					reason: "Force-pushing rewrites shared history. Use --force-with-lease on your own branch, after the user agrees.",
				};
			}
		}
	}

	const rmAt = words.indexOf("rm");
	if (rmAt !== -1) {
		const args = words.slice(rmAt + 1);
		const recursive = args.some((t) => t === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(t));
		if (recursive) {
			const outside = args.filter((t) => !t.startsWith("-")).find((t) => isOutside(t, cwd));
			if (outside) {
				return { action: "block", reason: `Recursive delete of ${outside} reaches outside the project. Delete only paths inside it.` };
			}
		}
	}
	return undefined;
}

function isOutside(target: string, cwd: string): boolean {
	if (target === "/" || target.startsWith("~") || /\$\{?HOME\b/.test(target)) return true;
	if (target === ".." || target.startsWith("../") || target.startsWith("..\\")) return true;
	if (isAbsolute(target)) {
		const root = resolve(cwd);
		const abs = resolve(target);
		return abs !== root && !abs.startsWith(root + sep);
	}
	return false;
}

const OPERATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);

/**
 * Minimal shell tokenizer: honours quotes (`'…'`, `"…"`, `$'…'`) and backslash escapes, and splits out
 * control operators. An escaped quote opens nothing, so `echo \' ; cmd` still shows `cmd`.
 */
export function tokenize(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | "$'" | null = null;
	let has = false;
	const push = () => {
		if (has) tokens.push(current);
		current = "";
		has = false;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
			else current += ch;
			continue;
		}
		if (quote) {
			// In "…" a backslash escapes only " \ $ ` and a newline; in $'…' it escapes anything.
			const next = command[i + 1];
			// A backslash-newline inside "…" is a line continuation: both characters vanish.
			if (ch === "\\" && next === "\n" && quote === '"') {
				i++;
				continue;
			}
			if (ch === "\\" && next !== undefined && (quote === "$'" || /["\\$`\n]/.test(next))) {
				current += next;
				i++;
			} else if (ch === (quote === "$'" ? "'" : '"')) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "\\") {
			// A backslash-newline is a line continuation: the shell joins the lines.
			if (command[i + 1] === "\n") {
				i++;
				continue;
			}
			if (i + 1 < command.length) current += command[++i];
			has = true;
			continue;
		}
		if (ch === "$" && command[i + 1] === "'") {
			quote = "$'";
			has = true;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			has = true;
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			push();
			tokens.push(two);
			i++;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			push();
			tokens.push(ch);
			continue;
		}
		if (/\s/.test(ch) || ch === "<" || ch === ">") {
			push();
			continue;
		}
		current += ch;
		has = true;
	}
	push();
	return tokens;
}

/** Group tokens into simple commands separated by control operators. */
export function splitSegments(tokens: string[]): string[][] {
	const segments: string[][] = [[]];
	for (const token of tokens) {
		if (OPERATORS.has(token)) segments.push([]);
		else segments[segments.length - 1]!.push(token);
	}
	return segments.filter((s) => s.length > 0);
}

const PUSH_WORDS = /\bgit\b.*\bpush\b/;
const PUSH_CONFIRM: GuardDecision = { action: "confirm", reason: "This command pushes to a remote." };
const PUSH_SAFE_OPTIONS = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--progress", "--no-progress", "-n", "--dry-run", "--porcelain"]);
/** Any of these in a command means the shell is not plain: a refused character ends the allowlist. */
const PUSH_REFUSED_CHARS = /[;&|\n\r\0(){}<>`$\\'"*?[\]~#=]/;
/** Environment that can redirect git's repository, config or transport. */
const GIT_ENV_REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND", "GIT_COMMON_DIR", "GIT_EXEC_PATH", "GIT_SSH", "GIT_PROXY_COMMAND", "GIT_NAMESPACE"];

/** The kit's branch naming (git-workflow): only such a branch is pushed without a question. */
const WORK_BRANCH = /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)\/[a-z0-9][a-z0-9._-]*$/;

/** Anything that mentions `git … push` asks, unless the command is the plain own-branch push (see ownBranchPush). */
function checkPushes(command: string, dir: string, env: NodeJS.ProcessEnv): GuardDecision | undefined {
	if (!PUSH_WORDS.test(command)) return undefined;
	return ownBranchPush(command, dir, env) ? undefined : PUSH_CONFIRM;
}

/**
 * A strict allowlist: true only for exactly `git [-C <path>] push [safe options] [<remote> [<refspec>]]` as the
 * whole command, from a clean environment, naming the current convention-named work branch (or nothing) on a configured
 * remote whose config cannot redirect or enlarge the push. Everything else is false, so it asks.
 */
export function ownBranchPush(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (PUSH_REFUSED_CHARS.test(command)) return false;
	if (GIT_ENV_REDIRECTS.some((name) => env[name] !== undefined)) return false;
	const tokens = command.trim().split(/\s+/);
	if (tokens[0] !== "git") return false;
	let dir = cwd;
	let i = 1;
	if (tokens[i] === "-C") {
		if (tokens[i + 1] === undefined) return false;
		dir = resolve(cwd, tokens[i + 1]!);
		i += 2;
	}
	if (tokens[i] !== "push") return false;
	const positional: string[] = [];
	for (const t of tokens.slice(i + 1)) {
		if (t.startsWith("-")) {
			if (!PUSH_SAFE_OPTIONS.has(t)) return false;
		} else positional.push(t);
	}
	if (positional.length > 2) return false;

	if (git(dir, ["rev-parse", "--git-dir"]) === undefined) return false;
	const branch = currentBranch(dir);
	const base = baseBranch(dir);
	if (!branch || !base || branch === base || !WORK_BRANCH.test(branch)) return false;
	const config = gitConfig(dir);
	if (!config) return false;

	const remotes = new Set<string>();
	for (const key of config.keys()) {
		const m = /^remote\.(.+)\.url$/.exec(key);
		if (m) remotes.add(m[1]!);
	}
	const [given, spec] = positional;
	const remote = given ?? config.get(`branch.${branch}.pushremote`) ?? config.get("remote.pushdefault") ?? config.get(`branch.${branch}.remote`) ?? "origin";
	if (!remotes.has(remote)) return false;

	// insteadOf rules may rewrite the URL: the one git would push to must be the one written in the config.
	const written = config.get(`remote.${remote}.pushurl`) ?? config.get(`remote.${remote}.url`);
	if (written === undefined || git(dir, ["remote", "get-url", "--push", remote]) !== written) return false;
	for (const name of ["mirror", "push", "receivepack"]) if (config.has(`remote.${remote}.${name}`)) return false;
	const follow = config.get("push.followtags");
	if (follow !== undefined && !/^(false|no|off|0)$/i.test(follow)) return false;
	if (config.has("push.pushoption")) return false;
	const submodules = config.get("push.recursesubmodules");
	if (submodules !== undefined && submodules !== "no" && submodules !== "false") return false;
	const pd = config.get("push.default");
	if (pd !== undefined && pd !== "simple" && pd !== "current") return false;

	if (spec === undefined) return true;
	const here = new Set([branch, "HEAD", "@", `refs/heads/${branch}`]);
	const [src, dst, extra] = spec.split(":");
	if (extra !== undefined) return false;
	if (dst === undefined) return here.has(src!);
	const srcOk = src === branch || src === "HEAD" || src === "@";
	return srcOk && (dst === branch || dst === `refs/heads/${branch}`);
}

/** Git's own options that take a separate value, so the value is not the subcommand. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const BASE_NAME = (token: string) => token.slice(token.lastIndexOf("/") + 1);
const WATCHED_CONFIG = /^(remote|url|push|branch|alias|include|includeif)\./;

/** Git commands that change where or what a later push sends, and merging a PR/MR: asked about whatever the position. */
function checkPushSetup(segments: string[][]): GuardDecision | undefined {
	const setup: GuardDecision = { action: "confirm", reason: "This command changes where or what git pushes." };
	const base: GuardDecision = { action: "confirm", reason: "This command changes which branch is the base." };
	for (const tokens of segments) {
		const lower = tokens.map((t) => t.toLowerCase());
		for (const [tool, noun] of [["gh", "pr"], ["glab", "mr"]] as const) {
			const at = tokens.findIndex((t) => BASE_NAME(t) === tool);
			const n = at === -1 ? -1 : tokens.indexOf(noun, at + 1);
			if (n !== -1 && tokens.indexOf("merge", n + 1) !== -1) return { action: "confirm", reason: "This command merges a PR/MR." };
		}
		const at = tokens.findIndex((t) => BASE_NAME(t) === "git");
		if (at === -1) continue;
		let v = at + 1;
		while (v < tokens.length && tokens[v]!.startsWith("-")) {
			const t = tokens[v]!;
			if (t === "-c" || t === "--config-env" || t.startsWith("--config-env=") || /^-c./.test(t)) return { action: "confirm", reason: "This git call overrides git config on the command line." };
			v += GIT_VALUE_OPTIONS.has(t) ? 2 : 1;
		}
		const sub = tokens[v];
		const rest = tokens.slice(v + 1);
		if (sub === "remote") {
			const verb = rest.find((t) => !t.startsWith("-"));
			if (verb !== undefined && ["add", "set-url", "rename"].includes(verb)) return setup;
			if (verb === "set-head") return base;
		}
		if ((sub === "symbolic-ref" || sub === "update-ref") && rest.some((t) => t.includes("refs/remotes/"))) return base;
		if (sub === "config") {
			const args = lower.slice(v + 1);
			if (args.some((t) => ["--get", "--list", "-l", "--get-all", "--get-regexp"].includes(t))) continue;
			if (args.some((t) => WATCHED_CONFIG.test(t))) return setup;
		}
	}
	return undefined;
}

/** Effective git config as lowercase-section keys, last value winning; undefined when unreadable. */
function gitConfig(dir: string): Map<string, string> | undefined {
	const out = git(dir, ["config", "--list"]);
	if (out === undefined) return undefined;
	const map = new Map<string, string>();
	for (const line of out.split("\n")) {
		const eq = line.indexOf("=");
		if (eq === -1) map.set(line, "");
		else map.set(line.slice(0, eq), line.slice(eq + 1));
	}
	return map;
}

function git(cwd: string, args: string[]): string | undefined {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
	return r.status === 0 ? r.stdout.trim() : undefined;
}
