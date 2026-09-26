import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DEFAULT_IGNORE } from "../extensions/lib/commands.ts";
import { detectVerifyCommands, planInit } from "../extensions/lib/init.ts";

function project(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "init-"));
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(resolve(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

const scripts = (s: Record<string, string>) => JSON.stringify({ scripts: s });

test("verify commands come from AGENTS.md first", () => {
	const dir = project({ "AGENTS.md": "## Commands\n- `make check`\n", "package.json": scripts({ test: "vitest run" }) });
	assert.deepEqual(detectVerifyCommands(dir), ["make check"]);
});

test("then from package.json scripts, with the package manager from the lockfile", () => {
	const s = scripts({ dev: "vite", test: "vitest run", typecheck: "tsc", lint: "eslint .", build: "vite build", start: "node ." });
	assert.deepEqual(detectVerifyCommands(project({ "package.json": s, "package-lock.json": "{}" })), [
		"npm run typecheck",
		"npm run lint",
		"npm test",
		"npm run build",
	]);
	assert.deepEqual(detectVerifyCommands(project({ "package.json": s, "pnpm-lock.yaml": "" }))[0], "pnpm run typecheck");
	assert.deepEqual(detectVerifyCommands(project({ "package.json": scripts({ test: "jest" }), "yarn.lock": "" })), ["yarn test"]);
	assert.deepEqual(detectVerifyCommands(project({ "package.json": scripts({ test: 'echo "Error: no test specified" && exit 1' }) })), [], "npm's placeholder test script is not a check");
});

test("then from well-known build tools", () => {
	assert.deepEqual(detectVerifyCommands(project({ gradlew: "", "build.gradle.kts": "" })), ["./gradlew check"]);
	assert.deepEqual(detectVerifyCommands(project({ "Cargo.toml": "" })), ["cargo test"]);
	assert.deepEqual(detectVerifyCommands(project({ "go.mod": "" })), ["go vet ./...", "go test ./..."]);
	assert.deepEqual(detectVerifyCommands(project({ "App.sln": "" })), ["dotnet test"]);
	assert.deepEqual(detectVerifyCommands(project({ "pyproject.toml": "" })), ["pytest"]);
	assert.deepEqual(detectVerifyCommands(project({})), []);
});

test("planInit creates what is missing and never plans to overwrite", () => {
	const dir = project({ "package.json": scripts({ test: "vitest run" }), ".pi/guard.json": "{}" });
	const plan = planInit(dir);
	const byTarget = Object.fromEntries(plan.map((i) => [i.target, i]));

	assert.equal(byTarget[".pi/guard.json"]!.status, "exists");
	assert.equal(byTarget[".pi/verify.json"]!.status, "create");
	assert.deepEqual(JSON.parse(byTarget[".pi/verify.json"]!.content!), { commands: ["npm test"], timeoutSec: 600, ignore: DEFAULT_IGNORE });
	assert.equal(byTarget[".pi/model-routing.json"]!.status, "create");
	assert.ok(JSON.parse(byTarget[".pi/model-routing.json"]!.content!).modes.deep);
	assert.equal(byTarget[".pi/settings.json"]!.status, "create");
	assert.deepEqual(JSON.parse(byTarget[".pi/settings.json"]!.content!), { packages: ["npm:pi-subagents"] });
	assert.equal(byTarget["AGENTS.md"]!.status, "missing", "AGENTS.md is left to /onboard");
	for (const item of plan) assert.ok(item.content === undefined || item.content.endsWith("\n"));
});

test("planInit merges pi-subagents into existing settings without touching other keys", () => {
	const existing = { packages: ["git:example.com/kit@v1"], defaultThinkingLevel: "high" };
	const dir = project({ ".pi/settings.json": JSON.stringify(existing), "AGENTS.md": "# x\n" });
	const settings = planInit(dir).find((i) => i.target === ".pi/settings.json")!;
	assert.equal(settings.status, "merge");
	assert.deepEqual(JSON.parse(settings.content!), { ...existing, packages: [...existing.packages, "npm:pi-subagents"] });
	assert.equal(planInit(dir).find((i) => i.target === "AGENTS.md")!.status, "exists");

	const done = project({ ".pi/settings.json": JSON.stringify({ packages: [{ source: "npm:pi-subagents" }] }) });
	assert.equal(planInit(done).find((i) => i.target === ".pi/settings.json")!.status, "exists");

	const broken = project({ ".pi/settings.json": "{ not json" });
	assert.equal(planInit(broken).find((i) => i.target === ".pi/settings.json")!.status, "exists", "broken JSON is left alone");
});

test("verify.json without detectable commands is still created, empty, with a hint", () => {
	const item = planInit(project({})).find((i) => i.target === ".pi/verify.json")!;
	assert.deepEqual(JSON.parse(item.content!).commands, []);
	assert.match(item.why, /fill in/i);
});
