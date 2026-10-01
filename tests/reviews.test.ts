import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkGateFiles, checkReview, exempt, parseReview, readReviews, recordReview, recordVerdict, stripRedirects, type ReviewGateOptions } from "../extensions/lib/reviews.ts";

const OPTIONS: ReviewGateOptions = { workDocs: ["docs/tasks"], missing: "block", waiver: "reviewGate: false", verify: ["npm test", "npm run lint"] };

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

test("shell writes to the gate's own files: records are blocked, the guard config asks, reads pass", () => {
	const project = mkdtempSync(join(tmpdir(), "gate-files-"));
	mkdirSync(join(project, ".pi"));
	const guard = ".pi/guard.json";
	const check = (command: string) => checkGateFiles(command, project, project, guard)?.action ?? "allow";
	const records = join(tmpdir(), "eng-kit", "reviews");
	assert.equal(check(`echo '{}' > ${records}/x/y.json`), "block");
	assert.equal(check(`cd ${join(tmpdir(), "eng-kit")} && echo x > reviews/h/y.json`), "block", "cd is followed");
	assert.equal(check(`grep -rn eng-kit/reviews lib/`), "allow", "reading is fine");
	assert.equal(check(`ls ${records}`), "allow");
	for (const write of [`echo '{"reviewGate":false}' > .pi/guard.json`, "sed -i '' s/x/y/ ./.pi/guard.json", "cat new.json > .pi/guard.json", "jq . x | tee .pi/guard.json", "git checkout main -- .pi/guard.json", "git restore -s HEAD~1 .pi/guard.json", "cd .pi && sed -i '' s/a/b/ guard.json", "(cd .pi && sed -i '' s/a/b/ guard.json)"]) {
		assert.equal(check(write), "confirm", write);
	}
	for (const read of ["cat .pi/guard.json", "git diff .pi/guard.json", "git log -p .pi/guard.json", "npm test"]) assert.equal(check(read), "allow", read);
});

test("HEAD pushes, whitespace and binary changes, and directories the guard can't follow", () => {
	const { dir, git, commit, head, check, review } = repo();
	review(report(head, "Yes"));
	const pyReviewed = commit({ "src/job.py": "if ok:\n    run()\nclean()\n" });
	review(report(pyReviewed, "Yes"));
	assert.equal(check("gh pr create --fill"), undefined);
	commit({ "src/job.py": "if ok:\n    run()\n    clean()\n" });
	assert.equal(action(check("gh pr create --fill")), "block", "an indentation change is a code change");
	const binReviewed = commit({ "src/job.py": "if ok:\n    run()\nclean()\n", "bin/tool.bin": "\u0000\u0001" });
	review(report(binReviewed, "Yes"));
	commit({ "bin/tool.bin": "\u0000\u0002" });
	assert.equal(action(check("gh pr create --fill")), "block", "a changed binary is a code change");

	for (const unknown of [`cd "$WT" && gh pr create`, "cd $(git rev-parse --show-toplevel) && gh pr create", "cd ~/no-such-dir-xyz && gh pr create", "(cd .worktrees/none && gh pr create)", "gh pr merge feat/a -R o/r"]) {
		assert.equal(action(check(unknown)), "block", unknown);
	}
	git("switch", "-q", "main");
	commit({ "src/hotfix.ts": "export const fix = 1;\n" });
	for (const push of ["git push origin HEAD", "git push -u origin HEAD", "git push origin @", "git push origin HEAD:main"]) assert.equal(action(check(push)), "block", push);
	assert.equal(action(check("git branch -f main feat/a && git push origin main")), "block", "a ref move before a push");
	assert.equal(action(check("git fetch . feat/a:main && git push origin main")), "block");
	assert.equal(check("git status && git fetch origin"), undefined);
	assert.ok(dir);
});

test("the newest review of a change decides; a failed run spoils only its commit; merge -m and agent rules", () => {
	const { dir, root, git, commit, head, check, review } = repo();
	review(report(head, "Yes"), "p1", "a");
	const docs = commit({ "docs/more.md": "x\n" });
	review(report(docs, "No"), "p2", "a");
	git("switch", "-q", "main");
	assert.equal(action(check(`git push origin ${head}:main`)), "block", "a later No on the same change wins over an older exact Yes");

	git("switch", "-q", "feat/a");
	review(report(docs, "Yes"), "p3", "a");
	recordVerdict(dir, docs, "Inconclusive", { promptId: "p3", run: "b" }, root);
	assert.equal(readReviews(dir, root)[0]?.verdict, "Inconclusive", "a parallel run that failed on the same commit counts against it");
	const fixed = commit({ "src/a.ts": "export const a = 3;\n" });
	review(report(fixed, "Yes"), "p3", "c");
	assert.equal(readReviews(dir, root)[0]?.verdict, "Yes", "a re-review of a later commit in the same prompt is unaffected");
	git("switch", "-q", "main");
	assert.equal(check("git merge -m 'land a' feat/a"), undefined, "the -m value is not a ref");

	for (const rule of ["agents.md", "AGENTS.override.md", "CLAUDE.MD", "docs/conf.py", "docs/.vitepress/config.ts", "docs/requirements.txt"]) assert.equal(exempt(rule, "", []), false, rule);
});

