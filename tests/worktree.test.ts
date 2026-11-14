import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { slowGit } from "./slow-git.ts";
import { callChanges, callChangesSplit, changedPaths, ignoreFilter, MAX_ENTRIES, shellWriteTargets, treeFingerprint } from "../extensions/lib/worktree.ts";

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

test("treeFingerprint: a workspace repository late once is blind for that call; late twice running, it is remembered", () => {
	const ws = workspace();
	writeFileSync(join(ws, "b", "m.ts"), "export const m = 1;\n");
	const { log, restore } = slowGit(realpathSync(join(ws, "a")));
	try {
		const why1: { slowParts?: string[] } = {};
		const first = treeFingerprint(ws, [], why1);
		assert.ok(first);
		assert.deepEqual(first.blind, ["a"], "only the slow repository");
		assert.ok("b/m.ts" in first.files && "notes/x.js" in first.files, "the other parts are still fingerprinted");
		assert.deepEqual(why1.slowParts ?? [], [], "one late fingerprint is not remembered");
		const why2: { slowParts?: string[] } = {};
		assert.deepEqual(treeFingerprint(ws, [], why2, { previous: first })?.blind, ["a"]);
		assert.deepEqual(why2.slowParts, ["a"], "late twice running");
		const calls = readFileSync(log, "utf8");
		assert.deepEqual(treeFingerprint(ws, [], {}, { skip: ["a"] })?.blind, ["a"]);
		assert.equal(readFileSync(log, "utf8"), calls, "a remembered part runs no git");
	} finally {
		restore();
	}
});

test("treeFingerprint: a workspace repository whose HEAD read runs out of time is blind, not a repository without commits", () => {
	const ws = workspace();
	const { restore } = slowGit(realpathSync(join(ws, "a")), "--verify");
	try {
		const tree = treeFingerprint(ws, []);
		assert.ok(tree);
		assert.deepEqual(tree.blind, ["a"]);
		assert.equal(tree.heads?.a, undefined);
	} finally {
		restore();
	}
});

test("treeFingerprint: a part that goes blind keeps its last fingerprint, so neither noise nor changes are lost", () => {
	const ws = workspace();
	writeFileSync(join(ws, "a", "f.ts"), "export const f = 2;\n");
	const seen = fingerprint(ws);
	const blind = treeFingerprint(ws, [], {}, { deadline: Date.now() - 1, previous: seen });
	assert.ok(blind);
	assert.deepEqual(blind.blind, ["", "a", "b"]);
	assert.equal(blind.files["a/f.ts"], seen.files["a/f.ts"], "carried");
	assert.equal(blind.heads?.a, seen.heads?.a);
	assert.deepEqual(callChanges(seen, blind, ws, { command: "ls", cwd: ws }), [], "nothing changed");
	writeFileSync(join(ws, "a", "f.ts"), "export const f = 3;\n");
	writeFileSync(join(ws, "notes", "x.js"), "3;\n");
	assert.deepEqual(callChanges(blind, fingerprint(ws), ws, { command: "ls", cwd: ws }), ["a/f.ts", "notes/x.js"], "changed while blind, found once seen again");
});

test("treeFingerprint: a workspace repository whose git fails is blind but not remembered as slow", () => {
	const ws = workspace();
	mkdirSync(join(ws, "c"));
	writeFileSync(join(ws, "c", ".git"), "gitdir: /nonexistent/gitdir\n");
	const why: { slowParts?: string[] } = {};
	assert.deepEqual(treeFingerprint(ws, [], why)?.blind, ["c"]);
	assert.deepEqual(why.slowParts ?? [], []);
});

test("callChanges: a part blind before and fingerprinted now has no baseline, so its listed files don't count", () => {
	const ws = workspace();
	writeFileSync(join(ws, "a", "f.ts"), "export const f = 2;\n");
	const before = treeFingerprint(ws, [], {}, { maxEntries: 0 });
	assert.ok(before);
	assert.deepEqual(before.blind, ["", "a"]);
	assert.deepEqual(callChanges(before, fingerprint(ws), ws, { command: "ls", cwd: ws }), []);
});

