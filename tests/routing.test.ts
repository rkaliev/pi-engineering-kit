import assert from "node:assert/strict";
import test from "node:test";
import { mergeRouting, parseRouting, pickModel, routeFor } from "../extensions/lib/routing.ts";

const raw = {
	modes: {
		deep: { model: ["anthropic/strong", "openai/strong"], thinking: "high" },
		fast: { model: "anthropic/mid" },
	},
	commands: { review: "deep", implement: "fast", "skill:security-review": "deep" },
};

test("parseRouting normalizes model lists and keeps thinking optional", () => {
	const { routing, errors } = parseRouting(raw);
	assert.deepEqual(errors, []);
	assert.deepEqual(routing.modes.fast, { models: ["anthropic/mid"], thinking: undefined });
	assert.deepEqual(routing.modes.deep!.models, ["anthropic/strong", "openai/strong"]);
	assert.equal(routing.commands.review, "deep");
});

test("parseRouting reports bad entries instead of throwing", () => {
	const { routing, errors } = parseRouting({
		modes: { a: { model: "no-slash" }, b: { model: "x/y", thinking: "turbo" }, c: {} },
		commands: { review: "missing", plan: "b" },
	});
	assert.equal(errors.length, 4, errors.join("\n"));
	assert.deepEqual(Object.keys(routing.modes), ["b"]);
	assert.equal(routing.modes.b!.thinking, undefined, "invalid thinking level dropped");
	assert.deepEqual(routing.commands, { plan: "b" });
	assert.deepEqual(parseRouting("nope").errors.length, 1);
});

test("routeFor matches slash commands and skill commands only", () => {
	const { routing } = parseRouting(raw);
	assert.equal(routeFor("/review", routing), "deep");
	assert.equal(routeFor("  /implement tasks/01.md", routing), "fast");
	assert.equal(routeFor("/skill:security-review src/", routing), "deep");
	assert.equal(routeFor("/plan x", routing), undefined, "unrouted command");
	assert.equal(routeFor("please /review this", routing), undefined, "not a leading command");
	assert.equal(routeFor("review it", routing), undefined);
});

test("pickModel takes the first candidate that exists and is available", () => {
	const registry = new Map([
		["anthropic/strong", { id: "strong", provider: "anthropic" }],
		["openai/strong", { id: "strong", provider: "openai" }],
	]);
	const find = (p: string, id: string) => registry.get(`${p}/${id}`);
	const openaiOnly = (m: { provider: string }) => m.provider === "openai";
	assert.equal(pickModel(["anthropic/strong", "openai/strong"], find, openaiOnly)?.provider, "openai");
	assert.equal(pickModel(["anthropic/strong"], find, openaiOnly), undefined);
	assert.equal(pickModel(["google/x"], find, () => true), undefined);
});

test("model ids may contain slashes after the provider", () => {
	const seen: string[] = [];
	pickModel(["openrouter/meta/llama-4"], (p, id) => (seen.push(`${p}|${id}`), undefined), () => true);
	assert.deepEqual(seen, ["openrouter|meta/llama-4"]);
});

test("mergeRouting: project overrides global per key", () => {
	const global = parseRouting(raw).routing;
	const project = parseRouting({ modes: { fast: { model: "local/small" } }, commands: { review: "fast" } }).routing;
	const merged = mergeRouting(global, project);
	assert.deepEqual(merged.modes.fast!.models, ["local/small"]);
	assert.deepEqual(merged.modes.deep!.models, ["anthropic/strong", "openai/strong"]);
	assert.equal(merged.commands.review, "fast");
	assert.equal(merged.commands.implement, "fast");
});
