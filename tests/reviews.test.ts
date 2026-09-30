import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkGateFiles, checkReview, exempt, parseReview, readReviews, recordReview, type ReviewGateOptions } from "../extensions/lib/reviews.ts";

const OPTIONS: ReviewGateOptions = { workDocs: ["docs/tasks"], missing: "block", waiver: "reviewGate: false" };

/** A repo with a remote: `main` pushed, then a work branch with one code commit and a task file. */
function repo() {
	const dir = mkdtempSync(join(tmpdir(), "reviews-"));
	const remote = mkdtempSync(join(tmpdir(), "reviews-remote-"));
	const root = mkdtempSync(join(tmpdir(), "reviews-records-"));
	const run = (cwd: string, ...args: string[]) => {
		const r = spawnSync("git", args, { cwd, encoding: "utf8" });
		assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.trim();
	};
	const git = (...args: string[]) => run(dir, ...args);
	const commit = (files: Record<string, string | null>, cwd = dir) => {
		for (const [name, content] of Object.entries(files)) {
			if (content === null) rmSync(join(cwd, name));
			else {
				mkdirSync(resolve(cwd, name, ".."), { recursive: true });
				writeFileSync(join(cwd, name), content);
			}
		}
		run(cwd, "add", "-A");
		run(cwd, "commit", "-qm", "change");
		return run(cwd, "rev-parse", "HEAD");
	};
	run(remote, "init", "-q", "--bare", "-b", "main");
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	commit({ "README.md": "x\n", "src/base.ts": "export const base = 1;\n" });
	git("remote", "add", "origin", remote);
	git("push", "-q", "origin", "main");
	git("remote", "set-head", "origin", "main");
	git("switch", "-qc", "feat/a");
	const head = commit({ "src/a.ts": "export const a = 1;\n", "docs/tasks/2026-01-01-a.md": "# A\n" });
	let prompt = 0;
	const check = (command: string, options = OPTIONS, cwd = dir) => checkReview(command, cwd, dir, options, root);
	const review = (text: string, promptId = `p${++prompt}`, runId = "r1") => recordReview(dir, text, { promptId, run: runId }, root);
	return { dir, root, git, run, commit, head, check, review };
}

const report = (sha: string, verdict: string) => `### Verdict\nReviewed HEAD: ${sha.slice(0, 10)}\nReady to merge: ${verdict}, one sentence.`;
const action = (d: ReturnType<typeof checkReview>) => d?.action ?? "allow";

test("parseReview reads the SHA and the worst verdict; ambiguous reports and the template line give nothing", () => {
	assert.deepEqual(parseReview(report("abc1234def", "Yes")), { sha: "abc1234def", verdict: "Yes" });
	assert.deepEqual(parseReview("**Reviewed HEAD:** `abc1234`\n**Ready to merge:** With fixes"), { sha: "abc1234", verdict: "With fixes" });
	assert.equal(parseReview(`${report("abc1234", "Yes")}\n${report("abc1234", "No")}`)?.verdict, "No", "parallel reports: the worst wins");
	assert.equal(parseReview("Ready to merge: Yes"), undefined, "no SHA");
	assert.equal(parseReview(`${report("abc1234", "Yes")}\n${report("def5678", "Yes")}`), undefined, "two SHAs");
	assert.equal(parseReview("Reviewed HEAD: abc1234\nReady to merge: Yes / No / With fixes / Inconclusive"), undefined, "an echoed template is not a verdict");
	assert.equal(parseReview("Reviewed HEAD: abc1234\nReady to merge: Yes | No"), undefined);
});

test("no review, or a failing one, blocks a PR; a passing review of HEAD allows it", () => {
	const { head, check, review } = repo();
	assert.match(check("gh pr create --fill")!.reason!, /no reviewer verdict recorded .* Only the user can waive the gate \(reviewGate: false\)/);
	for (const verdict of ["No", "With fixes", "Inconclusive"]) {
		assert.equal(typeof review(report(head, verdict)), "object");
		assert.match(check("gh pr create --fill")!.reason!, new RegExp(`returned "${verdict}"`));
	}
	review(report(head, "Yes"));
	assert.equal(check("gh pr create --fill"), undefined);
	assert.equal(check("git push -u origin feat/a"), undefined, "pushing a work branch is not a landing");
	assert.equal(check("gh pr create --fill", { ...OPTIONS, missing: "confirm" }), undefined);
});