test("callChanges: a listed file changed in the call where its part goes blind counts in that call", () => {
	const ws = workspace();
	writeFileSync(join(ws, "a", "f.ts"), "export const f = 2;\n");
	const seen = fingerprint(ws);
	writeFileSync(join(ws, "a", "f.ts"), "export const f = 3;\n");
	const blind = treeFingerprint(ws, [], {}, { deadline: Date.now() - 1, previous: seen });
	assert.deepEqual(callChanges(seen, blind, ws, { command: "python gen.py", cwd: ws }), ["a/f.ts"]);
});

test("callChanges: with a blind part, source, . and eval hide names only as the command, not as an argument", () => {
	const ws = "/ws";
	const tree = { head: "", files: {}, heads: { a: "1", b: "2" }, blind: ["svc"] };
	const changes = (command: string) => callChanges(tree, tree, ws, { command, cwd: ws });
	assert.deepEqual(changes("cd a && npx eslint . > $S/lint.log"), [], "`.` as an argument");
	assert.deepEqual(changes("cd a && echo source eval > $S/x.log"), [], "the words as arguments");
	assert.deepEqual(changes(". ./env.sh; echo x > f.ts"), ["f.ts"]);
	assert.deepEqual(changes("if true; then source x; fi; echo x > f.ts"), ["f.ts"]);
	assert.deepEqual(changes("export $(cat .env); echo x > f.ts"), ["f.ts"], "a declaration of names the text doesn't show");
	assert.deepEqual(changes("CDPATH=a; cd src && echo x > f.ts"), ["f.ts"], "CDPATH changes where a move lands");
});

test("callChangesSplit: fingerprint changes are exact; targets read from the command's text are guessed", () => {
	const ws = "/ws";
	const tree = { head: "", files: {}, heads: { a: "1", b: "2" }, blind: ["svc"] };
	assert.deepEqual(callChangesSplit(tree, tree, ws, { command: ". ./env.sh; echo x > f.ts", cwd: ws }), { exact: [], guessed: ["f.ts"] });
	assert.deepEqual(callChangesSplit(undefined, undefined, ws, { command: "echo x > src/a.ts", cwd: ws }), { exact: [], guessed: ["src/a.ts"] }, "no fingerprint: only the text");
	const w = workspace();
	const seen = fingerprint(w);
	writeFileSync(join(w, "a", "f.ts"), "export const f = 9;\n");
	assert.deepEqual(callChangesSplit(seen, fingerprint(w), w, { command: "python gen.py", cwd: w }), { exact: ["a/f.ts"], guessed: [] });
});

test("callChanges: with only symlinks blind, a move the hook can't follow counts only targets under a symlink", () => {
	const ws = workspace();
	const outside = join(mkdtempSync(join(tmpdir(), "linked-")), "o.ts");
	writeFileSync(outside, "1;\n");
	symlinkSync(outside, join(ws, "notes", "o.ts"));
	symlinkSync(mkdtempSync(join(tmpdir(), "linked-")), join(ws, "svc"));
	const tree = fingerprint(ws);
	assert.deepEqual(tree.blind, ["notes/o.ts", "svc"]);
	const changes = (command: string) => callChanges(tree, tree, ws, { command, cwd: ws });
	assert.deepEqual(changes("S=$(mktemp -d); cd a && echo x > $S/x"), [], "the task's own case, with a symlink in the workspace");
	assert.deepEqual(changes("source .venv/bin/activate && pytest > $LOG"), []);
	assert.deepEqual(changes("cd $D && echo x > svc/y.ts"), ["svc/y.ts"], "a target written under the symlink");
});

test("treeFingerprint: a part remembered for the session keeps its stored identities; only a part blind in this call is read again", () => {
	const ws = workspace();
	writeFileSync(join(ws, "a", "f.ts"), "export const f = 2;\n");
	const seen = fingerprint(ws);
	writeFileSync(join(ws, "a", "f.ts"), "export const f = 3;\n");
	const latched = treeFingerprint(ws, [], {}, { skip: ["a"], previous: seen });
	assert.equal(latched?.files["a/f.ts"], seen.files["a/f.ts"], "not read: the part costs no I/O once remembered");
});

