/**
 * Stack-independent test hygiene check: focused tests, skips without a reason, sleeps, retries,
 * JUnit report sanity and success-criterion to scenario tags. One self-contained file with no
 * imports from the repo, so it can be copied verbatim into any project and run in its CI.
 *
 *   node test-hygiene.ts [--all] [--base <ref>] [--junit <file-or-dir> ...] [--config <path>]
 *
 * Default (PR mode) is a ratchet: only violations on lines added since the merge-base with the
 * base branch fail the run; older ones are only counted as "pre-existing". --all checks every line
 * of every tracked file. JUnit and criterion-tag checks are never ratcheted.
 *
 * A line opts out with an inline comment `test-hygiene: allow <reason>`; an allow without a reason
 * is itself a violation. Config (.claude/test-hygiene.json, else .pi/test-hygiene.json, or
 * --config): { "testFiles": [glob], "ignore": [glob], "patterns": [{ id, files, regex, message }] }.
 * Exit 0: no new violation, 1: violations, 2: usage, config or git error.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "1";

export type Violation = { path: string; line: number; rule: string; message: string };
export type Pattern = { id: string; files: string; regex: string; message: string };
export type Config = { testFiles: string[]; ignore: string[]; patterns: Pattern[] };

/** Bad usage, bad config or a git failure: exit code 2. */
export class UsageError extends Error {}

const EMPTY_CONFIG: Config = { testFiles: [], ignore: [], patterns: [] };

// ---------------------------------------------------------------- globs

