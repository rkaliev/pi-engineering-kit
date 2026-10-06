import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { checkGateFiles, checkReview, checkReviewerCommand, parseReview, readReviews, recordReview, notePr, openPrBranches, recordVerdict, reviewsDir, settlePr, stripRedirects, type ReviewGateOptions } from "../extensions/lib/reviews.ts";

const OPTIONS: ReviewGateOptions = { missing: "block", waiver: "reviewGate: false", verify: ["npm test", "npm run lint"] };

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
	const base = git("rev-parse", "HEAD");
	git("switch", "-qc", "feat/a");
	const head = commit({ "src/a.ts": "export const a = 1;\n", "docs/tasks/2026-01-01-a.md": "# A\n" });
	let prompt = 0;
	const check = (command: string, options = OPTIONS, cwd = dir) => checkReview(command, cwd, dir, options, root);
	const review = (text: string, promptId = `p${++prompt}`, runId = "r1") => recordReview(dir, text, { promptId, run: runId }, root);
	return { dir, root, git, run, commit, head, base, check, review };
}

const report = (sha: string, verdict: string, base: string) => `### Verdict\nReviewed BASE: ${base.slice(0, 10)}\nReviewed HEAD: ${sha.slice(0, 10)}\nReady to merge: ${verdict}, one sentence.`;
const action = (d: ReturnType<typeof checkReview>) => d?.action ?? "allow";

test("parseReview reads the SHA and the worst verdict; ambiguous reports and the template line give nothing", () => {
	assert.deepEqual(parseReview(report("abc1234def", "Yes", "0000aaa")), { base: "0000aaa", sha: "abc1234def", verdict: "Yes" });
	assert.deepEqual(parseReview("**Reviewed BASE:** `0000aaa`\n**Reviewed HEAD:** `abc1234`\n**Ready to merge:** With fixes"), { base: "0000aaa", sha: "abc1234", verdict: "With fixes" });
	assert.equal(parseReview("Reviewed HEAD: abc1234\nReady to merge: Yes"), undefined, "no BASE: the range is unknown");
	assert.equal(parseReview(`${report("abc1234", "Yes", "0000aaa")}\n${report("abc1234", "Yes", "1111bbb")}`), undefined, "two BASEs");
	assert.equal(parseReview(`${report("abc1234", "Yes", "0000aaa")}\n${report("abc1234", "No", "0000aaa")}`)?.verdict, "No", "parallel reports: the worst wins");
	assert.equal(parseReview("Ready to merge: Yes"), undefined, "no SHA");
	assert.equal(parseReview(`${report("abc1234", "Yes", "0000aaa")}\n${report("def5678", "Yes", "0000aaa")}`), undefined, "two SHAs");
	assert.equal(parseReview("Reviewed HEAD: abc1234\nReady to merge: Yes / No / With fixes / Inconclusive"), undefined, "an echoed template is not a verdict");
	assert.equal(parseReview("Reviewed HEAD: abc1234\nReady to merge: Yes | No"), undefined);
});

test("no review, or a failing one, blocks a PR; a passing review of HEAD allows it", () => {
	const { head, check, review, base } = repo();
	assert.match(check("gh pr create --fill")!.reason!, /no reviewer verdict recorded .* Only the user can waive the gate \(reviewGate: false\)/);
	for (const verdict of ["No", "With fixes", "Inconclusive"]) {
		assert.equal(typeof review(report(head, verdict, base)), "object");
		assert.match(check("gh pr create --fill")!.reason!, new RegExp(`returned "${verdict}"`));
	}
	review(report(head, "Yes", base));
	assert.equal(check("gh pr create --fill"), undefined);
	assert.equal(check("git push -u origin feat/a"), undefined, "pushing a work branch is not a landing");
	assert.equal(check("gh pr create --fill", { ...OPTIONS, missing: "confirm" }), undefined);
});

test("on the base branch: pushing local commits is a landing; merging what is already upstream is not", () => {
	const { git, commit, head, check, review, base } = repo();
	assert.equal(action(check("git push origin feat/a:main")), "block");
	git("switch", "-q", "main");
	assert.equal(action(check("git merge feat/a")), "block");
	review(report(head, "Yes", base));
	assert.equal(check("git merge feat/a"), undefined);

	commit({ "src/hotfix.ts": "export const fix = 1;\n" });
	for (const push of ["git push", "git push origin main", "git push --all origin"]) assert.equal(action(check(push)), "block", push);
	git("reset", "-q", "--hard", "origin/main");
	assert.equal(check("git merge --ff-only origin/main"), undefined, "teammates' commits already on the remote base");
});

test("gh pr merge: a named branch is checked, a number or URL asks; --head names the branch", () => {
	const { git, head, check, review, base } = repo();
	git("switch", "-q", "main");
	assert.equal(action(check("gh pr merge feat/a --squash")), "block");
	assert.equal(check("gh pr merge 12 --squash")?.action, "confirm");
	assert.equal(check("gh pr merge https://github.com/o/r/pull/12")?.action, "confirm");
	assert.equal(action(check("gh pr create --head feat/a --fill")), "block");
	assert.equal(action(check("glab mr create --source-branch=feat/a")), "block");
	review(report(head, "Yes", base));
	assert.equal(check("gh pr merge feat/a --squash"), undefined);
	assert.equal(check("gh pr create --head feat/a --fill"), undefined);
});

test("a commit or HEAD move chained before a landing is refused: land it as its own command", () => {
	const { head, check, review, base } = repo();
	review(report(head, "Yes", base));
	assert.match(check("git commit -am fix && gh pr create --fill")!.reason!, /Run the landing as its own command/);
	assert.equal(action(check("git switch main && git merge feat/a")), "block");
	assert.equal(check("git add -A && git commit -m x && git push -u origin feat/a"), undefined, "no landing: nothing to refuse");
});

test("cd and git -C are followed: a worktree's branch is checked where the command runs", () => {
	const { dir, git, run, commit, check, review, base } = repo();
	const wt = join(dir, ".worktrees", "b");
	git("worktree", "add", "-q", "-b", "feat/b", wt, "main");
	const b = commit({ "src/b.ts": "export const b = 1;\n" }, wt);
	assert.match(check(`cd ${wt} && gh pr create --fill`)!.reason!, new RegExp(`no reviewer verdict recorded for ${b.slice(0, 7)}`));
	review(report(b, "Yes", base));
	assert.equal(check(`cd .worktrees/b && gh pr create --fill`), undefined, "relative cd from the project");
	assert.equal(check(`git -C ${wt} push origin HEAD:main`), undefined);
	assert.equal(check("gh pr create --fill", OPTIONS, wt), undefined, "the session cwd is the worktree");
	assert.equal(action(check("gh pr create --fill")), "block", "the main checkout's feat/a is still unreviewed");
	run(wt, "status");
});

