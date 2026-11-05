import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, beforeEach } from "node:test";
import { slowGit } from "./slow-git.ts";
import bootstrap, { BOOTSTRAP_MARKER } from "../extensions/bootstrap.ts";
import { readReports, readReviews, recordVerdict, reviewsDir } from "../extensions/lib/reviews.ts";
import guard from "../extensions/guard.ts";
import init from "../extensions/init.ts";
import models from "../extensions/models.ts";
import verify from "../extensions/verify.ts";
import { verifyState } from "../extensions/lib/verify-state.ts";

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


// Isolate git from the machine's own config (the guard's git calls inherit this process's environment).
process.env.HOME = mkdtempSync(join(tmpdir(), "home-"));
process.env.XDG_CONFIG_HOME = join(process.env.HOME, ".config");
process.env.GIT_CONFIG_NOSYSTEM = "1";

type Handler = (event: any, ctx: any) => unknown;

// The guard's session record lives in the environment and on globalThis: each test starts without one.
beforeEach(() => {
	delete process.env.ENG_KIT_GUARD_BASELINE;
	verifyState.guardBaseline = undefined;
});

function fakePi(execCodes: Record<string, number> = {}, onExec: (command: string) => void = () => {}) {
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: any; options: any }> = [];
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const execs: string[] = [];
	const modelCalls: string[] = [];
	const pi = {
		async setModel(model: any) {
			modelCalls.push(`model:${model.provider}/${model.id}`);
			return true;
		},
		setThinkingLevel(level: string) {
			modelCalls.push(`thinking:${level}`);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage(message: any, options?: any) {
			sent.push({ message, options });
		},
		sendUserMessage(content: any, options?: any) {
			sent.push({ message: { user: content }, options });
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
		async exec(_shell: string, args: string[]) {
			const command = args[args.length - 1]!;
			execs.push(command);
			onExec(command);
			const code = execCodes[command] ?? 0;
			return { stdout: code === 0 ? "ok" : `boom in ${command}`, stderr: "", code, killed: false };
		},
	};
	const emit = async (event: string, payload: any, ctx: any) => {
		let result: unknown;
		for (const h of handlers.get(event) ?? []) result = (await h({ type: event, ...payload }, ctx)) ?? result;
		return result as any;
	};
	return { pi: pi as any, handlers, sent, tools, commands, execs, modelCalls, emit };
}

function ctx(cwd: string, opts: { hasUI?: boolean; confirm?: boolean; trusted?: boolean } = {}) {
	const notes: string[] = [];
	const asked: string[] = [];
	return {
		cwd,
		hasUI: opts.hasUI ?? true,
		isProjectTrusted: () => opts.trusted ?? true,
		notes,
		asked,
		ui: {
			confirm: async (title: string, message: string) => (asked.push(`${title} ${message}`), opts.confirm ?? false),
			notify: (m: string) => notes.push(m),
			setStatus: () => {},
			setWorkingMessage: () => {},
		},
	};
}

function project(files: Record<string, string>) {
	const dir = temp("kit-");
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(resolve(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

// ---------- package manifest ----------

test("package.json is a pi package exposing skills, prompts and all extensions", () => {
	const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));
	assert.ok(pkg.keywords.includes("pi-package"));
	assert.deepEqual(pkg.pi.skills, ["./skills"]);
	assert.deepEqual(pkg.pi.prompts, ["./prompts/*.md"]);
	assert.deepEqual(pkg.pi.extensions, [
		"./extensions/bootstrap.ts",
		"./extensions/guard.ts",
		"./extensions/verify.ts",
		"./extensions/models.ts",
		"./extensions/init.ts",
	]);
	for (const dep of Object.keys(pkg.dependencies ?? {})) assert.ok(!dep.startsWith("@earendil-works/"), `${dep} must be a peer dependency`);
});

// ---------- bootstrap ----------

test("bootstrap injects using-skills into every request as one user message after compaction summaries", async () => {
	const { pi, emit, handlers } = fakePi();
	bootstrap(pi);
	assert.deepEqual([...handlers.keys()], ["context"], "stateless: no lifecycle flags to get out of sync");

	const summary = { role: "compactionSummary", summary: "earlier" };
	const user = { role: "user", content: "hi", timestamp: 1 };
	const result = await emit("context", { messages: [summary, user] }, {});
	assert.equal(result.messages.length, 3);
	assert.equal(result.messages[0], summary);
	assert.equal(result.messages[1].role, "user");
	const text = result.messages[1].content[0].text as string;
	assert.ok(text.includes(BOOTSTRAP_MARKER));
	assert.ok(text.includes("## The rule"), "skill body is inlined");
	assert.ok(!text.includes("description:"), "frontmatter is stripped");

	assert.equal(await emit("context", { messages: result.messages }, {}), undefined, "no duplicate while marker present");
	// context edits are not persisted, so a later agent run (next prompt, follow-up) must get it again
	const later = await emit("context", { messages: [user, { role: "assistant", content: "ok" }, user] }, {});
	assert.equal(later.messages.length, 4);
	assert.ok(later.messages[0].content[0].text.includes(BOOTSTRAP_MARKER));
});

// ---------- guard ----------

test("guard blocks, confirms and allows tool calls", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const dir = project({});

	const blocked = await emit("tool_call", { toolName: "bash", input: { command: "git push --force" } }, ctx(dir));
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /force-with-lease/);

	assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, ctx(dir)), undefined);
	assert.equal((await emit("tool_call", { toolName: "read", input: { path: ".env" } }, ctx(dir))).block, true);

	const push = { toolName: "bash", input: { command: "git push origin feature" } };
	assert.equal(await emit("tool_call", push, ctx(dir, { confirm: true })), undefined, "confirmed by human");
	assert.equal((await emit("tool_call", push, ctx(dir, { confirm: false }))).block, true, "declined by human");
	assert.match((await emit("tool_call", push, ctx(dir, { hasUI: false }))).reason, /unavailable/, "no UI means block");
});

test("guard: in a workspace, a write of a repository's CI pipeline asks", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const { dir } = workspaceProject();
	const c = ctx(dir, { confirm: false });
	const write = await emit("tool_call", { toolName: "write", input: { path: "a/.github/workflows/ci.yml" } }, c);
	assert.equal(write?.block, true, "the write is asked about");
	assert.match(write.reason, /CI\/release pipeline/);
	assert.equal(c.asked.length, 1, "asked, then declined");
});

test("guard: in a workspace, a repository's restrictions always apply and its loosening only in a trusted project", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const { dir } = workspaceProject();
	mkdirSync(join(dir, "a", ".pi"), { recursive: true });
	writeFileSync(join(dir, "a", ".pi", "guard.json"), JSON.stringify({ allow: ["npm run deploy"], block: ["make release"] }));
	const deploy = { toolName: "bash", input: { command: "cd a && npm run deploy" } };
	assert.equal(await emit("tool_call", deploy, ctx(dir, { trusted: true })), undefined);
	assert.equal((await emit("tool_call", deploy, ctx(dir, { trusted: false, confirm: false }))).block, true);
	const release = await emit("tool_call", { toolName: "bash", input: { command: "cd a && make release" } }, ctx(dir, { trusted: false }));
	assert.equal(release.block, true);
	assert.match(release.reason, /make release/);
});

test("guard: in a workspace, a repository's guard config is asked about in every form, also before git init", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const { dir } = workspaceProject();
	mkdirSync(join(dir, "a", ".pi"), { recursive: true });
	for (const command of ["cd a/.pi && echo '{}' > guard.json", "echo '{}' > a/.pi/./guard.json"]) {
		const c = ctx(dir, { confirm: false });
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command } }, c))?.block, true, command);
		assert.equal(c.asked.length, 1, command);
	}
	const c = ctx(dir, { confirm: false });
	assert.equal((await emit("tool_call", { toolName: "write", input: { path: "x/.pi/guard.json" } }, c))?.block, true, "x has no .git yet");
	assert.equal(c.asked.length, 1);
});

test("guard: in a workspace, a PowerShell landing can't be placed and is blocked", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const { dir, git } = workspaceProject();
	git("a", "switch", "-qc", "feat/x");
	mkdirSync(join(dir, "a", "docs", "tasks"), { recursive: true });
	writeFileSync(join(dir, "a", "docs", "tasks", "t.md"), "# T\n");
	git("a", "add", "-A");
	git("a", "commit", "-qm", "task");
	const pr = await emit("tool_call", { toolName: "powershell", input: { command: "Set-Location a; gh pr create" } }, ctx(dir));
	assert.equal(pr?.block, true);
	assert.match(pr.reason, /can't tell which repository/);
});

test("guard: in a workspace, a repository cloned after the session started pushes only with a question", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const { dir } = workspaceProject();
	await emit("session_start", { reason: "startup" }, ctx(dir));
	const remote = temp("kit-remote-");
	spawnSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
	const c = join(dir, "c");
	const run = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: c });
	mkdirSync(c);
	run("init", "-q", "-b", "main");
	run("commit", "-q", "--allow-empty", "-m", "init");
	run("remote", "add", "origin", remote);
	run("push", "-q", "origin", "main");
	run("switch", "-qc", "feat/x");
	const asked = ctx(dir, { confirm: false });
	assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "git -C c push" } }, asked))?.block, true);
	assert.match(asked.asked[0] ?? "", /pushes to a remote/);
});

test("guard: in a workspace, an untrusted project ignores a repository's reviewGate and workDocs", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const { dir, git } = workspaceProject();
	git("a", "switch", "-qc", "feat/x");
	mkdirSync(join(dir, "a", "docs", "tasks"), { recursive: true });
	writeFileSync(join(dir, "a", "docs", "tasks", "t.md"), "# T\n");
	git("a", "add", "-A");
	git("a", "commit", "-qm", "task");
	mkdirSync(join(dir, "a", ".pi"));
	writeFileSync(join(dir, "a", ".pi", "guard.json"), JSON.stringify({ reviewGate: false, workDocs: [] }));
	const pr = { toolName: "bash", input: { command: "cd a && gh pr create --fill" } };
	const untrusted = await emit("tool_call", pr, ctx(dir, { trusted: false }));
	assert.equal(untrusted?.block, true);
	assert.match(untrusted.reason, /Task files would reach/);
	assert.equal(await emit("tool_call", pr, ctx(dir, { trusted: true })), undefined, "trusted: a's task-file rule is off and its gate waived");
});

