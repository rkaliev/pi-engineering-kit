import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { baseBranch, checkWorkDocs, finishedWorkDocs, landing } from "../extensions/lib/workdocs.ts";

const TASK = "docs/tasks/2026-01-01-a.md";

/** A repo on `main` with one commit; returns a git runner and a file writer. */
function repo() {
	const dir = mkdtempSync(join(tmpdir(), "workdocs-"));
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
		const l = landing(command.split(" "));
		return l?.kind === "push" ? { remote: l.remote, refspecs: l.refspecs } : l;
	};
	for (const flag of ["-o", "--push-option", "--repo", "--receive-pack", "--exec"]) {
		assert.deepEqual(push(`git push ${flag} x origin`), { remote: "origin", refspecs: [] }, flag);
	}
	assert.deepEqual(push("git push --push-option=x origin main"), { remote: "origin", refspecs: ["main"] });
	assert.deepEqual(push("git push -u origin feat/a"), { remote: "origin", refspecs: ["feat/a"] }, "a flag without a value takes nothing");
});
