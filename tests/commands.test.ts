import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commandMatches, owedCommands, parseAgentsCommands, resolveVerifyCommands, resolveVerifyPaths } from "../extensions/lib/commands.ts";

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
		const dir = mkdtempSync(join(tmpdir(), "paths-"));
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
	const dir = mkdtempSync(join(tmpdir(), "paths-"));
	writeFileSync(join(dir, "AGENTS.md"), "## Commands\n- `npm test`\n");
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "verify.json"), JSON.stringify({ paths: { "npm test": ["src/**"] } }));
	assert.deepEqual(resolveVerifyPaths(dir, ["npm test"]), { scopes: new Map(), problems: [] });
});