test("guard: in a workspace, a repository's broken config and its rules name that config", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const { dir } = workspaceProject();
	mkdirSync(join(dir, "a", ".pi"), { recursive: true });
	writeFileSync(join(dir, "a", ".pi", "guard.json"), JSON.stringify({ block: ["make release", "(unclosed"] }));
	const c = ctx(dir);
	const blocked = await emit("tool_call", { toolName: "bash", input: { command: "echo $(cd b) && make release" } }, c);
	assert.match(blocked.reason, /make release\/ in a\/\.pi\/guard\.json/);
	assert.ok(c.notes.some((n) => /invalid regex ignored in a\/\.pi\/guard\.json/.test(n)), JSON.stringify(c.notes));
	mkdirSync(join(dir, "b", ".pi"));
	writeFileSync(join(dir, "b", ".pi", "guard.json"), "{");
	const broken = ctx(dir);
	await emit("tool_call", { toolName: "bash", input: { command: "ls" } }, broken);
	assert.ok(broken.notes.some((n) => /b[\\/]\.pi[\\/]guard\.json/.test(n)), JSON.stringify(broken.notes));
});

/** A repository `c` cloned into `dir` with a work branch `feat/x` that has a remote: pushing it is an own-branch push. */
function cloneLater(dir: string, name = "c") {
	const remote = temp("kit-remote-");
	spawnSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
	const c = join(dir, name);
	const run = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: c });
	mkdirSync(c);
	run("init", "-q", "-b", "main");
	run("commit", "-q", "--allow-empty", "-m", "init");
	run("remote", "add", "origin", remote);
	run("push", "-q", "origin", "main");
	run("switch", "-qc", "feat/x");
}

test("guard: without a session_start, the baseline is the folder at the first check", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const { dir } = workspaceProject();
	assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx(dir)), undefined);
	cloneLater(dir);
	assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "git -C c push" } }, ctx(dir, { confirm: false })))?.block, true);
});

test("guard: a child pi process in the same folder takes its parent's baseline", async () => {
	const { dir } = workspaceProject();
	const saved = process.env.ENG_KIT_GUARD_BASELINE;
	delete process.env.ENG_KIT_GUARD_BASELINE;
	try {
		const parent = fakePi();
		guard(parent.pi);
		await parent.emit("session_start", { reason: "startup" }, ctx(dir));
		cloneLater(dir);
		const child = fakePi();
		guard(child.pi);
		await child.emit("session_start", { reason: "startup" }, ctx(dir));
		assert.equal((await child.emit("tool_call", { toolName: "bash", input: { command: "git -C c push" } }, ctx(dir, { confirm: false })))?.block, true);
	} finally {
		if (saved === undefined) delete process.env.ENG_KIT_GUARD_BASELINE;
		else process.env.ENG_KIT_GUARD_BASELINE = saved;
	}
});

test("guard: in a workspace, the review gate holds a PowerShell landing even with task files off", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const { dir } = workspaceProject({ ...COMMANDS, ".pi/guard.json": JSON.stringify({ workDocs: [] }) });
	const pr = await emit("tool_call", { toolName: "powershell", input: { command: "Set-Location a; gh pr create --fill" } }, ctx(dir, { confirm: false }));
	assert.equal(pr?.block, true);
	assert.match(pr.reason, /can't tell which checkout/);
});

test("guard: in a workspace, the review gate holds a PR named by GH_REPO even with task files off", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const { dir } = workspaceProject({ ...COMMANDS, ".pi/guard.json": JSON.stringify({ workDocs: [] }) });
	const pr = await emit("tool_call", { toolName: "bash", input: { command: "GH_REPO=org/a gh pr create -H feat/x --fill" } }, ctx(dir, { confirm: false }));
	assert.equal(pr?.block, true);
	assert.match(pr.reason, /can't tell which repository/);
});

test("guard: a child pi process started in a repository cloned into the workspace pushes only with a question", async () => {
	const { dir } = workspaceProject();
	const saved = process.env.ENG_KIT_GUARD_BASELINE;
	delete process.env.ENG_KIT_GUARD_BASELINE;
	try {
		const parent = fakePi();
		guard(parent.pi);
		await parent.emit("session_start", { reason: "startup" }, ctx(dir));
		cloneLater(dir);
		const child = fakePi();
		guard(child.pi);
		const c = join(dir, "c");
		await child.emit("session_start", { reason: "startup" }, ctx(c));
		assert.equal((await child.emit("tool_call", { toolName: "bash", input: { command: "git push" } }, ctx(c, { confirm: false })))?.block, true);
		assert.match(String(process.env.ENG_KIT_GUARD_BASELINE), new RegExp(JSON.stringify(dir).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the child keeps the parent's record");
	} finally {
		if (saved === undefined) delete process.env.ENG_KIT_GUARD_BASELINE;
		else process.env.ENG_KIT_GUARD_BASELINE = saved;
	}
});

/** A parent pi session in `parent`, and a child pi process (a subagent) in `child`, sharing the environment record. */
async function parentAndChild(parent: string, child: string, between: () => void = () => {}, trust: { parent?: boolean; child?: boolean } = {}) {
	const saved = process.env.ENG_KIT_GUARD_BASELINE;
	delete process.env.ENG_KIT_GUARD_BASELINE;
	const p = fakePi();
	guard(p.pi);
	await p.emit("session_start", { reason: "startup" }, ctx(parent, { trusted: trust.parent ?? true }));
	between();
	const c = fakePi();
	guard(c.pi);
	await c.emit("session_start", { reason: "startup" }, ctx(child, { trusted: trust.child ?? true }));
	return { emit: c.emit, restore: () => (saved === undefined ? delete process.env.ENG_KIT_GUARD_BASELINE : (process.env.ENG_KIT_GUARD_BASELINE = saved)) };
}

test("guard: a child below a workspace folder that isn't a repository doesn't push a later clone silently", async () => {
	const { dir } = workspaceProject();
	mkdirSync(join(dir, "tmp"));
	const { emit, restore } = await parentAndChild(dir, join(dir, "tmp"), () => cloneLater(join(dir, "tmp")));
	try {
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "git -C c push" } }, ctx(join(dir, "tmp"), { confirm: false })))?.block, true);
	} finally {
		restore();
	}
});

test("guard: a child in a workspace repository keeps what that repository restricted at the start", async () => {
	const { dir } = workspaceProject();
	mkdirSync(join(dir, "a", ".pi"));
	writeFileSync(join(dir, "a", ".pi", "guard.json"), JSON.stringify({ block: ["make release"] }));
	const { emit, restore } = await parentAndChild(dir, join(dir, "a"), () => rmSync(join(dir, "a", ".pi"), { recursive: true }));
	try {
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "make release" } }, ctx(join(dir, "a"))))?.block, true);
	} finally {
		restore();
	}
});

test("guard: in one repository, a child in a subfolder pushes its own work branch without a question", async () => {
	const dir = temp("kit-");
	cloneLater(dir, "r");
	const r = join(dir, "r");
	mkdirSync(join(r, "packages", "x"), { recursive: true });
	const { emit, restore } = await parentAndChild(r, join(r, "packages", "x"));
	try {
		assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "git push" } }, ctx(join(r, "packages", "x"), { confirm: false })), undefined);
	} finally {
		restore();
	}
});

/** A repository `r` in a temp folder with a remote, a committed `.pi/guard.json` and the work branch `feat/x`. */
function repoWithGuard(guardJson: object, dir = temp("kit-")) {
	cloneLater(dir, "r");
	const r = join(dir, "r");
	const run = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: r, encoding: "utf8" });
	mkdirSync(join(r, ".pi"));
	writeFileSync(join(r, ".pi", "guard.json"), JSON.stringify(guardJson));
	run("add", "-A");
	run("commit", "-q", "-m", "guard");
	return { dir, r, run };
}

test("guard: a child in a worktree below the session keeps its own checkout's CI, protected paths and push", async () => {
	const { r, run } = repoWithGuard({ protectedPaths: ["db/"] });
	assert.equal(run("worktree", "add", "-q", join(r, ".worktrees", "x"), "-b", "feat/w").status, 0);
	const wt = join(r, ".worktrees", "x");
	const { emit, restore } = await parentAndChild(r, wt);
	try {
		assert.match((await emit("tool_call", { toolName: "write", input: { path: "db/m.sql" } }, ctx(wt)))?.reason ?? "", /protected by/, "the worktree's protected path");
		const asked = ctx(wt, { confirm: false });
		assert.equal((await emit("tool_call", { toolName: "write", input: { path: ".github/workflows/ci.yml" } }, asked))?.block, true);
		assert.match(asked.asked[0] ?? "", /CI\/release pipeline/);
		assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "git push" } }, ctx(wt, { confirm: false })), undefined, "its own branch");
	} finally {
		restore();
	}
});

test("guard: a child in a repository below the folder pi started in is judged by that repository's own config", async () => {
	// pi started two levels above the repository, so the record's folder holds it without being a workspace of it.
	const above = temp("kit-");
	mkdirSync(join(above, "code"));
	const { r } = repoWithGuard({ block: ["make release"] }, join(above, "code"));
	const { emit, restore } = await parentAndChild(above, r);
	try {
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "make release" } }, ctx(r)))?.block, true);
	} finally {
		restore();
	}
});

test("guard: a trusted child of an untrusted session gets no loosening from the session's config", async () => {
	const { r } = repoWithGuard({ allow: ["npm run deploy"], reviewGate: false });
	mkdirSync(join(r, "packages", "x"), { recursive: true });
	const child = join(r, "packages", "x");
	const { emit, restore } = await parentAndChild(r, child, () => {}, { parent: false, child: true });
	try {
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "npm run deploy" } }, ctx(child, { trusted: true, hasUI: false })))?.block, true);
	} finally {
		restore();
	}
});

test("guard: a trusted child in its untrusted parent's own folder gets no loosening from that folder's config", async () => {
	const { r } = repoWithGuard({ allow: ["npm run deploy"], reviewGate: false });
	const { emit, restore } = await parentAndChild(r, r, () => {}, { parent: false, child: true });
	try {
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "npm run deploy" } }, ctx(r, { trusted: true, hasUI: false })))?.block, true);
	} finally {
		restore();
	}
});

