import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ciCoverage } from "../extensions/lib/ci.ts";
import { resolveVerifyCommands } from "../extensions/lib/commands.ts";

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
		for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "packageManager", "engines", "devEngines", "overrides", "resolutions", "volta", "pnpm"]) {
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

test("pnpm-workspace.yaml pins no versions through catalogs or overrides", () => {
	const yaml = readFileSync(join(template, "pnpm-workspace.yaml"), "utf8").replace(/^\s*#.*$/gm, "");
	for (const key of ["catalog", "catalogs", "overrides"]) assert.doesNotMatch(yaml, new RegExp(`^${key}:`, "m"), key);
});

test("the template workflow reads the Node version from .nvmrc only", () => {
	const yaml = readFileSync(join(template, ".github", "workflows", "pr.yml"), "utf8").replace(/^\s*#.*$/gm, "");
	assert.doesNotMatch(yaml, /\bnode-version:/);
	assert.match(yaml, /node-version-file: \.nvmrc/);
});

test("kit-init verifies the scaffolded project with one turbo run, and its CI runs it", () => {
	const dir = mkdtempSync(join(tmpdir(), "tpl-verify-"));
	const manifest = ["CLAUDE.md", "AGENTS.md"].find((name) => existsSync(join(template, name))) as string;
	cpSync(join(template, manifest), join(dir, manifest));
	mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
	cpSync(join(template, ".github", "workflows", "pr.yml"), join(dir, ".github", "workflows", "pr.yml"));
	const { commands } = resolveVerifyCommands(dir);
	assert.deepEqual(commands, ["pnpm turbo run typecheck lint test"]);
	assert.deepEqual(ciCoverage(dir, commands).missing, []);
});

test("the Postgres version lives in .postgres-version at scaffold, and the template runs it through pnpm db:up", () => {
	assert.equal(existsSync(join(template, ".postgres-version")), false, "the template has no .postgres-version");
	const pkg = JSON.parse(readFileSync(join(template, "package.json"), "utf8"));
	assert.equal(pkg.scripts["db:up"], "POSTGRES_MAJOR=$(cat .postgres-version) docker compose up -d --wait postgres");
	assert.equal(pkg.scripts["db:down"], "POSTGRES_MAJOR=$(cat .postgres-version) docker compose down");
	assert.doesNotMatch(readFileSync(join(template, ".env.example"), "utf8"), /POSTGRES_MAJOR/);
	assert.match(readFileSync(join(template, "docker-compose.yml"), "utf8"), /\$\{POSTGRES_MAJOR:\?[^}]*\.postgres-version[^}]*pnpm db:up[^}]*\}/);
});

test("the template CI has a db job in the gate, with no literal Postgres image", () => {
	const yaml = readFileSync(join(template, ".github", "workflows", "pr.yml"), "utf8").replace(/^\s*#.*$/gm, "");
	assert.doesNotMatch(yaml, /postgres:\d/);
	const db = /^  db:\n([\s\S]*?)(?=^  \S|$(?![\s\S]))/m.exec(yaml)?.[1] ?? "";
	assert.match(db, /run: pnpm db:up/);
	assert.match(db, /migrate deploy/);
	assert.match(db, /migrate:down/);
	assert.match(yaml, /needs: \[[^\]]*\bdb\b[^\]]*\]/);
});
