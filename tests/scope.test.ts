import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCommand, checkPath, type GuardConfig } from "../extensions/lib/patterns.ts";
import { guardScope, scopedConfig, scopedPath, strictest } from "../extensions/lib/scope.ts";

/** A folder outside git holding repositories `a` and `b`, each root's config taken from `configs` (by `""`, `a`, `b`). */
function workspace(configs: Record<string, GuardConfig> = {}) {
	const ws = mkdtempSync(join(tmpdir(), "scope-"));
	for (const r of ["a", "b"]) mkdirSync(join(ws, r, ".git"), { recursive: true });
	const scope = guardScope(ws, (root) => configs[root === ws ? "" : root.slice(ws.length + 1)] ?? {});
	const command = (cmd: string) => checkCommand(cmd, ws, scopedConfig(cmd, ws, scope), ws).action;
	return { ws, scope, command };
}

test("scopedPath: a CI pipeline or the guard config of a workspace repository asks", () => {
	const { ws, scope } = workspace();
	assert.equal(scopedPath("write", join(ws, "a", ".github", "workflows", "ci.yml"), scope).action, "confirm");
	assert.equal(scopedPath("edit", join(ws, "a", ".pi", "guard.json"), scope).action, "confirm");
});

test("scopedPath: a repository's protected paths block under it, measured from it", () => {
	const { ws, scope } = workspace({ a: { protectedPaths: ["secret/"] } });
	assert.equal(scopedPath("write", join(ws, "a", "secret", "x"), scope).action, "block");
	assert.equal(scopedPath("write", join(ws, "b", "secret", "x"), scope).action, "allow");
});

test("scopedConfig: a repository's rules apply to a command that runs in it, or whose folder is unknown", () => {
	const { command } = workspace({ a: { block: ["make release"] } });
	assert.equal(command("cd a && make release"), "block");
	assert.equal(command("cd b && make release"), "allow");
	assert.equal(command("echo $(cd b) && make release"), "block", "a hidden move: every repository's rules");
});

test("scopedConfig: a repository's allow applies only when the whole command runs in it; the workspace's everywhere", () => {
	const { command } = workspace({ a: { allow: ["npm run deploy"] } });
	assert.equal(command("cd a && npm run deploy"), "allow");
	assert.equal(command("cd b && npm run deploy"), "confirm");
	assert.equal(command("cd a && npm run deploy && cd ../b && npm run deploy"), "confirm");
	assert.equal(workspace({ "": { allow: ["npm run deploy"] } }).command("cd b && npm run deploy"), "allow");
});

test("strictest: block, then confirm, then allow; a tie keeps the first", () => {
	const allow = { action: "allow" as const };
	const ask = { action: "confirm" as const, reason: "ask" };
	const deny = { action: "block" as const, reason: "deny" };
	assert.equal(strictest(allow, ask), ask);
	assert.equal(strictest(deny, ask), deny);
	assert.equal(strictest(ask, deny), deny);
	assert.equal(strictest(ask, { ...ask }), ask);
});

test("guardScope: outside a workspace the scope is the session folder's config alone", () => {
	const dir = mkdtempSync(join(tmpdir(), "scope-"));
	const config: GuardConfig = { protectedPaths: ["db/"], allow: ["npm run deploy"] };
	const scope = guardScope(dir, () => config);
	assert.equal(scope.repos.size, 0);
	assert.equal(scopedConfig("npm run deploy", dir, scope), config);
	assert.deepEqual(scopedPath("write", join(dir, "db", "x.sql"), scope), checkPath("write", join(dir, "db", "x.sql"), dir, config));
});