test("treeFingerprint: a symlink chain or a path through a symlinked folder that leaves the project is a blind part, never followed", () => {
	const ws = workspace();
	const outside = mkdtempSync(join(tmpdir(), "linked-"));
	writeFileSync(join(outside, "x"), "1;\n");
	symlinkSync(join(outside, "x"), join(ws, "notes", "l2"));
	symlinkSync(join(ws, "notes", "l2"), join(ws, "notes", "l1"));
	symlinkSync(outside, join(ws, "notes", "sub"));
	symlinkSync(join(ws, "notes", "sub", "x"), join(ws, "notes", "c"));
	assert.deepEqual(fingerprint(ws).blind, ["notes/c", "notes/l1", "notes/l2", "notes/sub"]);
});

test("callChanges: with a blind part, a CDPATH in the environment counts every target of a command that moves", () => {
	const tree = { head: "", files: {}, heads: { b: "2" }, blind: ["a"] };
	const saved = process.env.CDPATH;
	process.env.CDPATH = "a";
	try {
		assert.deepEqual(callChanges(tree, tree, "/ws", { command: "cd src && echo x > f.ts", cwd: "/ws" }), ["f.ts"]);
	} finally {
		if (saved === undefined) delete process.env.CDPATH;
		else process.env.CDPATH = saved;
	}
});

test("callChanges: with a blind part, source, . or eval count only in a command position, also inside compound commands", () => {
	const tree = { head: "", files: {}, heads: { b: "2" }, blind: ["a"] };
	const changes = (command: string) => callChanges(tree, tree, "/ws", { command, cwd: "/ws" });
	assert.deepEqual(changes("S=$(mktemp -d); npx eslint . > $S/lint.log"), [], "`.` as an argument of a command that isn't plain shell");
	assert.deepEqual(changes("find . -exec cat {} \\; > $OUT"), []);
	assert.deepEqual(changes("f() ( . ./env.sh; echo x > $OUT ); f"), ["$OUT"], "a function whose body is a subshell");
});

test("callChanges: with a blind part, source after a glued function header or a command prefix's options counts every target", () => {
	const tree = { head: "", files: {}, heads: { b: "2" }, blind: ["a"] };
	const changes = (command: string) => callChanges(tree, tree, "/ws", { command, cwd: "/ws" });
	for (const command of ["f(){ . ./env; }; echo > $S/x", "f()(source ./env); echo > $S/x", "command -p source ./env; echo > $S/x", "time -p . ./env; echo > $S/x", "command -- eval x; echo > $S/x"]) {
		assert.deepEqual(changes(command), ["$S/x"], command);
	}
});

test("callChanges: with a blind part, source in a function or case arm however it is spaced, or after any prefix, counts every target", () => {
	const tree = { head: "", files: {}, heads: { b: "2" }, blind: ["a"] };
	const changes = (command: string) => callChanges(tree, tree, "/ws", { command, cwd: "/ws" });
	for (const command of [
		"function f { . ./env; }; f; echo > $S/x",
		"function f() { . ./env; }; f; echo > $S/x",
		"f () { . ./env; }; f; echo > $S/x",
		"case $M in dev ) . ./env;; esac; echo > $S/x",
		"case $M in\ndev ) . ./env ;;\nesac; echo > $S/x",
		"X=${Y} . ./env; echo > $S/x",
		"X=$(pwd -P) . ./env; echo > $S/x",
		"ROOT=$(git rev-parse --show-toplevel) . ./env; echo > $S/x",
		"PATH=${PATH}:bin source ./env; echo > $S/x",
		"X=1 . ./env; echo > $S/x",
		"! source ./env; echo > $S/x",
		"while true; do . ./env; done; echo > $S/x",
		"if false; then true; else . ./env; fi; echo > $S/x",
		"builtin source ./env; echo > $S/x",
		"exec . ./env; echo > $S/x",
		"X=`git rev-parse --show-toplevel` . ./env; echo > $S/x",
		'X="(" . ./env; echo > $S/x',
		"(X=1 . ./env; echo > $S/x)",
		'X=$(echo "(") . ./env; echo > $S/x',
		"X=$(pwd | sed s/a/b/) . ./env; echo > $S/x",
		"X=$(. ./env; echo > $S/x)",
		"if(. ./env); then echo > $S/x; fi",
		"case x in (a) . ./env;; esac; echo > $S/x",
		"X=${Y:-$(pwd)} . ./env; echo > $S/x",
		"builtin -- source ./env; echo > $S/x",
	]) {
		assert.deepEqual(changes(command), ["$S/x"], command);
	}
});