test("a PR merge checks the remote head too; glab -s names the branch", () => {
	const { dir, git, run, commit, head, check, review } = repo();
	git("push", "-q", "origin", "feat/a");
	review(report(head, "Yes"));
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

test("a rebase over another edit to a file the branch changes keeps the review", () => {
	const { git, commit, check, review } = repo();
	const lines = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`);
	git("switch", "-q", "main");
	commit({ "src/big.ts": `${lines.join("\n")}\n` });
	git("push", "-q", "origin", "main");
	git("switch", "-q", "feat/a");
	git("rebase", "-q", "main");
	const branchLines = [...lines];
	branchLines[1] = "export const v1 = 100;";
	const reviewed = commit({ "src/big.ts": `${branchLines.join("\n")}\n` });
	review(report(reviewed, "Yes"));
	git("switch", "-q", "main");
	const baseLines = ["// header added on main", ...lines];
	baseLines[39] = "export const v38 = 380;";
	commit({ "src/big.ts": `${baseLines.join("\n")}\n` });
	git("push", "-q", "origin", "main");
	git("switch", "-q", "feat/a");
	git("rebase", "-q", "main");
	assert.equal(check("gh pr create --fill"), undefined, "the branch's own hunk is unchanged, though its line moved");
	commit({ "src/big.ts": `${["// header added on main", ...branchLines].map((l, i) => (i === 39 ? "export const v38 = 380;" : i === 2 ? "export const v1  = 100;" : l)).join("\n")}\n` });
	assert.equal(action(check("gh pr create --fill")), "block", "whitespace inside the branch's own line still counts");
});

test("before a landing: read-only steps and the project's verify commands may run; anything else may not", () => {
	const { head, check, review } = repo();
	review(report(head, "Yes"));
	for (const ok of ["npm test && gh pr create --fill", "npm run lint && npm test && gh pr create", "git log --oneline | head -5 && gh pr create --fill", "(cd src && ls) && gh pr create --fill", `(cd ${tmpdir()} && ls) && gh pr create --fill`]) {
		assert.equal(check(ok), undefined, ok);
	}
	for (const bad of ["npm run build && gh pr create", "npm version patch && gh pr create", "popd && gh pr create"]) assert.equal(action(check(bad)), "block", bad);
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

test("non-ASCII doc names are recognized as docs", () => {
	const { git, commit, check } = repo();
	git("switch", "-qc", "docs/ru", "main");
	commit({ "docs/архитектура.md": "текст\n" });
	assert.equal(check("gh pr create --fill"), undefined);
});

test("the change identity: moved lines, trailing whitespace, odd file names and color settings", () => {
	const { git, commit, check, review } = repo();
	git("switch", "-q", "main");
	commit({ "src/flow.ts": "a();\nb();\nc();\nd();\ne();\nf();\n" });
	git("push", "-q", "origin", "main");
	git("switch", "-q", "feat/a");
	git("rebase", "-q", "main");
	const reviewed = commit({ "src/flow.ts": "a();\nb();\nauthorize();\nc();\nd();\ne();\nf();\n", 'src/we"ird.ts': "a\n", "src/back\\slash.ts": "a\n", "src/z.ts": "export const z = 1;\n" });
	review(report(reviewed, "Yes"));
	git("config", "color.ui", "always");
	assert.equal(check("gh pr create --fill"), undefined, "color.ui=always changes nothing");
	const cases: Array<[string, string]> = [
		["src/flow.ts", "a();\nb();\nc();\nd();\nauthorize();\ne();\nf();\n"],
		["src/z.ts", "export const z = 1;   \n"],
		["src/z.ts", "export const z = 1;\r\n"],
		['src/we"ird.ts', "b\n"],
		["src/back\\slash.ts", "b\n"],
	];
	for (const [file, content] of cases) {
		const before = git("rev-parse", "HEAD");
		commit({ [file]: content });
		assert.equal(action(check("gh pr create --fill")), "block", `${file}: ${JSON.stringify(content)}`);
		git("reset", "-q", "--hard", before);
	}
});

test("redirected verify commands may precede a landing; a nested subshell fails closed", () => {
	const { head, check, review } = repo();
	review(report(head, "Yes"));
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