test("parallel reviewers of one prompt combine to the worst verdict; a later prompt replaces it", () => {
	const { dir, root, head, review, base } = repo();
	review(report(head, "Yes", base), "p1", "a1");
	review(report(head, "No", base), "p1", "a2");
	assert.equal(readReviews(dir, root)[0]?.verdict, "No", "no run overwrites another");
	review(report(head, "Yes", base), "p1", "a3");
	assert.equal(readReviews(dir, root)[0]?.verdict, "No", "the same prompt can't overturn it");
	review(report(head, "Yes", base), "p2", "a1");
	assert.equal(readReviews(dir, root)[0]?.verdict, "Yes");
	assert.equal(readReviews(dir, root)[0]?.sha, head, "the SHA is stored in full");
	assert.match(String(review(report("0000000", "Yes", base))), /not a commit/);
});

test("shell writes to the gate's own files: records are blocked, the guard config asks, reads pass", () => {
	const project = mkdtempSync(join(tmpdir(), "gate-files-"));
	mkdirSync(join(project, ".pi"));
	const guard = ".pi/guard.json";
	const check = (command: string) => checkGateFiles(command, project, project, guard)?.action ?? "allow";
	const records = join(tmpdir(), "eng-kit", "reviews");
	assert.equal(check(`echo '{}' > ${records}/x/y.json`), "block");
	assert.equal(check(`cd ${join(tmpdir(), "eng-kit")} && echo x > reviews/h/y.json`), "block", "cd is followed");
	assert.equal(check(`cd ${join(tmpdir(), "eng-kit", "reviews", "not-yet")} && echo x > y.json`), "block", "into a folder that doesn't exist yet");
	assert.equal(check(`grep -rn eng-kit/reviews lib/`), "allow", "reading is fine");
	assert.equal(check(`ls ${records}`), "allow");
	for (const write of [`echo '{"reviewGate":false}' > .pi/guard.json`, "sed -i '' s/x/y/ ./.pi/guard.json", "cat new.json > .pi/guard.json", "jq . x | tee .pi/guard.json", "git checkout main -- .pi/guard.json", "git restore -s HEAD~1 .pi/guard.json", "cd .pi && sed -i '' s/a/b/ guard.json", "(cd .pi && sed -i '' s/a/b/ guard.json)"]) {
		assert.equal(check(write), "confirm", write);
	}
	for (const read of ["cat .pi/guard.json", "git diff .pi/guard.json", "git log -p .pi/guard.json", "npm test"]) assert.equal(check(read), "allow", read);
});

test("HEAD pushes, whitespace and binary changes, and directories the guard can't follow", () => {
	const { dir, git, commit, head, check, review, base } = repo();
	review(report(head, "Yes", base));
	const pyReviewed = commit({ "src/job.py": "if ok:\n    run()\nclean()\n" });
	review(report(pyReviewed, "Yes", base));
	assert.equal(check("gh pr create --fill"), undefined);
	commit({ "src/job.py": "if ok:\n    run()\n    clean()\n" });
	assert.equal(action(check("gh pr create --fill")), "block", "an indentation change is a code change");
	const binReviewed = commit({ "src/job.py": "if ok:\n    run()\nclean()\n", "bin/tool.bin": "\u0000\u0001" });
	review(report(binReviewed, "Yes", base));
	commit({ "bin/tool.bin": "\u0000\u0002" });
	assert.equal(action(check("gh pr create --fill")), "block", "a changed binary is a code change");

	for (const unknown of [`cd "$WT" && gh pr create`, "cd $(git rev-parse --show-toplevel) && gh pr create", "cd ~/no-such-dir-xyz && gh pr create", "(cd .worktrees/none && gh pr create)", "gh pr merge feat/a -R o/r"]) {
		assert.equal(action(check(unknown)), "block", unknown);
	}
	git("switch", "-q", "main");
	commit({ "src/hotfix.ts": "export const fix = 1;\n" });
	for (const push of ["git push origin HEAD", "git push -u origin HEAD", "git push origin @", "git push origin HEAD:main"]) assert.equal(action(check(push)), "block", push);
	for (const push of ["(git push origin HEAD:main)", "echo $(git push origin HEAD:main)", "echo `git push origin HEAD:main`", "git send-pack origin HEAD:main", "git http-push origin HEAD:main"]) assert.equal(action(check(push)), "block", push);
	assert.equal(action(check("git branch -f main feat/a && git push origin main")), "block", "a ref move before a push");
	assert.equal(action(check("git fetch . feat/a:main && git push origin main")), "block");
	assert.equal(check("git status && git fetch origin"), undefined);
	assert.ok(dir);
});

test("a failed run spoils only its commit; merge -m values are not refs", () => {
	const { dir, root, git, commit, head, check, review, base } = repo();
	review(report(head, "Yes", base), "p3", "a");
	recordVerdict(dir, head, "Inconclusive", { promptId: "p3", run: "b" }, root);
	assert.equal(readReviews(dir, root)[0]?.verdict, "Inconclusive", "a parallel run that failed on the same commit counts against it");
	const fixed = commit({ "src/a.ts": "export const a = 3;\n" });
	review(report(fixed, "Yes", base), "p3", "c");
	assert.equal(readReviews(dir, root)[0]?.verdict, "Yes", "a re-review of a later commit in the same prompt is unaffected");
	git("switch", "-q", "main");
	assert.equal(check("git merge -m 'land a' feat/a"), undefined, "the -m value is not a ref");
});
test("a PR merge checks the remote head too; glab -s names the branch", () => {
	const { dir, git, run, commit, head, check, review, base } = repo();
	git("push", "-q", "origin", "feat/a");
	review(report(head, "Yes", base));
	const clone = mkdtempSync(join(tmpdir(), "reviews-clone-"));
	run(clone, "clone", "-q", "-b", "feat/a", git("remote", "get-url", "origin"), ".");
	run(clone, "config", "user.email", "o@example.com");
	run(clone, "config", "user.name", "o");
	commit({ "src/other.ts": "export const o = 1;\n" }, clone);
	run(clone, "push", "-q", "origin", "feat/a");
	git("fetch", "-q", "origin");
	git("switch", "-q", "main");
	assert.equal(action(check("gh pr merge feat/a")), "block", "origin/feat/a has a commit nobody reviewed");
	assert.equal(action(check("glab mr create -s feat/a")), "block");
	git("switch", "-q", "feat/a");
	assert.equal(action(check("gh pr merge")), "block", "no argument: the current branch, local and remote");
	assert.ok(dir);
});

test("before a landing: read-only steps and the project's verify commands may run; anything else may not", () => {
	const { head, check, review, base } = repo();
	review(report(head, "Yes", base));
	for (const ok of ["npm test && gh pr create --fill", "npm run lint && npm test && gh pr create", "git log --oneline | head -5 && gh pr create --fill", "(cd src && ls) && gh pr create --fill", `(cd ${tmpdir()} && ls) && gh pr create --fill`]) {
		assert.equal(check(ok), undefined, ok);
	}
	for (const bad of ["npm run build && gh pr create", "npm version patch && gh pr create", "popd && gh pr create", "rg --pre ./commit.sh x . && gh pr create", "rg --pre=sh x . && gh pr create"]) assert.equal(action(check(bad)), "block", bad);
});

