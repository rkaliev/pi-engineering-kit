import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { approvalReminder, taskFileReminders, taskFileWarning } from "../extensions/lib/approvals.ts";
import { slowGit } from "./slow-git.ts";
import { allLandings, baseBranch, checkWorkDocs, finishedWorkDocs, WORK_DOC_DIRS } from "../extensions/lib/workdocs.ts";

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


const TASK = "docs/tasks/2026-01-01-a.md";

/** A repo on `main` with one commit; returns a git runner and a file writer. */
function repo(dir = mkdtempSync(join(tmpdir(), "workdocs-"))) {
	mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) => {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.trim();
	};
	const write = (files: Record<string, string>) => {
		for (const [name, content] of Object.entries(files)) {
			mkdirSync(resolve(dir, name, ".."), { recursive: true });
			writeFileSync(join(dir, name), content);
		}
	};
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	write({ "README.md": "x\n" });
	git("add", "-A");
	git("commit", "-qm", "init");
	const commit = (files: Record<string, string>) => {
		write(files);
		git("add", "-A");
		git("commit", "-qm", "change");
	};
	return { dir, git, write, commit };
}

const action = (command: string, dir: string, dirs?: string[]) => checkWorkDocs(command, dir, dirs)?.action ?? "allow";

test("base branch: origin/HEAD first, then main or master", () => {
	const { dir, git } = repo();
	assert.equal(baseBranch(dir), "main");
	git("branch", "-m", "master");
	assert.equal(baseBranch(dir), "master");
	git("update-ref", "refs/remotes/origin/trunk", "HEAD");
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
	assert.equal(baseBranch(dir), "trunk");
	assert.equal(baseBranch(mkdtempSync(join(tmpdir(), "nogit-"))), undefined);
});

test("a task file on the work branch may be pushed, but not proposed or merged", () => {
	const { dir, git, commit } = repo();
	git("switch", "-qc", "feat/a");
	commit({ [TASK]: "# A\n\n## Plan\n\n- [ ] task\n", "docs/tasks/2026-01-02-b.md": "# B\n" });

	assert.equal(action("git push -u origin feat/a", dir), "allow", "backing up the work branch is fine");
	assert.equal(action("git push", dir), "allow");
	const pr = checkWorkDocs("gh pr create --fill", dir);
	assert.equal(pr?.action, "block");
	assert.match(pr!.reason!, /docs\/tasks\/2026-01-01-a\.md/);
	assert.match(pr!.reason!, /2026-01-02-b\.md/);
	assert.match(pr!.reason!, /Follow-ups/);
	assert.match(pr!.reason!, /git rm/);
	assert.equal(action("cd . && gh pr merge 12 --squash", dir), "block");
	assert.equal(action("glab mr create", dir), "block");
	assert.equal(action("git push origin feat/a:main", dir), "block", "a refspec that lands on the base");
	assert.equal(action("git push origin HEAD:refs/heads/main", dir), "block");
	assert.equal(action("git -c user.name=x -C . push origin feat/a:main", dir), "block", "git's own options before the subcommand");
	assert.equal(action("git log --oneline commit", dir), "allow", "only the subcommand counts");
	assert.equal(action("echo 'gh pr create'", dir), "allow", "quoted text is not a command");

	git("switch", "-q", "main");
	assert.equal(action("git merge feat/a", dir), "block");
	assert.equal(action("git merge --abort", dir), "allow");

	git("switch", "-q", "feat/a");
	git("rm", "-rq", "docs/tasks");
	git("commit", "-qm", "docs: remove the task file");
	assert.equal(action("gh pr create --fill", dir), "allow", "deleted: nothing left to leak");
	git("switch", "-q", "main");
	assert.equal(action("git merge feat/a", dir), "allow");
});

test("on the base branch: pushing working docs or committing them is blocked", () => {
	const { dir, git, write } = repo();
	write({ [TASK]: "# A\n" });
	git("add", TASK);
	const commit = checkWorkDocs("git commit -m 'docs: plan'", dir);
	assert.equal(commit?.action, "block");
	assert.match(commit!.reason!, /work branch/);
	git("switch", "-qc", "feat/b");
	assert.equal(action("git commit -m 'docs: plan'", dir), "allow", "committing on a work branch is fine");
	git("commit", "-qm", "docs: plan");
	git("switch", "-q", "main");
	git("merge", "-q", "feat/b");
	assert.equal(action("git push", dir), "block");
	assert.equal(action("git push origin main", dir), "block");
});

