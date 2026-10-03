import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkPnpm, MIN_RELEASE_AGE_MINUTES, parseRegistryInfo, pickRelease, pickStable, planScaffold, scaffold, type Run } from "../extensions/lib/scaffold.ts";

const versions = { node: "24.1.0", pnpm: "10.0.0" };

function fakeTemplate(scaffoldJson: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "tpl-"));
	mkdirSync(join(dir, "apps", "api"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", private: true }));
	writeFileSync(join(dir, "apps", "api", "package.json"), "{}");
	writeFileSync(join(dir, "scaffold.json"), JSON.stringify(scaffoldJson));
	return dir;
}

test("plans installs from scaffold.json", () => {
	const tpl = fakeTemplate({
		"apps/api": { dependencies: ["express"], devDependencies: ["vitest"] },
		"packages/x": { dependencies: [], devDependencies: [] },
	});
	const plan = planScaffold(tpl, "/unused", versions);
	assert.deepEqual(plan.installs, [
		["pnpm", "--filter", "./apps/api", "add", "-E", "express"],
		["pnpm", "--filter", "./apps/api", "add", "-E", "-D", "vitest"],
	]);
});

test("workspace packages install as workspace:* and the root uses -w", () => {
	const tpl = fakeTemplate({
		".": { devDependencies: ["turbo", "@repo/prettier-config"] },
		"apps/api": { dependencies: ["@repo/db"] },
	});
	assert.deepEqual(planScaffold(tpl, "/unused", versions).installs, [
		["pnpm", "add", "-w", "-E", "-D", "turbo", "@repo/prettier-config@workspace:*"],
		["pnpm", "--filter", "./apps/api", "add", "-E", "@repo/db@workspace:*"],
	]);
});

test("writes .nvmrc and packageManager", () => {
	const plan = planScaffold(fakeTemplate({}), "/unused", versions);
	assert.equal(plan.writes[".nvmrc"], "24.1.0\n");
	const pkg = JSON.parse(plan.writes["package.json"] ?? "{}");
	assert.equal(pkg.packageManager, "pnpm@10.0.0");
	assert.equal(pkg.name, "app");
	assert.ok(plan.copy.includes("apps/api/package.json"));
	assert.ok(!plan.copy.includes("scaffold.json"));
});

test("refuses a non-empty destination", () => {
	const dest = mkdtempSync(join(tmpdir(), "dest-"));
	writeFileSync(join(dest, "keep.txt"), "x");
	assert.throws(
		() => scaffold(fakeTemplate({}), dest, versions, () => ({ status: 0 })),
		(e: Error) => /not empty/.test(e.message) && e.message.includes(dest),
	);
});

test("copies, writes, then runs install and the planned installs in order", () => {
	const dest = join(mkdtempSync(join(tmpdir(), "dest-")), "app");
	const calls: string[][] = [];
	const run: Run = (cmd, args, opts) => {
		calls.push([cmd, ...args]);
		assert.equal(opts.cwd, dest);
		return { status: 0 };
	};
	scaffold(fakeTemplate({ "apps/api": { dependencies: ["express", "@repo/db"] } }), dest, versions, run, () => "1.2.3");
	assert.equal(readFileSync(join(dest, ".nvmrc"), "utf8"), "24.1.0\n");
	assert.ok(existsSync(join(dest, "apps", "api", "package.json")));
	assert.deepEqual(calls, [
		["pnpm", "install"],
		["pnpm", "--filter", "./apps/api", "add", "-E", "express@1.2.3", "@repo/db@workspace:*"],
	]);
});

test("a failing command throws with its output", () => {
	const dest = join(mkdtempSync(join(tmpdir(), "dest-")), "app");
	const run: Run = () => ({ status: 1, stdout: "out", stderr: "boom" });
	assert.throws(() => scaffold(fakeTemplate({}), dest, versions, run), /pnpm install.*boom/s);
});

const now = new Date("2026-10-02T12:00:00Z");
const old = "2026-01-01T00:00:00Z";

test("pickStable skips pre-releases and ignores created/modified", () => {
	const times = { created: old, modified: "2026-10-02T11:59:00Z", "7.9.1-dev.1": old, "7.10.0": old, "8.0.0-rc.19": old };
	assert.equal(pickStable(times, now, 1440), "7.10.0");
});

test("pickStable compares numerically", () => {
	assert.equal(pickStable({ "7.9.0": old, "7.10.0": old, "7.2.11": old }, now, 1440), "7.10.0");
});

test("pickStable skips a release younger than the age", () => {
	const times = { "7.10.0": old, "7.11.0": "2026-10-02T11:00:00Z" };
	assert.equal(pickStable(times, now, 1440), "7.10.0");
});

test("pickStable returns undefined without a candidate", () => {
	assert.equal(pickStable({ created: old, "1.0.0-rc.1": old }, now, 1440), undefined);
});

test("pickStable with exactMajor stays in that major", () => {
	assert.equal(pickStable({ "24.9.0": old, "26.6.3": old }, now, 1440, { exactMajor: 24 }), "24.9.0");
	assert.equal(pickStable({ "24.9.0": old, "24.10.1": old, "26.6.3": old }, now, 1440, { exactMajor: 24 }), "24.10.1");
});

test("pickStable with maxMajor skips only higher majors", () => {
	assert.equal(pickStable({ "7.10.0": old, "8.1.0": old }, now, 1440, { maxMajor: 7 }), "7.10.0");
	assert.equal(pickStable({ "6.2.0": old, "7.1.0": old }, now, 1440, { maxMajor: 7 }), "7.1.0");
});

test("a stable latest tag caps the major; a young new major under it is skipped by age", () => {
	const info = {
		time: { "7.10.0": old, "8.0.0": "2026-10-02T11:00:00Z" },
		"dist-tags": { latest: "8.0.0" },
	};
	assert.equal(pickRelease(info, now, 1440), "7.10.0");
});

test("a stable latest tag keeps a stable-numbered release under next out", () => {
	const info = { time: { "7.10.0": old, "8.0.0": old }, "dist-tags": { latest: "7.10.0", next: "8.0.0" } };
	assert.equal(pickRelease(info, now, 1440), "7.10.0");
});

test("a pre-release latest tag caps nothing, and exactMajor wins over the cap", () => {
	const rc = { time: { "7.10.0": old, "8.0.0-rc.1": old }, "dist-tags": { latest: "8.0.0-rc.1" } };
	assert.equal(pickRelease(rc, now, 1440), "7.10.0");
	assert.equal(pickRelease({ time: { "7.10.0": old }, "dist-tags": {} }, now, 1440), "7.10.0", "no latest tag caps nothing");
	const node = { time: { "24.9.0": old, "26.6.3": old }, "dist-tags": { latest: "26.6.3" } };
	assert.equal(pickRelease(node, now, 1440, 24), "24.9.0");
});

test("pickStable skips entries whose date does not parse", () => {
	assert.equal(pickStable({ "2.0.0": "not a date", "1.0.0": old }, now, 1440), "1.0.0");
});

test("parseRegistryInfo names the package when the registry answer is not JSON", () => {
	assert.throws(() => parseRegistryInfo("zod", "<html>"), /zod/);
});

test("scaffold resolves @types/node within the major of the running Node and caps others by latest", () => {
	const tpl = fakeTemplate({ "apps/api": { devDependencies: ["@types/node", "vitest"] } });
	const dest = join(mkdtempSync(join(tmpdir(), "dest-")), "app");
	const seen: Record<string, number | undefined> = {};
	scaffold(tpl, dest, versions, () => ({ status: 0 }), (name, major) => ((seen[name] = major), "1.0.0"));
	assert.equal(seen["@types/node"], 24);
	assert.equal(seen["vitest"], undefined);
});

test("the template's minimumReleaseAge equals the scaffold's", () => {
	const yaml = readFileSync(join(import.meta.dirname, "..", "templates", "ts-monorepo", "pnpm-workspace.yaml"), "utf8");
	assert.equal(Number(/^minimumReleaseAge:\s*(\d+)/m.exec(yaml)?.[1]), MIN_RELEASE_AGE_MINUTES);
});

test("checkPnpm refuses a pnpm without allowBuilds, names the floor, and accepts newer", () => {
	assert.match(checkPnpm("10.25.9") ?? "", /10\.26\.0/);
	assert.equal(checkPnpm("10.26.0"), undefined);
	assert.equal(checkPnpm("12.4.1"), undefined);
	assert.match(checkPnpm("garbage") ?? "", /10\.26\.0/);
	assert.match(checkPnpm("9.99.0") ?? "", /10\.26\.0/);
});

test("the copy skips local state: .env files, build output, caches, generated code", () => {
	const tpl = fakeTemplate({});
	for (const file of [".env", ".env.local", ".env.production.local", ".env.example", ".turbo/cache/x", "apps/api/dist/main.js", "packages/db/src/generated/types.ts", "apps/api/node_modules/x/index.js"]) {
		mkdirSync(join(tpl, file, ".."), { recursive: true });
		writeFileSync(join(tpl, file), "x");
	}
	const { copy } = planScaffold(tpl, "/unused", versions);
	assert.deepEqual(
		copy.filter((f) => /\.env|\.turbo|dist|generated|node_modules/.test(f)),
		[".env.example"],
	);
	assert.ok(copy.includes("apps/api/package.json"));
});