test("gate files: reads with stderr redirects, jq and unrelated mentions pass; the records folder is matched exactly", () => {
	const project = mkdtempSync(join(tmpdir(), "gate-files-"));
	mkdirSync(join(project, ".pi"));
	const check = (command: string) => checkGateFiles(command, project, project, ".pi/guard.json")?.action ?? "allow";
	for (const read of ["grep -rn eng-kit/reviews src 2>/dev/null", "cat .pi/guard.json 2>&1", "jq . .pi/guard.json", "git commit -m 'eng-kit/reviews: tidy'"]) assert.equal(check(read), "allow", read);
	assert.equal(check("echo x > $TMPDIR/eng-kit/reviews/h/a.json"), "block");
	assert.equal(check("rm -rf ${TMPDIR}/eng-kit/reviews"), "block");
	assert.equal(check("cat .pi/guard.json | jq . > /tmp/x.json && cp /tmp/x.json .pi/guard.json"), "confirm");
});

test("redirected verify commands may precede a landing; a nested subshell fails closed", () => {
	const { head, check, review, base } = repo();
	review(report(head, "Yes", base));
	for (const ok of ["npm test 2>&1 && gh pr create --fill", "npm test 2>&1 | tail -20 && gh pr create --fill", "npm test >/dev/null && gh pr create"]) assert.equal(check(ok), undefined, ok);
	assert.equal(action(check("(cd src && (cd .. && ls)) && gh pr create")), "block");
});

test("redirections are stripped outside quotes only: a > in a commit message is text", () => {
	assert.equal(stripRedirects("npm test 2>&1 | tail -20").replace(/\s+/g, " ").trim(), "npm test | tail -20");
	assert.equal(stripRedirects("npm test &>/dev/null && x").replace(/\s+/g, " ").trim(), "npm test && x");
	assert.equal(stripRedirects("(npm test > out.log) && x").replace(/\s+/g, " ").trim(), "(npm test ) && x");
	assert.equal(stripRedirects(`git commit -m "a -> b" && gh pr create`), `git commit -m "a -> b" && gh pr create`);
	assert.equal(stripRedirects("git commit -m 'Map<K, V>' && x"), "git commit -m 'Map<K, V>' && x");

	const { dir, git, commit, check } = repo();
	for (const sneaky of [`git commit -qm "fix: a -> b" && gh pr create --fill`, `git commit -qm "use Map<K, V>" && gh pr create`, `git commit -am "x=>y" && git push origin HEAD:main`, `echo "x>y"; gh pr create --fill`]) {
		assert.equal(action(check(sneaky)), "block", sneaky);
	}
	const wt = join(dir, ".worktrees", "r");
	git("worktree", "add", "-q", "-b", "feat/r", wt, "main");
	commit({ "src/r.ts": "export const r = 1;\n" }, wt);
	assert.equal(action(check(`(cd ${wt} && npm test > out.log) && gh pr create --fill`)), "block", "a redirect target ends at the closing parenthesis");
});

test("a verdict covers exactly the reviewed commit: any change after it needs a new review", () => {
	const { git, commit, head, check, review, base } = repo();
	review(report(head, "Yes", base));
	assert.equal(check("gh pr create --fill"), undefined);
	const changes: Array<[string, () => void]> = [
		["deleting the task file", () => commit({ "docs/tasks/2026-01-01-a.md": null })],
		["a docs edit", () => commit({ "docs/guide.md": "x\n" })],
		["a CHANGELOG edit", () => commit({ "CHANGELOG.md": "- a\n" })],
		["an amend", () => git("commit", "-q", "--amend", "-m", "reworded")],
	];
	for (const [what, change] of changes) {
		git("reset", "-q", "--hard", head);
		change();
		assert.match(check("gh pr create --fill")!.reason!, /no reviewer verdict recorded|changed after/, what);
	}
	git("reset", "-q", "--hard", head);
	assert.equal(check("gh pr create --fill"), undefined, "back on the reviewed commit");
});

test("a rebase onto a newer base needs a new review", () => {
	const { git, commit, head, check, review, base } = repo();
	review(report(head, "Yes", base));
	git("switch", "-q", "main");
	commit({ "src/base.ts": "export const base = 2;\n" });
	git("push", "-q", "origin", "main");
	git("switch", "-q", "feat/a");
	git("rebase", "-q", "main");
	assert.equal(action(check("gh pr create --fill")), "block");
	review(report(git("rev-parse", "HEAD"), "Yes", base));
	assert.equal(check("gh pr create --fill"), undefined, "the rebased commit, reviewed");
});

test("a docs-only branch is reviewed like any other; reviewing another branch doesn't forget this one", () => {
	const { git, commit, head, check, review, base } = repo();
	review(report(head, "Yes", base));
	git("switch", "-qc", "docs/b", "main");
	const docs = commit({ "docs/guide.md": "x\n" });
	assert.equal(action(check("gh pr create --fill")), "block");
	assert.equal(check("gh pr create --fill", { ...OPTIONS, missing: "confirm" })?.action, "confirm");
	review(report(docs, "Yes", base));
	assert.equal(check("gh pr create --fill"), undefined);
	git("switch", "-q", "feat/a");
	assert.equal(check("gh pr create --fill"), undefined, "feat/a's own review still stands");
});

test("nothing new to land needs no review", () => {
	const { git, check } = repo();
	git("switch", "-qc", "empty", "main");
	assert.equal(check("gh pr create --fill"), undefined, "a branch at the base lands nothing");
});

test("commits on the base count as landed only against the push remote's tracking branch, never the local base", () => {
	const { dir, git, run, commit, check } = repo();
	const other = mkdtempSync(join(tmpdir(), "reviews-github-"));
	run(other, "init", "-q", "--bare", "-b", "main");
	git("remote", "add", "github", other);
	git("switch", "-q", "main");
	commit({ "src/hotfix.ts": "export const fix = 1;\n" });
	for (const push of ["git push github main", "git push github HEAD:main"]) assert.equal(action(check(push)), "block", `${push}: no github/main to compare with`);
	git("push", "-q", "github", "main");
	git("fetch", "-q", "github");
	assert.equal(check("git push github main"), undefined, "already on github/main");
	assert.equal(action(check("git push origin main")), "block", "not on origin/main yet");
	assert.ok(dir);
});

test("a Yes whose BASE is not on the remote base and has no covered record of its own does not cover HEAD", () => {
	const { git, commit, head, check, review } = repo();
	const second = commit({ "src/a2.ts": "export const a2 = 1;\n" });
	review(report(second, "Yes", head));
	for (const landing of ["gh pr create --fill", "git push origin feat/a:main"]) {
		assert.match(String(check(landing)?.reason), /does not cover/, landing);
	}
	git("switch", "-q", "main");
	assert.match(String(check("git merge feat/a")?.reason), /does not cover/, "a merge into the base");
});

