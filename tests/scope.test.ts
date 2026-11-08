import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slowGit } from "./slow-git.ts";
import test, { after } from "node:test";
import { checkCommand, checkPath, type GuardConfig } from "../extensions/lib/patterns.ts";
import { guardBaseline, guardScope, hooksPaths, scopedConfig, scopedPath, strictest } from "../extensions/lib/scope.ts";

/** Temp folders this file makes, removed when its tests end. */
const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}


/** A folder outside git holding repositories `a` and `b`, each root's config taken from `configs` (by `""`, `a`, `b`). */
function workspace(configs: Record<string, GuardConfig> = {}) {
	const ws = temp("scope-");
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

test("scopedPath: a repository's hooks folder asks under it, measured from it", () => {
	const { ws, scope } = workspace({ a: { hooksPath: "hooks" } });
	assert.equal(scopedPath("write", join(ws, "a", "hooks", "pre-commit"), scope).action, "confirm");
	assert.equal(scopedPath("write", join(ws, "hooks", "pre-commit"), scope).action, "allow");
	assert.equal(scopedPath("write", join(ws, "b", "hooks", "pre-commit"), scope).action, "allow");
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
	const dir = temp("scope-");
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
	assert.equal(scopedPath("write", join(ws, "x", ".PI", "guard.json"), scope).action, "confirm", "in any case");
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
	assert.equal(command("cd b && git -C ../b status && make docs"), "allow", "every segment runs in b");
	assert.equal(command("git -C b status && make docs"), "confirm", "make docs runs at the workspace root");
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
	const ws = temp("scope-");
	for (const r of ["a", "b"]) mkdirSync(join(ws, r, ".git"), { recursive: true });
	const deploy: GuardConfig = { allow: ["npm run deploy"], block: ["make release"] };
	mkdirSync(join(ws, "b", ".pi"));
	writeFileSync(join(ws, "b", ".pi", "guard.json"), JSON.stringify(deploy));
	const baseline = guardBaseline(ws, ".pi/guard.json", (root) => (root === ws ? {} : root.endsWith("b") ? deploy : {}));
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

test("scopedConfig: a segment that runs outside every repository gets every repository's restrictions, whatever its form", () => {
	const { command } = workspace({ a: { block: ["make release"] }, b: { allow: ["npm run deploy"] } });
	for (const cmd of ["fish -c 'cd a; make release'", "python3 -c \"import os; os.chdir('a'); os.system('make release')\"", "echo 'cd a && make release' | sh", "bash <<< 'cd a; make release'"]) {
		assert.equal(command(cmd), "block", cmd);
	}
	assert.equal(command("cd b && fish -c 'cd ../a; make release'"), "block", "inside b, naming a adds a's");
	assert.equal(command("ls -la"), "allow", "no repository's rule matches");
	assert.equal(command("cd b && npm run deploy"), "allow", "b's own allow, every segment in b");
});

/** A workspace of `a` and `b` (a `.git` folder each), its baseline taken with `configs` (by name) as at the start. */
function started(configs: Record<string, GuardConfig> = {}) {
	const ws = temp("scope-");
	for (const r of ["a", "b"]) mkdirSync(join(ws, r, ".git"), { recursive: true });
	const load = (root: string) => configs[root === ws ? "" : root.slice(ws.length + 1)] ?? {};
	const baseline = guardBaseline(ws, ".pi/guard.json", load);
	return { ws, load, baseline, scope: () => guardScope(ws, load, ".pi/guard.json", baseline) };
}

test("guardScope: a later repository named like an Object property, or one cloned in place of another, is no push owner", () => {
	const { ws, scope } = started();
	mkdirSync(join(ws, "constructor", ".git"), { recursive: true });
	renameSync(join(ws, "a"), join(ws, "a.old"));
	mkdirSync(join(ws, "a", ".git"), { recursive: true });
	assert.deepEqual(scope().owners, [join(ws, "b")]);
});

test("guardScope: a repository's restrictions from the session start stay when its config is removed or changed", () => {
	const { ws, baseline } = started({ a: { block: ["make release"], protectedPaths: ["secret/"] } });
	const removed = guardScope(ws, () => ({}), ".pi/guard.json", baseline);
	const cmd = "cd a && make release";
	assert.equal(checkCommand(cmd, ws, scopedConfig(cmd, ws, removed), ws).action, "block");
	assert.equal(scopedPath("write", join(ws, "a", "secret", "x"), removed).action, "block");
});

test("guardScope: git init at the workspace root keeps the repositories of the session start", () => {
	const { ws, scope } = started();
	execFileSync("git", ["init", "-q"], { cwd: ws });
	assert.equal(scope().kind, "workspace");
	assert.equal(scopedPath("write", join(ws, "a", ".github", "workflows", "ci.yml"), scope()).action, "confirm");
	rmSync(join(ws, ".git"), { recursive: true });
});

test("scopedPath: a repository's rules hold for a path written inside it that a symlink leads out of it", () => {
	const { ws, scope } = workspace({ a: { protectedPaths: ["shared/"] } });
	mkdirSync(join(ws, "shared-config"));
	symlinkSync(join(ws, "shared-config"), join(ws, "a", "shared"));
	assert.equal(scopedPath("write", join(ws, "a", "shared", "x"), scope).action, "block");
});

test("scopedConfig: a word that reaches a repository through a symlink, a case-swapped name or an expansion adds its restrictions", () => {
	const { ws, command } = workspace({ b: { block: ["release"] } });
	symlinkSync(join(ws, "b"), join(ws, "a", "lnk"));
	assert.equal(command("cd a && make -C lnk release"), "block", "a symlink in a to b");
	assert.equal(command("cd a && make -C ../$R release"), "block", "an expansion next to ..");
	if (existsSync(join(ws, "B"))) assert.equal(command("cd a && make -C ../B release"), "block", "a case-insensitive volume");
});

test("scopedConfig: a repository's name in a message doesn't take its allow from a command that runs in it", () => {
	const { command } = workspace({ b: { allow: ["npm run deploy"] } });
	assert.equal(command('cd b && npm run deploy -- --note "a"'), "allow");
	assert.equal(command("cd b && npm run deploy --prefix ../a"), "confirm", "a path into a still does");
});

test("guardScope: a repository whose .git was moved away, or that was renamed, keeps its restrictions from the start", () => {
	const restricted = { a: { protectedPaths: ["secret/"], block: ["make release"] } };
	const moved = started(restricted);
	renameSync(join(moved.ws, "a", ".git"), join(moved.ws, "a", ".git-off"));
	const scope = guardScope(moved.ws, () => ({}), ".pi/guard.json", moved.baseline);
	assert.equal(scopedPath("write", join(moved.ws, "a", "secret", "x"), scope).action, "block");
	assert.equal(scopedPath("write", join(moved.ws, "a", ".github", "workflows", "ci.yml"), scope).action, "confirm");
	const renamed = started(restricted);
	renameSync(join(renamed.ws, "a"), join(renamed.ws, "a2"));
	const after = guardScope(renamed.ws, () => ({}), ".pi/guard.json", renamed.baseline);
	const cmd = "cd a2 && make release";
	assert.equal(checkCommand(cmd, renamed.ws, scopedConfig(cmd, renamed.ws, after), renamed.ws).action, "block");
	assert.deepEqual(after.owners, [join(renamed.ws, "b")], "a renamed repository pushes only with a question");
});

test("scopedConfig: a rule spelled like an Object property names its own config", () => {
	const { ws, scope } = workspace({ a: { block: ["constructor"], label: "a/.pi/guard.json" }, "": { label: ".pi/guard.json" } });
	const cmd = "echo constructor";
	assert.match(String(checkCommand(cmd, ws, scopedConfig(cmd, ws, scope), ws).reason), /in a\/\.pi\/guard\.json/);
});

test("scopedConfig: a repository named outside quotes takes the allow away; one named in a quoted message doesn't", () => {
	const { command } = workspace({ a: { confirm: ["release"] }, b: { allow: ["make .*release", "npm run deploy"] } });
	assert.equal(command("cd b && make -C../a release"), "confirm", "-C glued to a path into a");
	assert.equal(command('cd b && npm run deploy -- --note "a"'), "allow");
});

test("guardScope: two repositories that swapped folders keep both entries' restrictions", () => {
	const { ws, baseline } = started({ a: { block: ["make release"] } });
	renameSync(join(ws, "a"), join(ws, "t"));
	renameSync(join(ws, "b"), join(ws, "a"));
	renameSync(join(ws, "t"), join(ws, "b"));
	const scope = guardScope(ws, () => ({}), ".pi/guard.json", baseline);
	const cmd = "cd b && make release";
	assert.equal(checkCommand(cmd, ws, scopedConfig(cmd, ws, scope), ws).action, "block", "a's repository now in folder b");
});

/** A real repository at `dir` (created), with `core.hooksPath` set to `hooks` unless undefined. */
function gitRepo(dir: string, hooks?: string): string {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: dir, env: isolated });
	if (hooks !== undefined) execFileSync("git", ["config", "core.hooksPath", hooks], { cwd: dir, env: isolated });
	return dir;
}
// No global or system git config: the user's own core.hooksPath must not leak into these tests.
const isolated = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

test("hooksPaths: each repository's own core.hooksPath inside the session folder, relative to its root", () => {
	const withEnv = (fn: () => void) => {
		const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
		Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
		try {
			fn();
		} finally {
			for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_NOSYSTEM", saved.s]] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	};
	withEnv(() => {
		const repo = gitRepo(join(temp("hooks-"), "r"), "tools/hooks");
		assert.deepEqual(hooksPaths(repo), { [repo]: "tools/hooks" });
		const absolute = gitRepo(join(temp("hooks-"), "r"));
		execFileSync("git", ["config", "core.hooksPath", join(absolute, "x")], { cwd: absolute, env: isolated });
		assert.deepEqual(hooksPaths(absolute), { [absolute]: "x" });
		const root = gitRepo(join(temp("hooks-"), "r"), ".");
		assert.deepEqual(hooksPaths(root), { [root]: "" });
		for (const outside of ["../outside", "/tmp/elsewhere"]) {
			const r = gitRepo(join(temp("hooks-"), "r"), outside);
			assert.deepEqual(hooksPaths(r), {}, outside);
		}
		assert.deepEqual(hooksPaths(gitRepo(join(temp("hooks-"), "r"))), {}, "unset");
		const sub = gitRepo(join(temp("hooks-"), "r"), "app/hooks");
		mkdirSync(join(sub, "app"));
		assert.deepEqual(hooksPaths(join(sub, "app")), { [join(sub, "app")]: "hooks" }, "a session in a subfolder measures from it");
		const above = gitRepo(join(temp("hooks-"), "r"), "tools/hooks");
		mkdirSync(join(above, "app"));
		assert.deepEqual(hooksPaths(join(above, "app")), {}, "a hooks folder above the session folder is outside it");
		const ws = temp("hooks-ws-");
		gitRepo(join(ws, "a"), "h");
		gitRepo(join(ws, "b"));
		assert.deepEqual(hooksPaths(ws), { [join(ws, "a")]: "h" });
		assert.deepEqual(hooksPaths(temp("hooks-none-")), {});
	});
});

test("hooksPaths: a git that can't run leaves nothing, without throwing", () => {
	// A workspace is found without git, so the failing call is the one that reads core.hooksPath.
	const ws = temp("hooks-ws-");
	gitRepo(join(ws, "a"), "tools/hooks");
	const saved = process.env.PATH;
	process.env.PATH = temp("no-git-");
	try {
		assert.deepEqual(hooksPaths(ws), {});
	} finally {
		process.env.PATH = saved;
	}
});

test("scopedPath: outside a workspace too, a write is judged where it really leads: a symlink to a hook folder asks", () => {
	const dir = temp("scope-real-");
	mkdirSync(join(dir, ".husky"));
	symlinkSync(".husky", join(dir, "h"));
	mkdirSync(join(dir, "tools", "git-hooks"), { recursive: true });
	symlinkSync(join("tools", "git-hooks"), join(dir, ".hooks"));
	const scope = guardScope(dir, () => ({ hooksPath: "tools/git-hooks" }), ".claude/guard.json");
	assert.equal(scopedPath("write", join(dir, "h", "pre-commit"), scope).action, "confirm");
	assert.equal(scopedPath("write", join(dir, ".hooks", "pre-commit"), scope).action, "confirm");
	assert.equal(scopedPath("write", join(dir, "src.ts"), scope).action, "allow");
});

// APFS opens `.huſky` (long s, U+017F) as `.husky`; a file system that doesn't has nothing to bypass.
const folds = (() => {
	const dir = temp("scope-fold-");
	mkdirSync(join(dir, ".husky"));
	return existsSync(join(dir, ".hu\u017fky"));
})();
test("scopedPath: a letter the file system folds onto a protected name is judged by the name on disk", { skip: !folds && "platform: needs a file system that folds U+017F onto s (APFS)" }, () => {
	const dir = temp("scope-fold-");
	mkdirSync(join(dir, ".husky"));
	const scope = guardScope(dir, () => ({}), ".claude/guard.json");
	assert.equal(scopedPath("write", join(dir, ".hu\u017fky", "pre-commit"), scope).action, "confirm");
});

test("hooksPaths: a configured folder with a trailing slash, or reached through a symlink, is kept by its real path", () => {
	const isolatedEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	const saved = { ...process.env };
	Object.assign(process.env, isolatedEnv);
	try {
		const slashed = gitRepo(join(temp("hooks-"), "r"), "tools/hooks/");
		assert.deepEqual(hooksPaths(slashed), { [slashed]: "tools/hooks" });
		const linked = gitRepo(join(temp("hooks-"), "r"), ".hooks");
		mkdirSync(join(linked, "tools", "git-hooks"), { recursive: true });
		symlinkSync(join("tools", "git-hooks"), join(linked, ".hooks"));
		assert.deepEqual(hooksPaths(linked), { [linked]: "tools/git-hooks" });
		const deep = gitRepo(join(temp("hooks-"), "r"), Array.from({ length: 12000 }, () => "a").join("/"));
		assert.doesNotThrow(() => hooksPaths(deep), "a very deep folder that doesn't exist yet");
	} finally {
		for (const k of Object.keys(isolatedEnv)) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
});

test("hooksPaths: the reads share one budget, so hanging repositories can't hold the session start past it", () => {
	const ws = temp("hooks-ws-");
	const names = ["a", "b", "c", "d"];
	for (const name of names) gitRepo(join(ws, name), "h");
	const slow = names.map((name) => slowGit(realpathSync(join(ws, name)), "", 10));
	const status = { complete: true };
	let calls: string[] = [];
	try {
		assert.deepEqual(hooksPaths(ws, 1000, status), {});
		calls = slow.map((s) => readFileSync(s.log, "utf8"));
	} finally {
		for (const s of [...slow].reverse()) s.restore();
	}
	// The first read used the whole budget: the others were never started, and the result says it is incomplete.
	assert.notEqual(calls[0], "", "a was read");
	assert.deepEqual(calls.slice(1), ["", "", ""], "b, c and d were skipped");
	assert.equal(status.complete, false);
});

test("hooksPaths: one hanging repository gets at most a second, so the others are still read", () => {
	const ws = temp("hooks-ws-");
	for (const name of ["a", "b", "c"]) gitRepo(join(ws, name), "h");
	const slow = slowGit(realpathSync(join(ws, "a")), "", 10);
	const status = { complete: true };
	let found: Record<string, string> = {};
	try {
		found = hooksPaths(ws, 3000, status);
	} finally {
		slow.restore();
	}
	assert.deepEqual(found, { [join(ws, "b")]: "h", [join(ws, "c")]: "h" });
	assert.equal(status.complete, false, "a's read timed out");
});
