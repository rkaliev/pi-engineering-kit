import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { baseBranch, checkWorkDocs, finishedWorkDocs } from "../extensions/lib/workdocs.ts";

const PLAN = "docs/plans/2026-01-01-a.md";
const OPEN_ROADMAP = "# R\n\n- [x] one\n- [ ] two\n";
const CLOSED_ROADMAP = "# R\n\n- [x] one\n- [x] two\n";

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

test("a plan on the work branch may be pushed, but not proposed or merged", () => {
	const { dir, git, commit } = repo();
	git("switch", "-qc", "feat/a");
	commit({ [PLAN]: "# Plan\n\n- [ ] task\n", "docs/plans/2026-01-01-a.progress.md": "# Ledger\n" });

	assert.equal(action("git push -u origin feat/a", dir), "allow", "backing up the work branch is fine");
	assert.equal(action("git push", dir), "allow");
	const pr = checkWorkDocs("gh pr create --fill", dir);
	assert.equal(pr?.action, "block");
	assert.match(pr!.reason!, /docs\/plans\/2026-01-01-a\.md/);
	assert.match(pr!.reason!, /progress\.md/);
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
	git("rm", "-rq", "docs/plans");
	git("commit", "-qm", "docs: remove working docs");
	assert.equal(action("gh pr create --fill", dir), "allow", "deleted: nothing left to leak");
	git("switch", "-q", "main");
	assert.equal(action("git merge feat/a", dir), "allow");
});

test("on the base branch: pushing working docs or committing them is blocked", () => {
	const { dir, git, write } = repo();
	write({ [PLAN]: "# Plan\n" });
	git("add", PLAN);
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

test("an open roadmap may live on the base branch; a finished one may not", () => {
	const { dir, commit, write } = repo();
	commit({ "docs/specs/2026-01-01-shop-roadmap.md": OPEN_ROADMAP, "docs/specs/openapi.yaml": "openapi: 3.1.0\n" });
	assert.equal(action("git push", dir), "allow", "open roadmap and non-Markdown files don't count");
	commit({ "docs/specs/2026-01-01-shop-roadmap.md": CLOSED_ROADMAP });
	assert.match(checkWorkDocs("git push", dir)!.reason!, /roadmap/);
	write({ "docs/specs/2026-01-01-shop-roadmap.md": OPEN_ROADMAP });
	assert.equal(action("git push", dir), "block", "what is pushed is the commit, not the working tree");
});

test("custom or empty work-doc dirs; outside git nothing is checked", () => {
	const { dir, git, commit } = repo();
	git("switch", "-qc", "feat/c");
	commit({ "plans/x.md": "# X\n", [PLAN]: "# Plan\n" });
	assert.equal(action("gh pr create", dir, []), "allow", "disabled");
	assert.match(checkWorkDocs("gh pr create", dir, ["plans"])!.reason!, /plans\/x\.md/);
	assert.doesNotMatch(checkWorkDocs("gh pr create", dir, ["plans"])!.reason!, /docs\/plans/);
	const plain = mkdtempSync(join(tmpdir(), "nogit-"));
	assert.equal(action("gh pr create", plain), "allow");
	rmSync(plain, { recursive: true, force: true });
});

test("finished working docs: every checkbox ticked, in the working tree", () => {
	const { dir, write } = repo();
	write({
		[PLAN]: "# Plan\n\n- [x] one\n- [X] two\n",
		"docs/plans/2026-01-01-a.progress.md": "# Ledger\n- [x] Task 1\n",
		"docs/plans/2026-01-02-b.md": "# Plan\n\n- [x] one\n- [ ] two\n",
		"docs/plans/2026-01-03-c.md": "# Plan, no tasks yet\n",
		"docs/specs/2026-01-01-shop-roadmap.md": CLOSED_ROADMAP,
		"docs/specs/2026-01-01-s.md": "# Spec\n\n- [x] a list in a spec is not a plan\n",
	});
	assert.deepEqual(finishedWorkDocs(dir).sort(), [PLAN, "docs/specs/2026-01-01-shop-roadmap.md"]);
	assert.deepEqual(finishedWorkDocs(dir, []), []);
});
