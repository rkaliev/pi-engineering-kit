import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
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
	[/\bprisma\s+(db\s+execute|migrate\s+resolve)\b/, "changes the database outside migrations"],
	[
		/\bprisma\s+(migrate\s+(deploy|reset)|db\s+push)\b|\brails\s+db:(migrate|drop|reset|rollback)\b|\balembic\s+(upgrade|downgrade)\b|\bflyway\s+(migrate|clean)\b|\bknex\s+migrate\b|\bdb:migrate\b|\bmanage\.py\s+migrate\b|\bmigrate\s+(up|deploy|reset)\b|\bmigrate[:\s](down|rollback)\b|\b(node|tsx|ts-node|bun|deno)\b[^;&|\n]*\bmigrate-down\.ts\b/,
		"runs a database migration",
	],
	[/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE)\b/i, "destroys database data"],
	[/\bgit\b.*\breset\s+--hard\b|\bgit\b.*\bclean\b.*\s-[a-zA-Z]*f|\bgit\b.*\bbranch\b.*\s-D\b|\bgit\b.*\bstash\s+(drop|clear)\b|\bgit\b.*\b(checkout|restore)\s+(--\s+)?\.(\s|$)|\bgit\b.*\bfilter-(branch|repo)\b/, "discards local git work"],
	[/\b(sudo|doas|run0|pkexec)\b/, "runs as root"],
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

	const push = checkPushSetup(segments, command) ?? checkPushes(command, segments, cwd, dir, env);
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
	const words = tokens.map(unwrapToken).filter((t) => t !== "" && (!t.includes("=") || t.startsWith("-")));
	if (tokens.includes("--no-verify") || words.includes("--no-verify")) {
		return { action: "block", reason: "Bypassing git hooks (--no-verify) is not allowed. Fix what the hook reports instead." };
	}
	const gitAt = words.indexOf("git");
	if (gitAt !== -1) {
		const rest = words.slice(gitAt + 1);
		if (rest.includes("commit") && rest.some((t) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t))) {
			return { action: "block", reason: "git commit -n bypasses hooks. Fix what the hook reports instead." };
		}
		if (rest.some((t) => PUSH_VERBS.has(t))) {
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

/** A token without a `NAME=` before a substitution, the `(`, `$(`, backtick or `{` that opens a group before it and the `)`, backtick, `}` or `;` after it. */
export function unwrapToken(token: string): string {
	// `NAME=` in front of a substitution (`x=$(git …)`) is an assignment, not part of the command.
	return token.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?=\$\(|`)/, "").replace(/^(\$\(|[(`{])+/, "").replace(/[)`};]+$/, "");
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

/** Git's ways to send commits to a remote. */
const PUSH_VERBS = new Set(["push", "send-pack", "http-push"]);
const PUSH_WORDS = /\bgit\b.*\b(push|send-pack|http-push|svn\s+dcommit|p4\s+(submit|commit))\b/;
const PUSH_CONFIRM: GuardDecision = { action: "confirm", reason: "This command pushes to a remote." };
const PUSH_SAFE_OPTIONS = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--progress", "--no-progress", "-n", "--dry-run", "--porcelain"]);
/** Any of these in a command means the shell is not plain: a refused character ends the allowlist. */
const PUSH_REFUSED_CHARS = /[;&|\n\r\0(){}<>`$\\'"*?[\]~#=]/;
/** Environment that can redirect git's repository, config or transport. */
const GIT_ENV_REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND", "GIT_COMMON_DIR", "GIT_EXEC_PATH", "GIT_SSH", "GIT_PROXY_COMMAND", "GIT_NAMESPACE"];

/** The kit's branch naming (git-workflow): only such a branch is pushed without a question. */
const WORK_BRANCH = /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)\/[a-z0-9][a-z0-9._-]*$/;

/** Anything that mentions `git … push` asks, unless the command is the plain own-branch push (see ownBranchPush). */
function checkPushes(command: string, segments: string[][], project: string, dir: string, env: NodeJS.ProcessEnv): GuardDecision | undefined {
	// A verb split by quotes or escapes (`pu''sh`) no longer matches the text, but its token is `push`.
	const pushToken = segments.some((tokens) =>
		// A subcommand that is not a literal word (`$X`, a substitution) could be push.
		parseGitCalls(tokens).some((call) => call.sub !== undefined && (PUSH_VERBS.has(call.sub) || !/^[a-z][a-z0-9-]*$/.test(call.sub))),
	);
	// A git-like token with a push verb after it, whatever wrapper or option sits between.
	const pushAfterGit = segments.some((tokens) => {
		const words = tokens.map(unwrapToken);
		const at = words.findIndex(gitLike);
		return at !== -1 && words.slice(at + 1).some((t) => PUSH_VERBS.has(t));
	});
	if (!pushToken && !pushAfterGit && !PUSH_WORDS.test(command)) return undefined;
	return ownBranchPush(command, dir, env, project) ? undefined : PUSH_CONFIRM;
}

/**
 * A strict allowlist: true only for exactly `git [-C <path>] push [safe options] [<remote> [<refspec>]]` as the
 * whole command, from a clean environment, naming the current convention-named work branch (or nothing) on a configured
 * remote whose config cannot redirect or enlarge the push. Everything else is false, so it asks.
 */
export function ownBranchPush(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env, project: string = cwd): boolean {
	// One trailing `2>&1` only merges the output streams.
	const text = command.trim().replace(/ 2>&1$/, "");
	if (PUSH_REFUSED_CHARS.test(text)) return false;
	if (GIT_ENV_REDIRECTS.some((name) => env[name] !== undefined)) return false;
	const tokens = text.split(/\s+/);
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
	// Only the project's own repository (or one of its worktrees) is pushed silently.
	const repoDir = commonDir(dir);
	if (repoDir === undefined || repoDir !== commonDir(project)) return false;
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
/** Git's own options that take no value. Any other option before the subcommand is unknown, so it asks. */
const GIT_FLAG_OPTIONS = new Set(["-p", "--paginate", "-P", "--no-pager", "--no-replace-objects", "--bare", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-advice", "--version", "--help", "-h"]);
const BASE_NAME = (token: string) => token.slice(token.lastIndexOf("/") + 1);
/** Config keys whose value is a command git runs (pager, editor, helpers, drivers, filters). */
const COMMAND_KEYS =
	"core[.](pager|editor|askpass)|sequence[.]editor|diff[.]external|gpg[.]([^.]+[.])?program|filter[.]|pager[.]|diff[.].+[.](command|textconv)|merge[.].+[.]driver|(difftool|mergetool)[.].+[.]cmd|submodule[.].+[.]update|credential[.](.+[.])?helper";
/** Keys that move where git pushes, fetches or what it executes, besides the command-valued ones. */
const EXEC_KEYS = `${COMMAND_KEYS}|core[.](sshcommand|gitproxy|hookspath|fsmonitor)|http[.]proxy`;
const COMMAND_KEY = new RegExp(`^(${COMMAND_KEYS})`);
/** Values of a command key that run nothing of interest. */
const HARMLESS_COMMAND = /^(|cat|true|:)$/;
const WATCHED_CONFIG = new RegExp(`^((remote|url|push|branch|alias|include|includeif)[.]|${EXEC_KEYS})`);

/** Words that run the command after them, so a git token behind one is a git call. */
const WRAPPERS = new Set(["xargs", "parallel", "env", "command", "exec", "nice", "nohup", "time", "timeout", "strace", "script", "sudo", "stdbuf", "flock", "ionice", "taskset", "chrt", "setsid", "unbuffer", "doas"]);
/** Shell keywords that start a command without being one. */
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "(", "((", "&&", "||"]);
/** A token that opens a group, substitution or backticks: the git inside it is a call of its own. */
const OPENS_COMMAND = /^([A-Za-z_][A-Za-z0-9_]*=)?(\$\(|[(`{])/;
/** `git`, `git-<sub>`, or a path to one that is absolute or starts with `./`; `skills/git-workflow` is not git. */
function gitLike(token: string): boolean {
	if (!/^git(-[a-z][a-z-]*)?$/.test(BASE_NAME(token))) return false;
	return !token.includes("/") || /^(\/|\.\/)/.test(token);
}
/** Config keys that move where git pushes, fetches from, or what it executes. */
const RISKY_CONFIG = new RegExp(`^((alias|remote|url|push|branch|include|includeif|protocol|uploadpack|receivepack)[.]|${EXEC_KEYS})`);

interface GitCall {
	at: number;
	v: number;
	sub: string | undefined;
	rest: string[];
	issue?: GuardDecision;
}

/**
 * The git calls in a segment. A git-like token is a call only in command position: at the segment start, after
 * assignments or shell keywords, behind a wrapper such as `sudo`/`xargs`, or opening its own `$(`, backtick or `(`.
 * Each call carries the subcommand after git's global options, its arguments, and `issue` when something before the
 * subcommand overrides config, is unknown, or hides the call.
 */
function parseGitCalls(raw: string[]): GitCall[] {
	const tokens = raw.map(unwrapToken);
	const positions: number[] = [];
	let territory = true; // a command may start here
	let wrapped = false; // behind a wrapper, everything after may be the wrapped command
	tokens.forEach((t, i) => {
		const opens = OPENS_COMMAND.test(raw[i]!);
		if (gitLike(t) && (territory || wrapped || opens)) positions.push(i);
		const word = BASE_NAME(t);
		if ((territory || wrapped) && WRAPPERS.has(word) && !(word === "command" && /^-[vV]$/.test(tokens[i + 1] ?? ""))) wrapped = true;
		else if (!wrapped) territory = t === "" || SHELL_KEYWORDS.has(t) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[i]!) || opens;
	});
	// Calls that open their own group are separate; plain ones in one segment hide each other.
	const plain = positions.filter((i) => !OPENS_COMMAND.test(raw[i]!));
	return positions.map((at) => {
		const call = parseGit(raw, tokens, at);
		if (!OPENS_COMMAND.test(raw[at]!)) {
			if (plain.length > 1) call.issue ??= { action: "confirm", reason: "This runs git indirectly, so the guard can't see the subcommand." };
			else if (tokens.slice(0, at).some((t) => /^(xargs|parallel)$/.test(BASE_NAME(t)))) call.issue ??= { action: "confirm", reason: "Git gets its arguments from input, so the guard can't see them." };
		}
		return call;
	});
}

function parseGit(raw: string[], tokens: string[], at: number): GitCall {
	let issue: GuardDecision | undefined;
	// A `git-<sub>` binary is `git <sub>`: it takes no global options.
	const direct = /^git-([a-z][a-z-]*)$/.exec(BASE_NAME(tokens[at]!));
	if (direct) return { at, v: at, sub: direct[1], rest: tokens.slice(at + 1) };
	let v = at + 1;
	let bare = true; // only --version/--help/-h so far
	while (v < tokens.length && tokens[v]!.startsWith("-")) {
		const t = tokens[v]!;
		if (t === "--config-env" || t.startsWith("--config-env=")) {
			issue ??= { action: "confirm", reason: "This git call overrides git config on the command line." };
		}
		if (t === "-c" || /^-c./.test(t)) {
			const setting = t === "-c" ? (tokens[v + 1] ?? "") : t.slice(2);
			const eq = setting.indexOf("=");
			const key = (eq === -1 ? setting : setting.slice(0, eq)).toLowerCase();
			// A pager or editor set to `cat`, `true`, `:` or nothing runs nothing; credential helpers are always programs.
			const harmless = eq !== -1 && COMMAND_KEY.test(key) && !key.startsWith("credential") && HARMLESS_COMMAND.test(setting.slice(eq + 1));
			if (RISKY_CONFIG.test(key) && !harmless) issue ??= { action: "confirm", reason: "This git call overrides git config on the command line." };
		}
		const named = t.includes("=") ? t.slice(0, t.indexOf("=")) : undefined;
		if (!["--version", "--help", "-h"].includes(t)) bare = false;
		if (GIT_VALUE_OPTIONS.has(t)) v += 2;
		else if (GIT_FLAG_OPTIONS.has(t) || (named !== undefined && GIT_VALUE_OPTIONS.has(named)) || /^-c./.test(t)) v += 1;
		else {
			issue ??= { action: "confirm", reason: "Unknown git option before the subcommand." };
			bare = false;
			v += 1;
		}
	}
	// No subcommand (`xargs git`) or git as the subcommand (`strace -o git git …`): a wrapper hides the real call.
	if ((v >= tokens.length && !(bare && v > at + 1)) || (v < tokens.length && gitLike(tokens[v]!))) {
		issue ??= { action: "confirm", reason: "This runs git indirectly, so the guard can't see the subcommand." };
	}
	// A substitution or variable in the subcommand or before it hides what git runs.
	if (raw.slice(at + 1, v + 1).some((t) => /[$`()]/.test(t.replace(/[)`};]+$/, "")))) {
		issue ??= { action: "confirm", reason: "The git subcommand is not a literal word, so the guard can't see it." };
	}
	return { at, v, sub: tokens[v], rest: tokens.slice(v + 1), issue };
}

/**
 * `gh api` / `glab api` at `at` (the binary): true unless it is a plain GET. The API verb is the first word after
 * the binary that is not an option (or the value of -R/--repo); a method other than GET, or fields or an input
 * body (gh then defaults to POST), write. The graphql endpoint writes unless it carries an inline query without `mutation`.
 */
/** `$` or a backtick in a `query=` value that is unquoted or double-quoted: the shell fills it in. Single quotes keep GraphQL variables literal. */
const SHELL_EXPANDS_QUERY = /query=(?:"[^"]*[$`]|[^'"\s]*[$`])/;

function apiWrite(words: string[], at: number, command: string): boolean {
	let i = at + 1;
	while (i < words.length && words[i]!.startsWith("-")) i += /^(-R|--repo|--hostname)$/.test(words[i]!) ? 2 : 1;
	if (words[i] !== "api") return false;
	const args = words.slice(i + 1);
	const graphql = args.includes("graphql");
	let method: string | undefined;
	let input = false;
	const fields: string[] = [];
	args.forEach((t, k) => {
		if (t === "-X" || t === "--method") method = args[k + 1] ?? "";
		else if (t.startsWith("--method=")) method = t.slice(9);
		else if (t.startsWith("-X")) method = t.slice(2);
		else if (t === "--input" || t.startsWith("--input=")) input = true;
		else if (["-f", "-F", "--field", "--raw-field"].includes(t)) fields.push(args[k + 1] ?? "");
		else if (/^--(raw-)?field=/.test(t)) fields.push(t.slice(t.indexOf("=") + 1));
		else if (/^-[fF]./.test(t)) fields.push(t.slice(2));
	});
	const written = method !== undefined && method.toUpperCase() !== "GET";
	if (graphql) {
		// A query with an inline text and no `mutation` only reads; a file, stdin or a mutation does not.
		const queries = fields.filter((f) => f.startsWith("query="));
		return input || written || queries.length === 0 || queries.some((q) => q.startsWith("query=@") || /mutation/i.test(q)) || SHELL_EXPANDS_QUERY.test(command);
	}
	return method === undefined ? input || fields.length > 0 : written;
}

/** Variables that make git run a program, inject config or move the repository; the editor family only counts in front of a git call. */
const ENV_RUNS = /^(GIT_(SSH_COMMAND|SSH|PROXY_COMMAND|ASKPASS|EXTERNAL_DIFF|PAGER|EDITOR|SEQUENCE_EDITOR)|SSH_ASKPASS)$/;
const ENV_EDITORS = /^(PAGER|EDITOR|VISUAL)$/;
const ENV_CONFIG = /^GIT_(CONFIG(_COUNT|_PARAMETERS|_GLOBAL|_SYSTEM)?|CONFIG_(KEY|VALUE)_[0-9]+)$/;
const ENV_REDIRECTS = /^GIT_(DIR|WORK_TREE|COMMON_DIR|EXEC_PATH|NAMESPACE|TEMPLATE_DIR)$/;
/** Of the program-running variables, the ones whose harmless value (`cat`, `true`, `:`, empty) runs nothing. */
const ENV_HARMLESS_OK = /^(GIT_(PAGER|EDITOR|SEQUENCE_EDITOR|ASKPASS)|SSH_ASKPASS|PAGER|EDITOR|VISUAL)$/;

/** Does `NAME=value` set a git variable that runs a program or redirects git? `beforeGit`: it sits in front of a git call. */
function riskyEnvAssignment(token: string, beforeGit: boolean): boolean {
	const eq = token.indexOf("=");
	if (eq < 1) return false;
	const name = token.slice(0, eq);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
	if (ENV_EDITORS.test(name) ? !beforeGit : !(ENV_RUNS.test(name) || ENV_CONFIG.test(name) || ENV_REDIRECTS.test(name))) return false;
	return !(ENV_HARMLESS_OK.test(name) && HARMLESS_COMMAND.test(token.slice(eq + 1)));
}

/** `export`, `declare -x` or `typeset -x`, after leading keywords and empty words: the names or assignments it exports. */
function exportedWords(words: string[]): string[] {
	let i = 0;
	while (i < words.length && (words[i] === "" || SHELL_KEYWORDS.has(words[i]!))) i++;
	const head = words[i];
	const args = words.slice(i + 1);
	// Options end at the first operand, `--` or a lone `-`: a later `-n` is a name, and bash still exports the rest.
	// `declare` and `typeset` also take `+` options (`+i` turns an attribute off). Their options end only at an
	// assignment, so the words of a dropped redirection (`declare 2>err -x X=…`) don't hide a later `-x`.
	const ends =
		head === "export"
			? (t: string) => t === "--" || !/^-./.test(t)
			: (t: string) => t === "--" || t === "-" || t === "+" || /^[A-Za-z_]\w*=/.test(t);
	const end = args.findIndex(ends);
	const flags = end === -1 ? args : args.slice(0, end);
	// `export -n` un-exports: nothing it names is exported.
	if (head === "export") return flags.some((t) => /^-[a-zA-Z]*n/.test(t)) ? [] : args;
	if ((head === "declare" || head === "typeset") && flags.some((t) => /^-[a-zA-Z]*x/.test(t))) return args;
	return [];
}

/** An assignment in front of a git call in this segment, or an export anywhere, that sets such a variable. */
function gitEnvDecision(tokens: string[], calls: GitCall[]): GuardDecision | undefined {
	const words = tokens.map(unwrapToken);
	const first = calls.length > 0 ? Math.min(...calls.map((c) => c.at)) : -1;
	const before = first === -1 ? [] : words.slice(0, first);
	// `export NAME` by name exports a value set elsewhere, which the guard cannot see.
	const byName = (t: string) => ENV_RUNS.test(t) || ENV_CONFIG.test(t) || ENV_REDIRECTS.test(t);
	const exported = exportedWords(words).filter((t) => !t.startsWith("-"));
	if (before.some((t) => riskyEnvAssignment(t, true)) || exported.some((t) => (t.includes("=") ? riskyEnvAssignment(t, false) : byName(t)))) {
		return { action: "confirm", reason: "This command sets a git variable that runs a program or redirects git." };
	}
	return undefined;
}

/** Git commands that change where or what a later push sends, and merging a PR/MR: asked about whatever the position. */
function checkPushSetup(segments: string[][], command: string): GuardDecision | undefined {
	const setup: GuardDecision = { action: "confirm", reason: "This command changes where or what git pushes." };
	const base: GuardDecision = { action: "confirm", reason: "This command changes which branch is the base." };
	for (const tokens of segments) {
		const lower = tokens.map((t) => unwrapToken(t).toLowerCase());
		for (const [tool, noun] of [["gh", "pr"], ["glab", "mr"]] as const) {
			const at = lower.findIndex((t) => BASE_NAME(t) === tool);
			const n = at === -1 ? -1 : lower.indexOf(noun, at + 1);
			if (n !== -1 && lower.indexOf("merge", n + 1) !== -1) return { action: "confirm", reason: "This command merges a PR/MR." };
			if (at !== -1 && apiWrite(tokens.map(unwrapToken), at, command)) return { action: "confirm", reason: "This command calls the API with a write method." };
		}
		const shell = tokens.findIndex((t, i) => /^(ba|z|da|k)?sh$/.test(BASE_NAME(t)) && tokens.slice(i + 1).some((a) => /^-[a-z]*c[a-z]*$/.test(a)));
		const evalAt = tokens.findIndex((t) => t === "eval");
		const from = shell !== -1 ? shell : evalAt;
		if (from !== -1 && tokens.slice(from + 1).some((t) => /\bgit\b/.test(t))) return { action: "confirm", reason: "This command runs git through a shell string." };
		const calls = parseGitCalls(tokens);
		const envAsk = gitEnvDecision(tokens, calls);
		if (envAsk) return envAsk;
		for (const call of calls) {
			if (call.issue) return call.issue;
			const { sub, rest } = call;
			if (sub === "remote") {
				const verb = rest.find((t) => !t.startsWith("-"));
				if (verb !== undefined && ["add", "set-url", "rename"].includes(verb)) return setup;
				if (verb === "set-head") return base;
			}
			// Remote-writing front ends: `git svn dcommit`, `git p4 submit` send commits like a push.
			if ((sub === "svn" && rest.some((t) => ["dcommit", "branch", "tag", "set-tree"].includes(t))) || (sub === "p4" && rest.some((t) => ["submit", "commit"].includes(t)))) return PUSH_CONFIRM;
			if (sub === "symbolic-ref") {
				// Reading one ref (`git symbolic-ref --short HEAD`) is fine; setting, deleting or anything else is not.
				const operands = rest.filter((t) => !t.startsWith("-"));
				if (operands.length !== 1 || rest.some((t) => t.startsWith("-") && !["--short", "-q", "--quiet"].includes(t))) return base;
			}
			if (sub === "update-ref" && rest.some((t) => t === "--stdin" || t.includes("refs/remotes/"))) return base;
			if (sub === "config") {
				const args = lower.slice(call.v + 1);
				if (args.some((t) => t === "-e" || t === "--edit")) return setup;
				if (args.some((t) => ["--get", "--list", "-l", "--get-all", "--get-regexp"].includes(t))) continue;
				// `git config get|list` (git 2.46+) read like --get/--list.
				const verb = args.find((t) => !t.startsWith("-"));
				if (verb === "get" || verb === "list") continue;
				// One key and no flag but a scope (`git config core.editor`) only reads it.
				const operands = args.filter((t) => !t.startsWith("-"));
				const scope = ["--global", "--local", "--system", "--worktree", "--show-origin", "--show-scope"];
				if (operands.length === 1 && args.every((t) => !t.startsWith("-") || scope.includes(t)) && !["set", "unset", "add"].includes(operands[0]!)) continue;
				if (args.some((t) => WATCHED_CONFIG.test(t))) return setup;
			}
		}
	}
	return undefined;
}

/** The real path of a repository's common git directory (shared by its worktrees), or undefined. */
function commonDir(dir: string): string | undefined {
	const out = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!out) return undefined;
	try {
		return realpathSync(out);
	} catch {
		return undefined;
	}
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
