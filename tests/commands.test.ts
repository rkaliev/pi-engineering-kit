import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commandMatches, parseAgentsCommands, resolveVerifyCommands } from "../extensions/lib/commands.ts";

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
	assert.equal(commandMatches("npm test && npm run typecheck", "npm run typecheck"), true);
	assert.equal(commandMatches("cd packages/app && npm run typecheck", "npm run typecheck"), false, "another directory proves nothing here");
	assert.equal(commandMatches("npm test -- --grep x", "npm test"), false, "filtered runs do not prove the suite");
	assert.equal(commandMatches("echo npm test", "npm test"), false);
});
