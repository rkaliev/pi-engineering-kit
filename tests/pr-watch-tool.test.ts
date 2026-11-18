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

const ctx = { cwd: tmpdir(), hasUI: false };
const call = (f: ReturnType<typeof fakePi>, params: Record<string, unknown> = {}) => f.tools.get("watch_pr").execute("id", params, undefined, undefined, ctx);
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
	assert.equal(second.details.pid, first.details.pid);
	await until(() => f.sent.length > 0);
	await new Promise((done) => setTimeout(done, 300));
	assert.equal(f.sent.length, 1);
});

test("watch_pr: a watcher that prints no JSON reports blocked watcher failed", async () => {
	const f = fakePi();
	registerPrWatch(f.pi, script(`console.log("oops"); process.exit(3);`));
	await call(f);
	await until(() => f.sent.length > 0);
	assert.match(f.sent[0]?.message.content, /"event": "blocked"/);
	assert.match(f.sent[0]?.message.content, /watcher failed: exit 3/);
});

test("watch_pr: session_shutdown stops the watcher and nothing is sent (review focus 5)", async () => {
	const f = fakePi();
	registerPrWatch(f.pi, script(`setTimeout(() => console.log("{}"), 3000);`));
	const result = await call(f);
	await f.emit("session_shutdown", ctx);
	await until(() => !alive(result.details.pid));
	assert.equal(alive(result.details.pid), false);
	await new Promise((done) => setTimeout(done, 300));
	assert.equal(f.sent.length, 0);
});
