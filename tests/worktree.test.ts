import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callChanges, changedPaths, MAX_ENTRIES, shellWriteTargets, treeFingerprint } from "../extensions/lib/worktree.ts";

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
	assert.deepEqual(changedPaths(before, edited, dir), ["src/a.ts"]);
	writeFileSync(join(dir, "src/b.ts"), "export const b = 1;\n");
	assert.deepEqual(changedPaths(edited, fingerprint(dir), dir), ["src/b.ts"]);
});

test("treeFingerprint: a deleted file shows as deleted, a rename as both paths", () => {
	const dir = repo();
	const before = fingerprint(dir);
	rmSync(join(dir, "src/a.ts"));
	const deleted = fingerprint(dir);
	assert.deepEqual(changedPaths(before, deleted, dir), ["src/a.ts"]);
	assert.equal(deleted.files["src/a.ts"], "deleted");
	git(dir, "checkout", "-q", "--", "src/a.ts");
	git(dir, "mv", "src/a.ts", "src/c.ts");
	assert.deepEqual(changedPaths(before, fingerprint(dir), dir), ["src/a.ts", "src/c.ts"]);
});

test("treeFingerprint: ignored files, excluded paths and paths outside the project don't count", () => {
	const dir = repo();
	mkdirSync(join(dir, "pkg"));
	const before = fingerprint(dir, ["docs/**"]);
	mkdirSync(join(dir, "dist"));
	writeFileSync(join(dir, "dist/x.js"), "built\n");
	mkdirSync(join(dir, "docs"));
	writeFileSync(join(dir, "docs/n.md"), "note\n");
	assert.deepEqual(changedPaths(before, fingerprint(dir, ["docs/**"]), dir), []);

	const pkg = join(dir, "pkg");
	const inside = fingerprint(pkg);
	writeFileSync(join(dir, "other.ts"), "outside the project\n");
	assert.deepEqual(changedPaths(inside, fingerprint(pkg), pkg), []);
	writeFileSync(join(pkg, "p.ts"), "inside\n");
	assert.deepEqual(changedPaths(inside, fingerprint(pkg), pkg), ["p.ts"], "paths are relative to the project");
});

test("treeFingerprint: staging and committing a change are not changes", () => {
	const dir = repo();
	writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
	const edited = fingerprint(dir);
	git(dir, "add", "-A");
	const staged = fingerprint(dir);
	assert.deepEqual(changedPaths(edited, staged, dir), []);
	git(dir, "commit", "-q", "-m", "a = 2");
	assert.deepEqual(changedPaths(staged, fingerprint(dir), dir), []);
	assert.deepEqual(changedPaths(edited, fingerprint(dir), dir), []);
});

test("treeFingerprint: reverting a change is a change", () => {
	const dir = repo();
	writeFileSync(join(dir, "src/a.ts"), "export const a = 22;\n");
	const edited = fingerprint(dir);
	git(dir, "checkout", "-q", "--", "src/a.ts");
	assert.deepEqual(changedPaths(edited, fingerprint(dir), dir), ["src/a.ts"]);
});

test("treeFingerprint: a file edited and committed in one step shows", () => {
	const dir = repo();
	const clean = fingerprint(dir);
	writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
	git(dir, "commit", "-q", "-am", "a = 2");
	assert.deepEqual(changedPaths(clean, fingerprint(dir), dir), ["src/a.ts"]);
});

test("treeFingerprint: a tree over the cap has none", () => {
	const dir = repo();
	mkdirSync(join(dir, "many"));
	for (let i = 0; i <= MAX_ENTRIES; i++) writeFileSync(join(dir, "many", `${i}.txt`), "");
	assert.equal(treeFingerprint(dir, []), undefined);
});

test("treeFingerprint: outside a git repository there is none", () => {
	assert.equal(treeFingerprint(mkdtempSync(join(tmpdir(), "no-git-")), []), undefined);
});

/** A folder outside git holding repositories `a` (committed `f.ts`) and `b` (committed `m.ts`), and a loose `notes/x.js`. */
function workspace(): string {
	const ws = mkdtempSync(join(tmpdir(), "workspace-"));
	for (const [name, file] of [["a", "f.ts"], ["b", "m.ts"]] as const) {
		mkdirSync(join(ws, name));
		git(join(ws, name), "init", "-q", "-b", "main");
		writeFileSync(join(ws, name, file), "export {};\n");
		git(join(ws, name), "add", "-A");
		git(join(ws, name), "commit", "-q", "-m", "initial");
	}
	mkdirSync(join(ws, "notes"));
	writeFileSync(join(ws, "notes", "x.js"), "1;\n");
	return ws;
}

