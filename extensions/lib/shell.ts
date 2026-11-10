/**
 * The shell parser the review gate reads commands with: redirections, quotes, segments, and the folders a
 * command's `cd`, `pushd` and `popd` lead to. Pure text work plus the filesystem checks a move needs.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { commandName, tokenize, unwrapToken } from "./patterns.ts";

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

/** Where the `'` of a `$'…'` word opened by the `$` at `command[i]` is, past any line continuations (as tokenize reads it); -1 for none. */
function ansiQuoteAt(command: string, i: number): number {
	let at = i + 1;
	while (command[at] === "\\" && command[at + 1] === "\n") at += 2;
	return command[at] === "'" ? at : -1;
}

/** The command with the text inside quotes replaced by spaces; the quotes stay, so a quoted target is still a word. */
export function blankQuoted(command: string): string {
	return scan(command, false).text;
}

/**
 * The comments of a command, in one pass with blankQuoted's quote model: an unquoted `#` that starts a word (after
 * any blank, an operator or a backtick) runs to the next `\n`, and a quote inside it opens nothing. PowerShell also
 * ends a line at `\r`, so there a comment may end before this range does. U+00A0 and `\r` count as blanks because
 * PowerShell reads them so; for bash that only adds a reading, and so maybe a question.
 */
export function quotedComments(command: string): Array<{ start: number; end: number }> {
	return scan(command, true).comments;
}

/** blankQuoted's text and, with `withComments`, the comments, skipped in the same pass. */
function scan(command: string, withComments: boolean): { text: string; comments: Array<{ start: number; end: number }> } {
	const comments: Array<{ start: number; end: number }> = [];
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
		} else if (ch === "$" && ansiQuoteAt(command, i) !== -1) {
			const at = ansiQuoteAt(command, i);
			quote = "$'";
			out += command.slice(i, at + 1);
			i = at;
		} else if (withComments && ch === "#" && (i === 0 || /[\s\u0085;&|()<>`]/u.test(command[i - 1]!))) {
			const end = command.indexOf("\n", i);
			const stop = end === -1 ? command.length : end;
			comments.push({ start: i, end: stop });
			out += command.slice(i, stop);
			i = stop - 1;
		} else {
			if (ch === "'" || ch === '"') quote = ch;
			out += ch;
		}
	}
	return { text: out, comments };
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
		const args = move === "other" ? words.filter((w) => !MOVES.has(bare(w))) : move.arg === undefined ? (move.cmd === "cd" ? ["~"] : []) : [move.arg];
		for (const arg of args) {
			// Before any move in this command, the previous folder is one an earlier command left in OLDPWD.
			if ((arg === "-" || /^~-(?=\/|$)/.test(arg)) && !moved) unknown = true;
			if (arg === "-" || arg === "") continue;
			// A marked folder (`$"…"`) leaves the set unknown, and its likely reading is added: more folders only block more.
			if (arg.includes("\0")) unknown = true;
			const path = expandDir(arg.replace(/^~[+-](?=\/|$)/, "."), true) ?? (arg.includes("\0") ? expandDir(bare(arg).replace(/^~[+-](?=\/|$)/, "."), true) : undefined);
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
	return !plainShell(command) && tokenize(command).some((t) => MOVES.has(bare(t).replace(/\)+$/, "").split(/\$\(|`|\(/).pop()!));
}
/** Prefixes whose own options come before the command: `command -p cd`, `time -p cd`. */
const OPTION_PREFIXES = new Set(["command", "time", "exec"]);
/** Words that may stand before a command in the same segment. */
const PREFIXES = new Set(["{", "}", "!", "then", "do", "else", "elif", "if", "while", "until", "time", "builtin", "command", "exec"]);

/**
 * A word without the mark tokenize puts on a reading the shells may disagree on (`$"builtin"` is `builtin` in bash).
 * Names, options and refs are compared this way; the mark itself still asks in the guard.
 */
export function bare(word: string): string {
	return word.replaceAll("\0", "");
}

/** Where a segment's command word is: after reserved words, `builtin`-style prefixes and assignments; -1 for none. */
function commandIndex(words: string[]): number {
	return words.findIndex((w, i) => !PREFIXES.has(bare(w)) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(bare(w)) && !(bare(w).startsWith("-") && OPTION_PREFIXES.has(bare(words[i - 1] ?? ""))));
}

/** A move the guard follows exactly. */
type Move = { cmd: "cd" | "pushd" | "popd"; arg?: string; physical: boolean };

/**
 * The move a segment's words make: undefined when they name no `cd`, `pushd` or `popd`; "other" for any form
 * the guard doesn't follow exactly. A plain move is the segment's first word with at most `-L`/`-P` (cd only) and
 * `--`, then one folder for `pushd`, none for `popd`, at most one for `cd`, written without a glob or brace.
 */
