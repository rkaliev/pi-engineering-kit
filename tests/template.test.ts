import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const template = join(root, "templates", "ts-monorepo");
const profile = join(root, "skills", "choosing-a-stack", "references", "ts-fullstack-profile.md");

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		if (name === "node_modules") return [];
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

function requireTemplate(): void {
	assert.ok(existsSync(join(template, "scaffold.json")), "templates/ts-monorepo/scaffold.json is missing");
}

test("template package.json files hold no versions", () => {
	requireTemplate();
	const files = walk(template).filter((f) => f.endsWith("package.json"));
	assert.ok(files.length >= 7, "expected a package.json in the root and every workspace");
	for (const file of files) {
		const pkg = JSON.parse(readFileSync(file, "utf8"));
		for (const key of ["dependencies", "devDependencies", "peerDependencies", "packageManager", "engines"]) {
			assert.equal(key in pkg, false, `${relative(template, file)} has "${key}"`);
		}
	}
});

test("scaffold.json names existing workspaces and bare packages", () => {
	requireTemplate();
	const scaffold = JSON.parse(readFileSync(join(template, "scaffold.json"), "utf8")) as Record<
		string,
		{ dependencies?: string[]; devDependencies?: string[] }
	>;
	const name = /^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/;
	assert.ok(Object.keys(scaffold).length > 0);
	for (const [dir, lists] of Object.entries(scaffold)) {
		assert.ok(existsSync(join(template, dir, "package.json")), `${dir} has no package.json`);
		for (const pkg of [...(lists.dependencies ?? []), ...(lists.devDependencies ?? [])]) {
			assert.match(pkg, name, `${dir}: "${pkg}" is not a bare package name`);
		}
	}
});

test("workflow actions are pinned at scaffold", () => {
	requireTemplate();
	const workflows = walk(join(template, ".github", "workflows"));
	assert.ok(workflows.length > 0);
	for (const file of workflows) {
		const uses = readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => !line.trim().startsWith("#"))
			.map((line) => /\buses:\s*(\S+)/.exec(line)?.[1])
			.filter((v): v is string => v !== undefined && !v.startsWith("./"));
		assert.ok(uses.length > 0);
		for (const action of uses) assert.ok(action.endsWith("@<sha>"), `${action} is not pinned as @<sha>`);
	}
});

test("the profile states no versions", () => {
	assert.doesNotMatch(readFileSync(profile, "utf8"), /\b\d+\.\d+(\.\d+)?\b/);
});
