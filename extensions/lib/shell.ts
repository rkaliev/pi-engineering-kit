/**
 * The shell parser the review gate reads commands with: redirections, quotes, segments, and the folders a
 * command's `cd`, `pushd` and `popd` lead to. Pure text work plus the filesystem checks a move needs.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { tokenize } from "./patterns.ts";

/**
 * Writing redirections (`>`, `>>`, `>|`, `&>`, `&>>`, `>& file`) and `tee` make any command a writer;
 * `2>/dev/null`, `2>&1` and `>&-` don't. The text is scanned as written, quotes included: the guard can't pair
 * quotes as the shell does (a substitution in double quotes runs, an apostrophe in a comment or heredoc body opens
 * nothing), so a `>` in a quoted message counts too.
 */
export function writes(command: string): boolean {
	return (
		[...command.matchAll(/(&>>?|\d*>[>|&]?)\s*([^\s;&|()<>]*)/g)].some(([, op, target]) => target !== "/dev/null" && !(op!.endsWith("&") && /^(\d+|-)$/.test(target!))) ||
		/\btee\b/.test(command)
	);
}

/** The command with the text inside quotes replaced by spaces; the quotes stay, so a quoted target is still a word. */
export function blankQuoted(command: string): string {
	let out = "";
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote) {
			// A backslash escapes the next character in "…" and $'…', never in '…'.
			if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
				out += "  ";
				i++;
			} else if (ch === (quote === "$'" ? "'" : quote)) {
				quote = null;
				out += ch;
			} else out += " ";
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			out += command.slice(i, i + 2);
			i++;
		} else if (ch === "$" && command[i + 1] === "'") {
			quote = "$'";
			out += "$'";
			i++;
		} else {
			if (ch === "'" || ch === '"') quote = ch;
			out += ch;
		}
	}
	return out;
}

/**
 * Every folder the shell may be in during the command: the start folder and any folder a `cd`, `pushd` or
 * `popd` may reach from any of them. The set only grows, so a failed move or a subshell never hides a folder;
 * `cd -`, `~-` and `popd` return to one already in it, and a write may create a folder first, so a folder need
 * not exist. `unknown` when a move isn't plain (see parseMove), when `cd -` or `~-` comes before any move in the
 * command (the previous folder is then an earlier command's), or when the set would pass 256 folders: then any
 * write asks.
 */
export function reachable(command: string, cwd: string): { dirs: string[]; unknown: boolean } {
	const dirs = new Set([cwd]);
	let unknown = false;
	const simple = plainShell(command);
	if (hiddenMove(command)) unknown = true;
	let moved = false;
	for (const { words: raw, alone, redirected } of moveSegments(command)) {
		const words = raw.map((t) => t.replace(/^\(+|\)+$/g, "")).filter(Boolean);
		const move = parseMove(words);
		if (move === undefined) continue;
		const plain = move !== "other" && alone && simple && !redirected && !(move.physical && move.arg?.split("/").includes(".."));
		if (!plain) unknown = true;
		// A move the guard doesn't follow still adds its literal words: more candidates only block more.
		const args = move === "other" ? words.filter((w) => !MOVES.has(w)) : move.arg === undefined ? (move.cmd === "cd" ? ["~"] : []) : [move.arg];
		for (const arg of args) {
			// Before any move in this command, the previous folder is one an earlier command left in OLDPWD.
			if ((arg === "-" || /^~-(?=\/|$)/.test(arg)) && !moved) unknown = true;
			if (arg === "-" || arg === "") continue;
			const path = expandDir(arg.replace(/^~[+-](?=\/|$)/, "."), true);
			if (path === undefined) {
				unknown = true;
				continue;
			}
			for (const dir of isAbsolute(path) ? [cwd] : [...dirs]) {
				// An absolute folder doesn't multiply the set, so it always counts.
				if (dirs.size >= 256 && !isAbsolute(path)) unknown = true;
				else dirs.add(resolve(dir, path));
			}
		}
		moved = true;
	}
	return { dirs: [...dirs], unknown };
}