test("a repeat round chains to a covered earlier round at any verdict", () => {
	const { commit, head, base, check, review } = repo();
	review(report(head, "No", base));
	const fixed = commit({ "src/a.ts": "export const a = 2;\n" });
	review(report(fixed, "Yes", head));
	assert.equal(check("gh pr create --fill"), undefined);
});

test("a rebase breaks the chain: the earlier round's commit is no longer an ancestor", () => {
	const { git, commit, head, base, check, review } = repo();
	review(report(head, "Yes", base));
	git("switch", "-q", "main");
	commit({ "src/base.ts": "export const base = 2;\n" });
	git("push", "-q", "origin", "main");
	git("switch", "-q", "feat/a");
	git("rebase", "-q", "main");
	review(report(git("rev-parse", "HEAD"), "Yes", head));
	assert.match(String(check("gh pr create --fill")?.reason), /does not cover/);
});

test("an empty range covers nothing", () => {
	const { head, check, review } = repo();
	review(report(head, "Yes", head));
	assert.match(String(check("gh pr create --fill")?.reason), /does not cover/);
});

test("records written before Reviewed BASE existed cover nothing", () => {
	const { dir, root, head, check } = repo();
	const folder = reviewsDir(dir, root);
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	writeFileSync(join(folder, `${head}.old.r.json`), JSON.stringify({ sha: head, verdict: "Yes", promptId: "old", at: Date.now() }));
	assert.match(String(check("gh pr create --fill")?.reason), /does not cover/);
});

test("a chain of 20 rounds covers the branch; a 21st link is refused", () => {
	const { commit, head, base, check, review } = repo();
	review(report(head, "Yes", base));
	let previous = head;
	for (let i = 2; i <= 20; i++) {
		const next = commit({ "src/a.ts": `export const a = ${i};\n` });
		review(report(next, "Yes", previous));
		previous = next;
	}
	assert.equal(check("gh pr create --fill"), undefined, "20 rounds");
	const last = commit({ "src/a.ts": "export const a = 21;\n" });
	review(report(last, "Yes", previous));
	assert.match(String(check("gh pr create --fill")?.reason), /does not cover/, "21 rounds");
});

test("without a tracking ref the local base anchors the chain; with one, the local base does not", () => {
	const { git, commit, head, check, review } = repo();
	git("switch", "-q", "main");
	const local = commit({ "src/local.ts": "export const l = 1;\n" });
	git("switch", "-q", "feat/a");
	git("rebase", "-q", "main");
	const rebased = git("rev-parse", "HEAD");
	review(report(rebased, "Yes", local));
	assert.match(String(check("gh pr create --fill")?.reason), /does not cover/, "origin/main exists: an unpushed local main is not reviewed code");
	git("remote", "remove", "origin");
	assert.equal(check("git merge feat/a", OPTIONS), undefined, "on feat/a: merging into feat/a itself lands nothing");
	git("switch", "-q", "main");
	assert.equal(check("git merge feat/a"), undefined, "no remote: the local base is all there is");
	assert.ok(head);
});

test("after the agent opens a PR, pushing a new unreviewed commit to its branch is refused until it is reviewed", () => {
	const { dir, root, commit, head, base, check, review } = repo();
	review(report(head, "Yes", base));
	assert.equal(check("git push -u origin feat/a"), undefined, "no PR yet: a work-branch push");
	notePr(dir, "t1", "gh pr create --fill", dir, root);
	settlePr(dir, "t1", true, root);
	const next = commit({ "src/a.ts": "export const a = 2;\n" });
	for (const push of ["git push", "git push -u origin feat/a", "git push origin HEAD"]) assert.match(String(check(push)?.reason), /no reviewer verdict recorded/, push);
	review(report(next, "Yes", head));
	assert.equal(check("git push"), undefined, "the new commit, reviewed");
});

test("a PR branch named with --head (fork syntax too) is remembered; a merged PR branch is forgotten", () => {
	const { dir, root, git, commit, head, base, check, review } = repo();
	review(report(head, "Yes", base));
	git("push", "-q", "origin", "feat/a");
	git("switch", "-q", "main");
	notePr(dir, "t1", "gh pr create --head octo:feat/a --fill", dir, root);
	settlePr(dir, "t1", true, root);
	git("switch", "-q", "feat/a");
	const second = commit({ "src/a.ts": "export const a = 2;\n" });
	assert.equal(action(check("git push origin feat/a")), "block");
	review(report(second, "Yes", head));
	git("push", "-q", "origin", "feat/a");
	git("switch", "-q", "main");
	git("merge", "-q", "--ff-only", "feat/a");
	git("push", "-q", "origin", "main");
	git("switch", "-q", "feat/a");
	commit({ "src/a.ts": "export const a = 3;\n" });
	assert.equal(check("git push origin feat/a"), undefined, "its PR was merged: a plain work-branch push again");
});

test("shell writes to the open-PR list are blocked like the verdict records", () => {
	const project = mkdtempSync(join(tmpdir(), "gate-files-"));
	const records = join(tmpdir(), "eng-kit", "reviews");
	assert.equal(checkGateFiles(`echo '{}' > ${records}/h/prs.json`, project, project, ".pi/guard.json")?.action, "block");
});

test("the reviewer's shell runs only inspection, temp worktrees, the verify commands and review-log", () => {
	// A checkout outside the temp folder, so `../w` leaves it.
	const project = resolve(import.meta.dirname, "..");
	const kit = "/kit";
	const check = (command: string) => checkReviewerCommand(command, project, ["npm test", "npm run lint"], kit)?.action ?? "allow";
	const tmp = join(tmpdir(), "r");
	for (const ok of ["git diff a..b", "git diff --stat a..b -- src", "git log --oneline -5", "git -C /x log --oneline", "git show a:CLAUDE.md", "git merge-base origin/main HEAD", "git merge-base --is-ancestor abc origin/main", `git worktree add ${tmp} abc`, `git worktree add --detach ${tmp} abc`, `git worktree remove --force ${tmp}`, "git worktree list", "git diff a..b | head -50", "cat f | grep x", "grep -rn foo src 2>/dev/null", "npm test", "npm test 2>&1 | tail -20", "cd tests && git status", `node ${kit}/scripts/review-log.ts abc`]) {
		assert.equal(check(ok), "allow", ok);
	}
	const bad = [
		"git commit -m x", "git checkout main", "git switch -c x", "git stash", "git add -A", "git grep x", "git -c core.pager=sh log",
		"git diff --output=x a..b", "git log --ou=x", "git diff --ext-diff",
		"git worktree add ../w abc", `git worktree add -b x ${tmp} abc`, `git worktree add ${tmp}`, "git worktree add $TMPDIR/r abc", "git worktree remove --force .worktrees/x",
		"rm f", "echo x > f", "cat a >> b", "echo x >| cat", "echo hi >&ls", "grep x f | tee out", "git diff; rm f", "ls &",
		"cat $(echo f)", "cat `echo f`", "echo \\' ; rm f ; echo \\'", "echo $'x'",
		"rg --pre rm x .", "sort -o f x", "uniq a b", "file -C -m x", "sed -i s/a/b/ f", "npm run build",
		"cd /tmp && cd - && ls", "cd no-such-dir-xyz && ls", "pushd /tmp", "( cd /tmp ) && ls", "cd",
		"node examples/scripts/review-log.ts x", "node -e 'require(\"fs\").writeFileSync(\"x\", \"\")'",
		// A glob can expand into a planted file name such as `--output=a.txt`.
		"git diff HEAD *", "git log -- src/?.ts", "cat [a-z]*",
	];
	for (const command of bad) assert.equal(check(command), "block", command);
	assert.match(String(checkReviewerCommand("rm f", project, [], kit)?.reason), /reviewer is read-only/);
});

