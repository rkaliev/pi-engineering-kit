import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedPaths, shellWriteTargets, treeFingerprint } from "../extensions/lib/worktree.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });

/** A repository with one committed `src/a.ts` and `dist/` ignored. */
function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "worktree-"));
	git(dir, "init", "-q", "-b", "main");
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(join(dir, ".gitignore"), "dist/\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "initial");
	return dir;
}

const fingerprint = (dir: string, ignore: string[] = []) => {
	const tree = treeFingerprint(dir, ignore);
	assert.ok(tree, "a git repository has a fingerprint");
	return tree;
};

test("treeFingerprint: a write through the file system shows as a changed path", () => {
	const dir = repo();
	const before = fingerprint(dir);
	writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
	const edited = fingerprint(dir);
	assert.deepEqual(changedPaths(before, edited), ["src/a.ts"]);
	writeFileSync(join(dir, "src/b.ts"), "export const b = 1;\n");
	assert.deepEqual(changedPaths(edited, fingerprint(dir)), ["src/b.ts"]);
});

test("treeFingerprint: a deleted file shows as deleted, a rename as both paths", () => {
	const dir = repo();
	const before = fingerprint(dir);
	rmSync(join(dir, "src/a.ts"));
	const deleted = fingerprint(dir);
	assert.deepEqual(changedPaths(before, deleted), ["src/a.ts"]);
	assert.equal(deleted["src/a.ts"], "deleted");
	git(dir, "checkout", "-q", "--", "src/a.ts");
	git(dir, "mv", "src/a.ts", "src/c.ts");
	assert.deepEqual(changedPaths(before, fingerprint(dir)), ["src/a.ts", "src/c.ts"]);
});

test("treeFingerprint: ignored files, excluded paths and paths outside the project don't count", () => {
	const dir = repo();
	mkdirSync(join(dir, "pkg"));
	const before = fingerprint(dir, ["docs/**"]);
	mkdirSync(join(dir, "dist"));
	writeFileSync(join(dir, "dist/x.js"), "built\n");
	mkdirSync(join(dir, "docs"));
	writeFileSync(join(dir, "docs/n.md"), "note\n");
	assert.deepEqual(changedPaths(before, fingerprint(dir, ["docs/**"])), []);

	const pkg = join(dir, "pkg");
	const inside = fingerprint(pkg);
	writeFileSync(join(dir, "other.ts"), "outside the project\n");
	assert.deepEqual(changedPaths(inside, fingerprint(pkg)), []);
	writeFileSync(join(pkg, "p.ts"), "inside\n");
	assert.deepEqual(changedPaths(inside, fingerprint(pkg)), ["p.ts"], "paths are relative to the project");
});

test("treeFingerprint: outside a git repository there is none", () => {
	assert.equal(treeFingerprint(mkdtempSync(join(tmpdir(), "no-git-")), []), undefined);
});

test("shellWriteTargets: files a command writes inside the project", () => {
	const project = mkdtempSync(join(tmpdir(), "no-git-"));
	const targets = (command: string, cwd = project) => shellWriteTargets(command, cwd, project);
	assert.deepEqual(targets("cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF"), ["src/a.ts"]);
	assert.deepEqual(targets("echo x >> src/b.ts"), ["src/b.ts"]);
	assert.deepEqual(targets("echo x | tee src/c.ts"), ["src/c.ts"]);
	assert.deepEqual(targets("echo x | tee -a src/c.ts"), ["src/c.ts"]);
	assert.deepEqual(targets("sed -i '' 's/a/b/' src/d.ts"), ["src/d.ts"]);
	assert.deepEqual(targets("sed -i.bak 's/a/b/' src/d.ts"), ["src/d.ts"]);
	assert.deepEqual(targets("echo x > a.ts", join(project, "src")), ["src/a.ts"], "relative to the command's folder");
	for (const none of ["cat x > /tmp/y", "npm test 2>/dev/null", "npm test 2>&1", "cat src/a.ts", "echo > ../outside.ts", "sed 's/a/b/' src/d.ts"]) {
		assert.deepEqual(targets(none), [], none);
	}
});