/** The command without redirections that write nothing (`2>/dev/null`, `>/dev/null`, `&>/dev/null`, `2>&1`, `>&-`), so they don't make a move look unusual. */
function quiet(command: string): string {
	// Matched on the text with quotes blanked (same length), so a `2>/dev/null` inside quotes stays part of its word.
	const text = blankQuoted(command);
	let out = "";
	let at = 0;
	for (const m of text.matchAll(/(^|[\s;&|()])(?:\d*>&(?:\d+|-)|&>>?\s*\/dev\/null|\d*>>?\s*\/dev\/null)(?=[\s;&|()]|$)/g)) {
		out += command.slice(at, m.index! + m[1]!.length);
		at = m.index! + m[0].length;
	}
	return out + command.slice(at);
}

/**
 * The command's segments with harmless redirections removed: `full` keeps the other redirections' targets, `words`
 * drops them, `redirected` says the segment had one. When the two splits don't line up, every segment counts as
 * redirected.
 */
export function moveSegments(command: string): Array<{ full: string[]; words: string[]; alone: boolean; redirected: boolean }> {
	const q = quiet(command);
	const full = segmentsOf(tokenize(q));
	const bare = segmentsOf(tokenize(stripRedirects(q)));
	const aligned = full.length === bare.length;
	return full.map((segment, i) => {
		const words = aligned ? bare[i]!.raw : segment.raw;
		const redirected = !aligned || words.length !== segment.raw.length || words.some((w, j) => w !== segment.raw[j]);
		return { full: segment.raw, words, alone: segment.alone, redirected };
	});
}

/**
 * Whether the command's shape lets the guard follow its moves at all: no comment, unquoted command or process
 * substitution or backtick, brace group, `|&`, heredoc or `case`. In any of these a `cd` may sit where the segments can't
 * place it. A substitution inside quotes stays one word and runs in a subshell, so it can't move the shell.
 */
export function plainShell(command: string): boolean {
	const text = blankQuoted(command).replace(/\\./g, "").replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "");
	return !/\$\(|`|#|[{}]|[<>]\(|\|&|<<|(^|[\s;&|(])case\s/.test(text);
}

/** zsh's `chdir` is a move too; the guard never follows it. */
export const MOVES = new Set(["cd", "pushd", "popd", "chdir"]);

/** Whether a command the guard can't follow (see plainShell) names a move anywhere, as in `echo $( cd x )`. */
function hiddenMove(command: string): boolean {
	return !plainShell(command) && tokenize(command).some((t) => MOVES.has(t.replace(/\)+$/, "").split(/\$\(|`|\(/).pop()!));
}
/** Prefixes whose own options come before the command: `command -p cd`, `time -p cd`. */
const OPTION_PREFIXES = new Set(["command", "time", "exec"]);
/** Words that may stand before a command in the same segment. */
const PREFIXES = new Set(["{", "}", "!", "then", "do", "else", "elif", "if", "while", "until", "time", "builtin", "command", "exec"]);

/** A move the guard follows exactly. */
type Move = { cmd: "cd" | "pushd" | "popd"; arg?: string; physical: boolean };

/**
 * The move a segment's words make: undefined when they name no `cd`, `pushd` or `popd`; "other" for any form
 * the guard doesn't follow exactly. A plain move is the segment's first word with at most `-L`/`-P` (cd only) and
 * `--`, then one folder for `pushd`, none for `popd`, at most one for `cd`, written without a glob or brace.
 */
