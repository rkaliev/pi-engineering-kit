import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectRepos, repoOf } from "../extensions/lib/repos.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

/** A folder outside git with repositories `b` (a `.git` folder) and `a` (a `.git` file, as in a linked worktree). */
function workspace(): string {
	const ws = mkdtempSync(join(tmpdir(), "repos-"));
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
	const dir = mkdtempSync(join(tmpdir(), "repos-"));
	git(dir, "init", "-q");
	mkdirSync(join(dir, "sub"));
	assert.deepEqual(projectRepos(dir), { kind: "repo", repos: [""] });
	assert.deepEqual(projectRepos(join(dir, "sub")), { kind: "repo", repos: [""] });
});

test("projectRepos: a non-git folder of repositories is a workspace of its first-level repositories, without ignored folders or symlinks", () => {
	assert.deepEqual(projectRepos(workspace(), ["ignored/**"]), { kind: "workspace", repos: ["a", "b"] });
});

test("projectRepos: a folder with no repositories, or with more than 32, is none", () => {
	assert.deepEqual(projectRepos(mkdtempSync(join(tmpdir(), "repos-"))), { kind: "none", repos: [] });
	const many = mkdtempSync(join(tmpdir(), "repos-"));
	for (let i = 10; i < 42; i++) mkdirSync(join(many, `r${i}`, ".git"), { recursive: true });
	assert.equal(projectRepos(many).kind, "workspace", "32 repositories are within the limit");
	mkdirSync(join(many, "r42", ".git"), { recursive: true });
	assert.deepEqual(projectRepos(many), { kind: "none", repos: [] });
});

test("repoOf: the workspace repository holding a path, else the project folder", () => {
	const ws = workspace();
	assert.equal(repoOf(ws, join(ws, "b", "src", "x.ts")), join(ws, "b"));
	assert.equal(repoOf(ws, join(ws, "b")), join(ws, "b"));
	assert.equal(repoOf(ws, join(ws, "plain", "x.ts")), ws);
	assert.equal(repoOf(ws, join(tmpdir(), "elsewhere")), ws);
	const dir = mkdtempSync(join(tmpdir(), "repos-"));
	git(dir, "init", "-q");
	assert.equal(repoOf(dir, join(dir, "src", "x.ts")), dir);
});
