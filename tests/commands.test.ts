import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { commandMatches, owedCommands, parseAgentsCommands, resolveVerifyCommands, resolveVerifyPaths } from "../extensions/lib/commands.ts";

/** Temp folders the `paths` tests make, removed when the file's tests end. */
const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

test("parses verification commands from an AGENTS.md Commands section", () => {
	const md = `# App

## Структура
- src/lib — logic

## Команды
- npm test — тесты (vitest run)
- npm run typecheck — проверка типов (tsc --noEmit)
- npm run dev — dev-сервер. Не запускай: он уже открыт

## Правила
- npm run lint is not in the commands section
`;
	assert.deepEqual(parseAgentsCommands(md), ["npm test", "npm run typecheck"]);
});

test("prefers backticked commands and skips long-running ones", () => {
	const md = `## Commands
- Test: \`pnpm vitest run\`
- Lint: \`pnpm lint\`
- Build: \`./gradlew assembleDebug\`
- Serve: \`pnpm start\`
- \`cargo watch -x test\`
`;
	assert.deepEqual(parseAgentsCommands(md), ["pnpm vitest run", "pnpm lint", "./gradlew assembleDebug"]);
});

test("returns nothing when there is no commands section", () => {
	assert.deepEqual(parseAgentsCommands("# Title\n\n- npm test\n"), []);
});

test(".pi/verify.json wins over AGENTS.md", () => {
	const dir = mkdtempSync(join(tmpdir(), "verify-"));
	writeFileSync(join(dir, "AGENTS.md"), "## Commands\n- `npm test`\n");
	assert.deepEqual(resolveVerifyCommands(dir), { commands: ["npm test"], source: "AGENTS.md" });

	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "verify.json"), JSON.stringify({ commands: ["make check"] }));
	assert.deepEqual(resolveVerifyCommands(dir), { commands: ["make check"], source: ".pi/verify.json" });
});

test("a bash call proves a verification command only when it runs it exactly and keeps its exit code", () => {
	assert.equal(commandMatches("npm test > out.log 2>&1", "npm test"), true);
	assert.equal(commandMatches("npm test 2>&1 | tail -20", "npm test"), false, "a pipe hides the exit code");
	assert.equal(commandMatches("npm $'test\\0'x", "npm test"), false, "bash runs npm testx");
	assert.equal(commandMatches("npm test && npm run typecheck", "npm run typecheck"), true);
	assert.equal(commandMatches("cd packages/app && npm run typecheck", "npm run typecheck"), false, "another directory proves nothing here");
	assert.equal(commandMatches("npm test -- --grep x", "npm test"), false, "filtered runs do not prove the suite");
	assert.equal(commandMatches("echo npm test", "npm test"), false);
});

test("without configured commands they are detected from the project's manifests; configured ones still win", () => {
	const dir = mkdtempSync(join(tmpdir(), "verify-"));
	assert.deepEqual(resolveVerifyCommands(dir), { commands: [], source: "none" }, "an empty folder has none");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }));
	writeFileSync(join(dir, "package-lock.json"), "{}");
	assert.deepEqual(resolveVerifyCommands(dir), { commands: ["npm run lint", "npm test"], source: "detected" });
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "verify.json"), JSON.stringify({ commands: ["make check"] }));
	assert.deepEqual(resolveVerifyCommands(dir), { commands: ["make check"], source: ".pi/verify.json" });
});

test("an unreadable Makefile doesn't break command detection", () => {
	const dir = mkdtempSync(join(tmpdir(), "verify-"));
	mkdirSync(join(dir, "Makefile"));
	assert.deepEqual(resolveVerifyCommands(dir), { commands: [], source: "none" });
	assert.deepEqual(resolveVerifyCommands(dir, { detect: false }), { commands: [], source: "none" });
});

test("owedCommands: a change is owed by the commands whose paths cover it; a command without paths covers every file", () => {
	const scopes = new Map([["test", ["src/**"]]]);
	assert.deepEqual(owedCommands(["docs/a.md"], ["fmt", "test"], scopes), ["fmt"]);
	assert.deepEqual(owedCommands(["src/a.ts"], ["fmt", "test"], scopes), ["fmt", "test"]);
	assert.deepEqual(owedCommands(["x.txt"], ["fmt", "test"], new Map([["fmt", ["src/**"]], ["test", ["src/**"]]])), [], "no command covers it");
});

test("owedCommands: an unknown file or the verify config itself owes every command, in config order", () => {
	const scopes = new Map([["fmt", ["src/**"]], ["test", ["src/**"]]]);
	assert.deepEqual(owedCommands(["(unknown file)"], ["fmt", "test"], scopes), ["fmt", "test"]);
	assert.deepEqual(owedCommands([".pi/verify.json"], ["fmt", "test"], scopes), ["fmt", "test"]);
});