test("a project reached through a symlink keeps its review records", () => {
	const { dir, root, head, base, review } = repo();
	review(report(head, "Yes", base));
	const link = join(mkdtempSync(join(tmpdir(), "reviews-link-")), "project");
	symlinkSync(dir, link);
	assert.equal(readReviews(link, root)[0]?.sha, head);
});

test("a backslash-escaped quote doesn't hide a landing from the gate", () => {
	const { check } = repo();
	for (const sneaky of ["echo \\' ; gh pr create --fill ; echo \\'", 'echo "a\\\\" ; gh pr create --fill',"echo $'\\'' ; gh pr create --fill ; echo '"]) {
		assert.equal(action(check(sneaky)), "block", sneaky);
	}
	assert.equal(stripRedirects("echo \\' > f").replace(/\s+/g, " ").trim(), "echo \\'", "an escaped quote opens no quote");
});

test("a backslash line continuation joins the command, as the shell does", () => {
	const { check } = repo();
	for (const continued of ["git push \\\n  origin feat/a:main", "gh pr \\\ncreate --fill", 'git push "origin" \\\n feat/a:main']) {
		assert.equal(action(check(continued)), "block", JSON.stringify(continued));
	}
});

test("a push to a remote with no tracking ref still anchors the chain on the remote base, not the local one", () => {
	const { git, run, commit, check, review } = repo();
	const fork = mkdtempSync(join(tmpdir(), "reviews-fork-"));
	run(fork, "init", "-q", "--bare", "-b", "main");
	git("remote", "add", "fork", fork);
	git("switch", "-q", "main");
	commit({ "src/u1.ts": "export const u1 = 1;\n" });
	const u2 = commit({ "src/u2.ts": "export const u2 = 1;\n" });
	const c3 = commit({ "src/c3.ts": "export const c3 = 1;\n" });
	review(report(c3, "Yes", u2));
	assert.equal(action(check("git push origin main")), "block");
	assert.match(String(check("git push fork main")?.reason), /does not cover/, "fork has no fork/main: origin/main is still the remote base");
});

test("a repeat round can't skip a newer reviewed commit and its findings", () => {
	const { commit, head, base, check, review } = repo();
	review(report(head, "Yes", base));
	const c2 = commit({ "src/a.ts": "export const a = 2;\n" });
	review(report(c2, "No", head));
	const c3 = commit({ "src/a.ts": "export const a = 3;\n" });
	review(report(c3, "Yes", head));
	assert.match(String(check("gh pr create --fill")?.reason), /does not cover/, "c2's round is skipped");
	review(report(c3, "Yes", c2));
	assert.equal(check("gh pr create --fill"), undefined, "the round after c2");
});

test("many parallel bases per round are checked in bounded time", () => {
	const { git, commit, check, review } = repo();
	const orphan = git("rev-parse", "HEAD");
	const shas = [orphan];
	for (let i = 1; i <= 16; i++) shas.push(commit({ "src/chain.ts": `export const c = ${i};\n` }));
	// Every round has two reviewers with different bases; the chain's root never reaches the remote base.
	for (let i = 2; i < shas.length; i++) {
		review(report(shas[i]!, "Yes", shas[i - 1]!), `p${i}`, "r1");
		review(report(shas[i]!, "Yes", shas[i - 2]!), `p${i}`, "r2");
	}
	// The skip rule, the cache and the git-call budget keep this walk bounded: it answers "does not cover" and never
	// runs into the hook's timeout.
	assert.match(String(check("gh pr create --fill")?.reason), /does not cover/);
});

test("a PR opened but not confirmed by the tool result isn't registered; an old entry expires after 30 days", () => {
	const { dir, root } = repo();
	notePr(dir, "t1", "gh pr create --fill", dir, root);
	assert.deepEqual(openPrBranches(dir, dir, "origin", "refs/remotes/origin/main", root), [], "pending only");
	settlePr(dir, "t1", false, root);
	settlePr(dir, "t1", true, root);
	assert.deepEqual(openPrBranches(dir, dir, "origin", "refs/remotes/origin/main", root), [], "a failed call is forgotten");
	notePr(dir, "t2", "gh pr create --fill", dir, root);
	settlePr(dir, "t2", true, root);
	assert.deepEqual(openPrBranches(dir, dir, "origin", "refs/remotes/origin/main", root), ["feat/a"]);
	assert.deepEqual(openPrBranches(dir, dir, "origin", "refs/remotes/origin/main", root, Date.now() + 31 * 24 * 60 * 60 * 1000), []);
});

test("gate files: >| and >&file are writes too", () => {
	const project = mkdtempSync(join(tmpdir(), "gate-files-"));
	const records = join(tmpdir(), "eng-kit", "reviews");
	for (const write of [`echo x >| ${records}/h/a.json`, `echo x >&${records}/h/a.json`]) {
		assert.equal(checkGateFiles(write, project, project, ".pi/guard.json")?.action, "block", write);
	}
	assert.equal(checkGateFiles("cat .pi/guard.json >&2", project, project, ".pi/guard.json"), undefined, ">&2 is not a file");
	for (const write of [`cat x >&${records}/h/a.json`, `jq . x >& ${records}/h/a.json`, `cat x &>${records}/h/a.json`, `head x >|${records}/h/a.json`]) {
		assert.equal(checkGateFiles(write, project, project, ".pi/guard.json")?.action, "block", `a read-only command that redirects into the records: ${write}`);
	}
});

test("redirections read as the shell does: >| and >& take a word, &< is a background & then <", () => {
	const flat = (command: string) => stripRedirects(command).replace(/\s+/g, " ").trim();
	assert.equal(flat("git push >|log origin main"), "git push origin main");
	assert.equal(flat("git push >& log origin main"), "git push origin main");
	assert.equal(flat("true &</dev/null git push x"), "true & git push x");
	assert.equal(flat("a >| b; git push origin main"), "a ; git push origin main");
	assert.equal(flat("a &&>/dev/null b"), "a && b", "&& comes before &>");
	const { check } = repo();
	for (const hidden of ["git push >|log origin HEAD:main", "git push >& log origin HEAD:main", "git commit -qm x &</dev/null git push origin HEAD:main"]) {
		assert.equal(action(check(hidden)), "block", hidden);
	}
});