test("guard: a read through a symlink to a secret file is blocked", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const { dir } = workspaceProject();
	writeFileSync(join(dir, "a", ".env"), "TOKEN=x\n");
	symlinkSync(join(dir, "a", ".env"), join(dir, "a", "dev.cfg"));
	assert.equal((await emit("tool_call", { toolName: "read", input: { path: "a/dev.cfg" } }, ctx(dir)))?.block, true);
});

test("guard honours .pi/guard.json, but only trusted projects may relax confirmation", async () => {
	const { pi, emit } = fakePi();
	guard(pi);
	const dir = project({ ".pi/guard.json": JSON.stringify({ allow: ["^git push origin feature"], protectedPaths: ["db/migrations/"], block: ["(unclosed"] }) });
	const push = { toolName: "bash", input: { command: "git push origin feature" } };

	assert.equal(await emit("tool_call", push, ctx(dir, { trusted: true })), undefined);
	assert.equal((await emit("tool_call", push, ctx(dir, { trusted: false, confirm: false }))).block, true);
	const c = ctx(dir);
	assert.equal((await emit("tool_call", { toolName: "write", input: { path: "db/migrations/1.sql" } }, c)).block, true);
	assert.ok(c.notes.some((n) => n.includes("invalid regex")), "bad regex is reported, not thrown");
});

// ---------- verify ----------

test("verify reminds once after unverified edits and clears after a green run", async () => {
	const dir = project({ "AGENTS.md": "## Commands\n- `npm test`\n- `npm run typecheck`\n" });
	const { pi, emit, sent, tools } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);

	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0, "no edits, no reminder");

	await emit("tool_result", { toolName: "edit", input: { path: "a.ts" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.options.triggerTurn, true);
	assert.match(sent[0]!.message.content, /run_verification/);

	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1, "at most one reminder per user prompt");

	await emit("input", { text: "go on", source: "interactive" }, c);
	await emit("tool_result", { toolName: "bash", input: { command: "npm test" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 2, "one of two checks is not proof");

	await emit("input", { text: "again", source: "interactive" }, c);
	const result = await tools.get("run_verification").execute("id", {}, undefined, undefined, c);
	assert.equal(result.details.ok, true);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 2, "green run clears the gate");
});

test("verify ignores edits outside the project and doc edits by default", async () => {
	const dir = project({ "AGENTS.md": "## Commands\n- `npm test`\n" });
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	for (const path of ["README.md", "docs/tasks/x.md", "/tmp/elsewhere/a.ts", "../sibling/b.ts"]) {
		await emit("tool_result", { toolName: "write", input: { path }, isError: false }, c);
	}
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0, "nothing the checks verify changed");
	await emit("tool_result", { toolName: "edit", input: { path: "src/a.ts" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1);
});

/** A git repository with `src/a.ts` committed and the given files, so shell changes are found from the working tree. */
function gitProject(files: Record<string, string>) {
	const dir = project({ ...files, "src/a.ts": "export const a = 1;\n" });
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", "initial");
	return { dir, edit: (content: string) => writeFileSync(join(dir, "src/a.ts"), content) };
}

const COMMANDS = { "AGENTS.md": "## Commands\n- `npm test`\n- `npm run typecheck`\n" };

test("verify: a file changed from the shell marks the workspace, also when the command fails", async () => {
	for (const isError of [false, true]) {
		const { dir, edit } = gitProject(COMMANDS);
		const { pi, emit, sent } = fakePi();
		verify(pi);
		const c = ctx(dir);
		await emit("session_start", { reason: "startup" }, c);
		edit("export const a = 2;\n");
		await emit("tool_result", { toolName: "bash", input: { command: "cat > src/a.ts <<'EOF'\nexport const a = 2;\nEOF" }, isError }, c);
		await emit("agent_end", { messages: [] }, c);
		assert.equal(sent.length, 1, `isError: ${isError}`);
		assert.match(sent[0]!.message.content, /src\/a\.ts/);
	}
});

test("verify: a verification run that changes files doesn't mark the workspace again", async () => {
	const { dir, edit } = gitProject(COMMANDS);
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await bashCall(emit, c, "sed -i '' 's/1/2/' src/a.ts", false, () => edit("export const a = 2;\n"));
	await bashCall(emit, c, "npm test");
	await bashCall(emit, c, "npm run typecheck", false, () => edit("export const a = 3;\n"));
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0, "the typecheck run's own change keeps npm test green");
});