test("treeFingerprint: a workspace lists each repository's changes under its folder", () => {
	const ws = workspace();
	const before = fingerprint(ws);
	writeFileSync(join(ws, "a", "f.ts"), "export const f = 1;\n");
	writeFileSync(join(ws, "b", "n.ts"), "export {};\n");
	assert.deepEqual(changedPaths(before, fingerprint(ws), ws), ["a/f.ts", "b/n.ts"]);
});

test("treeFingerprint: a commit in one workspace repository counts the files it touched", () => {
	const ws = workspace();
	const before = fingerprint(ws);
	writeFileSync(join(ws, "b", "c.ts"), "export {};\n");
	git(join(ws, "b"), "add", "c.ts");
	git(join(ws, "b"), "commit", "-q", "-m", "c");
	const after = fingerprint(ws);
	assert.notEqual(after.heads?.b, before.heads?.b);
	assert.deepEqual(changedPaths(before, after, ws), ["b/c.ts"]);
});

test("treeFingerprint: a file outside the workspace repositories counts, an ignored one doesn't", () => {
	const ws = workspace();
	const ignore = ["docs/**"];
	const before = fingerprint(ws, ignore);
	writeFileSync(join(ws, "notes", "x.js"), "2;\n");
	mkdirSync(join(ws, "docs"));
	writeFileSync(join(ws, "docs", "y.md"), "y\n");
	assert.deepEqual(changedPaths(before, fingerprint(ws, ignore), ws, ignore), ["notes/x.js"]);
});

test("treeFingerprint: a workspace repository over the limit is blind, the others still compare", () => {
	const ws = workspace();
	const before = treeFingerprint(ws, [], {}, { maxEntries: 2 });
	assert.ok(before);
	for (const n of [1, 2, 3]) writeFileSync(join(ws, "a", `${n}.ts`), "");
	writeFileSync(join(ws, "b", "m.ts"), "export const m = 1;\n");
	const after = treeFingerprint(ws, [], {}, { maxEntries: 2 });
	assert.ok(after);
	assert.deepEqual(after.blind, ["a"]);
	assert.deepEqual(changedPaths(before, after, ws), ["b/m.ts"]);
});

test("treeFingerprint: past the deadline every workspace part is blind", () => {
	const tree = treeFingerprint(workspace(), [], {}, { deadline: Date.now() - 1 });
	assert.ok(tree);
	assert.deepEqual(tree.blind, ["", "a", "b"]);
	assert.deepEqual(tree.files, {});
});

test("treeFingerprint: a removed workspace repository counts the files it listed", () => {
	const ws = workspace();
	writeFileSync(join(ws, "a", "f.ts"), "export const f = 2;\n");
	const before = fingerprint(ws);
	rmSync(join(ws, "a"), { recursive: true, force: true });
	assert.ok(changedPaths(before, fingerprint(ws), ws).includes("a/f.ts"));
});