export function parseMove(words: string[]): Move | "other" | undefined {
	const at = commandIndex(words);
	if (at === -1) return undefined;
	// A word marked as read differently by the shells (see tokenize) that is a move without its mark may or may not move.
	if (words[at]!.includes("\0") && MOVES.has(words[at]!.replaceAll("\0", ""))) return "other";
	if (!MOVES.has(words[at]!)) return undefined;
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
		if (ch === "$" && ansiQuoteAt(command, i) !== -1) {
			const at = ansiQuoteAt(command, i);
			quote = "$'";
			out += command.slice(i, at + 1);
			i = at + 1;
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
	// A NUL byte is read differently by bash and zsh: the folder is unknown.
	return /[$`(\0]/.test(path) ? undefined : path;
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
	if (arg === undefined || /[$`(\0]/.test(arg)) return undefined;
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
 * The command split from its heredoc bodies: `text` is the command without them (the lines after a line with
 * `<<WORD`, `<<-` or a quoted WORD, up to the line that ends it), and `substitutions` are the `$(…)` and backtick
 * substitutions in unquoted bodies, which the shell runs (an escaped `\`` or `\$` doesn't). The operator is found in
 * the raw text, so a `<<` in quotes drops lines too: callers use this only to find more, never to see less.
 */
export function heredocs(command: string): { text: string; substitutions: string[] } {
	const out: string[] = [];
	const substitutions: string[] = [];
	const open: Array<{ word: string; tabs: boolean; quoted: boolean }> = [];
	// A body is scanned whole: a substitution may span its lines (a code fence between backticks).
	let body: string[] = [];
	const scan = () => {
		if (open[0] && !open[0].quoted) substitutions.push(...quotedSubstitutions(`"${body.join("\n").replace(/\\./g, "").replace(/"/g, "")}"`));
		body = [];
	};
	for (const line of command.split("\n")) {
		if (open.length > 0) {
			if ((open[0]!.tabs ? line.replace(/^\t+/, "") : line) === open[0]!.word) {
				scan();
				open.shift();
			} else body.push(line);
			continue;
		}
		out.push(line);
		// `<<<` is a here-string, not a heredoc.
		for (const m of line.matchAll(/(?<!<)<<(-?)[ \t]*(\\?)(['"]?)([\w.-]+)\3/g)) open.push({ word: m[4]!, tabs: m[1] === "-", quoted: m[2] !== "" || m[3] !== "" });
	}
	scan();
	return { text: out.join("\n"), substitutions };
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

/**
 * Each segment of `command`, started in `cwd`, with the folder it runs in: moves followed as the review gate follows
 * them (Subshells), a git call's `-C` included; undefined where the guard can't tell (any PowerShell command, a shell
 * string, `env -C`, git's `--git-dir`/`--work-tree` or `GIT_DIR`/`GIT_WORK_TREE`, a `-C` after a git word that isn't
 * the command). `move`: the segment only moves.
 */
export function segmentFolders(command: string, cwd: string, powershell = false): Array<{ raw: string[]; dir: string | undefined; move: boolean }> {
	const shell = new Subshells(cwd, command);
	// `export GIT_DIR=…` (or a bare assignment) moves every git call after it.
	let exported = false;
	const open = blankQuoted(command);
	return segmentsOf(tokenize(stripRedirects(command))).map(({ raw, alone, before }) => {
		shell.enter(raw, before);
		let dir = powershell || exported ? undefined : shell.dir;
		const words = raw.map((t) => unwrapToken(t.replace(/^\(+|\)+$/g, ""))).filter(Boolean);
		// A quoted word keeps its glob characters literal: the tokens lose the quotes, the blanked text still shows them.
		const literal = words.map((w) => !open.includes(w));
		if (hidesFolder(words, literal)) dir = undefined;
		const head = words[commandIndex(words)];
		if (words.some((w) => /^GIT_(DIR|WORK_TREE)=/.test(bare(w))) && (head === undefined || ["export", "declare", "typeset", "readonly"].includes(bare(head)))) exported = true;
		// git's own options come before its subcommand; `-C` (relative to the one before) and `-c` take a value.
		const at = commandIndex(words);
		// git as a bare word or a path from the root or `./` (as gitLike reads it): `tools/git` may be anything.
		const git = at !== -1 && commandName(words[at]!) === "git" && (!bare(words[at]!).includes("/") || /^(\/|\.\/)/.test(bare(words[at]!)));
		// Options compare without the mark; a marked folder value stays as written, so follow() refuses it.
		for (let i = at + 1; dir !== undefined && git && i < words.length && bare(words[i]!).startsWith("-"); i += bare(words[i]!) === "-C" || bare(words[i]!) === "-c" ? 2 : 1) {
			if (bare(words[i]!) === "-C") dir = follow(dir, words[i + 1]);
		}
		return { raw, dir, move: shell.move(raw, alone, before) !== undefined };
	});
}

/**
 * Words that run the segment, or a git call in it, somewhere the folder doesn't show. Programs (git, env, a shell) count
 * in any letter case, as macOS and Windows find them; `eval` is a builtin and only counts as written.
 */
function hidesFolder(marked: string[], literal: boolean[] = []): boolean {
	const words = marked.map(bare);
	const at = commandIndex(words);
	const git = (w: string) => commandName(w) === "git";
	return words.some((w, i) => {
		if (/^GIT_(DIR|WORK_TREE)=/.test(w) || w === "eval") return true;
		// `../$R`, `../a*`: a folder next to `..` that only the shell decides.
		if (!literal[i] && w.includes("..") && /[$`*?[{]/.test(w)) return true;
		if (/^(ba|z|da|k)?sh$/.test(commandName(w)) && words.slice(i + 1).some((a) => /^-[a-z]*c[a-z]*$/.test(a))) return true;
		if (commandName(w) === "env" && words.slice(i + 1).some((a) => a === "-C" || /^--chdir(=|$)/.test(a) || /^-[a-zA-Z]*C/.test(a))) return true;
		if (/^--(git-dir|work-tree)(=|$)/.test(w) && words.slice(0, i).some(git)) return true;
		// `-C` after a git word that isn't the command (`npm run x git -C a`): where it runs isn't where git would.
		return git(w) && i !== at && words.slice(i + 1).some((a) => a === "-C" || a.startsWith("--git-dir") || a.startsWith("--work-tree"));
	});
}
