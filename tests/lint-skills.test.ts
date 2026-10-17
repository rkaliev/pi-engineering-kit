import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const skillsDir = join(root, "skills");
const promptsDir = join(root, "prompts");
const MAX_BODY_WORDS = 800;
const MAX_DESCRIPTION = 400;

function frontmatter(text: string): { data: Record<string, string>; body: string } {
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	assert.ok(match, "missing YAML frontmatter");
	const data: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const kv = /^([\w-]+):\s*(.*)$/.exec(line);
		if (kv) data[kv[1]!] = kv[2]!.replace(/^"(.*)"$/, "$1");
	}
	return { data, body: match[2]! };
}

function relativeRefs(markdown: string): string[] {
	const refs = new Set<string>();
	// Backticked paths count as links only when they name a file (commands like `./gradlew` do not).
	for (const m of markdown.matchAll(/`((?:\.\.?\/|references\/|scripts\/)[^\s`{}<>*]+\.(?:md|sh|json|ts|js|py))`/g)) refs.add(m[1]!);
	for (const m of markdown.matchAll(/\]\(((?!https?:|#)[^)\s]+)\)/g)) refs.add(m[1]!);
	return [...refs];
}

const skills = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

test("there are skills to lint", () => {
	assert.ok(skills.length >= 20, `expected ≥ 20 skills, found ${skills.length}`);
});

for (const name of skills) {
	test(`skill ${name}: valid frontmatter, budget and links`, () => {
		const file = join(skillsDir, name, "SKILL.md");
		assert.ok(existsSync(file), "SKILL.md missing");
		const { data, body } = frontmatter(readFileSync(file, "utf8"));

		assert.equal(data.name, name, "name must equal the folder name");
		assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
		assert.ok(name.length <= 64);
		assert.ok(data.description, "description is required (pi skips skills without one)");
		assert.match(data.description!, /^Use (when|before|after)\b/, "description states triggers: 'Use when…'");
		assert.ok(data.description!.length <= MAX_DESCRIPTION, `description is ${data.description!.length} chars`);

		const words = body.split(/\s+/).filter(Boolean).length;
		assert.ok(words <= MAX_BODY_WORDS, `body is ${words} words; move reference material to references/`);

		const dir = join(skillsDir, name);
		const files = [file, ...(existsSync(join(dir, "references")) ? readdirSync(join(dir, "references")).map((f) => join(dir, "references", f)) : [])];
		for (const f of files) {
			const base = f === file ? dir : resolve(f, "..");
			for (const ref of relativeRefs(readFileSync(f, "utf8"))) {
				const target = ref.startsWith("references/") || ref.startsWith("scripts/") ? join(dir, ref) : resolve(base, ref);
				assert.ok(existsSync(target), `${f.slice(root.length + 1)} links to missing ${ref}`);
			}
		}
	});
}

const KEBAB = "[a-z0-9]+(?:-[a-z0-9]+)+";
const WORD = "[a-z0-9]+(?:-[a-z0-9]+)*";
/** Words that take a naming form without naming a skill: prose, tools, packages and lint rules. */
const ALLOWED_NAMES = [
	"append-only", "auto-detect", "cache-level", "content-heavy", "copy-pasted", "e-mail", "expect-expect", "feel-breaking",
	"getting-started", "gh-ost", "merge-base", "no-conditional-expect", "no-disabled-tests", "no-focused-tests", "node-version-file",
	"non-closing", "osv-scanner", "outside-in", "per-project", "personal-data", "pi-subagents", "pip-audit", "playwright-bdd",
	"pt-online-schema-change", "re-fetch", "re-run", "read-only", "schema-first", "server-rendered", "task-file", "transaction-scoped",
	"ts-monorepo", "type-only",
];
/** Agents a name may refer to: those pi-subagents provides, and the package itself ("`pi-subagents` agents"). */
const AGENT_NAMES = ["oracle", "reviewer", "scout", "worker", "pi-subagents"];

/** The leading name of each item in a span that may list several ("a, b and c", "a → b", "see a or b", "label: a", "a for b"). */
function listed(span: string): string[] {
	return span
		.split(/,|;|→|\s(?:and|or|then)\s/)
		.map((item) => item.replace(/^.*:\s/, "").replace(/["“”'`*]/g, " ").trim().replace(/^(?:(?:and|or|then|see|the)\s+)+/i, ""))
		.map((item) => /^([a-z0-9]+(?:-[a-z0-9]+)*)(?=[\s.)!?]|$)/.exec(item)?.[1])
		.filter((name): name is string => name !== undefined);
}

/**
 * Names in the forms the kit uses for a skill, agent or reference: "(a, b)", "(see a)", "**a**", "REQUIRED: a and b",
 * "see a or b", "the `a` skill", "a's", and (with `tables`) table cells such as "x → a → b".
 */
function namedIn(text: string, tables: boolean): string[] {
	const names: string[] = [];
	for (const m of text.matchAll(/\(([^()]{0,300})\)/g)) names.push(...listed(m[1]!));
	for (const m of text.matchAll(/\*\*`?([a-z0-9-]+)`?\*\*/g)) names.push(...listed(m[1]!));
	for (const m of text.matchAll(/REQUIRED:\s*([^.\n]*)/g)) names.push(...listed(m[1]!));
	for (const m of text.matchAll(/\b[Ss]ee ([^.;:()\n]*)/g)) names.push(...listed(m[1]!));
	for (const m of text.matchAll(new RegExp(`\`?\\b(${WORD})\`?(?:'s)? skills?\\b`, "g"))) names.push(m[1]!);
	for (const m of text.matchAll(new RegExp(`\`?\\b(${WORD})\`?'s\\b`, "g"))) names.push(m[1]!);
	if (tables) for (const line of text.split("\n")) if (line.startsWith("|") && !/^[|\s:-]+$/.test(line)) for (const cell of line.split("|")) names.push(...listed(cell));
	return [...new Set(names)];
}

