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
/** The forms the kit uses to name a skill: "(name)", "(name, …)", "**name**", "REQUIRED: name", "name skill". */
const NAMED_FORMS = [`\\((${KEBAB})[,)]`, `\\*\\*(${KEBAB})\\*\\*`, `REQUIRED:\\s*\\**(${KEBAB})`, `\\b(${KEBAB})(?:'s)? skill\\b`].map((p) => new RegExp(p, "g"));
/** Words that take those forms without naming a skill: prose and outside tools. */
const ALLOWED_NAMES = ["gh-ost", "non-closing", "outside-in", "pi-subagents", "playwright-bdd", "server-rendered"];
/** Agents that pi-subagents provides. */
const BUILTIN_AGENTS = ["oracle", "reviewer", "scout", "worker"];

function editDistance(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
		row = next;
	}
	return row[b.length]!;
}

test("named skills and agents exist", () => {
	const md = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)) : []);
	const stem = (file: string) => file.split(/[\\/]/).pop()!.replace(/\.\w+$/, "");
	const references = skills.flatMap((s) => md(join(skillsDir, s, "references")));
	const prompts = md(promptsDir);
	const known = new Set([...skills, ...prompts.map(stem), ...references.map(stem), ...ALLOWED_NAMES]);
	const files = [...skills.map((s) => join(skillsDir, s, "SKILL.md")), ...references, ...prompts, join(root, "README.md")];

	const problems: string[] = [];
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		const at = file.slice(root.length + 1);
		for (const form of NAMED_FORMS) for (const m of text.matchAll(form)) if (!known.has(m[1]!)) problems.push(`${at}: no skill, prompt or reference "${m[1]}"`);
		for (const m of text.matchAll(/`([A-Za-z][\w-]*)`(?: and `([\w-]+)`)? (?:sub)?agents?\b/g)) {
			for (const name of [m[1], m[2]]) if (name && !BUILTIN_AGENTS.includes(name) && !ALLOWED_NAMES.includes(name)) problems.push(`${at}: no agent "${name}"`);
		}
		// Anywhere in the text, a name one or two edits from a skill is a typo or a stale name.
		for (const m of text.matchAll(new RegExp(`\\b${KEBAB}\\b`, "g"))) {
			const near = known.has(m[0]) ? undefined : skills.find((s) => editDistance(m[0], s) <= 2);
			if (near) problems.push(`${at}: "${m[0]}" looks like the skill ${near}`);
		}
	}
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
