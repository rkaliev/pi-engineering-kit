import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkReview, parseReview, readReview, recordReview, type ReviewGateOptions } from "../extensions/lib/reviews.ts";

const OPTIONS: ReviewGateOptions = { ignore: ["docs/**"], workDocs: ["docs/tasks"], missing: "block" };

/** A repo on `main` with one commit, switched to a work branch with one code commit. */
function repo() {
	const dir = mkdtempSync(join(tmpdir(), "reviews-"));
	const root = mkdtempSync(join(tmpdir(), "reviews-stamps-"));
	const git = (...args: string[]) => {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.trim();
	};
	const commit = (files: Record<string, string | null>) => {
		for (const [name, content] of Object.entries(files)) {
			if (content === null) rmSync(join(dir, name));
			else {
				mkdirSync(resolve(dir, name, ".."), { recursive: true });
				writeFileSync(join(dir, name), content);
			}
		}
		git("add", "-A");
		git("commit", "-qm", "change");
		return git("rev-parse", "HEAD");
	};
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	commit({ "README.md": "x\n" });
	git("switch", "-qc", "feat/a");
	const head = commit({ "src/a.ts": "export const a = 1;\n", "docs/tasks/2026-01-01-a.md": "# A\n" });
	const check = (command: string, options = OPTIONS) => checkReview(command, dir, options, root);
	const review = (text: string, promptId?: string) => recordReview(dir, text, promptId, root);
	return { dir, root, git, commit, head, check, review };
}

const report = (sha: string, verdict: string) => `### Verdict\nReviewed HEAD: ${sha.slice(0, 10)}\nReady to merge: ${verdict}, one sentence.`;

test("parseReview reads the SHA and the worst verdict; ambiguous reports give nothing", () => {
	assert.deepEqual(parseReview(report("abc1234def", "Yes")), { sha: "abc1234def", verdict: "Yes" });
	assert.deepEqual(parseReview("**Reviewed HEAD:** `abc1234`\n**Ready to merge:** With fixes"), { sha: "abc1234", verdict: "With fixes" });
	assert.equal(parseReview(`${report("abc1234", "Yes")}\n${report("abc1234", "No")}`)?.verdict, "No", "parallel reports: the worst wins");
	assert.equal(parseReview("Ready to merge: Yes"), undefined, "no SHA");
	assert.equal(parseReview(`${report("abc1234", "Yes")}\n${report("def5678", "Yes")}`), undefined, "two SHAs");
});

test("no review, or a failing one, blocks a PR; a passing review of HEAD allows it", () => {
	const { head, check, review } = repo();
	assert.equal(check("gh pr create --fill")?.action, "block");
	assert.match(check("gh pr create --fill")!.reason!, /no reviewer verdict/);

	assert.equal(typeof review(report(head, "No")), "object");
	assert.match(check("gh pr create --fill")!.reason!, /returned "No"/);
	review(report(head, "With fixes"));
	assert.equal(check("gh pr create --fill")?.action, "block", "With fixes needs the fixes and a re-review");
	review(report(head, "Inconclusive"));
	assert.equal(check("gh pr create --fill")?.action, "block");
	review(report(head, "Yes"));
	assert.equal(check("gh pr create --fill"), undefined);
	assert.equal(check("git push -u origin feat/a"), undefined, "pushing a work branch is not a landing");
	assert.equal(check("gh pr create --fill", { ...OPTIONS, missing: "confirm" }), undefined);
});

test("deleting task files after the review keeps it valid; a code change needs a new one", () => {
	const { head, commit, check, review } = repo();
	review(report(head, "Yes"));
	commit({ "docs/tasks/2026-01-01-a.md": null, "docs/02-topic.md": "lasting\n" });
	assert.equal(check("gh pr create --fill"), undefined, "task-file cleanup and ignored docs are exempt");
	commit({ "src/a.ts": "export const a = 2;\n" });
	assert.match(check("gh pr create --fill")!.reason!, /changed code after it/);
});

test("a docs-only branch needs no review; missing: confirm asks instead of blocking", () => {
	const { git, commit, check } = repo();
	git("switch", "-qc", "docs/b", "main");
	commit({ "docs/guide.md": "x\n" });
	assert.equal(check("gh pr create --fill"), undefined);
	git("switch", "-q", "feat/a");
	assert.equal(check("gh pr create --fill", { ...OPTIONS, missing: "confirm" })?.action, "confirm");
});

test("merging into the base and pushing to it are landings too", () => {
	const { git, head, check, review } = repo();
	assert.equal(check("git push origin feat/a:main")?.action, "block");
	git("switch", "-q", "main");
	assert.equal(check("git merge feat/a")?.action, "block");
	review(report(head, "Yes"));
	assert.equal(check("git merge feat/a"), undefined);
});

test("reviews from one prompt merge to the worst verdict; a later prompt replaces it", () => {
	const { dir, root, head, review } = repo();
	review(report(head, "Yes"), "p1");
	review(report(head, "No"), "p1");
	assert.equal(readReview(dir, root)?.verdict, "No", "parallel reviewers: the worst wins");
	review(report(head, "Yes"), "p1");
	assert.equal(readReview(dir, root)?.verdict, "No", "the same prompt can't overturn it");
	review(report(head, "Yes"), "p2");
	assert.equal(readReview(dir, root)?.verdict, "Yes");
	assert.equal(readReview(dir, root)?.sha, head, "the SHA is stored in full");
	assert.match(String(review(report("0000000", "Yes"))), /not a commit/);
});