test("verify: outside git the command's text decides", async () => {
	const dir = project(COMMANDS);
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await emit("tool_result", { toolName: "bash", input: { command: "echo x > /tmp/y" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0, "a write outside the project");
	await emit("tool_result", { toolName: "bash", input: { command: "echo x > src/a.ts" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1);
});

test("verify: outside git, $HOME is the shell's in bash and PowerShell's own variable in powershell", async () => {
	const dir = project(COMMANDS);
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await emit("tool_result", { toolName: "bash", input: { command: "echo x > $HOME/a.ts" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0, "a write into the home folder");
	await emit("tool_result", { toolName: "powershell", input: { command: "echo x > $HOME/a.ts" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1, "a write the hook can't place");
});

test("verify: without commands the user gets one notice and the agent no follow-up", async () => {
	const dir = project({});
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await emit("tool_result", { toolName: "edit", input: { path: "src/a.ts" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0, "nothing to run, so no follow-up");
	assert.equal(c.notes.length, 1);
	assert.match(c.notes[0]!, /no verification commands/i);
	assert.match(c.notes[0]!, /\.pi\/verify\.json/);
	assert.match(c.notes[0]!, /kit-init/);
	await emit("input", { text: "more", source: "interactive" }, c);
	await emit("tool_result", { toolName: "edit", input: { path: "src/b.ts" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(c.notes.length, 1, "once per session");
});

test("verify: the follow-up asks for the complete final report", async () => {
	const dir = project(COMMANDS);
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await emit("tool_result", { toolName: "edit", input: { path: "src/a.ts" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	const text = sent[0]!.message.content;
	assert.match(text, /complete final report/);
	assert.match(text, /what changed/);
	assert.match(text, /what the user must do next/);
	assert.match(text, /the checks you ran and their results/);
});

/** One bash call as pi reports it: `tool_call` before it runs, `tool_result` after, with the same id. */
async function bashCall(emit: (event: string, payload: any, ctx: any) => Promise<unknown>, c: any, command: string, isError = false, during = () => {}) {
	const toolCallId = `call-${Math.random()}`;
	await emit("tool_call", { toolName: "bash", toolCallId, input: { command } }, c);
	during();
	await emit("tool_result", { toolName: "bash", toolCallId, input: { command }, isError }, c);
}

test("verify: committing after a green run is not an edit", async () => {
	const { dir, edit } = gitProject(COMMANDS);
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await bashCall(emit, c, "sed -i '' 's/1/2/' src/a.ts", false, () => edit("export const a = 2;\n"));
	await bashCall(emit, c, "npm test");
	await bashCall(emit, c, "npm run typecheck");
	await bashCall(emit, c, "git commit -qam 'a = 2'", false, () => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "a = 2"], { cwd: dir }));
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0);
	assert.equal(verifyState.unverified, false);
});

test("verify: a write chained with a check, or made by a failed check, is not exempt", async () => {
	const cases: Array<[string, boolean]> = [
		["npm test && sed -i '' 's/1/2/' src/a.ts", false],
		["npm test; cat > src/a.ts <<'EOF'\nexport const a = 2;\nEOF", false],
		["npm test", true],
	];
	for (const [command, isError] of cases) {
		const { dir, edit } = gitProject(COMMANDS);
		const { pi, emit, sent } = fakePi();
		verify(pi);
		const c = ctx(dir);
		await emit("session_start", { reason: "startup" }, c);
		await bashCall(emit, c, command, isError, () => edit("export const a = 2;\n"));
		await emit("agent_end", { messages: [] }, c);
		assert.equal(sent.length, 1, command);
		assert.match(sent[0]!.message.content, /src\/a\.ts/, command);
	}
});

test("verify: run_verification reports output over pi's limit as an output-limit failure, not a timeout", async () => {
	const { dir } = gitProject(COMMANDS);
	const f = fakePi();
	// pi 1.5 stops a check whose output passes its cap: killed, truncated and a nonzero code.
	f.pi.exec = async () => ({ stdout: "x".repeat(100), stderr: "", code: 1, killed: true, truncated: true });
	verify(f.pi);
	const c = ctx(dir);
	await f.emit("session_start", { reason: "startup" }, c);
	const result = await f.tools.get("run_verification").execute("id", {}, undefined, undefined, c);
	const text = result.content.map((p: { text: string }) => p.text).join("\n");
	assert.equal(result.details.ok, false);
	assert.match(text, /OUTPUT LIMIT/);
	assert.doesNotMatch(text, /TIMEOUT/);
});

test("verify: run_verification counts earlier changes, but not its own", async () => {
	const failing = gitProject(COMMANDS);
	const f = fakePi({ "npm test": 1 });
	verify(f.pi);
	const fc = ctx(failing.dir);
	await f.emit("session_start", { reason: "startup" }, fc);
	failing.edit("export const a = 2;\n");
	await f.tools.get("run_verification").execute("id", {}, undefined, undefined, fc);
	await f.emit("agent_end", { messages: [] }, fc);
	assert.equal(f.sent.length, 1, "the change before a failed run is marked");
	assert.match(f.sent[0]!.message.content, /src\/a\.ts/);

	const own = gitProject(COMMANDS);
	const o = fakePi({}, (command) => command === "npm run typecheck" && own.edit("export const a = 3;\n"));
	verify(o.pi);
	const oc = ctx(own.dir);
	await o.emit("session_start", { reason: "startup" }, oc);
	await o.tools.get("run_verification").execute("id", {}, undefined, undefined, oc);
	await o.emit("agent_end", { messages: [] }, oc);
	assert.equal(o.sent.length, 0, "a formatter run by the checks is theirs");
});

test("verify: a broken .pi/verify.json still gets a follow-up naming the error", async () => {
	const dir = project({ ".pi/verify.json": '{"commands": ["npm test"],}', "package.json": '{"scripts":{"test":"node --test"}}' });
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await emit("tool_result", { toolName: "edit", input: { path: "src/a.ts" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.message.content, /verify\.json/);
	assert.match(sent[0]!.message.content, /JSON|parse|Unexpected|Expected/i);
});

test("verify: without a UI, changes between tool calls aren't this process's", async () => {
	const { dir, edit } = gitProject(COMMANDS);
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir, { hasUI: false });
	await emit("session_start", { reason: "startup" }, c);
	edit("export const a = 2;\n");
	await bashCall(emit, c, "ls");
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0, "a sibling's write");
	await bashCall(emit, c, "node gen.js", false, () => edit("export const a = 3;\n"));
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1, "its own command's write");
});

test("verify: in a project with one command, a write chained after it still gets a follow-up", async () => {
	for (const command of ["npm test && sed -i '' 's/1/2/' src/a.ts", "npm test && grep -v x src/a.ts > src/b.ts", "npm test | tail -5"]) {
		const { dir, edit } = gitProject({ "package.json": '{"scripts":{"test":"node --test"}}', "package-lock.json": "{}" });
		const { pi, emit, sent } = fakePi();
		verify(pi);
		const c = ctx(dir);
		await emit("session_start", { reason: "startup" }, c);
		await bashCall(emit, c, command, false, () => edit("export const a = 2;\n"));
		await emit("agent_end", { messages: [] }, c);
		assert.equal(sent.length, 1, command);
	}
});

test("verify: a check reported without its tool_call can't claim earlier changes", async () => {
	const { dir, edit } = gitProject(COMMANDS);
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir, { hasUI: false });
	await emit("session_start", { reason: "startup" }, c);
	edit("export const a = 2;\n");
	await emit("tool_result", { toolName: "bash", toolCallId: "no-call", input: { command: "npm test" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1);
});

test("verify: a worker subagent's changes are counted as its call's, with or without a UI", async () => {
	const { dir, edit } = gitProject(COMMANDS);
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir, { hasUI: false });
	await emit("session_start", { reason: "startup" }, c);
	writeFileSync(join(dir, "src/sibling.ts"), "a sibling's write before the call\n");
	await emit("tool_call", { toolName: "subagent", toolCallId: "w0", input: {} }, c);
	await emit("tool_result", { toolName: "subagent", toolCallId: "w0", input: {}, content: [], isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0, "a change before the call isn't the worker's");
	await emit("input", { text: "next", source: "interactive" }, c);
	await emit("tool_call", { toolName: "subagent", toolCallId: "w1", input: {} }, c);
	edit("export const a = 2;\n");
	await emit("tool_result", { toolName: "subagent", toolCallId: "w1", input: {}, content: [], isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.message.content, /src\/a\.ts/);
});

/** A folder outside git holding repositories `a` (committed `f.ts`) and `b` (committed `m.ts`), with verification commands. */
function workspaceProject(files: Record<string, string> = COMMANDS) {
	const dir = project(files);
	const git = (repo: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: join(dir, repo), stdio: "pipe" });
	for (const [repo, file] of [["a", "f.ts"], ["b", "m.ts"]] as const) {
		mkdirSync(join(dir, repo));
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(dir, repo, file), "export {};\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "initial");
	}
	return { dir, git };
}

test("verify: a workspace repository late twice running is remembered for the session, so later calls don't wait on it", async () => {
	const { dir } = workspaceProject();
	const { log, restore } = slowGit(realpathSync(join(dir, "a")));
	try {
		const { pi, emit } = fakePi();
		verify(pi);
		const c = ctx(dir);
		await emit("session_start", { reason: "startup" }, c);
		assert.notEqual(readFileSync(log, "utf8"), "", "the first fingerprint tried the slow repository");
		await bashCall(emit, c, "ls");
		const calls = readFileSync(log, "utf8");
		await bashCall(emit, c, "ls");
		assert.equal(readFileSync(log, "utf8"), calls, "late twice running: no git in it any more");
	} finally {
		restore();
	}
});

test("verify: in a workspace, an edit a glob ignores by its path inside the repository isn't counted", async () => {
	const { dir } = workspaceProject({ ...COMMANDS, ".pi/verify.json": JSON.stringify({ commands: ["npm test"], ignore: ["docs/**"] }) });
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await emit("tool_result", { toolName: "write", input: { path: "a/docs/d.svg" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0);
	await emit("tool_result", { toolName: "write", input: { path: "a/src/d.ts" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.message.content, /a\/src\/d\.ts/);
});

test("verify: in a workspace, a repository's files follow its own ignore globs, in edits and commits", async () => {
	const { dir, git } = workspaceProject({ ...COMMANDS, ".pi/verify.json": JSON.stringify({ commands: ["npm test"], ignore: ["scripts/**"] }) });
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await bashCall(emit, c, "git -C a commit", false, () => {
		mkdirSync(join(dir, "a", "docs"));
		writeFileSync(join(dir, "a", "docs", "setup.yaml"), "x: 1\n");
		git("a", "add", "docs/setup.yaml");
		git("a", "commit", "-q", "-m", "docs");
	});
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0, "a's default docs/** ignores its committed docs file");
	await emit("tool_result", { toolName: "write", input: { path: "a/scripts/build.ts" }, isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1, "the workspace's scripts/** is for the workspace's own folder");
	assert.match(sent[0]!.message.content, /a\/scripts\/build\.ts/);
});

test("verify: in a workspace, a redirect to an unknown variable path marks nothing", async () => {
	const { dir } = workspaceProject();
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await bashCall(emit, c, "cd a && true > $S/red.log");
	await bashCall(emit, c, "S=$(mktemp -d); for e in x y; do true > $S/t-$e.log; done");
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 0);
});

test("verify: in a workspace, a shell write in a repository marks it with its folder", async () => {
	const { dir } = workspaceProject();
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await bashCall(emit, c, "echo x > a/f.ts", false, () => writeFileSync(join(dir, "a", "f.ts"), "x\n"));
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.message.content, /a\/f\.ts/);
});

test("verify: in a workspace, a subagent call's commit in a repository is its own", async () => {
	const { dir, git } = workspaceProject();
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir, { hasUI: false });
	await emit("session_start", { reason: "startup" }, c);
	await emit("tool_call", { toolName: "subagent", toolCallId: "w1", input: {} }, c);
	writeFileSync(join(dir, "b", "c.ts"), "export {};\n");
	git("b", "add", "c.ts");
	git("b", "commit", "-q", "-m", "c");
	await emit("tool_result", { toolName: "subagent", toolCallId: "w1", input: {}, content: [], isError: false }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.message.content, /b\/c\.ts/);
});

test("verify: a folder that becomes a git repository mid-session is fingerprinted from then on", async () => {
	const dir = project({ ...COMMANDS, "src/a.ts": "export const a = 1;\n" });
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir, { hasUI: false });
	await emit("session_start", { reason: "startup" }, c);
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", "initial");
	await bashCall(emit, c, "node gen.js", false, () => writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n"));
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1, "only the fingerprint can see a script's write");
});

test("verify: in a workspace, the reminder names a repository's approved task file", async () => {
	const { dir } = workspaceProject();
	mkdirSync(join(dir, "a", "docs", "tasks"), { recursive: true });
	writeFileSync(join(dir, "a", "docs", "tasks", "t.md"), "# T\n\nStatus: design approved (2026-11-03)\n");
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.ok(sent.some((s) => /Approval gate: .*a\/docs\/tasks\/t\.md/.test(String(s.message.content))), JSON.stringify(sent.map((s) => s.message.content)));
});

test("verify: the notice of skipped repositories comes again in a new session", async () => {
	const { dir } = workspaceProject();
	const { pi, emit } = fakePi();
	verify(pi);
	const slow = slowGit(realpathSync(join(dir, "a")), "status");
	try {
		const c = ctx(dir);
		await emit("session_start", { reason: "startup" }, c);
		await emit("agent_end", { messages: [] }, c);
		await emit("agent_end", { messages: [] }, c);
		const skipped = () => c.notes.filter((n) => n.startsWith("Task-file reminders skipped")).length;
		assert.equal(skipped(), 1, "once per set of skipped repositories");
		await emit("session_start", { reason: "new" }, c);
		await emit("agent_end", { messages: [] }, c);
		assert.equal(skipped(), 2, "again in the new session");
	} finally {
		slow.restore();
	}
});

test("verify: in a workspace, the reminders name a repository's finished task file and use each repository's git", async () => {
	const { dir, git } = workspaceProject();
	mkdirSync(join(dir, "b", "docs", "tasks"), { recursive: true });
	writeFileSync(join(dir, "b", "docs", "tasks", "done.md"), "# D\n\n## Plan\n\n- [x] one\n\n## Progress\n");
	git("b", "add", "-A");
	git("b", "commit", "-qm", "done");
	mkdirSync(join(dir, "a", "docs", "tasks"), { recursive: true });
	writeFileSync(join(dir, "a", "docs", "tasks", "t.md"), "# T\n\nStatus: design approved (2026-11-04)\n");
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await emit("agent_end", { messages: [] }, c);
	const text = sent.map((m) => String(m.message.content)).join("\n");
	assert.match(text, /Working-docs gate: .*b\/docs\/tasks\/done\.md/);
	assert.match(text, /git -C a add docs\/tasks\/t\.md/);
});

test("verify: a repository config that appeared after the session started can't move its task-file folders", async () => {
	const { dir } = workspaceProject();
	const g = fakePi();
	guard(g.pi);
	const v = fakePi();
	verify(v.pi);
	const c = ctx(dir);
	await g.emit("session_start", { reason: "startup" }, c);
	await v.emit("session_start", { reason: "startup" }, c);
	mkdirSync(join(dir, "a", ".pi"), { recursive: true });
	writeFileSync(join(dir, "a", ".pi", "guard.json"), JSON.stringify({ workDocs: ["plans"] }));
	mkdirSync(join(dir, "a", "docs", "tasks"), { recursive: true });
	writeFileSync(join(dir, "a", "docs", "tasks", "t.md"), "# T\n\nStatus: design approved (2026-11-04)\n");
	await v.emit("agent_end", { messages: [] }, c);
	assert.match(v.sent.map((m) => String(m.message.content)).join("\n"), /a\/docs\/tasks\/t\.md/);
});

test("verify: a repository config the session started with decides its task-file folders", async () => {
	const { dir } = workspaceProject();
	mkdirSync(join(dir, "a", ".pi"), { recursive: true });
	writeFileSync(join(dir, "a", ".pi", "guard.json"), JSON.stringify({ workDocs: ["plans"] }));
	mkdirSync(join(dir, "a", "plans"), { recursive: true });
	writeFileSync(join(dir, "a", "plans", "t.md"), "# T\n\nStatus: design approved (2026-11-04)\n");
	const g = fakePi();
	guard(g.pi);
	const v = fakePi();
	verify(v.pi);
	const c = ctx(dir, { trusted: true });
	await g.emit("session_start", { reason: "startup" }, c);
	await v.emit("session_start", { reason: "startup" }, c);
	await v.emit("agent_end", { messages: [] }, c);
	assert.match(v.sent.map((m) => String(m.message.content)).join("\n"), /a\/plans\/t\.md/);
});

test("verify also reminds to commit an approved task file", async () => {
	const dir = project({ "docs/tasks/s.md": "# S\n\nStatus: design approved (2026-01-01)\n" });
	const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	const { pi, emit, sent } = fakePi();
	verify(pi);
	const c = ctx(dir);
	await emit("session_start", { reason: "startup" }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.message.content, /Approval gate: .*docs\/tasks\/s\.md/);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1, "once per prompt");
	git("add", "-A");
	git("commit", "-qm", "docs: approve s");
	await emit("input", { text: "next", source: "interactive" }, c);
	await emit("agent_end", { messages: [] }, c);
	assert.equal(sent.length, 1, "committed: no reminder");
});

test("task files: guard blocks a PR while they exist; agent_end reminds once to delete a finished one", async () => {
	const dir = project({ "README.md": "x\n" });
	const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("switch", "-qc", "feat/a");
	mkdirSync(join(dir, "docs/tasks"), { recursive: true });
	writeFileSync(join(dir, "docs/tasks/p.md"), "# P\n\n## Plan\n\n- [x] one\n- [ ] two\n");
	git("add", "-A");
	git("commit", "-qm", "docs: plan");

	const g = fakePi();
	guard(g.pi);
	const bash = (command: string, c = ctx(dir)) => g.emit("tool_call", { toolName: "bash", input: { command } }, c);
	const pr = await bash("gh pr create --fill");
	assert.equal(pr?.block, true);
	assert.match(pr.reason, /^Guard: Task files would reach .*docs\/tasks\/p\.md/);
	const push = ctx(dir, { confirm: true });
	assert.equal(await bash("git push -u origin feat/a", push), undefined, "the work branch may be pushed after confirmation");
	assert.equal(push.asked.length, 1);

	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi/guard.json"), JSON.stringify({ workDocs: [] }));
	const untrusted = await bash("gh pr create", ctx(dir, { trusted: false }));
	assert.match(untrusted.reason, /Task files would reach/, "an untrusted project cannot turn the rule off");
	const trusted = await bash("gh pr create", ctx(dir, { trusted: true }));
	assert.doesNotMatch(trusted.reason, /Task files/, "a trusted project can");
	assert.match(trusted.reason, /Review gate: no reviewer verdict/, "the branch still needs a review, like any branch");

	const v = fakePi();
	verify(v.pi);
	const c = ctx(dir);
	await v.emit("session_start", { reason: "startup" }, c);
	writeFileSync(join(dir, ".pi/guard.json"), "{}");
	await v.emit("agent_end", { messages: [] }, c);
	assert.equal(v.sent.length, 0, "a task file with open plan steps is not finished");
	writeFileSync(join(dir, "docs/tasks/p.md"), "# P\n\n## Plan\n\n- [x] one\n- [x] two\n");
	await v.emit("agent_end", { messages: [] }, c);
	assert.equal(v.sent.length, 1);
	assert.match(v.sent[0]!.message.content, /Working-docs gate: .*docs\/tasks\/p\.md/);
	await v.emit("agent_end", { messages: [] }, c);
	assert.equal(v.sent.length, 1, "once per prompt");
	await v.emit("input", { text: "next", source: "interactive" }, c);
	await v.emit("agent_end", { messages: [] }, c);
	assert.equal(v.sent.length, 2);
});

test("run_verification reports the failing command and skips the rest", async () => {
	const dir = project({ ".pi/verify.json": JSON.stringify({ commands: ["npm test", "npm run build"] }) });
	const { pi, tools, execs } = fakePi({ "npm test": 1 });
	verify(pi);
	const result = await tools.get("run_verification").execute("id", {}, undefined, undefined, ctx(dir));
	const text = result.content[0].text as string;
	assert.equal(result.details.ok, false);
	assert.match(text, /FAIL {2}npm test/);
	assert.match(text, /SKIP {2}npm run build/);
	assert.match(text, /boom in npm test/);
	assert.deepEqual(execs, ["npm test"]);
});

test("run_verification explains how to configure checks when none exist", async () => {
	const { pi, tools } = fakePi();
	verify(pi);
	const result = await tools.get("run_verification").execute("id", {}, undefined, undefined, ctx(project({})));
	assert.match(result.content[0].text, /\.pi\/verify\.json/);
});

// ---------- model routing ----------

const registry = [
	{ provider: "anthropic", id: "strong" },
	{ provider: "anthropic", id: "mid" },
	{ provider: "openai", id: "strong" },
];

function modelCtx(cwd: string, opts: { trusted?: boolean; available?: string[] } = {}) {
	const base = ctx(cwd, { trusted: opts.trusted });
	const available = registry.filter((m) => (opts.available ?? ["anthropic"]).includes(m.provider));
	return {
		...base,
		model: registry[1],
		modelRegistry: {
			find: (provider: string, id: string) => registry.find((m) => m.provider === provider && m.id === id),
			// real pi returns fresh copies, so identity comparison must not be relied on
			getAvailable: () => available.map((m) => ({ ...m })),
		},
	};
}

const routingFile = JSON.stringify({
	modes: { deep: { model: ["anthropic/strong", "openai/strong"], thinking: "high" }, fast: { model: "anthropic/mid" } },
	commands: { review: "deep", implement: "fast" },
});

function withAgentDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	return fn().finally(() => {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
	});
}

test("models: routed commands switch model and thinking; plain input and extension messages do not", async () => {
	const dir = project({ ".pi/model-routing.json": routingFile });
	await withAgentDir(project({}), async () => {
		const { pi, emit, modelCalls } = fakePi();
		models(pi);
		const c = modelCtx(dir);
		assert.deepEqual(await emit("input", { text: "/review", source: "interactive" }, c), { action: "continue" });
		assert.deepEqual(modelCalls, ["model:anthropic/strong", "thinking:high"]);

		await emit("input", { text: "now fix it", source: "interactive" }, c);
		await emit("input", { text: "/review", source: "extension" }, c);
		assert.equal(modelCalls.length, 2, "sticky model; extension follow-ups are not routed");

		await emit("input", { text: "/implement tasks/01.md", source: "rpc" }, c);
		assert.deepEqual(modelCalls.slice(2), ["model:anthropic/mid"], "no thinking override when unset");
	});
});

test("models: falls back to the next available candidate, warns when none is usable", async () => {
	const dir = project({ ".pi/model-routing.json": routingFile });
	await withAgentDir(project({}), async () => {
		const { pi, emit, modelCalls } = fakePi();
		models(pi);
		await emit("input", { text: "/review", source: "interactive" }, modelCtx(dir, { available: ["openai"] }));
		assert.equal(modelCalls[0], "model:openai/strong");

		const none = modelCtx(dir, { available: [] });
		await emit("input", { text: "/review", source: "interactive" }, none);
		assert.equal(modelCalls.length, 2, "nothing switched");
		assert.ok(none.notes.some((n) => /no available model/i.test(n)));
	});
});

test("models: project routing needs trust; global routing always applies", async () => {
	const dir = project({ ".pi/model-routing.json": routingFile });
	const agentDir = project({ "model-routing.json": JSON.stringify({ modes: { cheap: { model: "anthropic/mid", thinking: "low" } }, commands: { review: "cheap" } }) });
	await withAgentDir(agentDir, async () => {
		const { pi, emit, modelCalls } = fakePi();
		models(pi);
		await emit("input", { text: "/review", source: "interactive" }, modelCtx(dir, { trusted: false }));
		assert.deepEqual(modelCalls, ["model:anthropic/mid", "thinking:low"], "untrusted project: global only");
	});
});

test("models: /mode switches manually, lists routes, and completes mode names", async () => {
	const dir = project({ ".pi/model-routing.json": routingFile });
	await withAgentDir(project({}), async () => {
		const { pi, commands, modelCalls } = fakePi();
		models(pi);
		const mode = commands.get("mode");
		const c = modelCtx(dir);
		await mode.handler("deep", c);
		assert.deepEqual(modelCalls, ["model:anthropic/strong", "thinking:high"]);
		await mode.handler("", c);
		assert.ok(c.notes.some((n) => /review → deep/.test(n)), "listing goes to the user, not the model");
		await mode.handler("nope", c);
		assert.ok(c.notes.some((n) => /unknown mode "nope"/.test(n)));
		const items = await mode.getArgumentCompletions("d");
		assert.deepEqual(items.map((i: any) => i.value), ["deep"]);
	});
});

// ---------- /kit-init ----------

test("/kit-init --yes creates missing project files and leaves existing ones untouched", async () => {
	const dir = project({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), ".pi/guard.json": '{"block":["mine"]}' });
	const { pi, commands } = fakePi();
	init(pi);
	const c = ctx(dir, { hasUI: false });
	await commands.get("kit-init").handler("--yes", c);

	assert.deepEqual(JSON.parse(readFileSync(join(dir, ".pi/verify.json"), "utf8")).commands, ["npm test"]);
	assert.equal(readFileSync(join(dir, ".pi/guard.json"), "utf8"), '{"block":["mine"]}', "existing file untouched");
	assert.ok(JSON.parse(readFileSync(join(dir, ".pi/model-routing.json"), "utf8")).commands.review);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, ".pi/settings.json"), "utf8")).packages, ["npm:pi-subagents"]);

	const before = readFileSync(join(dir, ".pi/verify.json"), "utf8");
	writeFileSync(join(dir, ".pi/verify.json"), before.replace("npm test", "npm run custom"));
	await commands.get("kit-init").handler("--yes", c);
	assert.match(readFileSync(join(dir, ".pi/verify.json"), "utf8"), /npm run custom/, "second run never overwrites");
});

test("/kit-init asks per file, writes only what was accepted, and offers /onboard", async () => {
	const dir = project({});
	const { pi, commands, sent } = fakePi();
	init(pi);

	const declined = ctx(dir, { confirm: false });
	await commands.get("kit-init").handler("", declined);
	assert.equal(existsSync(join(dir, ".pi/verify.json")), false, "declined: nothing written");
	assert.ok(declined.asked.some((q) => q.includes(".pi/verify.json")));
	assert.equal(sent.length, 0);

	const accepted = ctx(dir, { confirm: true });
	await commands.get("kit-init").handler("", accepted);
	assert.equal(existsSync(join(dir, ".pi/verify.json")), true);
	assert.ok(accepted.asked.some((q) => /onboard/i.test(q)));
	assert.deepEqual(sent.at(-1), { message: { user: "/onboard" }, options: { expandPromptTemplates: true, deliverAs: "followUp" } });
});

test("/kit-init without UI and without --yes only reports the plan", async () => {
	const dir = project({});
	const { pi, commands, sent } = fakePi();
	init(pi);
	await commands.get("kit-init").handler("", ctx(dir, { hasUI: false }));
	assert.equal(existsSync(join(dir, ".pi")), false);
	assert.match(sent.at(-1)!.message.content, /--yes/);
});

test("review gate: a reviewer run's report records the verdict; without one the guard asks before a PR", async () => {
	const dir = project({ "README.md": "x\n" });
	const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("switch", "-qc", "feat/a");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "feat: a");
	const head = git("rev-parse", "HEAD");

	const g = fakePi();
	guard(g.pi, { reviewsRoot: mkdtempSync(join(tmpdir(), "guard-reviews-")) });
	const bash = (command: string, c = ctx(dir)) => g.emit("tool_call", { toolName: "bash", input: { command } }, c);
	const verdict = (v: string) => `Reviewed BASE: ${git("rev-parse", "main")}\nReviewed HEAD: ${head.slice(0, 9)}\nReady to merge: ${v}`;
	const result = (toolName: string, results: unknown[], isError = false) =>
		g.emit("tool_result", { toolName, toolCallId: `c${Math.random()}`, input: {}, content: [{ type: "text", text: "summary" }], details: { mode: "single", results }, isError }, ctx(dir));
	const pr = async () => (await bash("gh pr create --fill"))?.block;

	const asking = ctx(dir);
	assert.equal((await bash("gh pr create --fill", asking))?.block, true, "declined");
	assert.match(asking.asked[0]!, /Review gate: no reviewer verdict/);
	assert.equal((await bash("gh pr create --fill", ctx(dir, { hasUI: false })))?.block, true, "no UI: blocked");
	const push = ctx(dir);
	await bash("git push origin feat/a:main", push);
	assert.match(push.asked[0]!, /Review gate: .* Also: This command pushes to a remote/, "one confirmation names both reasons");

	await result("bash", [{ agent: "reviewer", exitCode: 0, finalOutput: verdict("Yes") }]);
	await result("subagent", [{ agent: "scout", exitCode: 0, finalOutput: verdict("Yes") }]);
	assert.equal(await pr(), true, "only a reviewer run of the subagent tool counts");

	await g.emit("input", { text: "review it", source: "interactive" }, ctx(dir));
	await result("subagent", [{ agent: "reviewer", exitCode: 0, finalOutput: verdict("No") }]);
	await result("subagent", [{ agent: "reviewer", exitCode: 0, finalOutput: verdict("Yes") }]);
	assert.equal(await pr(), true, "a later Yes in the same prompt doesn't overturn a No");
	await g.emit("input", { text: "re-review", source: "interactive" }, ctx(dir));
	await result("subagent", [
		{ agent: "reviewer", exitCode: 0, finalOutput: verdict("Yes") },
		{ agent: "reviewer", exitCode: 1 },
	]);
	assert.equal(await pr(), true, "a failed reviewer run is Inconclusive");
	for (const bad of [{ agent: "reviewer", exitCode: 0, finalOutput: "couldn't read the range" }, { agent: "reviewer", exitCode: 0, finalOutput: verdict("Yes"), timedOut: true }]) {
		await g.emit("input", { text: "again", source: "interactive" }, ctx(dir));
		await result("subagent", [{ agent: "reviewer", exitCode: 0, finalOutput: verdict("Yes") }, bad]);
		assert.equal(await pr(), true, `a reviewer run without a usable verdict spoils the round: ${JSON.stringify(bad)}`);
	}
	await g.emit("input", { text: "typo", source: "interactive" }, ctx(dir));
	await result("subagent", [{ agent: "reviewer", exitCode: 0, finalOutput: verdict("Yes") }, { agent: "reviewer", exitCode: 1, finalOutput: "Reviewed HEAD: 0000000" }]);
	assert.equal(await pr(), true, "a failed run naming a SHA that isn't a commit counts against HEAD");
	await g.emit("input", { text: "again", source: "interactive" }, ctx(dir));
	await result("subagent", [{ agent: "reviewer", exitCode: 0, finalOutput: verdict("Yes") }]);
	assert.equal(await bash("gh pr create --fill"), undefined);
	const both = ctx(dir, { confirm: false });
	await bash("git push origin feat/a && cat x > .pi/guard.json", both);
	assert.match(both.asked[0]!, /\.pi\/guard\.json.* Also: This command pushes to a remote/, "the guard-config question keeps the push reason");
});

test("review gate: reviewGate: false only in a trusted project; the guard config and stamps are protected", async () => {
	const dir = project({ ".pi/guard.json": JSON.stringify({ reviewGate: false }) });
	const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("commit", "-q", "--allow-empty", "-m", "init");
	git("switch", "-qc", "feat/a");
	writeFileSync(join(dir, "a.ts"), "x\n");
	git("add", "-A");
	git("commit", "-qm", "a");
	const g = fakePi();
	guard(g.pi, { reviewsRoot: mkdtempSync(join(tmpdir(), "guard-reviews-")) });
	const call = (toolName: string, input: Record<string, unknown>, c = ctx(dir)) => g.emit("tool_call", { toolName, input }, c);
	assert.equal(await call("bash", { command: "gh pr create" }, ctx(dir, { trusted: true })), undefined, "trusted: off");
	assert.equal((await call("bash", { command: "gh pr create" }, ctx(dir, { trusted: false })))?.block, true, "untrusted: still on");

	const asked = ctx(dir, { confirm: false });
	assert.equal((await call("edit", { path: ".pi/guard.json" }, asked))?.block, true);
	assert.match(asked.asked[0]!, /guard config decides/);
	assert.equal((await call("write", { path: join(tmpdir(), "eng-kit", "reviews", "x.json") }))?.block, true);
	assert.equal((await call("bash", { command: `echo '{}' > .pi/guard.json` }))?.block, true, "declined confirmation");
});

test("review gate: detected commands don't make a review Inconclusive", async () => {
	const dir = project({ "package.json": '{"scripts":{"test":"node --test"}}', "package-lock.json": "{}" });
	const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("switch", "-qc", "feat/a");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "feat: a");
	const head = git("rev-parse", "HEAD");
	const g = fakePi();
	guard(g.pi, { reviewsRoot: mkdtempSync(join(tmpdir(), "guard-reviews-")) });
	try {
		verifyState.unverified = true;
		await g.emit("input", { text: "review", source: "interactive" }, ctx(dir));
		await g.emit("tool_result", { toolName: "subagent", toolCallId: "c1", input: {}, content: [], details: { results: [{ agent: "reviewer", exitCode: 0, finalOutput: `Reviewed BASE: ${git("rev-parse", "main")}\nReviewed HEAD: ${head}\nReady to merge: Yes` }] }, isError: false }, ctx(dir));
		assert.equal((await g.emit("tool_call", { toolName: "bash", input: { command: "gh pr create --fill" } }, ctx(dir)))?.block, undefined);
		const chained = await g.emit("tool_call", { toolName: "bash", input: { command: "npm test && gh pr create --fill" } }, ctx(dir));
		assert.equal(chained?.block, true, "a detected command is no read-only step before a landing");
	} finally {
		verifyState.unverified = false;
	}
});

test("review gate: a review that ran on unverified edits counts as Inconclusive", async () => {
	const dir = project({ "AGENTS.md": "## Commands\n- `npm test`\n" });
	const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("switch", "-qc", "feat/a");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "feat: a");
	const head = git("rev-parse", "HEAD");
	const g = fakePi();
	const reviewsRoot = mkdtempSync(join(tmpdir(), "guard-reviews-"));
	guard(g.pi, { reviewsRoot });
	const review = () => g.emit("tool_result", { toolName: "subagent", toolCallId: `c${Math.random()}`, input: {}, content: [], details: { results: [{ agent: "reviewer", exitCode: 0, finalOutput: `Reviewed BASE: ${git("rev-parse", "main")}\nReviewed HEAD: ${head}\nReady to merge: Yes` }] }, isError: false }, ctx(dir));
	const pr = async () => (await g.emit("tool_call", { toolName: "bash", input: { command: "gh pr create --fill" } }, ctx(dir)))?.block;
	try {
		verifyState.unverified = true;
		await g.emit("input", { text: "review", source: "interactive" }, ctx(dir));
		await review();
		assert.equal(await pr(), true);
		assert.equal(readReviews(dir, reviewsRoot)[0]?.bases.length, 1, "it keeps its range, so a later round can chain through it");
		verifyState.unverified = false;
		await g.emit("input", { text: "again", source: "interactive" }, ctx(dir));
		await review();
		assert.equal(await pr(), undefined, "after a green run the review counts");
	} finally {
		verifyState.unverified = false;
	}
});

test("verify state is shared across separately loaded module graphs, as pi loads extensions", async () => {
	const url = new URL("../extensions/lib/verify-state.ts", import.meta.url).href;
	const a = (await import(`${url}?graph=a`)) as { verifyState: { unverified: boolean } };
	const b = (await import(`${url}?graph=b`)) as { verifyState: { unverified: boolean } };
	try {
		a.verifyState.unverified = true;
		assert.equal(b.verifyState.unverified, true, "one state, whichever copy of the module wrote it");
		assert.equal(verifyState.unverified, true);
	} finally {
		a.verifyState.unverified = false;
	}
});

test("/kit-init completes the last flag and keeps the earlier ones", () => {
	const g = fakePi();
	init(g.pi);
	const complete = g.commands.get("kit-init").getArgumentCompletions as (prefix: string) => Array<{ value: string }> | null;
	assert.deepEqual(complete("--te")?.map((o) => o.value), ["--test-hygiene"]);
	assert.deepEqual(complete("--yes --te")?.map((o) => o.value), ["--yes --test-hygiene"]);
	assert.deepEqual(complete("--yes ")?.map((o) => o.value), ["--yes --test-hygiene"], "a flag already given isn't offered again");
	assert.equal(complete("--nope"), null);
});

test("review gate: a reviewer report without Reviewed BASE counts as Inconclusive", async () => {
	const dir = project({ "README.md": "x\n" });
	const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("switch", "-qc", "feat/a");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "feat: a");
	const head = git("rev-parse", "HEAD");
	const g = fakePi();
	guard(g.pi, { reviewsRoot: mkdtempSync(join(tmpdir(), "guard-reviews-")) });
	const c = ctx(dir);
	await g.emit("tool_result", { toolName: "subagent", toolCallId: "c1", input: {}, content: [], details: { results: [{ agent: "reviewer", exitCode: 0, finalOutput: `Reviewed HEAD: ${head}\nReady to merge: Yes` }] }, isError: false }, c);
	assert.match(c.notes.join("\n"), /no verdict recorded .*Reviewed BASE/);
	const asking = ctx(dir);
	await g.emit("tool_call", { toolName: "bash", input: { command: "gh pr create --fill" } }, asking);
	assert.match(asking.asked[0]!, /returned "Inconclusive"/);
});

test("review gate: after a successful gh pr create, a push of a new unreviewed commit to that branch asks", async () => {
	const dir = project({ "README.md": "x\n" });
	const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
	const remote = mkdtempSync(join(tmpdir(), "guard-remote-"));
	spawnSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("remote", "add", "origin", remote);
	git("push", "-q", "origin", "main");
	git("switch", "-qc", "feat/a");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "feat: a");
	const g = fakePi();
	guard(g.pi, { reviewsRoot: mkdtempSync(join(tmpdir(), "guard-reviews-")) });
	// The call is seen before it runs (its branch is noted) and its result confirms it.
	const bashResult = async (command: string, isError: boolean) => {
		const toolCallId = `b${Math.random()}`;
		await g.emit("tool_call", { toolName: "bash", toolCallId, input: { command } }, ctx(dir, { confirm: true }));
		await g.emit("tool_result", { toolName: "bash", toolCallId, input: { command }, content: [], details: {}, isError }, ctx(dir));
	};
	const pushAsked = async () => {
		const c = ctx(dir);
		await g.emit("tool_call", { toolName: "bash", toolCallId: `p${Math.random()}`, input: { command: "git push" } }, c);
		return c.asked.join("\n");
	};
	await bashResult("gh pr create --fill", true);
	assert.equal(await pushAsked(), "", "a failed PR creation opened nothing: pushing the own work branch asks nothing");
	await bashResult("gh pr create --fill", false);
	assert.match(await pushAsked(), /Review gate: no reviewer verdict recorded/);
});

test("guard: a check that throws rejects the handler, which pi turns into a blocked call", async () => {
	const dir = project({ "README.md": "x\n" });
	const g = fakePi();
	guard(g.pi, { reviewsRoot: mkdtempSync(join(tmpdir(), "guard-reviews-")) });
	const broken = { ...ctx(dir), isProjectTrusted: () => { throw new Error("boom"); } };
	await assert.rejects(g.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "ls" } }, broken), /boom/);
	assert.deepEqual(broken.asked, [], "never turned into a question the user could approve");
});

