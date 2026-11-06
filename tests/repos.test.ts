import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { projectRepos, repoOf } from "../extensions/lib/repos.ts";

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


const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

/** A folder outside git with repositories `b` (a `.git` folder) and `a` (a `.git` file, as in a linked worktree). */
function workspace(): string {
	const ws = temp("repos-");
	mkdirSync(join(ws, "b"));
	git(join(ws, "b"), "init", "-q");
	mkdirSync(join(ws, "a"));
	writeFileSync(join(ws, "a", ".git"), "gitdir: ../b/.git\n");
	mkdirSync(join(ws, "plain"));
	mkdirSync(join(ws, "ignored", ".git"), { recursive: true });
	mkdirSync(join(ws, "deep", "x", ".git"), { recursive: true });
	symlinkSync(join(ws, "b"), join(ws, "link"));
	return ws;
}

test("projectRepos: a folder inside git is one repository, also from a subfolder", () => {
	const dir = temp("repos-");
	git(dir, "init", "-q");
	mkdirSync(join(dir, "sub"));
	assert.deepEqual(projectRepos(dir), { kind: "repo", repos: [""] });
	assert.deepEqual(projectRepos(join(dir, "sub")), { kind: "repo", repos: [""] });
});

test("projectRepos: a non-git folder of repositories is a workspace of its first-level repositories, without ignored folders or symlinks", () => {
	assert.deepEqual(projectRepos(workspace(), ["ignored/**"]), { kind: "workspace", repos: ["a", "b"] });
});

test("projectRepos: a folder with no repositories, or with more than 32, is none", () => {
	assert.deepEqual(projectRepos(temp("repos-")), { kind: "none", repos: [] });
	const many = temp("repos-");
	for (let i = 10; i < 42; i++) mkdirSync(join(many, `r${i}`, ".git"), { recursive: true });
	assert.equal(projectRepos(many).kind, "workspace", "32 repositories are within the limit");
	mkdirSync(join(many, "r42", ".git"), { recursive: true });
	assert.deepEqual(projectRepos(many), { kind: "none", repos: [] });
});

test("projectRepos: the 32 limit counts ignored repositories too, so callers with and without ignore agree", () => {
	const many = temp("repos-");
	for (let i = 10; i < 43; i++) mkdirSync(join(many, `r${i}`, ".git"), { recursive: true });
	assert.deepEqual(projectRepos(many, ["r42/**"]), { kind: "none", repos: [] });
	assert.deepEqual(projectRepos(many), { kind: "none", repos: [] });
});

test("repoOf: a path is placed in the workspace repository holding it, by whole folder names", () => {
	const ws = join(tmpdir(), "ws");
	const repos = ["a", "b"];
	assert.equal(repoOf(ws, repos, join(ws, "a", "x", "y")), join(ws, "a"));
	assert.equal(repoOf(ws, repos, join(ws, "a")), join(ws, "a"));
	assert.equal(repoOf(ws, repos, `${ws}/a/../b/x`), join(ws, "b"), "a path that leaves its repository by ..");
	assert.equal(repoOf(ws, repos, join(ws, "ab", "x")), undefined, "a folder whose name only starts with a repository's");
	assert.equal(repoOf(ws, repos, join(ws, "notes", "x")), undefined);
});

test("repoOf: a path is placed by its real location: through a symlink, and by the name's case where the volume ignores it", () => {
	const ws = temp("repos-");
	for (const r of ["a", "b"]) mkdirSync(join(ws, r, ".git"), { recursive: true });
	symlinkSync(join(ws, "a"), join(ws, "link"));
	assert.equal(repoOf(ws, ["a", "b"], join(ws, "link", ".github", "workflows", "ci.yml")), join(ws, "a"));
	const caseless = existsSync(join(ws, "A"));
	assert.equal(repoOf(ws, ["a", "b"], join(ws, "A", "x")), caseless ? join(ws, "a") : undefined);
});