test("callChanges: in a workspace, text targets count only inside a blind part", () => {
	const ws = "/ws";
	const tree = (blind: string[]) => ({ head: "", files: {}, heads: { a: "1", b: "2" }, blind });
	const writes = (blind: string[], command: string) => callChanges(tree(blind), tree(blind), ws, { command, cwd: ws });
	assert.deepEqual(writes(["a"], "echo > a/x"), ["a/x"]);
	assert.deepEqual(writes(["a"], "echo > b/x"), []);
	assert.deepEqual(writes([""], "echo > loose.js"), ["loose.js"]);
	assert.deepEqual(writes([""], "echo > a/x"), []);
	assert.deepEqual(callChanges(tree([]), tree(["a"]), ws, { command: "echo > a/x", cwd: ws }), ["a/x"], "blind in either tree");
	assert.deepEqual(callChanges(undefined, undefined, ws, { command: "echo > a/x", cwd: ws }), ["a/x"], "no tree: the text, as before");
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

test("shellWriteTargets: home, environment and assigned variables are expanded", (t) => {
	const project = mkdtempSync(join(tmpdir(), "no-git-"));
	const home = mkdtempSync(join(tmpdir(), "home-"));
	t.after(() => [project, home].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
	const env = { HOME: home, TMPDIR: "/tmp/t" };
	const targets = (command: string) => shellWriteTargets(command, project, project, env);
	for (const none of ["echo x > ~/notes.txt", "echo x > ~", "echo x > $HOME/n", "echo x > ${HOME}/n", "echo x > $TMPDIR/n"]) {
		assert.deepEqual(targets(none), [], none);
	}
	assert.deepEqual(targets("OUT=src && echo x > $OUT/a.ts"), ["src/a.ts"]);
	assert.deepEqual(targets("export OUT=src; echo x > ${OUT}/a.ts"), ["src/a.ts"]);
	assert.deepEqual(targets(`P=${project}; echo x > $P/src/a.ts`), ["src/a.ts"], "a value inside the project still counts");
	assert.deepEqual(targets("OUT=/tmp/x echo y > $OUT/a.ts"), ["$OUT/a.ts"], "a prefix assignment isn't expanded for its own command");
	assert.deepEqual(targets(`export HOME=${project}/.home && echo x > ~/cfg`), ["~/cfg"], "HOME the command sets is unknown");
});

test("shellWriteTargets: a target that can't be expanded is judged by its literal start", (t) => {
	const project = mkdtempSync(join(tmpdir(), "no-git-"));
	t.after(() => rmSync(project, { recursive: true, force: true }));
	const targets = (command: string) => shellWriteTargets(command, project, project, {});
	assert.deepEqual(targets("S=/tmp/x && for e in a b; do npm test > $S/t-$e.log 2>&1; done"), []);
	assert.deepEqual(targets("echo x > $UNKNOWN/a.ts"), ["$UNKNOWN/a.ts"]);
	assert.deepEqual(targets("echo x > src/$name.ts"), ["src/$name.ts"]);
	assert.deepEqual(targets('echo x > "$(mktemp)"'), ["$(mktemp)"]);
	assert.deepEqual(targets(`echo x > ${project}/src/$name.ts`), ["src/$name.ts"], "an unknown part inside the project counts");
});

test("shellWriteTargets: a write the hook can't place still counts as written", (t) => {
	const parent = mkdtempSync(join(tmpdir(), "parent-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const project = join(parent, "app");
	mkdirSync(project);
	const targets = (command: string, env: NodeJS.ProcessEnv = {}, powershell = false, dir = project) => shellWriteTargets(command, dir, dir, env, powershell);
	assert.deepEqual(targets(`ROOT=${parent}; for r in app lib; do echo x > $ROOT/$r/a.ts; done`), ["$ROOT/$r/a.ts"], "a folder above the project");
	assert.deepEqual(targets("echo x > ~/$r/a.ts", { HOME: parent }), ["~/$r/a.ts"], "home above the project");
	const shellKept = { _: "/usr/local/bin/node", PWD: "/elsewhere", OLDPWD: "/elsewhere", OUTDIR: "/tmp/o" };
	for (const name of ["_", "PWD", "OLDPWD", "OUTDIR"]) {
		assert.deepEqual(targets(`mkdir -p src/gen && echo x > $${name}/a.ts`, shellKept), [`$${name}/a.ts`], `$${name} isn't read from the environment`);
	}
	assert.deepEqual(targets("OUT=reports; [ -n \"$CI\" ] && OUT=/tmp/ci; npm test > $OUT/junit.xml"), ["$OUT/junit.xml"], "two values make it unknown");
	assert.deepEqual(targets("OUT=src && echo x > $OUT/a.ts && OUT=/tmp/x && echo y > $OUT/b.log"), ["$OUT/a.ts", "$OUT/b.log"]);
	assert.deepEqual(targets("OUT=src; OUT=src; echo x > $OUT/a.ts"), ["src/a.ts"], "the same value twice is still known");
	assert.deepEqual(targets("HOME=/tmp/a; [ -n \"$CI\" ] && HOME=/tmp/b; echo x > $HOME/n", { HOME: "/tmp/h" }), ["$HOME/n"], "two values hide the environment's");
	assert.deepEqual(targets("echo x > $HOME/n", { HOME: "/tmp/h" }, true), ["$HOME/n"], "PowerShell variables aren't expanded");
	assert.deepEqual(targets("echo x > '$HOME/n'", { HOME: "/tmp/h" }), ["$HOME/n"], "single quotes keep $ literal");
	assert.deepEqual(targets('echo x > "~/n"', { HOME: "/tmp/h" }), ["~/n"], "quotes keep ~ literal");
	assert.deepEqual(targets("echo x > $constructor/a.ts"), ["$constructor/a.ts"], "names aren't looked up on the object prototype");
	assert.deepEqual(targets("echo x > ~/n"), ["~/n"], "without HOME, ~ is unknown");
	const link = join(parent, "link");
	symlinkSync(project, link);
	assert.deepEqual(targets(`P=${project}; echo x > $P/src/a.ts`, {}, false, link), ["$P/src/a.ts"], "the project's real path");
	const windows = "C:\\w\\p";
	assert.deepEqual(targets("P=/c/w/p; echo x > $P/src/a.ts", {}, false, windows), ["$P/src/a.ts"], "a path rooted differently from the project");
});

test("shellWriteTargets: only a plain word with names bound once is expanded", (t) => {
	const parent = mkdtempSync(join(tmpdir(), "parent-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const project = join(parent, "app");
	mkdirSync(project);
	const targets = (command: string, env: NodeJS.ProcessEnv = {}) => shellWriteTargets(command, project, project, env);
	assert.deepEqual(targets("d=/tmp/logs; npm test > $d/t.log; for d in src lib; do echo x > $d/index.ts; done"), ["$d/t.log", "$d/index.ts"], "for binds it again");
	assert.deepEqual(targets('OUT=/tmp/x; if [ -n "$CI" ]; then OUT=src/gen; fi; echo x > $OUT/a.ts'), ["$OUT/a.ts"], "an assignment after then");
	assert.deepEqual(targets("X=/tmp/x; read X; echo y > $X/a.ts"), ["$X/a.ts"], "read binds it");
	assert.deepEqual(targets('[ -n "$CI" ] && export HOME=/tmp/ci; echo x > ~/app/src/a.ts', { HOME: parent }), ["~/app/src/a.ts"], "HOME the command mentions");
	assert.deepEqual(targets("cd src && OUT=/tmp/x && echo x > $OUT/a.ts"), ["$OUT/a.ts"], "a command that moves");
	assert.deepEqual(targets(`P=${project}; echo x > "$P"/src/a.ts`).length, 1, "a quoted part");
	assert.deepEqual(targets(`P=${project}; echo x > $P"/src/a.ts"`).length, 1, "a quote later in the word");
	assert.deepEqual(targets("echo x > ~/My\\ Projects/app/src/a.ts", { HOME: parent }).length, 1, "an escaped space");
	assert.deepEqual(targets("echo x > $HOME/*.log", { HOME: "/tmp/h" }), ["$HOME/*.log"], "a glob");
	for (const command of ["OUT=/tmp/logs; . ./env.sh; echo x > $OUT/gen.ts", "OUT=/tmp/logs; source env.sh; echo x > $OUT/gen.ts", 'OUT=/tmp/logs; eval "$c"; echo x > $OUT/gen.ts']) {
		assert.deepEqual(targets(command), ["$OUT/gen.ts"], command);
	}
	for (const command of [
		"OUT=/tmp/logs; if [ -f .env ]; then . ./.env; fi; echo x > $OUT/gen.ts",
		"OUT=/tmp/logs; { source env.sh; }; echo x > $OUT/gen.ts",
		"OUT=/tmp/logs; (. ./env.sh); echo x > $OUT/gen.ts",
		"OUT=/tmp/logs; builtin source env.sh; echo x > $OUT/gen.ts",
		"OUT=/tmp/logs; export $(grep -v '^#' .env | xargs); echo x > $OUT/gen.ts",
		"OUT=/tmp/logs; (cd src && make); echo x > $OUT/gen.ts",
	]) {
		assert.deepEqual(targets(command), ["$OUT/gen.ts"], command);
	}
	assert.deepEqual(targets('[ -n "$CI" ] && OUT=/tmp/build; npm test > $OUT.log'), ["$OUT.log"], "an empty value would land here");
	assert.deepEqual(targets("P=/tmp/p; echo x > ${P}out.log"), ["${P}out.log"], "a name not followed by /");
	assert.deepEqual(targets(". ./ci-env.sh && npm test > $TMPDIR/test.log", { TMPDIR: "/tmp/t" }), ["$TMPDIR/test.log"], "a sourced file may set the environment");
	assert.deepEqual(targets('[ -n "$CI" ] && BUILD_DIR=/tmp/ci; make > $BUILD_DIR/build.log', { BUILD_DIR: "build" }), ["$BUILD_DIR/build.log"], "the environment has another value");
	assert.deepEqual(targets("BUILD_DIR=/tmp/ci; make > $BUILD_DIR/build.log", { BUILD_DIR: "/tmp/ci" }), [], "the same value as the environment's");
	assert.deepEqual(targets("echo x | tee ~/log $TMPDIR/b", { HOME: "/tmp/h", TMPDIR: "/tmp/t" }), ["~/log", "$TMPDIR/b"], "tee operands aren't expanded");
});