test("review-log prints the reports a reviewer run left for a commit", async () => {
	const dir = project({ "README.md": "x\n" });
	const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("add", "-A");
	git("commit", "-qm", "init");
	git("switch", "-qc", "feat/a");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "feat: a");
	const reviewsRoot = mkdtempSync(join(tmpdir(), "guard-reviews-"));
	const g = fakePi();
	guard(g.pi, { reviewsRoot });
	const { CLAUDE_PROJECT_DIR: _unset, ...shellEnv } = process.env;
	const run = () => spawnSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "review-log.ts"), "HEAD"], { cwd: dir, encoding: "utf8", env: { ...shellEnv, ENG_KIT_REVIEWS_ROOT: reviewsRoot } });
	const none = run();
	assert.equal(none.status, 1, "no review recorded yet");
	assert.equal(none.stdout, "");
	assert.match(none.stderr, /no recorded review for/);
	const finalOutput = `#### Important\n\`a.ts:1\` · no input check\nReviewed BASE: ${git("rev-parse", "main")}\nReviewed HEAD: ${git("rev-parse", "HEAD")}\nReady to merge: No`;
	await g.emit("tool_result", { toolName: "subagent", toolCallId: "c1", input: {}, content: [], details: { results: [{ agent: "reviewer", exitCode: 0, finalOutput }] }, isError: false }, ctx(dir));
	const log = run();
	assert.equal(log.status, 0, log.stderr);
	assert.match(log.stdout, /— No\n\n#### Important\n`a\.ts:1` · no input check/);
	assert.match(log.stdout, /^Round 2 since the last Yes \(the stop rule counts these\)\. Earlier rounds, newest first: [0-9a-f]{7}\.\.[0-9a-f]{7} No\.$/m);
	assert.match(log.stdout, /^Highest finding IDs so far: none; a new finding takes the next number\.$/m);
	// A failed run records no range and no report: review-log still prints the round and a placeholder.
	writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "feat: b");
	const failed = git("rev-parse", "HEAD");
	recordVerdict(dir, failed, "Inconclusive", { promptId: "p2", run: "a2" }, reviewsRoot);
	const afterFail = run();
	assert.equal(afterFail.status, 0, afterFail.stderr);
	assert.match(afterFail.stdout, new RegExp(`^Round 2 since the last Yes \\(the stop rule counts these\\)\\. Earlier rounds, newest first: ${failed.slice(0, 7)} Inconclusive\\.$`, "m"));
	assert.match(afterFail.stdout, /\(no report stored for this run\)/);
});