export function parseMove(words: string[]): Move | "other" | undefined {
	// The command word comes after reserved words, `builtin`-style prefixes and assignments.
	const at = words.findIndex((w, i) => !PREFIXES.has(w) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !(w.startsWith("-") && OPTION_PREFIXES.has(words[i - 1] ?? "")));
	if (at === -1 || !MOVES.has(words[at]!)) return undefined;
	if (at > 0 || words[at] === "chdir") return "other";
	const cmd = words[0] as Move["cmd"];
	let i = 1;
	let physical = false;
	// The last of `-L` and `-P` wins, as in bash.
	while (cmd === "cd" && /^-[LP]+$/.test(words[i] ?? "")) {
		const w = words[i++]!;
		physical = w.lastIndexOf("P") > w.lastIndexOf("L");
	}
	const dashes = words[i] === "--";
	if (dashes) i++;
	const operands = words.slice(i);
	const arg = operands[0];
	if (operands.length > 1 || (arg !== undefined && /[*?[{]/.test(arg))) return "other";
	// Without `--`, a word that starts with a dash is an option the guard doesn't follow (`-e`, `-@`, `+1`).
	if (arg !== undefined && !dashes && arg !== "-" && /^[-+]/.test(arg)) return "other";
	if (cmd === "popd" ? arg !== undefined : cmd === "pushd" && arg === undefined) return "other";
	return { cmd, arg, physical };
}

/**
 * Segments with whether a move in them runs in the current shell (not in a pipeline, after `||` or in the
 * background) and the separator before them. A newline or `&` right after another separator (`||⏎`, `|&`) keeps
 * the first one.
 */
export function segmentsOf(tokens: string[]): Array<{ raw: string[]; alone: boolean; before: string }> {
	const out: Array<{ raw: string[]; before: string; after: string }> = [];
	let raw: string[] = [];
	let before = "";
	for (const token of tokens) {
		if (!SEPARATORS.has(token)) {
			raw.push(token);
			continue;
		}
		if (raw.length > 0) {
			out.push({ raw, before, after: token });
			before = token;
		} else if (before === "" || (token !== "\n" && token !== "&")) before = token;
		raw = [];
	}
	if (raw.length > 0) out.push({ raw, before, after: "" });
	// A list (up to `;`, a newline or `&` outside parentheses) that ends in `&` runs in the background as a whole:
	// `cd x && make &`, `cd x && (a; b) &`.
	let start = 0;
	let depth = 0;
	const background = out.map(() => false);
	out.forEach(({ raw, after }, i) => {
		depth += (raw[0]?.match(/^\(+/)?.[0].length ?? 0) - (raw[raw.length - 1]?.match(/\)+$/)?.[0].length ?? 0);
		if (after === "&&" || after === "||" || after === "|" || depth > 0) return;
		if (after === "&") for (let j = start; j <= i; j++) background[j] = true;
		start = i + 1;
	});
	return out.map(({ raw, before, after }, i) => ({ raw, before, alone: !background[i] && before !== "||" && before !== "|" && after !== "|" }));
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);

/**
 * The command without its redirections (`2>&1`, `> out.log`, `&>/dev/null`, `< in`), which don't change what
 * lands and would otherwise split a segment at the `&` of `2>&1`. Only outside quotes: a `>` in a commit
 * message is text. A target ends at whitespace, an operator or a parenthesis.
 */
export function stripRedirects(command: string): string {
	let out = "";
	let quote: string | null = null;
	let i = 0;
	while (i < command.length) {
		const ch = command[i]!;
		if (quote) {
			// A backslash escapes the next character in "…" and $'…', never in '…'.
			if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
				out += command.slice(i, i + 2);
				i += 2;
				continue;
			}
			if (ch === (quote === "$'" ? "'" : quote)) quote = null;
			out += ch;
			i++;
			continue;
		}
		if (ch === "\\") {
			out += command.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (ch === "$" && command[i + 1] === "'") {
			quote = "$'";
			out += "$'";
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			out += ch;
			i++;
			continue;
		}
		if (command.startsWith("&&", i) || command.startsWith("||", i)) {
			out += command.slice(i, i + 2);
			i += 2;
			continue;
		}
		const boundary = i === 0 || /[\s;&|()]/.test(command[i - 1]!);
		// `[n]>`, `>>`, `>|`, `<`, `<>`, `>&` and `<&` (an fd, `-` or a word follows), `&>`, `&>>`. A `&` before
		// anything else is a background separator: `a &< f b` runs `a` in the background, then `b` reads f.
		let op = /^(?:\d*(?:>>|>\||>&|<&|<>|>|<)|&>>?)/.exec(command.slice(i))?.[0];
		const isRedirect = op !== undefined && (ch === ">" || ch === "<" || ch === "&" || (boundary && op.length > 1));
		if (!isRedirect || op === undefined) {
			out += ch;
			i++;
			continue;
		}
		if (op.endsWith("&")) op += /^(?:\d+|-)(?=[\s;&|()<>]|$)/.exec(command.slice(i + op.length))?.[0] ?? "";
		i += op.length;
		if (!/&(\d+|-)$/.test(op)) {
			while (i < command.length && /[ \t]/.test(command[i]!)) i++;
			let target: string | null = null;
			while (i < command.length && (target || !/[\s;&|()<>]/.test(command[i]!))) {
				const c = command[i]!;
				if (target) {
					if (c === target) target = null;
				} else if (c === "'" || c === '"') target = c;
				i++;
			}
		}
		out += " ";
	}
	return out;
}

/**
 * The folder a command runs in, segment by segment, for the review gate. A `cd` inside one `( … )` ends with it,
 * once the segment that closes it has run. A nested subshell, a closing `)` inside `$(…)`, or any parenthesis in
 * quotes or after a backslash (the tokens can't tell it from a real one) makes the folder unknown for the rest of
 * the command, so what follows fails closed.
 */
export class Subshells {
	private state: DirState;
	private outside: DirState;
	private inside = false;
	private closing = false;
	private lost = false;
	private conditional = false;
	private outsideConditional = false;
	private readonly textParens: boolean;
	private readonly simple: boolean;

	constructor(cwd: string, command: string) {
		this.state = this.outside = at(cwd);
		const count = (s: string) => s.match(/[()]/g)?.length ?? 0;
		this.textParens = count(command) !== count(blankQuoted(command).replace(/\\./g, ""));
		this.simple = plainShell(command);
		this.lost = hiddenMove(command);
	}

	get dir(): string | undefined {
		return this.lost ? undefined : here(this.state);
	}

	/**
	 * Starts a segment: ends the subshell the previous segment closed, opens one this segment starts. A move after
	 * `&&` may have been skipped, so once the `&&` chain breaks (`;`, a newline, `||`) the folder is unknown.
	 */
	enter(raw: string[], before: string): void {
		if (this.closing) {
			this.closing = false;
			this.inside = false;
			this.state = this.outside;
			this.conditional = this.outsideConditional;
		}
		if (this.conditional && before !== "&&") {
			this.conditional = false;
			this.state = { dirs: [], prev: [], stack: [] };
		}
		if (raw[0]?.startsWith("(")) {
			if (this.inside || raw[0].startsWith("((") || this.textParens || !this.simple) this.lost = true;
			this.inside = true;
			this.outside = this.state;
			// A separator inside the parentheses doesn't end the outer `&&` chain.
			this.outsideConditional = this.conditional;
			this.conditional = false;
		}
		const last = (raw[raw.length - 1] ?? "").replace(/^\(+/, "");
		if (this.inside && last.endsWith(")")) {
			if (last.replace(/\)+$/, "").includes("(")) this.lost = true;
			this.closing = true;
		}
	}

	/** Follows a plain move ("plain"); a move the guard doesn't follow makes the folder unknown ("other"); undefined for any other command. */
	move(raw: string[], alone: boolean, before = ""): "plain" | "other" | undefined {
		// A subshell's parentheses are not words; an empty quoted operand (`cd ""`) is.
		const words = raw.flatMap((t) => {
			const word = t.replace(/^\(+|\)+$/g, "");
			return word === "" && t !== "" ? [] : [word];
		});
		const move = parseMove(words);
		if (move === undefined) return undefined;
		const next = move !== "other" && alone && this.simple ? changeDir(this.state, move) : undefined;
		this.state = next ?? { dirs: [], prev: [], stack: [] };
		if (next && before === "&&") this.conditional = true;
		return next ? "plain" : "other";
	}
}

/** The folders a command may be in, as far as the guard follows `cd`, `pushd` and `popd`; none means unknown. */
type DirState = { dirs: string[]; prev: string[]; stack: string[][] };

function at(dir: string): DirState {
	return { dirs: [dir], prev: [], stack: [] };
}

/** The one folder a command is in, or undefined when the guard can't tell. */
function here(state: DirState): string | undefined {
	return state.dirs.length === 1 ? state.dirs[0] : undefined;
}

/**
 * The state after a plain move, or undefined when the guard can't confirm it (a missing folder, a variable, `..`
 * after `-P`, `popd` or `cd -` with nothing to return to). `cd -` and `~-` are the previous folder, `cd ""`
 * stays, `cd` alone goes home, and `pushd` and `popd` keep a stack.
 */
function changeDir(state: DirState, move: Move): DirState | undefined {
	const { cmd, arg } = move;
	if (cmd === "popd") {
		const [top, ...rest] = state.stack;
		return top === undefined ? undefined : { dirs: top, prev: state.dirs, stack: rest };
	}
	// `cd ""` stays, but whether it sets OLDPWD depends on the shell.
	if (arg === "" && cmd === "cd") return { ...state, prev: [] };
	// `-P` resolves symlinks before `..`; the guard resolves paths as written.
	if (move.physical && arg?.split("/").includes("..")) return undefined;
	let target: string[];
	if (arg === "-") target = state.prev;
	else if (arg !== undefined && /^~[+-](?=\/|$)/.test(arg)) target = (arg[1] === "-" ? state.prev : state.dirs).map((d) => resolve(d, arg.slice(3)));
	else {
		const path = expandDir(arg ?? "~", false);
		if (path === undefined) return undefined;
		target = isAbsolute(path) ? [resolve(path)] : state.dirs.map((d) => resolve(d, path));
	}
	if (target.length === 0 || !target.every(isDir)) return undefined;
	// `-P` resolves symlinks: the shell is in the real folder, and a later `..` leaves that.
	if (move.physical) target = target.map(safeRealpath);
	// zsh's AUTO_PUSHD makes `cd` push the stack too, so after a `cd` a `popd` can't be followed.
	return { dirs: target, prev: state.dirs, stack: cmd === "pushd" ? [state.dirs, ...state.stack] : cmd === "cd" ? [] : state.stack };
}

/** A `cd` operand with `~` expanded, and `$HOME` and `$TMPDIR` when `vars`; undefined when anything else would expand. */
function expandDir(arg: string, vars: boolean): string | undefined {
	let path = arg.replace(/^~(?=\/|$)/, homedir());
	// The shell's TMPDIR keeps its trailing slash (macOS), so `${TMPDIR}eng-kit` resolves as the shell sees it.
	if (vars) path = path.replace(/^\$(?:\{HOME\}|HOME\b)/, homedir()).replace(/^\$(?:\{TMPDIR\}|TMPDIR\b)/, process.env.TMPDIR || `${tmpdir()}/`);
	return /[$`(]/.test(path) ? undefined : path;
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** The directory `cd <arg>` moves to, or undefined when the guard can't know it. */
export function follow(dir: string, arg: string | undefined): string | undefined {
	if (arg === undefined || /[$`(]/.test(arg)) return undefined;
	const target = resolve(dir, arg.replace(/^~(?=\/|$)/, homedir()));
	return existsSync(target) ? target : undefined;
}

export function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * The command with heredoc bodies made plain text: the lines after a line with `<<WORD` (`<<-`, a quoted WORD) up
 * to the line that ends it. A quoted WORD's body is dropped; an unquoted one's runs its `$(…)` and backticks, so it
 * stays as one double-quoted word per line. The operator is found in the raw text, so a `<<` in quotes changes lines
 * too: callers use this text only to find more, never to see less.
 */
export function dropHeredocBodies(command: string): string {
	const out: string[] = [];
	const open: Array<{ word: string; tabs: boolean; quoted: boolean }> = [];
	for (const line of command.split("\n")) {
		if (open.length > 0) {
			if ((open[0]!.tabs ? line.replace(/^\t+/, "") : line) === open[0]!.word) open.shift();
			else if (!open[0]!.quoted) out.push(`"${line.replace(/["\\]/g, "")}"`);
			continue;
		}
		out.push(line);
		// `<<<` is a here-string, not a heredoc.
		for (const m of line.matchAll(/(?<!<)<<(-?)[ \t]*(\\?)(['"]?)([\w.-]+)\3/g)) open.push({ word: m[4]!, tabs: m[1] === "-", quoted: m[2] !== "" || m[3] !== "" });
	}
	return out.join("\n");
}

/** The text of each `$(…)` and backtick substitution inside double quotes: it runs, but stays one word. */
export function quotedSubstitutions(command: string): string[] {
	const found: string[] = [];
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
		} else if (ch === "\\") i++;
		else if (quote === null) {
			if (ch === "'" || ch === '"') quote = ch;
		} else if (ch === '"') quote = null;
		else if (ch === "`") {
			const end = command.indexOf("`", i + 1);
			found.push(command.slice(i + 1, end === -1 ? undefined : end));
			i = end === -1 ? command.length : end;
		} else if (command.startsWith("$(", i)) {
			let depth = 1;
			let j = i + 2;
			for (; j < command.length && depth > 0; j++) depth += command[j] === "(" ? 1 : command[j] === ")" ? -1 : 0;
			found.push(command.slice(i + 2, depth === 0 ? j - 1 : j));
			i = j - 1;
		}
	}
	return found;
}
