import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCommand, checkPath, type GuardConfig } from "../extensions/lib/patterns.ts";
import { guardBaseline, guardScope, scopedConfig, scopedPath, strictest } from "../extensions/lib/scope.ts";

/** A folder outside git holding repositories `a` and `b`, each root's config taken from `configs` (by `""`, `a`, `b`). */
function workspace(configs: Record<string, GuardConfig> = {}) {
	const ws = mkdtempSync(join(tmpdir(), "scope-"));
	for (const r of ["a", "b"]) mkdirSync(join(ws, r, ".git"), { recursive: true });
	const scope = guardScope(ws, (root) => configs[root === ws ? "" : root.slice(ws.length + 1)] ?? {}, ".pi/guard.json");
	const command = (cmd: string, powershell = false) => checkCommand(cmd, ws, scopedConfig(cmd, ws, scope, powershell), ws).action;
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
	const scope = guardScope(dir, () => config, ".pi/guard.json");
	assert.equal(scope.repos.size, 0);
	assert.equal(scopedConfig("npm run deploy", dir, scope), config);
	assert.deepEqual(scopedPath("write", join(dir, "db", "x.sql"), scope), checkPath("write", join(dir, "db", "x.sql"), dir, config));
});

test("scopedPath: outside git, a guard config in any first-level folder asks, also before the folder is a repository", () => {
	const { ws, scope } = workspace();
	assert.equal(scopedPath("write", join(ws, "x", ".pi", "guard.json"), scope).action, "confirm", "x has no .git yet");
	assert.equal(scopedPath("write", join(ws, "x", "deep", ".pi", "guard.json"), scope).action, "allow", "only a first-level folder's");
});

test("scopedConfig: a command the guard can't place gets every repository's restrictions and no repository's loosening", () => {
	const { command } = workspace({ a: { block: ["make release"] }, b: { allow: ["npm run deploy"] } });
	for (const cmd of ["bash -c 'cd a && make release'", 'eval "cd a && make release"', "env -C a make release", "git --git-dir=a/.git log && make release"]) {
		assert.equal(command(cmd), "block", cmd);
	}
	assert.equal(command("Set-Location a; make release", true), "block", "any PowerShell command");
	assert.equal(command("npm run deploy git -C b"), "confirm", "-C of a git word that isn't the command");
	assert.equal(command("cd b && GIT_DIR=../a/.git npm run deploy"), "confirm");
	assert.equal(command("cd b && npm run deploy"), "allow", "b's own, placed");
});

test("scopedConfig: a path into a repository adds its restrictions, never its loosening", () => {
	const { command } = workspace({ a: { block: ["npm run release"], confirm: ["make docs"] }, b: { allow: ["npm run deploy"] } });
	assert.equal(command("npm run release --prefix a"), "block");
	assert.equal(command("cd b && npm run deploy --prefix ../a"), "confirm", "b's allow doesn't cover a command reaching into a");
	assert.equal(command("git -C a status && make docs"), "confirm", "a's confirm through git -C");
	assert.equal(command("git -C b status && make docs"), "allow");
});

test("scopedPath: a repository's rules hold through a symlink and a case-swapped name", () => {
	const { ws, scope } = workspace();
	symlinkSync(join(ws, "a"), join(ws, "link"));
	assert.equal(scopedPath("write", join(ws, "link", ".github", "workflows", "ci.yml"), scope).action, "confirm");
	if (existsSync(join(ws, "A"))) assert.equal(scopedPath("write", join(ws, "A", ".github", "workflows", "ci.yml"), scope).action, "confirm", "a case-insensitive volume");
});

test("a repository's rule names its own config in the reason", () => {
	const { ws, scope } = workspace({ a: { block: ["make release"], protectedPaths: ["secret/"], label: "a/.pi/guard.json" }, "": { label: ".pi/guard.json" } });
	const cmd = "echo $(cd b) && make release";
	assert.match(String(checkCommand(cmd, ws, scopedConfig(cmd, ws, scope), ws).reason), /a\/\.pi\/guard\.json/);
	assert.match(String(scopedPath("write", join(ws, "a", "secret", "x"), scope).reason), /protected by a\/\.pi\/guard\.json/);
});

test("guardScope: a repository or a config that appeared after the session started restricts but never loosens", () => {
	const ws = mkdtempSync(join(tmpdir(), "scope-"));
	for (const r of ["a", "b"]) mkdirSync(join(ws, r, ".git"), { recursive: true });
	const deploy: GuardConfig = { allow: ["npm run deploy"], block: ["make release"] };
	mkdirSync(join(ws, "b", ".pi"));
	writeFileSync(join(ws, "b", ".pi", "guard.json"), JSON.stringify(deploy));
	const baseline = guardBaseline(ws, ".pi/guard.json");
	mkdirSync(join(ws, "a", ".pi"));
	writeFileSync(join(ws, "a", ".pi", "guard.json"), JSON.stringify(deploy));
	mkdirSync(join(ws, "c", ".git"), { recursive: true });
	const scope = guardScope(ws, (root) => (root === ws ? {} : deploy), ".pi/guard.json", baseline);
	const command = (cmd: string) => checkCommand(cmd, ws, scopedConfig(cmd, ws, scope), ws).action;
	assert.equal(command("cd b && npm run deploy"), "allow", "b's config was there at the start");
	assert.equal(command("cd a && npm run deploy"), "confirm", "a's config appeared later");
	assert.equal(command("cd c && npm run deploy"), "confirm", "c appeared later");
	assert.equal(command("cd c && make release"), "block", "its restrictions still apply");
	assert.deepEqual(scopedConfig("ls", ws, scope).pushOwners, [join(ws, "a"), join(ws, "b")], "only repositories there at the start push silently");
});