/** A workspace without verification commands, a guard with its own record store, and each repository's HEAD. */
function reviewWorkspace() {
	const { dir, git } = workspaceProject({});
	const reviewsRoot = mkdtempSync(join(tmpdir(), "guard-reviews-"));
	const g = fakePi();
	guard(g.pi, { reviewsRoot });
	const head = (repo: string) => String(git(repo, "rev-parse", "HEAD")).trim();
	const reviewer = (finalOutput: string) =>
		g.emit("tool_result", { toolName: "subagent", toolCallId: "c1", input: {}, content: [], details: { results: [{ agent: "reviewer", exitCode: 0, finalOutput }] }, isError: false }, ctx(dir));
	return { dir, reviewsRoot, head, reviewer };
}

test("review gate: a reviewer subagent's verdict in a workspace is recorded in the repository that has the commit", async () => {
	const { dir, reviewsRoot, head, reviewer } = reviewWorkspace();
	await reviewer(`Reviewed BASE: ${head("a")}\nReviewed HEAD: ${head("a")}\nReady to merge: Yes`);
	assert.deepEqual(readReviews(join(dir, "a"), reviewsRoot).map((r) => [r.sha, r.verdict]), [[head("a"), "Yes"]]);
});

test("review gate: a malformed report in a workspace lands Inconclusive on each repository's HEAD", async () => {
	const { dir, reviewsRoot, head, reviewer } = reviewWorkspace();
	await reviewer("Reviewed HEAD: deadbeef0");
	for (const repo of ["a", "b"]) assert.deepEqual(readReviews(join(dir, repo), reviewsRoot).map((r) => [r.sha, r.verdict]), [[head(repo), "Inconclusive"]], repo);
});

