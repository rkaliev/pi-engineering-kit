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

test("skill names mentioned in bold or as REQUIRED exist", () => {
	const known = new Set(skills);
	const suspicious: string[] = [];
	for (const name of skills) {
		const text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
		for (const m of text.matchAll(/\*\*([a-z]+(?:-[a-z]+){1,5})\*\*/g)) {
			if (!known.has(m[1]!) && /(ing|ment|review|workflow|code|money|systems|stack|agents|plans)$/.test(m[1]!)) suspicious.push(`${name}: ${m[1]}`);
		}
	}
	assert.deepEqual(suspicious, []);
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