/** Backticked names before "agent(s)": "`a` agent", "`a`, `b` and `c` agents". */
function agentsIn(text: string): string[] {
	return [...text.matchAll(/((?:`[\w-]+`(?:,\s*|\s+and\s+|\s+or\s+)?)+)\s+(?:sub)?agents?\b/g)].flatMap((m) => [...m[1]!.matchAll(/`([\w-]+)`/g)].map((n) => n[1]!));
}

function editDistance(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
		row = next;
	}
	return row[b.length]!;
}

test("name extraction finds every form", () => {
	const rows: [string, string[]][] = [
		["(see mobile-development)", ["mobile-development"]],
		["(outside-in, test-driven-development)", ["outside-in", "test-driven-development"]],
		["**writing-plans**", ["writing-plans"]],
		["REQUIRED: brainstorming and writing-plans.", ["brainstorming", "writing-plans"]],
		["(web-frontend,\n  payments-and-money or pos-systems)", ["web-frontend", "payments-and-money", "pos-systems"]],
		["See mobile-development and pos-systems.", ["mobile-development", "pos-systems"]],
		["the `writing-skills` skill", ["writing-skills"]],
		["by test-standard's rules", ["test-standard"]],
		["it quiets the `implementer`'s push", ["implementer"]],
		["| Bounded | Short design → test-driven-development → verify |", ["test-driven-development", "verify"]],
		["| Web code | the platform skill: web-frontend, mobile-development |", ["platform", "web-frontend", "mobile-development"]],
		['(\"REQUIRED: test-driven-development\")', ["test-driven-development"]],
		["(then web-frontend)", ["web-frontend"]],
		["(ui-motion for animation; the web-frontend references)", ["ui-motion", "web-frontend"]],
	];
	for (const [text, want] of rows) assert.deepEqual(namedIn(text, true), want, text);
	assert.deepEqual(agentsIn("a fresh `scout`, `worker` and `critic` agents"), ["scout", "worker", "critic"]);
});

/** What is wrong with the names in one file's text: a name that doesn't exist, an unknown agent, a near miss of a skill. */
function problemsIn(text: string, at: string, tables: boolean, known: Set<string>, agentNames: string[]): string[] {
	const near = (name: string) => (known.has(name) ? undefined : skills.find((s) => (s.includes("-") || s.length >= 8) && editDistance(name, s) <= 2));
	const problems: string[] = [];
	for (const name of namedIn(text, tables)) {
		// A hyphenated name must exist; a one-word one is usually prose, so only a near miss of a skill counts.
		if (name.includes("-") ? !known.has(name) : near(name)) problems.push(`${at}: no skill, prompt or reference "${name}"`);
	}
	for (const name of agentsIn(text)) if (!agentNames.includes(name)) problems.push(`${at}: no agent "${name}"`);
	// Anywhere in the text, a hyphenated word one or two edits from a skill is a typo or a stale name.
	for (const m of text.matchAll(new RegExp(`\\b${KEBAB}\\b`, "g"))) {
		const skill = near(m[0]);
		if (skill) problems.push(`${at}: "${m[0]}" looks like the skill ${skill}`);
	}
	return problems;
}

test("a wrong name is reported", () => {
	const known = new Set([...skills, ...ALLOWED_NAMES]);
	const found = (text: string) => problemsIn(text, "x.md", true, known, AGENT_NAMES);
	assert.deepEqual(found("(see writing-plan)"), ['x.md: no skill, prompt or reference "writing-plan"', 'x.md: "writing-plan" looks like the skill writing-plans']);
	assert.deepEqual(found("the brainstormng skill"), ['x.md: no skill, prompt or reference "brainstormng"']);
	assert.deepEqual(found("(see observabilty)"), ['x.md: no skill, prompt or reference "observabilty"']);
	assert.deepEqual(found("the `critic` agent"), ['x.md: no agent "critic"']);
	assert.deepEqual(found("(read-only, see writing-plans)"), []);
});

test("named skills and agents exist", () => {
	const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
	const stem = (file: string) => file.split(/[\\/]/).pop()!.replace(/\.\w+$/, "");
	const skillDocs = walk(skillsDir).filter((f) => f.endsWith(".md"));
	const promptDocs = readdirSync(promptsDir).filter((f) => f.endsWith(".md")).map((f) => join(promptsDir, f));
	const known = new Set([...skills, ...promptDocs.map(stem), ...skillDocs.map(stem), ...ALLOWED_NAMES]);
	const problems = [...skillDocs, ...promptDocs, join(root, "README.md")].flatMap((file) =>
		problemsIn(readFileSync(file, "utf8"), file.slice(root.length + 1), file.endsWith("SKILL.md"), known, AGENT_NAMES),
	);
	assert.deepEqual(problems, []);
});

for (const file of readdirSync(promptsDir).filter((f) => f.endsWith(".md"))) {
	test(`prompt ${file}: has description and names only existing skills`, () => {
		const { data, body } = frontmatter(readFileSync(join(promptsDir, file), "utf8"));
		assert.ok(data.description, "description is required");
		for (const m of body.matchAll(/skill[s]?[: ]+`?([a-z0-9-]+)`?/g)) {
			if (m[1]!.includes("-")) assert.ok(skills.includes(m[1]!), `unknown skill ${m[1]}`);
		}
	});
}