test("a push without a refspec lands where @{push} points", () => {
	const { git, check } = repo();
	assert.equal(action(check("git push")), "allow", "no upstream: the branch pushes to its own name");
	git("branch", "-q", "--set-upstream-to=origin/main");
	git("config", "push.default", "upstream");
	for (const command of ["git push", "git push origin", "git push -o ci.skip"]) assert.equal(action(check(command)), "block", command);
	git("config", "push.default", "simple");
	assert.equal(action(check("git push")), "allow", "simple refuses an upstream of another name, so nothing lands");
	git("config", "push.default", "upstream");
	assert.equal(action(check("git push --tags")), "allow", "--tags pushes tags, not the branch");
	git("config", "push.default", "simple");
	git("remote", "add", "up/stream", git("remote", "get-url", "origin"));
	git("fetch", "-q", "up/stream");
	git("branch", "-q", "--set-upstream-to=up/stream/main");
	git("config", "push.default", "upstream");
	assert.equal(action(check("git push")), "block", "a remote whose name contains a slash");
});

test("the remote @{push} names decides what is already landed", () => {
	const { dir, git, run, check } = repo();
	const other = mkdtempSync(join(tmpdir(), "reviews-other-"));
	run(other, "init", "-q", "--bare", "-b", "main");
	git("remote", "add", "up", other);
	git("push", "-q", "up", "HEAD:main");
	git("fetch", "-q", "up");
	git("branch", "-q", "--set-upstream-to=up/main");
	git("config", "push.default", "upstream");
	assert.equal(action(check("git push")), "allow", "HEAD is already on up/main, where the push goes");
	run(dir, "status");
});