test("no task file lives on the base branch, open or not; other files there are fine", () => {
	const { dir, commit, write, git } = repo();
	commit({ "docs/tasks/openapi.yaml": "openapi: 3.1.0\n", "docs/specs/old.md": "# a pre-0.11 spec\n" });
	assert.equal(action("git push", dir), "allow", "non-Markdown files and the old folders don't count");
	commit({ [TASK]: "# A\n\n## Plan\n\n- [x] one\n- [ ] two\n" });
	assert.match(checkWorkDocs("git push", dir)!.reason!, /docs\/tasks\/2026-01-01-a\.md/, "an unfinished task file is no exception");
	git("rm", "-q", TASK);
	git("commit", "-qm", "docs: remove");
	write({ [TASK]: "# A\n" });
	assert.equal(action("git push", dir), "allow", "what is pushed is the commit, not the working tree");
});

test("custom or empty work-doc dirs; outside git nothing is checked", () => {
	const { dir, git, commit } = repo();
	git("switch", "-qc", "feat/c");
	commit({ "work/x.md": "# X\n", [TASK]: "# A\n" });
	assert.equal(action("gh pr create", dir, []), "allow", "disabled");
	assert.match(checkWorkDocs("gh pr create", dir, ["work"])!.reason!, /work\/x\.md/);
	assert.doesNotMatch(checkWorkDocs("gh pr create", dir, ["work"])!.reason!, /docs\/tasks/);
	const plain = mkdtempSync(join(tmpdir(), "nogit-"));
	assert.equal(action("gh pr create", plain), "allow");
	rmSync(plain, { recursive: true, force: true });
});

test("finished task files: every box in the Plan section ticked, in the working tree", () => {
	const { dir, write } = repo();
	write({
		[TASK]: "# A\n\n## Scope\n\n- [ ] a box outside the Plan does not count\n\n## Plan\n\n### Task 1\n\n- [x] one\n- [X] two\n\n## Progress\n\nTask 1: complete\n",
		"docs/tasks/2026-01-02-b.md": "# B\n\n## Plan\n\n- [x] one\n- [ ] two\n",
		"docs/tasks/2026-01-03-c.md": "# C: designed, no plan yet\n\n## Success criteria\n\n- [x] a list outside the Plan\n",
		"docs/tasks/nested/2026-01-04-d.md": "# D\n\n## Plan\n\n- [x] one\n",
		"docs/tasks/2026-01-05-e.md": "# E\n\n## Plan\n\nNo tasks yet.\n",
	});
	assert.deepEqual(finishedWorkDocs(dir).sort(), [TASK, "docs/tasks/nested/2026-01-04-d.md"]);
	assert.deepEqual(finishedWorkDocs(dir, []), []);
});

test("push options that take a separate value don't name the remote or a refspec", () => {
	const push = (command: string) => {
		const l = allLandings(command.split(" "))[0];
		return l?.kind === "push" ? { remote: l.remote, refspecs: l.refspecs } : l;
	};
	for (const flag of ["-o", "--push-option", "--repo", "--receive-pack", "--exec"]) {
		assert.deepEqual(push(`git push ${flag} x origin`), { remote: "origin", refspecs: [] }, flag);
	}
	assert.deepEqual(push("git push --push-option=x origin main"), { remote: "origin", refspecs: ["main"] });
	assert.deepEqual(push("git push -u origin feat/a"), { remote: "origin", refspecs: ["feat/a"] }, "a flag without a value takes nothing");
	assert.deepEqual(push("git push -o -o origin main"), { remote: "origin", refspecs: ["main"] }, "a value may start with a dash");
	for (const repo of ["git push --repo origin", "git push --repo=origin"]) assert.deepEqual(push(repo), { remote: "origin", refspecs: [] }, repo);
});

/** A folder outside git holding `a` on `feat/x` with a committed task file, and `b` on `feat/y` without one. */
function workspace(aDirs?: string[]) {
	const root = temp("workdocs-ws-");
	const a = repo(join(root, "a"));
	a.git("switch", "-qc", "feat/x");
	a.commit({ [TASK]: "# A\n" });
	const b = repo(join(root, "b"));
	b.git("switch", "-qc", "feat/y");
	b.commit({ "src/b.ts": "x\n" });
	const dirsFor = (r: string) => (r === join(root, "a") && aDirs ? aDirs : WORK_DOC_DIRS);
	const check = (command: string, cwd = root, powershell = false, slow: string[] = []) => checkWorkDocs(command, root, undefined, { cwd, repos: ["a", "b"], dirsFor, powershell, slow });
	return { root, a, b, check };
}

test("in a workspace, a landing is judged in the repository it lands in", () => {
	const { root, check } = workspace();
	const act = (command: string, cwd?: string) => check(command, cwd)?.action ?? "allow";
	assert.equal(act("cd a && gh pr create"), "block");
	assert.equal(act("git -C a push origin feat/x:main"), "block");
	assert.equal(act("gh pr create", join(root, "a")), "block", "a command started inside the repository");
	assert.equal(act("cd b && gh pr create"), "allow");
});