test("callChanges: with a blind part, any command with case counts every target, however its patterns nest", () => {
	const tree = { head: "", files: {}, heads: { b: "2" }, blind: ["a"] };
	const changes = (command: string) => callChanges(tree, tree, "/ws", { command, cwd: "/ws" });
	for (const command of [
		'( load() { case "$1" in dev) . ./env;; esac; }; load dev; echo > $S/x )',
		'f() { case "$1" in (dev) . ./env;; esac; }; f dev; echo > $S/x',
		'case $f in *.c) grep -c \\( "$f";; *.sh) . ./env;; esac; echo > $S/x',
		'case "$ENV" in ci). ./ci.env;; esac; echo > $S/x',
		"case x in esac; . ./env; echo > $S/x",
		"f() if . ./env; then echo > $S/x; fi; f",
		'f() case "$1" in (dev) . ./env;; esac; f dev; echo > $S/x',
		'coproc case "$1" in (dev) . ./env; echo > $S/x;; esac',
	]) {
		assert.deepEqual(changes(command), ["$S/x"], command);
	}
});

test("case counts every target but doesn't stop a known variable or ~ from being expanded", () => {
	assert.deepEqual(shellWriteTargets('case "$OSTYPE" in darwin*) echo mac;; esac > ~/os.txt', "/ws", "/ws", { HOME: "/home/u" }), [], "~ is the home folder, outside the project");
	const tree = { head: "", files: {}, heads: { b: "2" }, blind: ["svc"], links: ["svc"] };
	assert.deepEqual(callChanges(tree, tree, "/ws", { command: "OUT=svc; case $1 in a) true;; esac; echo > $OUT/x", cwd: "/ws" }), ["svc/x"], "placed under the symlink");
});

test("callChanges: with a blind part, escaped brackets are data and an escaped quote doesn't hide a placed target", () => {
	const tree = { head: "", files: {}, heads: { b: "2" }, blind: ["a"] };
	const changes = (command: string) => callChanges(tree, tree, "/ws", { command, cwd: "/ws" });
	assert.deepEqual(changes("X=$(echo \\( ) . ./env; echo > $S/x"), ["$S/x"], "an escaped ( opens nothing");
	assert.deepEqual(changes('node -e "console.log(\\"hi\\")" > $S/red.log'), [], "a quoted bracket beside an escaped quote is data");
});

test("callChanges: with a blind part, a sourced file's variable is never expanded, so its target counts as written", () => {
	const tree = { head: "", files: {}, heads: { b: "2" }, blind: ["a"] };
	const changes = (command: string) => callChanges(tree, tree, "/ws", { command, cwd: "/ws" });
	assert.deepEqual(changes("OUT=a; echo $(. ./v.sh) > $OUT/x"), ["$OUT/x"]);
	assert.deepEqual(changes("f()(. ./ci-env.sh && npm test > $TMPDIR/test.log); f"), ["$TMPDIR/test.log"], "TMPDIR may be set by the sourced file");
});

test("callChanges: with a blind part, command -v and STARTERS or ) as arguments don't bind", () => {
	const tree = { head: "", files: {}, heads: { b: "2" }, blind: ["a"] };
	const changes = (command: string) => callChanges(tree, tree, "/ws", { command, cwd: "/ws" });
	for (const command of ["command -v source > $S/x", "command -V . > $S/x", "command -v source; echo > $S/x", 'grep -rn "time" . > $S/x', 'rg "(A|B)" . > $S/x', 'grep ")" . > $S/x', 'grep -F "(" . > $S/x', 'rg "{" . > $S/x']) {
		assert.deepEqual(changes(command), [], command);
	}
	for (const command of ["case x in a) . ./env;; esac; echo > $S/x", "case x in a) true;; b) . ./env;; esac; echo > $S/x", "if true; then . ./env; fi; echo > $S/x", '"source" ./env; echo > $S/x']) {
		assert.deepEqual(changes(command), ["$S/x"], command);
	}
});

test("treeFingerprint: a symlink whose text climbs out after a symlinked folder is a blind part", () => {
	const ws = workspace();
	const outside = mkdtempSync(join(tmpdir(), "linked-"));
	mkdirSync(join(outside, "deep"));
	symlinkSync(join(outside, "deep"), join(ws, "notes", "sub"));
	symlinkSync("sub/../x", join(ws, "notes", "l"));
	assert.ok(fingerprint(ws).blind?.includes("notes/l"));
});