test("resolveVerifyPaths reads verify.json paths and reports entries that would hide a check", () => {
	const project = (config: object) => {
		const dir = temp("paths-");
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "verify.json"), JSON.stringify(config));
		return dir;
	};
	const commands = ["npm run fmt", "npm test"];
	const valid = resolveVerifyPaths(project({ commands, paths: { "npm test": ["src/**"] } }), commands);
	assert.deepEqual([...valid.scopes], [["npm test", ["src/**"]]]);
	assert.deepEqual(valid.problems, []);

	assert.deepEqual(resolveVerifyPaths(project({ commands, paths: { "npm tset": ["src/**"] } }), commands), {
		scopes: new Map(),
		problems: ['paths: "npm tset" is not one of the commands'],
	});
	for (const bad of [[], "src/**", [1]]) {
		assert.deepEqual(resolveVerifyPaths(project({ commands, paths: { "npm test": bad } }), commands), {
			scopes: new Map(),
			problems: ['paths: "npm test" needs a non-empty list of globs'],
		}, JSON.stringify(bad));
	}
	assert.deepEqual(resolveVerifyPaths(project({ commands, paths: ["src/**"] }), commands), { scopes: new Map(), problems: ["paths must be an object"] });
});

test("resolveVerifyPaths: paths apply only to commands from verify.json, not to AGENTS.md ones", () => {
	const dir = temp("paths-");
	writeFileSync(join(dir, "AGENTS.md"), "## Commands\n- `npm test`\n");
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "verify.json"), JSON.stringify({ paths: { "npm test": ["src/**"] } }));
	assert.deepEqual(resolveVerifyPaths(dir, ["npm test"]), { scopes: new Map(), problems: [] });
});

test("owedCommands: a folder label owes every command; a file name with $, @ or ~ narrows by its globs (round 2, Q10)", () => {
	const scopes = new Map([["fmt", ["docs/**"]], ["test", ["src/**"]]]);
	assert.deepEqual(owedCommands(["repoA/"], ["fmt", "test"], scopes), ["fmt", "test"], "a whole repository");
	assert.deepEqual(owedCommands(["src/routes/posts.$slug.tsx"], ["fmt", "test"], scopes), ["test"], "a Remix route file");
	assert.deepEqual(owedCommands(["docs/@types.md"], ["fmt", "test"], scopes), ["fmt"]);
});

test("owedCommands: on a case-insensitive file system globs match in any case, so a change owes more, never less", () => {
	const scopes = new Map([["test", ["src/**"]]]);
	assert.deepEqual(owedCommands(["SRC/a.ts"], ["fmt", "test"], scopes, { foldCase: true }), ["fmt", "test"]);
	assert.deepEqual(owedCommands([".PI/Verify.json"], ["fmt", "test"], new Map([["fmt", ["x/**"]], ["test", ["x/**"]]]), { foldCase: true }), ["fmt", "test"]);
	assert.deepEqual(owedCommands(["SRC/a.ts"], ["fmt", "test"], scopes, { foldCase: false }), ["fmt"]);
	assert.deepEqual(owedCommands(["SRC/a.ts"], ["fmt", "test"], scopes), ["fmt", "test"], "folding is the default on every platform: Linux mounts can ignore case too");
});

test("resolveVerifyPaths: a glob that can never match a project path is a problem, and its command checks every file (R7)", () => {
	const commands = ["npm test"];
	for (const glob of ["./src/**", "src/", "/abs/src/**", "~/src/**", "C:/src/**", "src\\**", "../src/**", "src/../x/**"]) {
		const dir = temp("paths-");
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "verify.json"), JSON.stringify({ commands, paths: { "npm test": ["lib/**", glob] } }));
		const r = resolveVerifyPaths(dir, commands);
		assert.equal(r.scopes.has("npm test"), false, glob);
		assert.deepEqual(r.problems, [`paths: "npm test" has a glob that can never match a project path: ${JSON.stringify(glob)} (write it relative to the project, like "src/**")`], glob);
	}
});

test("resolveVerifyPaths: glob syntax paths doesn't support, and a bare folder name, are problems (round 2, Q1)", () => {
	const commands = ["npm test"];
	const check = (glob: string, problem: string) => {
		const dir = temp("paths-");
		mkdirSync(join(dir, ".pi"));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, ".pi", "verify.json"), JSON.stringify({ commands, paths: { "npm test": ["lib/**", glob] } }));
		const r = resolveVerifyPaths(dir, commands);
		assert.equal(r.scopes.has("npm test"), false, glob);
		assert.deepEqual(r.problems, [problem], glob);
	};
	for (const glob of ["**/*.{ts,tsx}", "src/**/*.[jt]s", "!docs/**", "src/@(a|b)/**"]) {
		check(glob, `paths: "npm test" has a glob with syntax paths doesn't support: ${JSON.stringify(glob)} (only *, ** and ? work)`);
	}
	check("src", `paths: "npm test" has a glob that names a folder, not its files: "src" (write "src/**")`);
	const dir = temp("paths-");
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "verify.json"), JSON.stringify({ commands, paths: { "npm test": ["routes/posts.$slug.tsx", "Makefile"] } }));
	assert.deepEqual(resolveVerifyPaths(dir, commands).problems, [], "a literal file name is fine, $ included");
});