test("deleting task files and changing docs keeps a review; code, agent rules and renames out of code need a new one", () => {
	const { head, commit, check, review } = repo();
	review(report(head, "Yes"));
	commit({ "docs/tasks/2026-01-01-a.md": null, "docs/02-topic.md": "lasting\n", "CHANGELOG.md": "- a\n" });
	assert.equal(check("gh pr create --fill"), undefined, "task-file cleanup and docs are exempt");
	const rules = commit({ "CLAUDE.md": "new rule\n" });
	assert.match(check("gh pr create --fill")!.reason!, /changes code it didn't see/, "the agent manifest steers the agent: reviewable");
	review(report(rules, "Yes"));
	assert.equal(check("gh pr create --fill"), undefined);
	commit({ "src/base.ts": null, "docs/base.ts": "export const base = 1;\n" });
	assert.equal(action(check("gh pr create --fill")), "block", "moving base code into docs deletes it from src");
});

test("the fixed exempt list: task files, docs and markdown, except what steers the agent", () => {
	const yes = ["docs/tasks/a.md", "docs/guide.md", "docs/img/x.png", "README.md", "src/notes.mdx"];
	const no = ["src/a.ts", "requirements.txt", "CLAUDE.md", "AGENTS.md", "pkg/AGENTS.md", ".claude/rules/api.md", ".pi/x.md", "skills/a/SKILL.md", "skills/a/references/b.md", "agents/reviewer.md", "prompts/finish.md"];
	for (const p of yes) assert.equal(exempt(p, "", ["docs/tasks"]), true, p);
	for (const p of no) assert.equal(exempt(p, "", ["docs/tasks"]), false, p);
	assert.equal(exempt("app/docs/guide.md", "app/", []), true, "paths are project-relative in a monorepo");
	assert.equal(exempt("other/README.md", "app/", []), false, "outside the project nothing is exempt");
});

test("a docs-only branch needs no review; missing: confirm asks instead of blocking", () => {
	const { git, commit, check } = repo();
	git("switch", "-qc", "docs/b", "main");
	commit({ "docs/guide.md": "x\n" });
	assert.equal(check("gh pr create --fill"), undefined);
	git("switch", "-q", "feat/a");
	assert.equal(check("gh pr create --fill", { ...OPTIONS, missing: "confirm" })?.action, "confirm");
});

test("on the base branch: pushing local commits is a landing; merging what is already upstream is not", () => {
	const { git, commit, head, check, review } = repo();
	assert.equal(action(check("git push origin feat/a:main")), "block");
	git("switch", "-q", "main");
	assert.equal(action(check("git merge feat/a")), "block");
	review(report(head, "Yes"));
	assert.equal(check("git merge feat/a"), undefined);

	commit({ "src/hotfix.ts": "export const fix = 1;\n" });
	for (const push of ["git push", "git push origin main", "git push --all origin"]) assert.equal(action(check(push)), "block", push);
	git("reset", "-q", "--hard", "origin/main");
	assert.equal(check("git merge --ff-only origin/main"), undefined, "teammates' commits already on the remote base");
});

test("gh pr merge: a named branch is checked, a number or URL asks; --head names the branch", () => {
	const { git, head, check, review } = repo();
	git("switch", "-q", "main");
	assert.equal(action(check("gh pr merge feat/a --squash")), "block");
	assert.equal(check("gh pr merge 12 --squash")?.action, "confirm");
	assert.equal(check("gh pr merge https://github.com/o/r/pull/12")?.action, "confirm");
	assert.equal(action(check("gh pr create --head feat/a --fill")), "block");
	assert.equal(action(check("glab mr create --source-branch=feat/a")), "block");
	review(report(head, "Yes"));
	assert.equal(check("gh pr merge feat/a --squash"), undefined);
	assert.equal(check("gh pr create --head feat/a --fill"), undefined);
});

test("a commit or HEAD move chained before a landing is refused: land it as its own command", () => {
	const { head, check, review } = repo();
	review(report(head, "Yes"));
	assert.match(check("git commit -am fix && gh pr create --fill")!.reason!, /Run the landing as its own command/);
	assert.equal(action(check("git switch main && git merge feat/a")), "block");
	assert.equal(check("git add -A && git commit -m x && git push -u origin feat/a"), undefined, "no landing: nothing to refuse");
});

test("cd and git -C are followed: a worktree's branch is checked where the command runs", () => {
	const { dir, git, run, commit, check, review } = repo();
	const wt = join(dir, ".worktrees", "b");
	git("worktree", "add", "-q", "-b", "feat/b", wt, "main");
	const b = commit({ "src/b.ts": "export const b = 1;\n" }, wt);
	assert.match(check(`cd ${wt} && gh pr create --fill`)!.reason!, new RegExp(`no reviewer verdict recorded for ${b.slice(0, 7)}`));
	review(report(b, "Yes"));
	assert.equal(check(`cd .worktrees/b && gh pr create --fill`), undefined, "relative cd from the project");
	assert.equal(check(`git -C ${wt} push origin HEAD:main`), undefined);
	assert.equal(check("gh pr create --fill", OPTIONS, wt), undefined, "the session cwd is the worktree");
	assert.equal(action(check("gh pr create --fill")), "block", "the main checkout's feat/a is still unreviewed");
	run(wt, "status");
});

test("reviews are kept per commit; a rebase onto a newer base keeps the review", () => {
	const { git, commit, head, check, review } = repo();
	review(report(head, "Yes"));
	git("switch", "-qc", "feat/c", "main");
	const c = commit({ "src/c.ts": "export const c = 1;\n" });
	review(report(c, "No"));
	git("switch", "-q", "feat/a");
	assert.equal(check("gh pr create --fill"), undefined, "reviewing feat/c didn't forget feat/a");

	git("switch", "-q", "main");
	commit({ "src/base.ts": "export const base = 2;\n" });
	git("push", "-q", "origin", "main");
	git("switch", "-q", "feat/a");
	git("rebase", "-q", "main");
	assert.equal(check("gh pr create --fill"), undefined, "same own change on a newer base");
});

test("parallel reviewers of one prompt combine to the worst verdict; a later prompt replaces it", () => {
	const { dir, root, head, review } = repo();
	review(report(head, "Yes"), "p1", "a1");
	review(report(head, "No"), "p1", "a2");
	assert.equal(readReviews(dir, root)[0]?.verdict, "No", "no run overwrites another");
	review(report(head, "Yes"), "p1", "a3");
	assert.equal(readReviews(dir, root)[0]?.verdict, "No", "the same prompt can't overturn it");
	review(report(head, "Yes"), "p2", "a1");
	assert.equal(readReviews(dir, root)[0]?.verdict, "Yes");
	assert.equal(readReviews(dir, root)[0]?.sha, head, "the SHA is stored in full");
	assert.match(String(review(report("0000000", "Yes"))), /not a commit/);
});

test("shell writes to the gate's own files: stamps are blocked, the guard config asks", () => {
	const guard = ".pi/guard.json";
	assert.equal(checkGateFiles(`echo '{}' > $TMPDIR/eng-kit/reviews/x/y.json`, guard)?.action, "block");
	assert.equal(checkGateFiles(`echo '{"reviewGate":false}' > .pi/guard.json`, guard)?.action, "confirm");
	assert.equal(checkGateFiles(`sed -i '' s/x/y/ ./.pi/guard.json`, guard)?.action, "confirm");
	assert.equal(checkGateFiles("cat .pi/guard.json", guard), undefined);
	assert.equal(checkGateFiles("git diff .pi/guard.json", guard), undefined);
	assert.equal(checkGateFiles("npm test", guard), undefined);
});