test("callChanges: with a blind part, source, . or eval in a case arm, a function body or after a redirection still hides names", () => {
	const ws = "/ws";
	const tree = { head: "", files: {}, heads: { b: "2" }, blind: ["a"] };
	const changes = (command: string, powershell = false) => callChanges(tree, tree, ws, { command, cwd: ws, powershell });
	assert.deepEqual(changes("case $E in p) source x;; esac; echo x > f.ts"), ["f.ts"]);
	assert.deepEqual(changes("f() { . ./env.sh; }; f; echo x > f.ts"), ["f.ts"]);
	assert.deepEqual(changes("2>/dev/null . ./env.sh; echo x > f.ts"), ["f.ts"]);
	assert.deepEqual(changes("./setup.ps1; 'x' > f.ts", true), ["f.ts"], "a PowerShell script may move the caller's location");
});

test("callChanges: with a blind part, a command that moves the shell has its targets placed from every folder it may reach", () => {
	const ws = "/ws";
	const tree = { head: "", files: {}, heads: { b: "2" }, blind: ["a"] };
	const changes = (command: string, powershell = false) => callChanges(tree, tree, ws, { command, cwd: ws, powershell });
	assert.deepEqual(changes("(cd a && echo x > f.ts)"), ["a/f.ts"]);
	assert.deepEqual(changes("pushd a && echo x > f.ts && popd"), ["a/f.ts"]);
	assert.deepEqual(changes("chdir a && echo x > f.ts"), ["f.ts"], "a move the guard's parser doesn't follow: every target counts");
	assert.deepEqual(changes("cd b && true > $S/red.log"), [], "an unknown variable path from a fingerprinted repository");
	assert.deepEqual(changes("cd a && true > $S/red.log"), ["a/$S/red.log"], "from the blind one it may land there");
	assert.deepEqual(changes("cd b && echo x > f.ts"), [], "a fingerprinted repository");
	assert.deepEqual(changes("cd $D && echo x > f.ts"), ["f.ts"], "a move the shell parser can't follow: every target counts");
	assert.deepEqual(changes("source env.sh; echo x > f.ts"), ["f.ts"], "names it can't see: every target counts");
	assert.deepEqual(changes("Set-Location a; 'x' > f.ts", true), ["f.ts"], "PowerShell moves aren't followed: every target counts");
	assert.deepEqual(changes("Set-Location(\"a\"); 'x' > f.ts", true), ["f.ts"]);
	assert.deepEqual(changes("cd..; 'x' > f.ts", true), ["f.ts"]);
	assert.deepEqual(changes("Microsoft.PowerShell.Management\\Set-Location a; 'x' > f.ts", true), ["f.ts"]);
	assert.deepEqual(changes("echo x > f.ts"), [], "no move: placed outside, which is fingerprinted");
});

test("treeFingerprint: a folder symlink in a workspace is not walked; it is a blind part, so writes through it count", () => {
	const ws = workspace();
	const target = mkdtempSync(join(tmpdir(), "linked-"));
	writeFileSync(join(target, "y.ts"), "1;\n");
	symlinkSync(target, join(ws, "svc"));
	symlinkSync(target, join(ws, "notes", "deep"));
	symlinkSync(join(target, "y.ts"), join(ws, "notes", "y.ts"));
	const tree = fingerprint(ws);
	assert.deepEqual(tree.blind, ["notes/deep", "notes/y.ts", "svc"], "the file link points outside the project");
	assert.ok(!Object.keys(tree.files).some((p) => p.startsWith("svc/") || p.startsWith("notes/deep/")));
	assert.deepEqual(callChanges(tree, tree, ws, { command: "echo x > svc/y.ts", cwd: ws }), ["svc/y.ts"]);
	assert.deepEqual(callChanges(tree, tree, ws, { command: "echo x > notes/deep/y.ts", cwd: ws }), ["notes/deep/y.ts"]);
});

