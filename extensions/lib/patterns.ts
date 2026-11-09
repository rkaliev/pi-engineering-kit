import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { projectRepos, repoOf } from "./repos.ts";
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
	/** The file this config was read from, as the reasons name it (default `.pi/guard.json`). */
	label?: string;
	/** For a combined config (lib/scope.ts): the file each `block`/`confirm` rule came from. */
	sources?: Record<string, string>;
	/** In a workspace: the repositories whose own work branch a plain push sends without a question (lib/scope.ts). */
	pushOwners?: string[];
	/** The folder `core.hooksPath` names, relative to this config's root (`""` for the root), as the session read it at its start. Never read from the file. */
	hooksPath?: string;
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

/**
 * A path as a case-insensitive file system opens it: compatibility forms and case folded, so `.ENV`, `.huſky` (U+017F)
 * and `lefthooK.yml` (U+212A) compare equal to `.env`, `.husky` and `lefthook.yml`, also for a name not created yet.
 */
export function foldPath(path: string): string {
	// Lower first: `ẞ` (U+1E9E) only lowercases to `ß`, which then uppercases to `SS`.
	return path.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase();
}

export function isSecretPath(path: string): boolean {
	const written = path.replaceAll("\\", "/");
	// Only the example names as written are exempt; every secret name counts folded (on macOS and Windows `.ENV` is `.env`).
	if (SECRET_EXAMPLE.test(written)) return false;
	const p = foldPath(written);
	return SECRET_PATTERNS.some((re) => re.test(p));
}

/**
 * Decide what to do with a shell command. `cwd` is the project root; `dir` is where the command runs. `judgeWrite`
 * judges a heredoc's write target (in a workspace, from the repository it lands in).
 */
export function checkCommand(
	command: string,
	cwd: string,
	config: GuardConfig,
	dir: string = cwd,
	env: NodeJS.ProcessEnv = process.env,
	judgeWrite: (target: string) => GuardDecision = (target) => checkPath("write", target, cwd, config),
): GuardDecision {
	// A command that only writes a project file through a quoted heredoc runs nothing from its body: judge its first
	// line, and its target as a Write would be. A target outside the project (a shell rc file) leaves it judged whole.
	const heredoc = quotedHeredoc(command);
	const write = heredoc?.target;
	const target = write !== undefined && !isOutside(write.startsWith("~") ? write : resolve(dir, write), cwd) ? resolve(dir, write) : undefined;
	const text = target ? heredoc!.head : command;
	const segments = splitSegments(tokenize(text));
	// The command as the shell runs it, decoded and folded: every word but an option (`-D` stays `-D`), every word (a
	// command glued to an option, `-c"…('GIT push')"`), and the raw text. Rules that block or ask read the text and the views;
	// `allow` and the own-branch push read only the text, so the views can't loosen anything.
	const viewsOf = (s: string) => {
		const words = tokenize(s);
		// The raw text folded too, quotes kept: `env -S"GIT push"` has its word boundary there.
		return [s, words.map((t) => (t.startsWith("-") ? t : foldPath(t))).join(" "), foldPath(words.join(" ")), foldPath(s)];
	};
	const views = viewsOf(text);
	const commandViews = text === command ? views : viewsOf(command);

	// An interpreter heredoc's body is code, not shell: the block rules, which read shell words, read its first line;
	// every ask below still reads the whole command. A backtick may hold shell (a node template literal run by
	// `execSync`), so a body with one is read whole, as before.
	const code = heredoc !== undefined && write === undefined && !command.includes("`");
	// A marked word (see tokenize) is also read without its mark, the way it most likely runs: a block there wins.
	const blockSegments = code ? splitSegments(tokenize(heredoc.head)) : segments;
	for (const segment of [...blockSegments, ...blockSegments.map((s) => s.map((t) => t.replaceAll("\0", "")))]) {
		const hard = checkSegment(segment, cwd);
		if (hard) return hard;
	}
	for (const source of config.block ?? []) {
		const re = new RegExp(source);
		if (commandViews.some((v) => re.test(v))) {
			return { action: "block", reason: `Blocked by project guard rule /${source}/ in ${sourceOf(config, source)}.` };
		}
	}
	const written = target ? judgeWrite(target) : ALLOW;
	if (written.action !== "allow") return written;
	// A word bash and zsh read differently (a NUL byte, `$$'`) asks, before `allow` so no rule skips it. It reads `text`:
	// a quoted heredoc's body is data. The cost: `read -d $'\0'` asks too.
	if (tokenize(text).some((t) => t.includes("\0"))) {
		return {
			action: "confirm",
			reason: "A word in this command may be read differently by bash and zsh (an escape in $'…' they decode differently, bytes that aren't UTF-8 on their own, a NUL byte or BOM, `$` before a quote, or a line continuation after `$`), so the guard can't tell what runs. Write the word in plain quotes.",
		};
	}
	if ((config.allow ?? []).some((source) => new RegExp(source).test(command))) return ALLOW;

	const push = checkPushSetup(segments, text) ?? checkPushes(text, views, segments, cwd, dir, env, config.pushOwners);
	if (push) return push;
	for (const [re, what] of CONFIRM_RULES) {
		if (views.some((v) => re.test(v))) return { action: "confirm", reason: `This command ${what}.` };
	}
	for (const source of config.confirm ?? []) {
		const re = new RegExp(source);
		if (commandViews.some((v) => re.test(v))) return { action: "confirm", reason: `Matches project confirm rule /${source}/ in ${sourceOf(config, source)}.` };
	}
	if (segments.some((segment) => segment.some(isSecretPath))) {
		return { action: "confirm", reason: "This command touches a secret file; its contents would be sent to the model provider." };
	}
	return ALLOW;
}