/** Minimal glob to RegExp: `**` spans directories, `*` and `?` stay in a segment, `{a,b}` alternates. */
export function globToRegExp(glob: string): RegExp {
	const g = glob;
	let out = "";
	let depth = 0;
	for (let i = 0; i < g.length; i++) {
		const ch = g[i];
		if (ch === "*" && g[i + 1] === "*") {
			if (g[i + 2] === "/") {
				out += "(?:.*/)?";
				i += 2;
			} else {
				out += ".*";
				i += 1;
			}
		} else if (ch === "*") out += "[^/]*";
		else if (ch === "?") out += "[^/]";
		else if (ch === "{") {
			out += "(?:";
			depth++;
		} else if (ch === "}" && depth > 0) {
			out += ")";
			depth--;
		} else if (ch === "," && depth > 0) out += "|";
		else out += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

const matchesAny = (path: string, globs: RegExp[]): boolean => globs.some((g) => g.test(path));

const DEFAULT_TEST_GLOBS = [
	"**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}",
	"**/__tests__/**",
	"**/test_*.py",
	"**/*_test.py",
	"**/tests/**/*.py",
	"**/conftest.py",
	"**/src/test/**/*.{java,kt,kts}",
	"**/src/androidTest/**",
	"**/*Test.{java,kt}",
	"**/*_test.go",
	"**/*Tests.swift",
	"**/*Tests/**/*.swift",
	"**/*Tests/**/*.cs",
	"**/*.Tests/**/*.cs",
	"**/*Test*.cs",
	"**/*.feature",
].map(globToRegExp);

/** True for a path matching the default test globs or the config's `testFiles`. */
export function isTestFile(path: string, extra: string[] = []): boolean {
	return matchesAny(path, DEFAULT_TEST_GLOBS) || matchesAny(path, extra.map(globToRegExp));
}

// ---------------------------------------------------------------- rules

type Lang = "js" | "py" | "jvm" | "go" | "swift" | "cs" | "feature";

const LANG_BY_EXT: Record<string, Lang> = {
	js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js",
	py: "py",
	java: "jvm", kt: "jvm", kts: "jvm",
	go: "go",
	swift: "swift",
	cs: "cs",
	feature: "feature",
};

function langOf(path: string): Lang | undefined {
	const ext = /\.([A-Za-z]+)$/.exec(path)?.[1];
	return ext ? LANG_BY_EXT[ext] : undefined;
}

/** A per-line rule on test files. `issue`: a nearby issue reference excuses the line. `context`: must also match the previous line joined with this one. */
type LineRule = { id: string; langs: Lang[]; re: RegExp; message: string; issue?: boolean; context?: RegExp };

const FOCUSED = "focused test: nothing else in the suite runs; remove it";
const SKIPPED = "skipped test without a reason: add an issue reference (#123, URL or ABC-123) on this line or the line above, or delete the test";
const SLEEP = "fixed sleep in a test: wait for a condition or event instead";

/** The JS test API with its modifiers: `it`, `test.concurrent`, `describe.each`, ... */
const JS_API = String.raw`(?<![\w.$])(?:it|test|describe|context|suite|bench)(?:\.(?:concurrent|each|sequential|only|skip|todo|skipIf|runIf))*`;

const LINE_RULES: LineRule[] = [
	{ id: "focused", langs: ["js"], re: new RegExp(String.raw`${JS_API}\.only\b(?=\s*[(.<])|(?<![\w.$])(?:fit|fdescribe)\(`), message: FOCUSED },
	{ id: "focused", langs: ["feature"], re: /(?:^|\s)@(?:only|focus)\b/, message: FOCUSED },

	{ id: "skip-without-reason", langs: ["js"], re: new RegExp(String.raw`${JS_API}\.(?:skip|todo)\b(?=\s*[(.<])|(?<![\w.$])(?:xit|xdescribe|xtest)\(`), message: SKIPPED, issue: true },
	{ id: "skip-without-reason", langs: ["py"], re: /@pytest\.mark\.skip\b(?!\s*\((?:[^)]*reason\s*=|\s*$))|\bpytest\.skip\(\s*\)/, message: SKIPPED, issue: true },
	{ id: "skip-without-reason", langs: ["jvm"], re: /@(?:Disabled|Ignore)\b(?!\s*\(\s*(?:value\s*=\s*)?"[^"])/, message: SKIPPED, issue: true },
	{ id: "skip-without-reason", langs: ["go"], re: /\bt\.Skip(?:Now)?\(\s*\)/, message: SKIPPED, issue: true },
	{ id: "skip-without-reason", langs: ["swift"], re: /XCTSkip(?:(?:If|Unless)\((?![^\n]*,\s*")|\(\s*\))/, message: SKIPPED, issue: true },
	{ id: "skip-without-reason", langs: ["cs"], re: /\bSkip\s*=\s*""|\[Ignore(?:\(\s*\))?\]|\[(?:Fact|Theory)\(\s*Skip\b(?!\s*=\s*"[^"])/, message: SKIPPED, issue: true },
	{ id: "skip-without-reason", langs: ["feature"], re: /(?:^|\s)@(?:skip|wip|ignore)\b/, message: SKIPPED, issue: true },

	{ id: "sleep", langs: ["js"], re: /\bwaitForTimeout\(|\bcy\.wait\(\d|(?<!(?:[Ss]kipping|[Ff]ake|[Mm]ock|[Cc]lock)\w*\.)\bsleep\(\s*[^\s)]/, message: SLEEP },
	{ id: "sleep", langs: ["js"], re: /\bsetTimeout\(\s*(?:resolve|res\w*|r\s*[,)]|\(\s*\)\s*=>\s*(?:\{\s*)?res)/, context: /new Promise/, message: SLEEP },
	{ id: "sleep", langs: ["py"], re: /\bsleep\(/, message: SLEEP },
	{ id: "sleep", langs: ["jvm"], re: /\bThread\.sleep\(/, message: SLEEP },
	{ id: "sleep", langs: ["go"], re: /\btime\.Sleep\(/, message: SLEEP },
	{ id: "sleep", langs: ["swift"], re: /\bu?sleep\(|\bThread\.sleep\b/, message: SLEEP },
	{ id: "sleep", langs: ["cs"], re: /\bTask\.Delay\(|\bThread\.Sleep\(/, message: SLEEP },
];

/** Retry settings in config files, matched on the file's base name; `lang` instead matches every file of that language. */
type RetryRule = { file?: RegExp; lang?: Lang; re: RegExp };

const RETRIES = "retries hide flaky tests: fix the test instead of rerunning it";

const RETRY_RULES: RetryRule[] = [
	{ file: /^playwright\.config\./, re: /\bretries\s*:[^,}\n/]*?(?<![\w.$])[1-9]\d*(?![\w.])/ },
	{ file: /^(?:cypress\.config\..+|cypress\.json)$/, re: /"?\bretries"?\s*:\s*(?:\{|[1-9])/ },
	{ lang: "js", re: /\bjest\.retryTimes\(/ },
	{ file: /^(?:vitest|vite)\.config\./, re: /\bretry\s*:\s*[1-9]/ },
	{ file: /^(?:pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|requirements.*\.txt)$/, re: /--reruns(?![ =]0\b)|pytest-rerunfailures|\bflaky\b/ },
	{ file: /\.gradle(?:\.kts)?$/, re: /org\.gradle\.test-retry|\bretry\s*\{/ },
	{ file: /\.ya?ml$|^Makefile$/, re: /--rerun-fails\b/ },
	{ file: /\.ya?ml$|\.xcconfig$/, re: /-retry-tests-on-failure|-test-iterations\b.*retry|retry.*-test-iterations\b/ },
];

const ISSUE_REF = /#\d+|https?:\/\/|\b[A-Z][A-Z0-9]+-\d+/;

/** `test-hygiene: allow <reason>` on a line: undefined when absent, "" when the reason is empty. */
function allowReason(line: string): string | undefined {
	const m = /test-hygiene:\s*allow\b(.*)$/.exec(line);
	if (!m) return undefined;
	return m[1].replace(/\*\/|-->|--%>|}}/g, "").trim();
}

function retryRulesFor(path: string): RetryRule[] {
	const name = basename(path);
	const lang = langOf(path);
	return RETRY_RULES.filter((r) => (r.file ? r.file.test(name) : r.lang === lang));
}

/** How a file marks comments and strings; `#` comments need a space before them (YAML, URLs), strings are only scanned in real languages. */
type Style = { comment: "//" | "#" | "none"; strings: boolean };

function styleOf(path: string): Style {
	const lang = langOf(path);
	if (lang === "py") return { comment: "#", strings: true };
	if (lang === "feature") return { comment: "#", strings: false };
	if (lang) return { comment: "//", strings: true };
	const name = basename(path);
	if (/\.gradle$/.test(name)) return { comment: "//", strings: true };
	if (/\.xcconfig$/.test(name)) return { comment: "//", strings: false };
	if (/\.json$/.test(name)) return { comment: "none", strings: false };
	return { comment: "#", strings: false };
}

/** Per-line view: where a comment starts and which characters sit inside a string literal. */
function mask(line: string, style: Style): { comment: number; inString: boolean[] } {
	const inString: boolean[] = new Array(line.length).fill(false);
	const trimmed = line.trimStart();
	const lead = line.length - trimmed.length;
	if (style.comment === "//" && /^(?:\/\/|\/\*|\*)/.test(trimmed)) return { comment: lead, inString };
	if (style.comment === "#" && trimmed.startsWith("#")) return { comment: lead, inString };
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			inString[i] = true;
			if (ch === "\\") {
				if (i + 1 < line.length) inString[++i] = true;
			} else if (ch === quote) quote = "";
			continue;
		}
		if (style.comment === "//" && (line.startsWith("//", i) || line.startsWith("/*", i))) return { comment: i, inString };
		if (style.comment === "#" && ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return { comment: i, inString };
		if (style.strings && (ch === '"' || ch === "'" || ch === "`")) {
			quote = ch;
			inString[i] = true;
		}
	}
	return { comment: line.length, inString };
}

/** A line that opens an `if` / `else` branch or is a one-line guard (`if (x) return;`). */
const GUARD = /^\s*(?:\}\s*)?(?:if|else)\b/;

const LOOP = /(?<![\w.$])(?:while|for|loop|repeat)\b|\bdo\s*\{/;

/** Scan one file's text. Which rules apply depends on the path; returns [] for files no rule looks at. */
export function scanText(path: string, text: string, config: Config = EMPTY_CONFIG): Violation[] {
	const lang = langOf(path);
	const lineRules = lang && isTestFile(path, config.testFiles) ? LINE_RULES.filter((r) => r.langs.includes(lang)) : [];
	const retryRules = retryRulesFor(path);
	const custom = config.patterns.filter((p) => globToRegExp(p.files).test(path)).map((p) => ({ ...p, re: new RegExp(p.regex) }));
	if (!lineRules.length && !retryRules.length && !custom.length) return [];

	const style = styleOf(path);
	const out: Violation[] = [];
	const lines = text.split(/\r?\n/);
	// code view of each line: comment cut off, string contents blanked (for loop detection)
	const views = lines.map((l) => mask(l, style));
	const bare = lines.map((l, i) => [...l.slice(0, views[i].comment)].map((ch, k) => (views[i].inString[k] ? " " : ch)).join(""));
	/** Does `re` match line `i` at a position that is real code (outside strings and comments)? */
	const hit = (re: RegExp, i: number, strings = false): RegExpMatchArray | undefined => {
		const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
		for (const m of lines[i].matchAll(g)) {
			if (m.index < views[i].comment && (strings || !views[i].inString[m.index])) return m;
		}
		return undefined;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const prev = i > 0 ? lines[i - 1] : "";
		const add = (rule: string, message: string) => {
			if (!out.some((v) => v.line === i + 1 && v.rule === rule)) out.push({ path, line: i + 1, rule, message });
		};
		const allow = allowReason(line);
		if (allow === "") add("allow-without-reason", "`test-hygiene: allow` needs a reason after it");
		if (allow) continue;
		for (const r of lineRules) {
			const m = hit(r.re, i);
			if (!m) continue;
			if (r.context && !r.context.test(`${prev}\n${line}`)) continue;
			if (r.issue && (ISSUE_REF.test(line) || ISSUE_REF.test(prev))) continue;
			if (r.id === "sleep") {
				// polling is a condition wait: a loop opens in the 4 lines above, or an `if` guards the sleep
				const loop = bare.slice(Math.max(0, i - 4), i).some((l) => LOOP.test(l));
				const guarded = /(?<![\w.$])if\b/.test(bare[i].slice(0, m.index)) || (i > 0 && GUARD.test(bare[i - 1]));
				if (loop || guarded || LOOP.test(bare[i].slice(0, m.index))) continue;
			}
			add(r.id, r.message);
		}
		if (retryRules.some((r) => hit(r.re, i, true))) add("retries", RETRIES);
		for (const p of custom) if (p.re.test(line)) add(p.id, p.message);
	}
	return out;
}

// ---------------------------------------------------------------- JUnit

const ATTRS = /([\w:.-]+)="([^"]*)"/g;

function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of tag.matchAll(ATTRS)) out[m[1]] = m[2];
	return out;
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length;

type JunitTotals = { tests: number; failures: number; errors: number; skipped: number; cases: number };

/** Check one JUnit XML text (regex based, no XML parser). Totals come back for aggregate checks. */
export function checkJunitText(path: string, text: string): { violations: Violation[]; totals: JunitTotals } {
	const violations: Violation[] = [];
	const sum = (tag: RegExp) => {
		const t = { tests: 0, failures: 0, errors: 0, skipped: 0 };
		let found = false;
		for (const m of text.matchAll(tag)) {
			found = true;
			const a = attrs(m[0]);
			for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += Number(a[k] ?? 0) || 0;
		}
		return found ? t : undefined;
	};
	const declared = sum(/<testsuite\b[^>]*>/g) ?? sum(/<testsuites\b[^>]*>/g) ?? { tests: 0, failures: 0, errors: 0, skipped: 0 };
	let cases = 0;
	for (const m of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
		cases++;
		const skipped = m[2] === undefined ? null : /<skipped\b([^>]*?)(?:\/>|>([\s\S]*?)<\/skipped>)/.exec(m[2]);
		if (!skipped) continue;
		const message = (attrs(skipped[1]).message ?? "").trim();
		const body = (skipped[2] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
		if (!message && !body) {
			violations.push({ path, line: lineAt(text, m.index), rule: "junit-skip-without-reason", message: "skipped test case has no message or text" });
		}
	}
	if (declared.tests !== cases) {
		violations.push({ path, line: 1, rule: "junit-mismatch", message: `declares ${declared.tests} tests but contains ${cases} test cases (crashed shard?)` });
	}
	return { violations, totals: { ...declared, cases } };
}

function xmlFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = resolve(dir, e.name);
		if (e.isDirectory()) out.push(...xmlFiles(p));
		else if (e.name.endsWith(".xml")) out.push(p);
	}
	return out.sort();
}

/** Check JUnit reports given as files or directories (searched recursively for *.xml). */
export function checkJunit(inputs: string[], cwd: string, root: string): Violation[] {
	const shown = (p: string) => relative(root, p) || p;
	const out: Violation[] = [];
	const files: string[] = [];
	for (const input of inputs) {
		const abs = resolve(cwd, input);
		if (!existsSync(abs)) continue;
		if (statSync(abs).isDirectory()) files.push(...xmlFiles(abs));
		else files.push(abs);
	}
	if (!files.length) {
		return [{ path: inputs.join(","), line: 1, rule: "junit-missing", message: "no JUnit XML report found: the test run produced nothing" }];
	}
	let cases = 0;
	for (const f of files) {
		const r = checkJunitText(shown(f), readFileSync(f, "utf8"));
		out.push(...r.violations);
		cases += r.totals.cases;
	}
	if (cases === 0) out.push({ path: shown(files[0]), line: 1, rule: "junit-empty", message: "reports contain 0 test cases" });
	return out;
}

// ---------------------------------------------------------------- criterion tags

type Source = { path: string; text: string };
type Criterion = { n: number; path: string; line: number; scenario: boolean };

const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/** Criteria from the first markdown table whose header row has a `Criterion` column. */
function parseCriteria(file: Source): Criterion[] {
	const lines = file.text.split(/\r?\n/);
	const start = lines.findIndex((l) => l.trim().startsWith("|") && /criterion/i.test(l));
	if (start < 0) return [];
	const out: Criterion[] = [];
	for (let i = start + 1; i < lines.length && lines[i].trim().startsWith("|"); i++) {
		const [num, , how = ""] = cells(lines[i]);
		if (!/^\d+$/.test(num ?? "")) continue;
		const n = Number(num);
		out.push({ n, path: file.path, line: i + 1, scenario: /scenario/i.test(how) || new RegExp(`@C${n}\\b`).test(how) });
	}
	return out;
}

/** Cross-check `@C<n>` scenario tags in .feature files against the success-criteria tables in task files. */
export function checkCriteria(tasks: Source[], features: Source[]): Violation[] {
	const criteria = tasks.flatMap(parseCriteria);
	const known = new Set(criteria.map((c) => c.n));
	const tags = new Map<number, { path: string; line: number }[]>();
	for (const f of features) {
		const lines = f.text.split(/\r?\n/);
		let pending: { n: number; line: number }[] = [];
		for (let i = 0; i < lines.length; i++) {
			const t = lines[i].trim();
			if (/^@/.test(t)) {
				for (const m of t.matchAll(/@C(\d+)\b/g)) pending.push({ n: Number(m[1]), line: i + 1 });
			} else if (/^(?:Feature|Scenario|Scenario Outline|Scenario Template|Example):/.test(t)) {
				for (const p of pending) tags.set(p.n, [...(tags.get(p.n) ?? []), { path: f.path, line: p.line }]);
				pending = [];
			} else if (t && !t.startsWith("#")) pending = [];
		}
	}
	const out: Violation[] = [];
	for (const c of criteria) {
		if (c.scenario && !tags.has(c.n)) {
			out.push({ path: c.path, line: c.line, rule: "criterion-without-scenario", message: `criterion ${c.n} is scenario-verified but no scenario is tagged @C${c.n}` });
		}
	}
	for (const [n, where] of tags) {
		if (!known.has(n)) {
			for (const w of where) out.push({ ...w, rule: "tag-without-criterion", message: `@C${n} matches no criterion in docs/tasks/*.md` });
		} else if (where.length > 1) {
			out.push({ ...where[1], rule: "criterion-many-scenarios", message: `criterion ${n} has ${where.length} tagged scenarios; one criterion maps to one scenario` });
		}
	}
	return out;
}

// ---------------------------------------------------------------- git

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
	const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
	return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr || r.error?.message || "").trim() };
}

/** Added line numbers per file from `git diff -U0` output. */
export function parseDiff(diff: string): Map<string, Set<number>> {
	const added = new Map<string, Set<number>>();
	let file: string | null = null;
	let remaining = 0;
	let next = 0;
	for (const line of diff.split("\n")) {
		if (remaining > 0) {
			remaining--;
			if (line.startsWith("+") && file) added.get(file)?.add(next++);
			continue;
		}
		if (line.startsWith("+++ ")) {
			const p = line.slice(4).replace(/\t.*$/, "");
			file = p === "/dev/null" ? null : p.replace(/^b\//, "");
			if (file && !added.has(file)) added.set(file, new Set());
			continue;
		}
		const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (h) {
			const oldCount = h[1] === undefined ? 1 : Number(h[1]);
			const newCount = h[3] === undefined ? 1 : Number(h[3]);
			next = Number(h[2]);
			remaining = oldCount + newCount;
		}
	}
	return added;
}

/** The commit PR mode diffs against: --base or origin/HEAD, else main, else master; merge-base with HEAD when there is one. */
function resolveBase(root: string, base: string | undefined): string {
	const candidates = base ? [base] : ["origin/HEAD", "main", "master"];
	for (const ref of candidates) {
		if (!git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok) continue;
		const mb = git(root, ["merge-base", "HEAD", ref]);
		return mb.ok && mb.out.trim() ? mb.out.trim() : ref;
	}
	throw new UsageError(base ? `base ref not found: ${base}` : "no base to compare with: pass --base <ref> (looked for origin/HEAD, main, master)");
}

// ---------------------------------------------------------------- config

/** Parse and validate config JSON; throws UsageError naming the source. */
export function parseConfig(text: string, source: string): Config {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		throw new UsageError(`${source}: invalid JSON: ${(e as Error).message}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError(`${source}: expected a JSON object`);
	const o = raw as Record<string, unknown>;
	const strings = (key: string): string[] => {
		const v = o[key] ?? [];
		if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) throw new UsageError(`${source}: "${key}" must be an array of strings`);
		return v as string[];
	};
	const patternsRaw = o.patterns ?? [];
	if (!Array.isArray(patternsRaw)) throw new UsageError(`${source}: "patterns" must be an array`);
	const patterns = patternsRaw.map((p: unknown, i): Pattern => {
		const q = (p ?? {}) as Record<string, unknown>;
		for (const k of ["id", "files", "regex", "message"]) {
			if (typeof q[k] !== "string" || !q[k]) throw new UsageError(`${source}: patterns[${i}].${k} must be a non-empty string`);
		}
		try {
			new RegExp(q.regex as string);
		} catch (e) {
			throw new UsageError(`${source}: patterns[${i}] has an invalid regex: ${(e as Error).message}`);
		}
		return { id: q.id as string, files: q.files as string, regex: q.regex as string, message: q.message as string };
	});
	return { testFiles: strings("testFiles"), ignore: strings("ignore"), patterns };
}

function loadConfig(root: string, cwd: string, explicit: string | undefined): Config {
	if (explicit) {
		const p = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
		if (!existsSync(p)) throw new UsageError(`config not found: ${explicit}`);
		return parseConfig(readFileSync(p, "utf8"), explicit);
	}
	for (const rel of [".claude/test-hygiene.json", ".pi/test-hygiene.json"]) {
		const p = resolve(root, rel);
		if (existsSync(p)) return parseConfig(readFileSync(p, "utf8"), rel);
	}
	return EMPTY_CONFIG;
}

// ---------------------------------------------------------------- run

type Options = { all: boolean; base?: string; junit: string[]; config?: string; help: boolean };

const USAGE = "usage: node test-hygiene.ts [--all] [--base <ref>] [--junit <file-or-dir> ...] [--config <path>]";

function parseArgs(argv: string[]): Options {
	const o: Options = { all: false, junit: [], help: false };
	for (let i = 0; i < argv.length; i++) {
		const [flag, inline] = argv[i].startsWith("--") && argv[i].includes("=") ? [argv[i].slice(0, argv[i].indexOf("=")), argv[i].slice(argv[i].indexOf("=") + 1)] : [argv[i], undefined];
		const value = (): string => {
			const v = inline ?? argv[++i];
			if (!v) throw new UsageError(`${flag} needs a value\n${USAGE}`);
			return v;
		};
		if (flag === "--all") o.all = true;
		else if (flag === "--base") o.base = value();
		else if (flag === "--config") o.config = value();
		else if (flag === "--junit") {
			o.junit.push(value());
			while (inline === undefined && i + 1 < argv.length && !argv[i + 1].startsWith("--")) o.junit.push(argv[++i]);
		} else if (flag === "--help" || flag === "-h") o.help = true;
		else throw new UsageError(`unknown argument: ${argv[i]}\n${USAGE}`);
	}
	return o;
}

/** Read a tracked file as text; undefined when missing, large or binary. */
function readText(abs: string): string | undefined {
	try {
		if (statSync(abs).size > 2 * 1024 * 1024) return undefined;
		const text = readFileSync(abs, "utf8");
		return text.includes("\0") ? undefined : text;
	} catch {
		return undefined;
	}
}

/** Run the checker from `cwd`; returns the exit code and writes the report through `out` / `err`. */
export function run(argv: string[], cwd: string, out: (s: string) => void, err: (s: string) => void): number {
	try {
		const o = parseArgs(argv);
		if (o.help) {
			out(`${USAGE}\n`);
			return 0;
		}
		const top = git(cwd, ["rev-parse", "--show-toplevel"]);
		if (!top.ok) throw new UsageError(`not a git repository: ${top.err}`);
		const root = top.out.trim();
		const config = loadConfig(root, cwd, o.config);
		const ignore = config.ignore.map(globToRegExp);

		const added = o.all ? undefined : parseDiffFor(root, o.base);
		const ls = git(root, ["ls-files", "-z"]);
		if (!ls.ok) throw new UsageError(`git ls-files failed: ${ls.err}`);
		const tracked = ls.out.split("\0").filter((p) => p && !matchesAny(p, ignore));

		const found: Violation[] = [];
		for (const path of tracked) {
			const text = readText(resolve(root, path));
			if (text !== undefined) found.push(...scanText(path, text, config));
		}
		const counted = added ? found.filter((v) => added.get(v.path)?.has(v.line)) : found;
		const preExisting = found.length - counted.length;

		const extra: Violation[] = [];
		if (o.junit.length) extra.push(...checkJunit(o.junit, cwd, root));
		const features = tracked.filter((p) => p.endsWith(".feature"));
		const tasks = tracked.filter((p) => /^docs\/tasks\/[^/]+\.md$/.test(p));
		if (features.length && tasks.length) {
			const load = (p: string): Source => ({ path: p, text: readText(resolve(root, p)) ?? "" });
			extra.push(...checkCriteria(tasks.map(load), features.map(load)));
		}

		const all = [...counted, ...extra].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
		for (const v of all) out(`${v.path}:${v.line}  ${v.rule}  ${v.message}\n`);
		const noun = all.length === 1 ? "violation" : "violations";
		out(`test-hygiene: ${all.length} ${added ? "new " : ""}${noun}${added ? `, pre-existing: ${preExisting}` : ""}\n`);
		return all.length ? 1 : 0;
	} catch (e) {
		if (e instanceof UsageError) {
			err(`test-hygiene: ${e.message}\n`);
			return 2;
		}
		throw e;
	}
}

function parseDiffFor(root: string, base: string | undefined): Map<string, Set<number>> {
	const ref = resolveBase(root, base);
	const d = git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", ref, "HEAD"]);
	if (!d.ok) throw new UsageError(`git diff failed: ${d.err}`);
	return parseDiff(d.out);
}

function isMain(): boolean {
	try {
		return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isMain()) {
	process.exitCode = run(process.argv.slice(2), process.cwd(), (s) => process.stdout.write(s), (s) => process.stderr.write(s));
}