test("treeFingerprint: a file symlink in a workspace counts by what it points to inside the project; one pointing outside is blind", () => {
	const ws = workspace();
	writeFileSync(join(ws, "notes", "real.ts"), "1;\n");
	symlinkSync(join(ws, "notes", "real.ts"), join(ws, "notes", "y.ts"));
	const outside = join(mkdtempSync(join(tmpdir(), "linked-")), "o.ts");
	writeFileSync(outside, "1;\n");
	symlinkSync(outside, join(ws, "notes", "o.ts"));
	const before = fingerprint(ws);
	assert.deepEqual(before.blind, ["notes/o.ts"], "not stat'ed: its target may be a slow mount");
	writeFileSync(join(ws, "notes", "real.ts"), "22;\n");
	assert.deepEqual(changedPaths(before, fingerprint(ws), ws), ["notes/real.ts", "notes/y.ts"]);
	assert.deepEqual(callChanges(before, before, ws, { command: "echo x > notes/o.ts", cwd: ws }), ["notes/o.ts"]);
});

test("treeFingerprint: the walk skips OS, editor, dependency and local tool files", () => {
	const ws = workspace();
	const files = [".DS_Store", "notes/.DS_Store", "Thumbs.db", ".claude/settings.local.json", ".claude/scheduled_tasks.lock", ".pi/git/pkg/a.js", ".pi/npm/pkg/a.js", ".idea/workspace.xml", ".vscode/settings.json", "node_modules/x/i.js", "notes/node_modules/y.js"];
	for (const f of files) {
		mkdirSync(join(ws, f, ".."), { recursive: true });
		writeFileSync(join(ws, f), "1");
	}
	const before = fingerprint(ws);
	for (const f of files) writeFileSync(join(ws, f), "22");
	assert.deepEqual(changedPaths(before, fingerprint(ws), ws), []);
});

test("treeFingerprint: in a workspace, a repository's default globs ignore its docs; a folder is pruned only by a <folder>/** glob", () => {
	const ws = workspace();
	const ignore = ["docs/**", "**/*.md"];
	mkdirSync(join(ws, "a", "docs"));
	mkdirSync(join(ws, "guide.md"));
	writeFileSync(join(ws, "guide.md", "index.js"), "1;\n");
	const before = fingerprint(ws, ignore);
	writeFileSync(join(ws, "a", "docs", "d.svg"), "<svg/>");
	writeFileSync(join(ws, "guide.md", "index.js"), "2;\n");
	assert.deepEqual(changedPaths(before, fingerprint(ws, ignore), ws, ignore), ["guide.md/index.js"]);
});

test("treeFingerprint: a repository's own files match its own ignore globs, not a workspace glob for the workspace's folders", () => {
	const ws = workspace();
	mkdirSync(join(ws, "a", ".pi"));
	writeFileSync(join(ws, "a", ".pi", "verify.json"), JSON.stringify({ commands: ["npm test"], ignore: ["gen/**"] }));
	mkdirSync(join(ws, "a", "gen"));
	mkdirSync(join(ws, "a", "scripts"));
	const ignore = ["scripts/**"];
	const before = fingerprint(ws, ignore);
	writeFileSync(join(ws, "a", "gen", "x.ts"), "1;\n");
	writeFileSync(join(ws, "a", "scripts", "build.ts"), "1;\n");
	assert.deepEqual(changedPaths(before, fingerprint(ws, ignore), ws, ignore), ["a/scripts/build.ts"]);
	const filter = ignoreFilter(ws, ignore);
	assert.equal(filter("a/gen/x.ts"), true);
	assert.equal(filter("a/scripts/build.ts"), false);
	assert.equal(filter("scripts/x.ts"), true);
	assert.equal(filter("a\\gen\\x.ts"), true, "a Windows path");
});

test("changedPaths: a workspace commit diff that can't run in time marks the repository folder", () => {
	const ws = workspace();
	const before = fingerprint(ws);
	writeFileSync(join(ws, "b", "c.ts"), "export {};\n");
	git(join(ws, "b"), "add", "c.ts");
	git(join(ws, "b"), "commit", "-q", "-m", "c");
	assert.deepEqual(changedPaths(before, fingerprint(ws), ws, [], Date.now() - 1), ["b/"]);
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

test("shellWriteTargets counts TEE and SED -i targets: the programs run in any letter case", (t) => {
	const project = mkdtempSync(join(tmpdir(), "no-git-"));
	t.after(() => rmSync(project, { recursive: true, force: true }));
	assert.deepEqual(shellWriteTargets("echo x | TEE src/c.ts", project, project), ["src/c.ts"]);
	assert.deepEqual(shellWriteTargets("SED -i '' 's/a/b/' src/d.ts", project, project), ["src/d.ts"]);
});