/** The file a rule came from, as its reason names it. */
function sourceOf(config: GuardConfig, rule: string): string {
	return (config.sources && Object.hasOwn(config.sources, rule) ? config.sources[rule] : undefined) ?? config.label ?? ".pi/guard.json";
}

/** CI and release pipelines run with repository credentials, so edits to them need a human look. */
const CI_PIPELINE = /^(\.github\/(workflows|actions)\/|\.gitlab\/ci\/|\.circleci\/|\.buildkite\/|(\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|Jenkinsfile)$)/i;

/** Git hook managers' files outside `.git`: husky, plain `.githooks`, lefthook (every config name it reads) and pre-commit. */
const GIT_HOOKS = /^(\.husky\/|\.githooks\/|(\.config\/)?\.?lefthook(-local)?\.(ya?ml|toml|jsonc?)$|\.pre-commit-config\.yaml$)/i;

/** Decide what to do with a read/write/edit of a file path. */
export function checkPath(tool: "read" | "write" | "edit", path: string, cwd: string, config: GuardConfig): GuardDecision {
	const absolute = resolve(cwd, path);
	const rel = relative(cwd, absolute).replaceAll("\\", "/");
	const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	// Every rule reads the path folded: on macOS and Windows `.GIT/config` is `.git/config` (see foldPath).
	const lower = foldPath(rel);
	const folded = foldPath(absolute.replaceAll("\\", "/"));

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

	if (/(^|\/)\.git(\/|$)/.test(inside ? lower : folded)) {
		return { action: "block", reason: "Never edit .git internals directly; use git commands." };
	}
	if (/(^|\/)eng-kit\/reviews\//.test(folded)) {
		return { action: "block", reason: "Review stamps are written only by the guard, from the reviewer's own report. Dispatch the reviewer instead." };
	}
	if (/(^|\/)eng-kit\/runs\//.test(folded)) {
		return { action: "block", reason: "Verify-run records are written only by the verify script. Run it instead." };
	}
	if (inside && lower === ".pi/guard.json") {
		return { action: "confirm", reason: "The guard config decides what the guard blocks. Loosening it is the user's call; show them the change first." };
	}
	const hit = (config.protectedPaths ?? []).find((prefix) => inside && lower.startsWith(foldPath(prefix.replace(/^\.\//, ""))));
	if (hit) return { action: "block", reason: `${path} is protected by ${config.label ?? ".pi/guard.json"} (${hit}). Ask the user before changing it.` };
	const hooks = config.hooksPath === undefined ? undefined : foldPath(config.hooksPath);
	if (inside && (GIT_HOOKS.test(lower) || (hooks !== undefined && (hooks === "" || lower === hooks || lower.startsWith(`${hooks}/`))))) {
		return { action: "confirm", reason: `${path} is a git hook; its code runs on every commit or push. Show the user the change first.` };
	}
	if (inside && CI_PIPELINE.test(lower)) {
		return { action: "confirm", reason: `${path} is a CI/release pipeline; it runs with repository credentials. Show the user the design before editing it.` };
	}
	if (!inside) return { action: "confirm", reason: `${path} is outside the project directory.` };
	return ALLOW;
}

/**
 * `-c core.hooksPath=…` or `--config-env core.hooksPath=…` among git's own options (before the subcommand): it skips or
 * replaces the hooks for that call. Read after git in any position (behind any wrapper, `find -exec`, a group) and after
 * a word that isn't literal (`$G`, `$SUDO`), which may be git; `git grep -c core.hooksPath` passes a subcommand first.
 */
function overridesHooksPath(tokens: string[]): boolean {
	const raw = tokens.map(unwrapToken);
	const sets = (i: number) => {
		const t = raw[i]!;
		const setting = t === "-c" || t === "--config-env" ? raw[i + 1] : /^-c./.test(t) ? t.slice(2) : t.startsWith("--config-env=") ? t.slice("--config-env=".length) : undefined;
		return setting !== undefined && setting.split("=")[0]!.toLowerCase() === "core.hookspath";
	};
	// A walk also starts where a substitution among git's options ends (`git -C $(git rev-parse …) -c …`).
	return raw.some((t, at) => {
		if (!gitLike(t) && !/[$`]/.test(tokens[at]!) && !/[)`]$/.test(tokens[at]!)) return false;
		for (let i = at + 1; i < raw.length && raw[i]!.startsWith("-"); i += GIT_VALUE_OPTIONS.has(raw[i]!) || raw[i] === "--attr-source" ? 2 : 1) {
			if (sets(i)) return true;
		}
		return false;
	});
}

const WRITE_PATH = String.raw`(?<target>[A-Za-z0-9_./~@+-]+)`;
const QUOTED_DELIMITER = String.raw`<<(?<tabs>-?)(?<quote>['"])(?<word>[\w.-]+)\k<quote>`;
/** `cat > f`, `cat >> f`, `tee [-a] f` with a quoted heredoc delimiter, and nothing else on the line. */
const FILE_WRITE_HEADS = [
	new RegExp(String.raw`^cat[ \t]+>>?[ \t]*${WRITE_PATH}[ \t]+${QUOTED_DELIMITER}[ \t]*$`),
	new RegExp(String.raw`^cat[ \t]+${QUOTED_DELIMITER}[ \t]+>>?[ \t]*${WRITE_PATH}[ \t]*$`),
	new RegExp(String.raw`^tee(?:[ \t]+-a)?[ \t]+${WRITE_PATH}[ \t]+${QUOTED_DELIMITER}[ \t]*$`),
];
/** `python`, `python3` or `node`, optionally `-`, reading its program from a quoted heredoc, and nothing else on the line. */
const INTERPRETER_HEAD = new RegExp(String.raw`^(?:python3?|node)(?:[ \t]+-)?[ \t]+${QUOTED_DELIMITER}[ \t]*$`);

/**
 * The first line of a command that, as a whole, only writes a file (with its `target`) or feeds an interpreter through a
 * quoted heredoc: a head above, the body, and the delimiter as the last line, appearing nowhere earlier. Anything else (an unquoted delimiter, a `$` in the
 * path, a second command on any line, a missing delimiter) returns undefined, and the command is judged whole. So does
 * a carriage return or another control character: some shells (Cygwin's `igncr`) end a heredoc where this wouldn't.
 */
export function quotedHeredoc(command: string): { head: string; target?: string } | undefined {
	if (/[\0-\x08\x0b-\x1f\x7f]/.test(command)) return undefined;
	const lines = command.split("\n");
	if (lines.length > 2 && lines[lines.length - 1] === "") lines.pop();
	const head = [...FILE_WRITE_HEADS, INTERPRETER_HEAD].map((re) => re.exec(lines[0]!)).find(Boolean);
	if (!head || lines.length < 2) return undefined;
	const { target, tabs, word } = head.groups!;
	const end = lines.findIndex((line, i) => i > 0 && (tabs === "-" ? line.replace(/^\t+/, "") : line) === word);
	return end === lines.length - 1 ? { head: lines[0]!, target } : undefined;
}

function checkSegment(tokens: string[], cwd: string): GuardDecision | undefined {
	const words = tokens.map(unwrapToken).filter((t) => t !== "" && (!t.includes("=") || t.startsWith("-")));
	// git takes any unambiguous abbreviation of a long option; `--no-ver` is ambiguous with `--no-verbose`.
	if ([...tokens, ...words].some((t) => /^--no-veri(?:fy?)?$/.test(t))) {
		return { action: "block", reason: "Bypassing git hooks (--no-verify) is not allowed. Fix what the hook reports instead." };
	}
	const gitAt = words.findIndex((w) => commandName(w) === "git");
	if (overridesHooksPath(tokens)) {
		return { action: "block", reason: "Overriding core.hooksPath on the command line skips or replaces the git hooks. Fix what the hook reports instead." };
	}
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

	const rmAt = words.findIndex((w) => commandName(w) === "rm");
	if (rmAt !== -1) {
		const args = words.slice(rmAt + 1);
		const recursive = args.some((t) => t === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(t));
		if (recursive) {
			// `2>/dev/null` leaves the word /dev/null behind: it is written to, not deleted.
			const outside = args.filter((t) => !t.startsWith("-") && t !== "/dev/null").find((t) => isOutside(t, cwd));
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
 * Minimal shell tokenizer: honours quotes (`'…'`, `"…"`, `$"…"` as `"…"`, and `$'…'` with its escapes decoded) and
 * backslash escapes, and splits out control operators. An escaped quote opens nothing, so `echo \' ; cmd` still shows
 * `cmd`.
 */
export function tokenize(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let has = false;
	// The unquoted, unescaped `<` or `>` just before this character, if any: `>&`, `<&` and `>|` continue it.
	let operator = "";
	const push = () => {
		// A word that reads as an operator was quoted or escaped (a bare operator never joins a word): it stays an
		// argument, written in quotes so no consumer splits on it (`rm -rf ';' ~` deletes ~).
		if (has) tokens.push(OPERATORS.has(current) ? `'${current}'` : current);
		current = "";
		has = false;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		const after = operator;
		operator = "";
		if (quote === "'") {
			if (ch === "'") quote = null;
			else current += ch;
			continue;
		}
		if (quote) {
			// In "…" a backslash escapes only " \ $ ` and a newline.
			const next = command[i + 1];
			// A backslash-newline inside "…" is a line continuation: both characters vanish.
			if (ch === "\\" && next === "\n") {
				i++;
				continue;
			}
			if (ch === "\\" && next !== undefined && /["\\$`\n]/.test(next)) {
				current += next;
				i++;
			} else if (ch === '"') quote = null;
			else current += ch;
			continue;
		}
		if (ch === "\\") {
			// A backslash-newline is a line continuation: the shell joins the lines. Between a `$` and a quote or another
			// `$` the shells may read them together (`$\⏎'…'` opens a `$'…'` word in bash and zsh), so the word asks;
			// `$\⏎HOME` and `$\⏎(…)` read as `$HOME` and `$(…)` in both.
			if (command[i + 1] === "\n") {
				let next = i + 2;
				while (command[next] === "\\" && command[next + 1] === "\n") next += 2;
				if (command[i - 1] === "$" && /['"$]/.test(command[next] ?? "")) {
					current += "\0";
					has = true;
				}
				i++;
				continue;
			}
			if (i + 1 < command.length) current += command[++i];
			has = true;
			continue;
		}
		if (ch === "$" && command[i + 1] === "'") {
			// The shell finds the word's end first (a backslash pairs with the next character, the first unpaired `'`
			// closes it) and only then decodes it, so no escape reaches past the quote.
			let end = i + 2;
			while (end < command.length && command[end] !== "'") end += command[end] === "\\" ? 2 : 1;
			// A NUL in the word marks a reading the shells may disagree on, and the guard asks about it (user ruling after
			// review round 3): a `$` just before this one (`$$'`, `\$$$'`: bash may read the PID and a plain quote, zsh a
			// `$` and this word), an escape the two decode differently, bytes that aren't UTF-8 on their own (bash and zsh
			// join them with the next part), or a decoded NUL (bash ends only the quoted part there, zsh the whole word).
			const { text: decoded, agreed } = decodeAnsi(command.slice(i + 2, Math.min(end, command.length)));
			if (command[i - 1] === "$" || !agreed) current += "\0";
			current += decoded;
			has = true;
			i = end;
			continue;
		}
		if (ch === "$" && command[i + 1] === '"') {
			// bash reads `$"…"` as `"…"` (a translation that is usually the same text); zsh as `$` and a quoted word.
			quote = '"';
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
		// `&>`, `&>>`, `>&`, `<&` and `>|` are redirections, not a background `&` or a pipe.
		if ((ch === "&" && (command[i + 1] === ">" || after !== "")) || (ch === "|" && after === ">")) {
			push();
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			push();
			tokens.push(ch);
			continue;
		}
		// Only blanks end a word, as in bash and zsh: U+00A0, U+FEFF, `\r`, `\v` and `\f` stay inside it.
		if (ch === " " || ch === "\t" || ch === "<" || ch === ">") {
			push();
			if (ch === "<" || ch === ">") operator = ch;
			continue;
		}
		current += ch;
		has = true;
	}
	push();
	return tokens;
}

/**
 * A `$'…'` word's body with its escapes decoded, and whether bash and zsh agree on all of it. Escapes give bytes (`\xc5\xbf`
 * is `ſ`), read as UTF-8 as the program receives them; bytes that aren't valid UTF-8 on their own may join the next part.
 */
function decodeAnsi(body: string): { text: string; agreed: boolean } {
	const bytes: number[] = [];
	let agreed = true;
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== "\\" || i + 1 >= body.length) {
			// By code point, so a character outside the BMP stays whole.
			const char = String.fromCodePoint(body.codePointAt(i)!);
			bytes.push(...Buffer.from(char, "utf8"));
			i += char.length - 1;
			continue;
		}
		const escape = ansiEscape(body, i);
		bytes.push(...escape.bytes);
		agreed &&= escape.agreed;
		i = escape.end;
	}
	try {
		// A BOM is kept, as the program receives it, and marked: some file systems ignore U+FEFF in a name, others don't.
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
		return { text, agreed: agreed && !text.includes("\0") && !text.includes("\ufeff") };
	} catch {
		return { text: Buffer.from(bytes).toString("utf8"), agreed: false };
	}
}

const ANSI_SIMPLE: Record<string, number> = { a: 0x07, b: 0x08, e: 0x1b, E: 0x1b, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b, "\\": 0x5c, "'": 0x27, '"': 0x22, "?": 0x3f };
const ANSI_HEX: Record<string, number> = { x: 2, u: 4, U: 8 };

/**
 * The escape at `body[i]` (a backslash inside a `$'…'` body): its bytes, the index of its last character, and whether bash
 * and zsh read it the same. They agree on the letters above, `\\`, `\'`, `\"`, `\?`, octal, and `\x` with digits. Anything
 * else (`\u` and `\U`, which macOS's bash 3.2 lacks; `\c`; zsh's `\C` and `\M`; an unknown letter; `\x` without digits) is
 * read differently, and its bytes are only a best guess.
 */
function ansiEscape(body: string, i: number): { bytes: number[]; end: number; agreed: boolean } {
	const ch = body[i + 1]!;
	if (Object.hasOwn(ANSI_SIMPLE, ch)) return { bytes: [ANSI_SIMPLE[ch]!], end: i + 1, agreed: true };
	const run = (digit: RegExp, from: number, max: number) => {
		let j = from;
		while (j < from + max && digit.test(body[j] ?? "")) j++;
		return j;
	};
	if (/[0-7]/.test(ch)) {
		const j = run(/[0-7]/, i + 1, 3);
		return { bytes: [parseInt(body.slice(i + 1, j), 8) & 0xff], end: j - 1, agreed: true };
	}
	if (Object.hasOwn(ANSI_HEX, ch)) {
		const j = run(/[0-9a-fA-F]/, i + 2, ANSI_HEX[ch]!);
		if (j === i + 2) return { bytes: [0], end: i + 1, agreed: false };
		const code = parseInt(body.slice(i + 2, j), 16);
		if (ch === "x") return { bytes: [code], end: j - 1, agreed: true };
		// macOS's /bin/bash 3.2 has no `\u` or `\U`, and the shells differ beyond U+10FFFF and on surrogates.
		return { bytes: code <= 0x10ffff ? [...Buffer.from(String.fromCodePoint(code), "utf8")] : [], end: j - 1, agreed: false };
	}
	const char = String.fromCodePoint(body.codePointAt(i + 1)!);
	return { bytes: [...Buffer.from(char, "utf8")], end: i + char.length, agreed: false };
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

/** Anything that mentions `git … push`, as written or in a decoded, folded view, asks, unless the command is the plain own-branch push (see ownBranchPush). */
function checkPushes(command: string, views: string[], segments: string[][], project: string, dir: string, env: NodeJS.ProcessEnv, owners?: string[]): GuardDecision | undefined {
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
	if (!pushToken && !pushAfterGit && !views.some((v) => PUSH_WORDS.test(v))) return undefined;
	return ownBranchPush(command, dir, env, project, owners) ? undefined : PUSH_CONFIRM;
}

/**
 * A strict allowlist: true only for exactly `git [-C <path>] push [safe options] [<remote> [<refspec>]]` as the
 * whole command, from a clean environment, naming the current convention-named work branch (or nothing) on a configured
 * remote whose config cannot redirect or enlarge the push. Everything else is false, so it asks.
 */
export function ownBranchPush(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env, project: string = cwd, owners?: string[]): boolean {
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
	// Only the project's own repository (or one of its worktrees) is pushed silently; in a workspace, the repository
	// the push runs in.
	const repoDir = commonDir(dir);
	const workspace = projectRepos(project);
	const owner = workspace.kind === "workspace" ? repoOf(project, workspace.repos, dir) : project;
	if (repoDir === undefined || owner === undefined || repoDir !== commonDir(owner)) return false;
	// Given owners (a workspace session): only a repository that was there when the session started, whatever the
	// session folder has become since (a clone made since, or a `.git` at the workspace root, asks).
	if (owners !== undefined && !owners.includes(owner)) return false;
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
/**
 * The program a command word names, as macOS and Windows find it: its base name folded like a path (`GIT`, `/usr/bin/Git`
 * and `ſh` run git and sh there). Only for external programs: a builtin or keyword in another case is not one (`CD x`
 * runs `/usr/bin/cd` in a child, `EVAL` isn't found), so `cd`, `eval`, `export` and the keywords compare as written.
 */
export function commandName(token: string): string {
	// A marked word (see tokenize) is also judged as the name it most likely spells: a block on that reading wins over the
	// question the mark asks.
	return foldPath(BASE_NAME(token.replaceAll("\0", "")));
}
/** Config keys whose value is a command git runs (pager, editor, helpers, drivers, filters). */
const COMMAND_KEYS =
	"core[.](pager|editor|askpass)|sequence[.]editor|diff[.]external|gpg[.]([^.]+[.])?program|filter[.]|pager[.]|diff[.].+[.](command|textconv)|merge[.].+[.]driver|(difftool|mergetool)[.].+[.]cmd|submodule[.].+[.]update|credential[.](.+[.])?helper";
/** Keys that move where git pushes, fetches or what it executes, besides the command-valued ones. */
const EXEC_KEYS = `${COMMAND_KEYS}|core[.](sshcommand|gitproxy|hookspath|fsmonitor)|http[.]proxy`;
const COMMAND_KEY = new RegExp(`^(${COMMAND_KEYS})`);
/** Values of a command key that run nothing of interest. */
const HARMLESS_COMMAND = /^(|cat|true|:)$/;
const WATCHED_CONFIG = new RegExp(`^((remote|url|push|branch|alias|include|includeif)[.]|${EXEC_KEYS})`);
/** The sections WATCHED_CONFIG's keys live in: removing or renaming one drops or plants such a key. */
const WATCHED_SECTIONS = new Set(["remote", "url", "push", "branch", "alias", "include", "includeif", "core", "sequence", "diff", "gpg", "filter", "pager", "merge", "difftool", "mergetool", "submodule", "credential", "http"]);

/** Words that run the command after them, so a git token behind one is a git call. */
const WRAPPERS = new Set(["xargs", "parallel", "env", "command", "exec", "nice", "nohup", "time", "timeout", "strace", "script", "sudo", "stdbuf", "flock", "ionice", "taskset", "chrt", "setsid", "unbuffer", "doas"]);
/** Shell keywords that start a command without being one. */
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "(", "((", "&&", "||"]);
/** A token that opens a group, substitution or backticks: the git inside it is a call of its own. */
const OPENS_COMMAND = /^([A-Za-z_][A-Za-z0-9_]*=)?(\$\(|[(`{])/;
/** `git`, `git-<sub>`, or a path to one that is absolute or starts with `./`; `skills/git-workflow` is not git. */
function gitLike(token: string): boolean {
	if (!/^git(-[a-z][a-z-]*)?$/.test(commandName(token))) return false;
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
		const word = commandName(t);
		if ((territory || wrapped) && WRAPPERS.has(word) && !(word === "command" && /^-[vV]$/.test(tokens[i + 1] ?? ""))) wrapped = true;
		else if (!wrapped) territory = t === "" || SHELL_KEYWORDS.has(t) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[i]!) || opens;
	});
	// Calls that open their own group are separate; plain ones in one segment hide each other.
	const plain = positions.filter((i) => !OPENS_COMMAND.test(raw[i]!));
	return positions.map((at) => {
		const call = parseGit(raw, tokens, at);
		if (!OPENS_COMMAND.test(raw[at]!)) {
			if (plain.length > 1) call.issue ??= { action: "confirm", reason: "This runs git indirectly, so the guard can't see the subcommand." };
			else if (tokens.slice(0, at).some((t) => /^(xargs|parallel)$/.test(commandName(t)))) call.issue ??= { action: "confirm", reason: "Git gets its arguments from input, so the guard can't see them." };
		}
		return call;
	});
}

function parseGit(raw: string[], tokens: string[], at: number): GitCall {
	let issue: GuardDecision | undefined;
	// A `git-<sub>` binary is `git <sub>`: it takes no global options.
	const direct = /^git-([a-z][a-z-]*)$/.exec(commandName(tokens[at]!));
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
			const at = lower.findIndex((t) => commandName(t) === tool);
			const n = at === -1 ? -1 : lower.indexOf(noun, at + 1);
			if (n !== -1 && lower.indexOf("merge", n + 1) !== -1) return { action: "confirm", reason: "This command merges a PR/MR." };
			if (at !== -1 && apiWrite(tokens.map(unwrapToken), at, command)) return { action: "confirm", reason: "This command calls the API with a write method." };
		}
		const shell = tokens.findIndex((t, i) => /^(ba|z|da|k)?sh$/.test(commandName(t)) && tokens.slice(i + 1).some((a) => /^-[a-z]*c[a-z]*$/.test(a)));
		const evalAt = tokens.findIndex((t) => t === "eval");
		const from = shell !== -1 ? shell : evalAt;
		if (from !== -1 && tokens.slice(from + 1).some((t) => /\bgit\b/.test(foldPath(t)))) return { action: "confirm", reason: "This command runs git through a shell string." };
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
				// Removing or renaming a section drops every key in it (`--remove-section core` unsets core.hooksPath).
				const sections = ["--remove-section", "--rename-section", "remove-section", "rename-section"];
				if (args.some((t) => sections.includes(t)) && args.some((t) => !t.startsWith("-") && !sections.includes(t) && WATCHED_SECTIONS.has(t.split(".")[0]!))) return setup;
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