test("in a workspace, a repository's workDocs folders decide its task files", () => {
	const { a, check } = workspace(["plans"]);
	assert.equal(check("cd a && gh pr create")?.action ?? "allow", "allow", "docs/tasks is not a's task-file folder");
	a.commit({ "plans/p.md": "# P\n" });
	const pr = check("cd a && gh pr create");
	assert.equal(pr?.action, "block");
	assert.match(pr!.reason!, /plans\/p\.md/);
});

test("in a workspace, a landing whose folder the guard can't tell is blocked", () => {
	assert.equal(workspace().check("Set-Location a; gh pr create", undefined, true)?.action, "block", "any PowerShell landing");
	const pr = workspace().check("cd $D && gh pr create");
	assert.equal(pr?.action, "block");
	assert.match(pr!.reason!, /can't tell which repository/);
});

test("taskFileReminders names the workspace repositories it had no time for or found slow", () => {
	const { root } = workspace();
	assert.deepEqual(taskFileReminders(root, () => WORK_DOC_DIRS, Date.now() - 1), { approved: [], finished: [], onBase: undefined, workspace: true, skipped: ["a", "b"] });
	assert.deepEqual(taskFileReminders(root, () => WORK_DOC_DIRS, Date.now() + 60_000, undefined, ["a"]).skipped, ["a"], "a repository found slow");
	assert.equal(taskFileWarning(["a", "b"]), "Task-file reminders skipped (no time left, or slow in this session): a, b");
	assert.equal(taskFileWarning([]), undefined);
});

test("in a workspace, a PR that names its repository, or starts outside git, can't be placed and is blocked", () => {
	const { check } = workspace();
	for (const command of ["gh pr create -R org/a -H feat/x", "GH_REPO=org/a gh pr create -H feat/x", "gh pr merge https://github.com/org/a/pull/12", "cd a && gh pr create -R org/a"]) {
		assert.equal(check(command)?.action, "block", command);
	}
});

test("in a workspace, an unplaced commit is judged in every repository, and no task-file folders anywhere means no block", () => {
	const { root, b, check } = workspace();
	assert.equal(check("cd $D && git commit -m x")?.action ?? "allow", "allow", "no repository is on its base with a staged task file");
	b.git("switch", "-q", "main");
	b.write({ "docs/tasks/s.md": "# S\n" });
	b.git("add", "docs/tasks/s.md");
	assert.equal(check("cd $D && git commit -m x")?.action, "block", "b is on main with a staged task file");
	const off = checkWorkDocs("cd $D && gh pr create", root, [], { cwd: root, repos: ["a", "b"], dirsFor: () => [] });
	assert.equal(off, undefined, '"workDocs": [] everywhere turns the rule off');
});

test("taskFileReminders names a repository whose git ran out of the time left, and its base branch lookup stays within it", () => {
	const { root, a } = workspace();
	// git hangs 10 s, far past the deadlines below, so a lookup that waits for it can't pass on a loaded machine either.
	const status = slowGit(realpathSync(join(root, "a")), "status", 10);
	try {
		const started = Date.now();
		const due = taskFileReminders(root, () => WORK_DOC_DIRS, Date.now() + 1000);
		assert.ok(due.skipped.includes("a"), JSON.stringify(due));
		assert.ok(Date.now() - started < 4500, "within the 1 s deadline, under git's own 5 s cap per call");
	} finally {
		status.restore();
	}
	a.write({ "docs/tasks/t.md": "# T\n\nStatus: design approved (2026-11-04)\n" });
	const base = slowGit(realpathSync(join(root, "a")), ["symbolic-ref", "rev-parse"], 10);
	try {
		const started = Date.now();
		const due = taskFileReminders(root, () => WORK_DOC_DIRS, Date.now() + 3000);
		assert.deepEqual(due.approved, ["a/docs/tasks/t.md"]);
		assert.ok(Date.now() - started < 4800, "the base branch lookup ends by the 3 s deadline, under git's own 5 s cap per call");
	} finally {
		base.restore();
	}
});

test("approvalReminder: in a workspace, the commit it suggests runs in each repository", () => {
	const text = approvalReminder(["a/docs/tasks/t.md", "b/docs/tasks/u.md"], "main in a", true);
	assert.match(text, /git -C a add docs\/tasks\/t\.md && git -C a commit/);
	assert.match(text, /git -C b add docs\/tasks\/u\.md && git -C b commit/);
	assert.match(text, /You are on main in a/);
	assert.match(text, /git -C <repo> switch -c/, "a work branch is created in the repository, not the workspace folder");
	assert.match(approvalReminder(["docs/tasks/t.md"]), /git add docs\/tasks\/t\.md && git commit/, "one repository, as before");
});

test("in a workspace, a PR naming its repository in another spelling, or after an export, can't be placed", () => {
	const { check } = workspace();
	for (const command of ["cd b && gh pr create -Rorg/a -H feat/x", "export GH_REPO=org/a; cd b && gh pr create -H feat/x", "export GIT_DIR=a/.git; git push origin feat/x:main"]) {
		assert.equal(check(command)?.action, "block", command);
	}
});

test("in a workspace, a heredoc body that mentions a landing is no landing", () => {
	assert.equal(workspace().check("cat > notes.md <<'EOF'\nOpen it with gh pr create --fill.\nEOF")?.action ?? "allow", "allow");
});

test("in a workspace, a PowerShell landing is told to use Bash", () => {
	assert.match(String(workspace().check("Set-Location a; gh pr create", undefined, true)?.reason), /Bash tool/);
});

test("in a workspace, an unplaced commit is judged within a deadline, and a slow repository can't be judged", () => {
	const { root, check } = workspace();
	assert.equal(check("cd $D && git commit -m x", undefined, false, ["a"])?.action, "block", "a was slow this session");
	const slow = slowGit(realpathSync(join(root, "a")));
	try {
		const started = Date.now();
		assert.equal(check("cd $D && git commit -m x")?.action, "block");
		assert.ok(Date.now() - started < 3900, "within the deadline, not git's 4 s hangs");
	} finally {
		slow.restore();
	}
});

test("in a workspace, a landing after a heredoc or a quoted <<, or in a shell's heredoc, is still judged", () => {
	const { check } = workspace();
	for (const command of ["bash <<'EOF'\ncd a && gh pr create --fill\nEOF", "echo '<<X'\ncd a && gh pr create --fill", "gh pr create --fill"]) {
		assert.equal(check(command)?.action, "block", command);
	}
});

test("in a workspace, an unplaced commit with no task-file folders anywhere isn't held, even with a slow repository", () => {
	const { root } = workspace();
	const off = checkWorkDocs("cd $D && git commit -m x", root, [], { cwd: root, repos: ["a", "b"], dirsFor: () => [], slow: ["a"] });
	assert.equal(off, undefined);
});

test("in a workspace, a landing from a checkout nested in another repository's folder can't be placed", () => {
	const { root, a, check } = workspace();
	a.git("worktree", "add", "-q", join(root, "b", "wt"), "-b", "feat/w");
	assert.equal(check("cd b/wt && gh pr create --fill")?.action, "block");
});

test("in a workspace, a repository's own worktree inside its folder is that repository", () => {
	const { root, a, check } = workspace();
	a.git("worktree", "add", "-q", join(root, "a", ".worktrees", "x"), "-b", "feat/w");
	assert.equal(check("cd a/.worktrees/x && git commit -m x")?.action ?? "allow", "allow", "a commit on its work branch");
	assert.match(String(check("cd a/.worktrees/x && gh pr create --fill")?.reason), /Task files would reach/, "judged in the worktree, by a's folders");
});

test("in a workspace, a quoted argument with .. and glob characters doesn't hide the folder", () => {
	const { check } = workspace();
	assert.match(String(check('cd a && gh pr create --title "handle ../ paths [WIP]"')?.reason), /Task files would reach/);
});

// macOS and Windows run gh, glab and git in any letter case: a landing is the same landing.
test("landing sees gh, glab and git in any letter case", () => {
	for (const [upper, lower] of [
		["GH pr merge 1", "gh pr merge 1"],
		["GH pr create", "gh pr create"],
		["GLAB mr merge 1", "glab mr merge 1"],
		["GIT push origin main", "git push origin main"],
		["GIT merge x", "git merge x"],
		["GIT commit -m x", "git commit -m x"],
	]) {
		assert.notEqual(allLandings(lower.split(" "))[0], undefined, lower);
		assert.deepEqual(allLandings(upper.split(" "))[0], allLandings(lower.split(" "))[0], upper);
	}
});

test("landing skips an assignment or argument whose base name is git or gh and finds the real call", () => {
	for (const [before, plain] of [
		[["HOME=/srv/git", "git", "push", "origin", "main"], ["git", "push", "origin", "main"]],
		[["GIT_SSH_COMMAND=ssh -i ~/.ssh/git", "git", "push", "origin", "main"], ["git", "push", "origin", "main"]],
		[["sudo", "-u", "Git", "git", "merge", "x"], ["git", "merge", "x"]],
		[["flock", "/tmp/gh", "gh", "pr", "merge", "1"], ["gh", "pr", "merge", "1"]],
	]) {
		assert.deepEqual(allLandings(before)[0], allLandings(plain)[0], before.join(" "));
	}
});

test("allLandings lists every commit, merge, push or PR call in a segment, in order", () => {
	assert.deepEqual(allLandings(["find", ".", "-exec", "git", "commit", "-qm", "x", "';'", "-exec", "git", "merge", "feat/a", "';'"]).map((l) => l.kind), ["commit", "merge"]);
});
