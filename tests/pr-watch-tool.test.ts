import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { registerPrWatch } from "../extensions/pr-watch.ts";

const made: string[] = [];
after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A watcher script that runs `body` (JavaScript) in place of the real one. */
function script(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pr-watch-tool-"));
	made.push(dir);
	const file = join(dir, "pr-watch.mjs");
	writeFileSync(file, body);
	return file;
}

function fakePi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sent: Array<{ message: any; options: any }> = [];
	const tools = new Map<string, any>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: (message: unknown, options?: unknown) => sent.push({ message, options }),
		registerTool: (tool: any) => tools.set(tool.name, tool),
	};
	const emit = async (event: string, ctx: unknown) => {
		for (const h of handlers.get(event) ?? []) await h({ type: event }, ctx);
	};
	return { pi: pi as any, sent, tools, emit };
}

const ctx = { cwd: tmpdir(), hasUI: false, isProjectTrusted: () => true };
const call = (f: ReturnType<typeof fakePi>, params: Record<string, unknown> = {}, c: object = ctx) => f.tools.get("watch_pr").execute("id", params, undefined, undefined, c);
const text = (result: any) => result.content.map((c: { text: string }) => c.text).join("");
async function until(check: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await new Promise((done) => setTimeout(done, 20));
}
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const READY = `setTimeout(() => console.log(JSON.stringify({ schemaVersion: 1, event: "ready", reason: "1 check passed" })), 200);`;

test("watch_pr returns at once, then wakes the agent with the event", async () => {
	const f = fakePi();
	registerPrWatch(f.pi, script(READY));
	const result = await call(f, { pr: 48 });
	assert.match(text(result), /Watching the PR/);
	assert.equal(f.sent.length, 0, "the tool returned before the watcher finished");
	await until(() => f.sent.length > 0);
	assert.deepEqual(f.sent[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal(f.sent[0]?.message.customType, "pr-watch");
	assert.match(f.sent[0]?.message.content, /"event": "ready"/);
	assert.match(f.sent[0]?.message.content, /references\/pr-watch\.md/);
});

test("watch_pr: a second call while one runs doesn't spawn another", async () => {
	const f = fakePi();
	registerPrWatch(f.pi, script(READY));
	const first = await call(f);
	const second = await call(f);
	assert.match(text(second), new RegExp(`already running \\(pid ${first.details.pid}\\)`));
	assert.equal(second.details.pid, first.details.pid, "no second watcher was started");
	await until(() => f.sent.length > 0);
});

test("watch_pr: a watcher that prints no JSON reports blocked watcher failed", async () => {
	const f = fakePi();
	registerPrWatch(f.pi, script(`console.log("oops"); process.exit(3);`));
	await call(f);
	await until(() => f.sent.length > 0);
	assert.match(f.sent[0]?.message.content, /"event": "blocked"/);
	assert.match(f.sent[0]?.message.content, /watcher failed: exit 3/);
});

/** `--pr 1` waits and answers only SIGTERM, with an event; any other PR is ready after 200 ms. */
const BY_PR = `const pr = process.argv[process.argv.indexOf("--pr") + 1];
const say = (event) => console.log(JSON.stringify({ schemaVersion: 1, event, pr }));
if (pr === "1") { process.on("SIGTERM", () => { say("stopped-but-sent"); process.exit(0); }); setInterval(() => {}, 1000); }
else setTimeout(() => say("ready"), 200);`;

test("watch_pr: session_shutdown stops the watcher and nothing is sent, even after a new watcher starts (review focus 5)", async () => {
	const f = fakePi();
	registerPrWatch(f.pi, script(BY_PR));
	const first = await call(f, { pr: 1 });
	await f.emit("session_shutdown", ctx);
	// The next watcher starts before the stopped one has exited.
	await call(f, { pr: 2 });
	await until(() => f.sent.some((s) => /"pr": "2"/.test(s.message.content)));
	assert.equal(alive(first.details.pid), false);
	assert.deepEqual(f.sent.map((s) => /"pr": "(\d)"/.exec(s.message.content)?.[1]), ["2"], "the stopped watcher's output is never sent");
});

test("watch_pr: an untrusted project's prFeedback rules are not applied (R8)", async () => {
	const echo = `console.log(JSON.stringify({ schemaVersion: 1, event: "ready", argv: process.argv.slice(2) }));`;
	const untrusted = fakePi();
	registerPrWatch(untrusted.pi, script(echo));
	await call(untrusted, {}, { ...ctx, isProjectTrusted: () => false });
	await until(() => untrusted.sent.length > 0);
	assert.match(untrusted.sent[0]?.message.content, /"--no-config"/);
	const trusted = fakePi();
	registerPrWatch(trusted.pi, script(echo));
	await call(trusted);
	await until(() => trusted.sent.length > 0);
	assert.doesNotMatch(trusted.sent[0]?.message.content, /--no-config/);
});