test("a push without a refspec is checked against the remote branch, whatever the fetch refspec calls it", () => {
	const { git, commit, check } = repo();
	git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/mirror/*");
	git("fetch", "-q", "origin");
	git("branch", "-q", "--set-upstream-to=mirror/main");
	git("config", "push.default", "upstream");
	assert.equal(action(check("git push")), "block", "feat/a's upstream is main on origin, tracked as mirror/main");
	git("switch", "-q", "main");
	commit({ "src/m.ts": "export const m = 1;\n" });
	for (const command of ["git push", "git push origin", "git push --branches origin"]) assert.equal(action(check(command)), "block", `on the base: ${command}`);
});

test("&> needs no space before it: the words after it stay with the command", () => {
	assert.equal(stripRedirects("git push origin feat&>log main").replace(/\s+/g, " ").trim(), "git push origin feat main");
	const { check } = repo();
	assert.equal(action(check("git push origin feat/a&>/dev/null HEAD:main")), "block");
});

test("gate files: every folder a cd, pushd or popd may reach is checked, in any form", () => {
	const project = mkdtempSync(join(tmpdir(), "gate-files-"));
	mkdirSync(join(project, ".pi"));
	const records = join(tmpdir(), "eng-kit", "reviews");
	const check = (command: string, cwd = tmpdir()) => checkGateFiles(command, cwd, project, ".pi/guard.json")?.action ?? "allow";
	const writes = [
		"cd nope; cd eng-kit/reviews; rm x",
		"cd -- eng-kit/reviews; rm x",
		"cd -P eng-kit/reviews; rm x",
		"cd $TMPDIR/eng-kit/reviews && rm x",
		"cd ${TMPDIR}/eng-kit/reviews && rm x",
		"pushd eng-kit/reviews && popd && rm x",
		"pushd eng-kit/reviews >/dev/null && cp /tmp/r.json r.json",
		"cd eng-kit/reviews 2>/dev/null && cp /tmp/r.json r.json",
		"cd eng-kit/reviews # into the records\ncp /tmp/r.json r.json",
		`pushd ${records} && pushd / && pushd && rm x`,
		`pushd ${records} && pushd / && pushd +1 && rm x`,
		`cd ${records} && cd / && cd ~- && rm x`,
		`pushd ${records} && pushd / && cd "$X" && popd && rm x`,
		`cd ${records}/h; cd ""; echo x > y.json`,
		`cd ${records} && (cd /) && rm x`,
		`cd ${records} && (cd / && (ls) && cd /) && rm x`,
		`(cd ${records}/h && ls $(pwd) && cp /tmp/r.json r.json)`,
		"cd ${TMPDIR}eng-kit/reviews && rm x",
		"echo x > ${TMPDIR}eng-kit/reviews/h/a.json",
		"cd $TMPDIR && cd eng-kit/reviews && rm x",
	];
	for (const write of writes) assert.equal(check(write), "block", `the shell may be in the records: ${write}`);
	assert.equal(check('cd "$X" && rm x', records), "block", "a cd the guard can't follow keeps the folders it knows");
	assert.equal(check(`cd ${project} && cd .pi 2>/dev/null && sed -i s/a/b/ guard.json`, "/"), "confirm", "a redirection on cd keeps its folder");
	assert.equal(check(`cd $HOME && cd ${relative(homedir(), project)}/.pi && sed -i s/a/b/ guard.json`, "/"), "confirm", "$HOME expands");
	assert.equal(check("cd src && rm x"), "allow", "a folder outside the records");
	assert.equal(check("cd src 2>/dev/null && npm test"), "allow", "a harmless redirection keeps the move plain");
	const unfollowed = [
		"{ cd eng-kit/reviews; rm x; }",
		"if true; then cd eng-kit/reviews; fi; rm x",
		'cd "$TMPDIR"eng-kit/reviews && cp /tmp/r.json r.json',
		"cd a b c d e f g h 2>/dev/null; rm x",
		"cd $X && npm test",
	];
	for (const command of unfollowed) assert.equal(check(command, "/"), "confirm", `a move the guard doesn't follow asks before a write: ${command}`);
	const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((d) => `cd ${d}`).join("; ");
	assert.equal(check(`${nine}; cd ${records}/h && cp /tmp/r.json r.json`, "/"), "block", "past the folder cap an absolute folder still counts");
	assert.equal(check("cd \"a 2>/dev/null x/../../../eng-kit/reviews/h\" && cp /tmp/r.json r.json"), "block", "a redirection inside quotes is part of the folder");
	assert.equal(check(`cd ${records}/h && ls # what's there\ncp /tmp/r.json abc.json`, "/"), "block", "in a command the guard can't read, no step counts as read-only");
	for (const back of ["cd - && cp /tmp/r.json a.json", "cd ~-/x && cp /tmp/r.json a.json"]) assert.equal(check(back, "/"), "confirm", `the previous folder before any move is an earlier command's: ${back}`);
	assert.equal(check(`popd > ${records}/h/x.json`, "/"), "block", "a redirection on a move is checked");
	assert.equal(check(`cd ${project} && cd . > .pi/guard.json`, "/"), "confirm", "a redirection on a move is checked");
	assert.equal(check(`cd ${tmpdir()} && cd -- -/../eng-kit/reviews/h && cp /tmp/r.json r.json`, "/"), "block", "after -- a dash word is a folder");
	assert.equal(check(`cd ${records}/h && cat "$(printf x > f.json)"`, "/"), "block", "a substitution in double quotes still runs");
	assert.equal(check('cat "`echo x > a.json`"', `${records}/h`), "block", "a backtick substitution in double quotes still runs");
	assert.equal(check(`cd > .pi/guard.json`, project), "confirm", "a redirection on a move with no folder is a write");
	assert.equal(check(`pushd > ${records}/h/x.json`, "/"), "block", "a redirection on pushd is a write");
	assert.equal(check(`cd "$X"; npm test; cp /tmp/r.json ${records}/h/a.json`, "/"), "block", "a write into the records blocks even after a move the guard doesn't follow");
	assert.equal(check(`cd ${records} 2>/dev/null && ls`, "/"), "allow", "reading the records with a harmless redirection");
	assert.equal(check("pushd src > /dev/null && npm test"), "allow", "a harmless redirection with a space");
	assert.equal(check(`cd ${project} && git commit -m "$(cat <<'EOF'\nmsg\nEOF\n)"`, "/"), "allow", "a substitution in quotes keeps the move plain");
	for (const hidden of [`echo $(cd ${tmpdir()}/eng-kit && cp /tmp/r.json reviews/h/a.json)`, `echo $( cd ${tmpdir()}/eng-kit && cp /tmp/r.json reviews/h/a.json )`, `X=$(cd ${tmpdir()}/eng-kit && cp /tmp/r.json reviews/h/a.json)`]) {
		assert.notEqual(check(hidden, "/"), "allow", `a move inside a substitution is not followed: ${hidden}`);
	}
	assert.equal(check(`cat <(cp /tmp/r.json ${records}/h/a.json)`, "/"), "block", "a process substitution makes a read-only command a writer");
	assert.equal(check(`cd ${records}/h && ls  # check what's there\ncat /tmp/r.json > abc.json`, "/"), "block", "an apostrophe in a comment doesn't hide a later write");
	assert.notEqual(check("cd \"$X\" && ls  # what's there\ncat /tmp/r.json > abc.json", `${records}/h`), "allow", "an apostrophe in a comment doesn't hide a later write");
	assert.equal(check("cat <(cd .pi && sed -i s/x/y/ guard.json)", project), "confirm", "a move inside a process substitution asks before a write");
	assert.notEqual(check("case x in x) cd eng-kit/reviews;; esac; rm x"), "allow", "a move in a case arm is not followed");
	for (const write of ["command -p cd eng-kit && cd reviews && rm x", "chdir eng-kit && cd reviews && rm x"]) assert.notEqual(check(write), "allow", write);
	for (const write of [`cat $(cp /tmp/r.json ${records}/h/a.json)`, `git show HEAD:x --output=${records}/h/a.json`, `git show HEAD:x --outp=${records}/h/a.json`, `echo "$(cp /tmp/r.json ${records}/h/a.json)"`, `cd "$(cp /tmp/r.json ${records}/h/a.json)"`, `dd if=/tmp/r.json of=${records}/h/a.json`]) {
		assert.equal(check(write, "/"), "block", `a read-only command that writes the records: ${write}`);
	}
});

test("cd options, cd -, pushd and popd are followed to the checkout a landing runs in", () => {
	const { dir, git, commit, check, review, base } = repo();
	const wt = join(dir, ".worktrees", "b");
	git("worktree", "add", "-q", "-b", "feat/b", wt, "main");
	const b = commit({ "src/b.ts": "export const b = 1;\n" }, wt);
	review(report(b, "Yes", base));
	for (const moved of [`cd -P ${wt} && git push origin HEAD:main`, `cd -- ${wt} && git push origin HEAD:main`, `cd ${wt} && cd src && cd - && git push origin HEAD:main`]) {
		assert.equal(check(moved), undefined, moved);
	}
	assert.equal(action(check(`pushd ${wt} && popd && git push origin HEAD:main`)), "block", "popd returns to the unreviewed main checkout");
	for (const unknown of ["popd && git push origin HEAD:main", "cd - && git push origin HEAD:main", "cd $TMPDIR && git push origin HEAD:main"]) {
		assert.match(check(unknown)!.reason!, /can't tell which checkout/, unknown);
	}
	// A failed cd or popd leaves the shell's previous folder as it was, so `cd -` goes back to the unreviewed checkout.
	for (const failed of [`cd ${dir}; cd ${wt}; cd nope; cd - && gh pr create --fill`, `cd ${dir}; cd ${wt}; popd; cd - && gh pr create --fill`, `(cd src && (ls) && cd ${wt}) && gh pr create --fill`]) {
		assert.equal(action(check(failed)), "block", failed);
	}
	for (const inside of [`(cd ${dir} && ls $(pwd) && gh pr create --fill)`, `(cd ${dir} && echo "a (b)" && gh pr create --fill)`]) {
		assert.equal(action(check(inside, OPTIONS, wt)), "block", `still inside the subshell: ${inside}`);
	}
	assert.match(check("cd -P src/.. && git push origin HEAD:main")!.reason!, /can't tell which checkout/, "cd -P with .. resolves physically");
	const unfollowed = [
		`true || cd ${wt}; git push origin HEAD:main`,
		`cd ${wt} | cat; git push origin HEAD:main`,
		`cd ${wt} & git push origin HEAD:main`,
		`cd ${wt} -P && git push origin HEAD:main`,
		`cd -e ${wt} && git push origin HEAD:main`,
		`{ cd ${wt}; } && git push origin HEAD:main`,
		`builtin cd ${wt} && git push origin HEAD:main`,
		`if true; then cd ${wt}; fi; git push origin HEAD:main`,
		`cd ${wt} # the worktree\ngit push origin HEAD:main`,
	];
	for (const command of unfollowed) assert.match(check(command)!.reason!, /can't tell which checkout/, command);
	for (const inside of [`(cd ${dir} && echo "done)" && gh pr create --fill)`, `(cd ${dir} && echo x\\) && gh pr create --fill)`, `(cd ${dir} && echo ')' && gh pr create --fill)`]) {
		assert.equal(action(check(inside, OPTIONS, wt)), "block", `a parenthesis in text doesn't close the subshell: ${inside}`);
	}
	assert.equal(action(check(`(cd ${wt} && git push -u origin feat/b) && gh pr create --fill`)), "block", "a landing inside ( … ) ends the subshell too");
	assert.equal(check(`cd ${wt} 2>/dev/null && git push origin HEAD:main`), undefined, "a harmless redirection keeps the move plain");
	const notRun = [
		`grep -q x README.md && cd ${wt}; gh pr create --fill`,
		`ls # ; cd ${wt}\ngh pr create --fill`,
		`echo $(true; cd ${wt}); gh pr create --fill`,
		`cat <(ls; cd ${wt}); gh pr create --fill`,
		`(echo $(ls -a); cd ${wt}); gh pr create --fill`,
		`true |& cd ${wt}; git push origin HEAD:main`,
		`git status ||\ncd ${wt}\ngit push origin HEAD:main`,
		`command cd ${wt} && git push origin HEAD:main`,
	];
	for (const command of notRun) assert.match(check(command)!.reason!, /can't tell which checkout/, `a move that may not run in this shell: ${command}`);
	assert.doesNotMatch(check("git log --grep cd && git push origin HEAD:main")!.reason!, /can't tell/, "cd as an argument is not a move");
	for (const command of [
		`grep -q x README.md && cd ${wt} && (ls); git push origin HEAD:main`,
		`cd ${wt} && npm test & git push origin HEAD:main`,
		`grep -q x README.md && cd ${wt} && (ls; ls); git push origin HEAD:main`,
		`grep -q x README.md && cd ${wt} && (ls || ls); git push origin HEAD:main`,
		`grep -q x README.md && cd ${wt} && (ls\nls); git push origin HEAD:main`,
		`cd ${wt} && (ls; ls) & git push origin HEAD:main`,
	]) {
		assert.match(check(command)!.reason!, /can't tell which checkout/, `a move that may not run in this shell: ${command}`);
	}
	assert.match(check(`chdir ${wt} && git push origin HEAD:main`)!.reason!, /can't tell which checkout/, "zsh chdir is not followed");
	assert.match(check(`cd ${wt}; cd ""; cd - && git push origin HEAD:main`)!.reason!, /can't tell which checkout/, "after cd \"\" the previous folder depends on the shell");
	for (const hidden of [`echo $(cd ${dir} && gh pr create --fill)`, `echo $( cd ${dir} && gh pr create --fill )`, "echo ` cd "+dir+" && gh pr create --fill`", `echo $(builtin cd ${dir} && gh pr create --fill)`, `cat <(cd ${dir} && gh pr create --fill)`, `echo x$(cd ${dir} && gh pr create --fill)`]) {
		assert.equal(action(check(hidden, OPTIONS, wt)), "block", `a move inside a substitution is not followed: ${hidden}`);
	}
	assert.match(check(`grep -q x README.md &&>/dev/null cd ${wt}; gh pr create --fill`)!.reason!, /can't tell which checkout/, "&&> is && then a redirection");
	assert.equal(check(`cd ${wt} && gh pr create --title t --body "$(cat <<'EOF'\nbody\nEOF\n)"`), undefined, "a substitution in quotes can't move the shell");
	symlinkSync(join(wt, "src"), join(dir, "lnk"));
	assert.equal(check(`cd -P lnk && cd .. && git push origin HEAD:main`), undefined, "cd -P follows the symlink's real folder");
	assert.equal(action(check(`cd -PL lnk && cd .. && git push origin HEAD:main`)), "block", "the last of -P and -L wins");
	assert.match(check(`pushd ${wt} && cd src && popd && git push origin HEAD:main`)!.reason!, /can't tell which checkout/, "cd may push the stack (zsh AUTO_PUSHD)");
	for (const inside of [`(cd ${dir} && echo $(git rev-parse HEAD) && gh pr create --fill)`, `(cd ${dir}; cat <(ls); gh pr create --fill)`]) {
		assert.equal(action(check(inside, OPTIONS, wt)), "block", `a subshell in a command the guard can't follow: ${inside}`);
	}
});

test("gate files: a > is a write wherever it stands, since the guard can't pair quotes as the shell does", () => {
	const project = mkdtempSync(join(tmpdir(), "gate-files-"));
	const records = join(tmpdir(), "eng-kit", "reviews");
	const check = (command: string, cwd = project) => checkGateFiles(command, cwd, project, ".pi/guard.json")?.action ?? "allow";
	assert.equal(check(`cat x > ${records}/y`), "block");
	assert.equal(check(`cd ${records}/h && cat <<EOF\nls what's here\nEOF\ncat /tmp/r.json > abc.json`, "/"), "block", "an apostrophe in a heredoc body doesn't hide a later write");
});

test("a PR created inside a compound command is registered, even when a later step fails or a subshell moved", () => {
	const { dir, root, git } = repo();
	const open = () => openPrBranches(dir, dir, "origin", "refs/remotes/origin/main", root);
	notePr(dir, "t1", "(cd /tmp) && gh pr create --fill", dir, root);
	settlePr(dir, "t1", true, root);
	assert.deepEqual(open(), ["feat/a"], "the subshell's cd ends with it");
	const wt = join(dir, ".worktrees", "n");
	git("worktree", "add", "-q", "-b", "feat/n", wt, "main");
	notePr(dir, "t3", `(cd src && (ls) && cd ${wt}) && gh pr create --fill`, dir, root);
	settlePr(dir, "t3", true, root);
	assert.deepEqual(open(), ["feat/a"], "after a nested subshell the folder stays unknown: feat/n is not noted");
	notePr(dir, "t4", `grep -q x README.md && cd ${wt} && (ls); gh pr create --fill`, dir, root);
	settlePr(dir, "t4", true, root);
	assert.deepEqual(open(), ["feat/a"], "a move in a broken && chain is not followed: feat/n is not noted");
	notePr(dir, "t5", `grep -q x README.md && cd ${wt} && (ls; ls); gh pr create --fill`, dir, root);
	settlePr(dir, "t5", true, root);
	assert.deepEqual(open(), ["feat/a"], "a separator inside the subshell doesn't end the outer && chain");
	notePr(dir, "t6", `echo $( cd ${wt} && gh pr create --fill )`, dir, root);
	notePr(dir, "t7", `PR=$(cd ${wt} && gh pr create --fill)`, dir, root);
	settlePr(dir, "t7", true, root);
	settlePr(dir, "t6", true, root);
	assert.deepEqual(open(), ["feat/a"], "a move inside a substitution is not followed");
	const other = repo();
	notePr(other.dir, "t2", "gh pr create --fill && gh pr view --web", other.dir, other.root);
	settlePr(other.dir, "t2", false, other.root);
	assert.deepEqual(openPrBranches(other.dir, other.dir, "origin", "refs/remotes/origin/main", other.root), ["feat/a"], "the call failed after the PR step: it may exist");
});

test("without a tracking ref for the base, a remote branch that merely ends in /<base> is not the anchor", () => {
	const { git, commit, check, review } = repo();
	git("remote", "remove", "origin");
	git("switch", "-qc", "other", "main");
	const x = commit({ "src/x.ts": "export const x = 1;\n" });
	git("update-ref", "refs/remotes/up/team/main", x);
	git("switch", "-qc", "feat/b", x);
	const c = commit({ "src/c.ts": "export const c = 1;\n" });
	review(report(c, "Yes", x));
	git("switch", "-q", "main");
	assert.match(String(check("git merge feat/b")?.reason), /does not cover/, "x is on up/team/main, not on the local main");
});