test("review gate: the lookups for one reviewer run share one deadline, so a hanging repository holds pi up for at most its length", async () => {
	const { dir, reviewsRoot, head, reviewer } = reviewWorkspace();
	assert.equal(spawnSync("git", ["clone", "-q", join(dir, "a"), join(dir, "c")]).status, 0);
	// c answers no lookup: the named commit's, then each HEAD's, would each take a full lookup without the deadline.
	const slow = slowGit(realpathSync(join(dir, "c")), "rev-parse", 20);
	const started = Date.now();
	try {
		await reviewer("Reviewed HEAD: deadbeef0");
	} finally {
		slow.restore();
	}
	assert.ok(Date.now() - started < 7500, `took ${Date.now() - started} ms, past the 7 s deadline`);
	assert.deepEqual(readReviews(join(dir, "a"), reviewsRoot).map((r) => [r.sha, r.verdict]), [[head("a"), "Inconclusive"]]);
});

test("review gate: a reviewer verdict short of Yes that misses a workspace repository is recorded elsewhere and noted", async () => {
	const { dir, git } = workspaceProject({});
	assert.equal(spawnSync("git", ["clone", "-q", join(dir, "a"), join(dir, "c")]).status, 0);
	const reviewsRoot = mkdtempSync(join(tmpdir(), "guard-reviews-"));
	writeFileSync(reviewsDir(join(dir, "a"), reviewsRoot), "not a folder");
	const g = fakePi();
	guard(g.pi, { reviewsRoot });
	const head = String(git("a", "rev-parse", "HEAD")).trim();
	const c = ctx(dir);
	await g.emit("tool_result", { toolName: "subagent", toolCallId: "c1", input: {}, content: [], details: { results: [{ agent: "reviewer", exitCode: 0, finalOutput: `F1 the finding\nReviewed BASE: ${head}\nReviewed HEAD: ${head}\nReady to merge: No` }] }, isError: false }, c);
	assert.ok(c.notes.some((n) => /could not be recorded in every repository/.test(n)), c.notes.join("\n"));
	assert.equal(readReviews(join(dir, "c"), reviewsRoot)[0]?.verdict, "No");
});

/** A workspace with repository `a`, its clone `c`, `a`'s record store made unwritable, and a guard over it. */
function partialWorkspace() {
	const { dir, git } = workspaceProject();
	assert.equal(spawnSync("git", ["clone", "-q", join(dir, "a"), join(dir, "c")]).status, 0);
	const reviewsRoot = mkdtempSync(join(tmpdir(), "guard-reviews-"));
	writeFileSync(reviewsDir(join(dir, "a"), reviewsRoot), "not a folder");
	const g = fakePi();
	guard(g.pi, { reviewsRoot });
	const head = String(git("a", "rev-parse", "HEAD")).trim();
	const reviewer = (finalOutput: string, c = ctx(dir)) =>
		g.emit("tool_result", { toolName: "subagent", toolCallId: "c1", input: {}, content: [], details: { results: [{ agent: "reviewer", exitCode: 0, finalOutput }] }, isError: false }, c);
	return { dir, reviewsRoot, head, reviewer };
}

test("review gate: a reviewer verdict short of Yes that misses a workspace repository is followed by an Inconclusive that holds the commit back", async () => {
	const { dir, reviewsRoot, head, reviewer } = partialWorkspace();
	await reviewer(`Reviewed BASE: ${head}\nReviewed HEAD: ${head}\nReady to merge: No`);
	assert.deepEqual(readReports(join(dir, "c"), head, reviewsRoot).map((r) => [r.run, r.verdict]).sort(), [["c1-0", "No"], ["c1-0-held", "Inconclusive"]]);
});

test("review gate: a review of unverified edits that misses a workspace repository is noted", async () => {
	const { head, reviewer, dir } = partialWorkspace();
	const c = ctx(dir);
	verifyState.unverified = true;
	try {
		await reviewer(`Reviewed BASE: ${head}\nReviewed HEAD: ${head}\nReady to merge: Yes`, c);
	} finally {
		verifyState.unverified = false;
	}
	assert.ok(c.notes.some((n) => /could not be recorded in every repository/.test(n)), c.notes.join("\n"));
});

test("review gate: a review of unverified edits that misses a workspace repository is held back there too", async () => {
	const { dir, reviewsRoot, head, reviewer } = partialWorkspace();
	verifyState.unverified = true;
	try {
		await reviewer(`Reviewed BASE: ${head}\nReviewed HEAD: ${head}\nReady to merge: Yes`);
	} finally {
		verifyState.unverified = false;
	}
	assert.deepEqual(readReports(join(dir, "c"), head, reviewsRoot).map((r) => [r.run, r.verdict]).sort(), [["c1-0", "Inconclusive"], ["c1-0-held", "Inconclusive"]]);
});

for (const unverified of [false, true]) {
	test(`review gate: a ${unverified ? "review of unverified edits" : "report"} naming a commit a hanging repository can't be searched for holds each HEAD back, without a second search`, async () => {
		const { dir, git } = workspaceProject();
		const reviewsRoot = mkdtempSync(join(tmpdir(), "guard-reviews-"));
		const g = fakePi();
		guard(g.pi, { reviewsRoot });
		const head = (repo: string) => String(git(repo, "rev-parse", "HEAD")).trim();
		const c = ctx(dir);
		const slow = slowGit(realpathSync(join(dir, "b")), "deadbeef1", 20);
		verifyState.unverified = unverified;
		let calls = "";
		try {
			await g.emit("tool_result", { toolName: "subagent", toolCallId: "c1", input: {}, content: [], details: { results: [{ agent: "reviewer", exitCode: 0, finalOutput: `Reviewed BASE: ${head("a")}\nReviewed HEAD: deadbeef1\nReady to merge: No` }] }, isError: false }, c);
			calls = readFileSync(slow.log, "utf8");
		} finally {
			verifyState.unverified = false;
			slow.restore();
		}
		assert.equal(calls.split("\n").filter((l) => l.includes("deadbeef1")).length, 1, "the commit is searched for once");
		for (const repo of ["a", "b"]) assert.deepEqual(readReviews(join(dir, repo), reviewsRoot).map((r) => [r.sha, r.verdict]), [[head(repo), "Inconclusive"]], repo);
		assert.ok(c.notes.some((n) => /could not be searched in time/.test(n)), c.notes.join("\n"));
	});
}

test("review gate: a review of unverified edits with a bad BASE holds back the commit it names, not HEAD", async () => {
	const { dir, git } = workspaceProject();
	const reviewsRoot = mkdtempSync(join(tmpdir(), "guard-reviews-"));
	const g = fakePi();
	guard(g.pi, { reviewsRoot });
	const named = String(git("a", "rev-parse", "HEAD")).trim();
	writeFileSync(join(dir, "a", "g.ts"), "export {};\n");
	git("a", "add", "g.ts");
	git("a", "commit", "-q", "-m", "g");
	verifyState.unverified = true;
	try {
		await g.emit("tool_result", { toolName: "subagent", toolCallId: "c1", input: {}, content: [], details: { results: [{ agent: "reviewer", exitCode: 0, finalOutput: `Reviewed BASE: deadbeef0\nReviewed HEAD: ${named}\nReady to merge: Yes` }] }, isError: false }, ctx(dir));
	} finally {
		verifyState.unverified = false;
	}
	assert.deepEqual(readReviews(join(dir, "a"), reviewsRoot).map((r) => [r.sha, r.verdict]), [[named, "Inconclusive"]]);
});

test("review gate: a review of unverified edits that names no commit here falls back to each repository's HEAD", async () => {
	const { dir, git } = workspaceProject();
	const reviewsRoot = mkdtempSync(join(tmpdir(), "guard-reviews-"));
	const g = fakePi();
	guard(g.pi, { reviewsRoot });
	verifyState.unverified = true;
	try {
		await g.emit("tool_result", { toolName: "subagent", toolCallId: "c1", input: {}, content: [], details: { results: [{ agent: "reviewer", exitCode: 0, finalOutput: "Reviewed BASE: deadbeef0\nReviewed HEAD: deadbeef1\nReady to merge: Yes" }] }, isError: false }, ctx(dir));
	} finally {
		verifyState.unverified = false;
	}
	for (const repo of ["a", "b"]) assert.deepEqual(readReviews(join(dir, repo), reviewsRoot).map((r) => [r.sha, r.verdict]), [[String(git(repo, "rev-parse", "HEAD")).trim(), "Inconclusive"]], repo);
});

test("review-log reads a short SHA as the commit it abbreviates, never a branch of that name", async () => {
	const { dir, reviewsRoot, head, reviewer } = reviewWorkspace();
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: join(dir, "a"), stdio: "pipe" });
	const first = head("a");
	writeFileSync(join(dir, "a", "g.ts"), "export {};\n");
	git("add", "g.ts");
	git("commit", "-q", "-m", "g");
	const second = head("a");
	await reviewer(`WRONG-COMMIT\nReviewed BASE: ${first}\nReviewed HEAD: ${second}\nReady to merge: No`);
	git("branch", first.slice(0, 10), second);
	const { CLAUDE_PROJECT_DIR: _unset, ...shellEnv } = process.env;
	const printed = spawnSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "review-log.ts"), first.slice(0, 10)], { cwd: join(dir, "a"), encoding: "utf8", env: { ...shellEnv, ENG_KIT_REVIEWS_ROOT: reviewsRoot } });
	assert.doesNotMatch(printed.stdout, /WRONG-COMMIT/);
	assert.equal(printed.status, 1);
});

test("review-log finds the commit's repository from the workspace folder", async () => {
	const { dir, reviewsRoot, head, reviewer } = reviewWorkspace();
	await reviewer(`Reviewed BASE: ${head("b")}\nReviewed HEAD: ${head("b")}\nReady to merge: No`);
	const { CLAUDE_PROJECT_DIR: _unset, ...shellEnv } = process.env;
	const printed = spawnSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "review-log.ts"), head("b")], { cwd: dir, encoding: "utf8", env: { ...shellEnv, ENG_KIT_REVIEWS_ROOT: reviewsRoot } });
	assert.equal(printed.status, 0, printed.stderr);
	assert.match(printed.stdout, /## Reviewer run c1-0 — No/);
});

test("token ledger: subagent results and the session's usage fill the branch's ledger; the status text and /usage show it", async () => {
	const dir = project({ "README.md": "x\n" });
	spawnSync("git", ["init", "-q", "-b", "feat/u"], { cwd: dir });
	const g = fakePi();
	guard(g.pi, { reviewsRoot: mkdtempSync(join(tmpdir(), "guard-reviews-")), usageRoot: mkdtempSync(join(tmpdir(), "guard-usage-")) });
	const statuses: string[] = [];
	const notes: string[] = [];
	const base = ctx(dir);
	const c = {
		...base,
		ui: { ...base.ui, setStatus: (_key: string, text: string) => statuses.push(text), notify: (m: string) => notes.push(m) },
		sessionManager: { getSessionId: () => "s1", getBranch: () => [{ type: "message", message: { role: "assistant", usage: { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 } } }] },
	};
	const usage = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
	await g.emit("tool_result", { toolName: "subagent", toolCallId: "c1", input: {}, content: [], details: { results: [{ agent: "scout", exitCode: 0, finalOutput: "x", model: "m", usage }] }, isError: false }, c);
	await g.emit("agent_end", {}, c);
	await g.emit("agent_end", {}, c);
	assert.equal(statuses.at(-1), "sub 1k · branch 6k", "a second snapshot of the session replaces the first");
	await g.commands.get("usage").handler("", c);
	assert.equal(notes.at(-1), "Tokens on feat/u: main 5k · scout 1k · total 6k");
	const child = { ...c, hasUI: false, sessionManager: { getSessionId: () => "child", getBranch: () => [{ type: "message", message: { role: "assistant", usage: { input: 9000, output: 0, cacheRead: 0, cacheWrite: 0 } } }] } };
	await g.emit("agent_end", {}, child);
	await g.commands.get("usage").handler("", c);
	assert.equal(notes.at(-1), "Tokens on feat/u: main 5k · scout 1k · total 6k", "a run without a UI (a subagent's own process) adds no session: the parent already counted it");
});
