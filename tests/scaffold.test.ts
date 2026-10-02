import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { latestMajor, MIN_RELEASE_AGE_MINUTES, parseRegistryInfo, pickStable, planScaffold, scaffold, type Run } from "../extensions/lib/scaffold.ts";

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
	assert.throws(() => scaffold(fakeTemplate({}), dest, versions, () => ({ status: 0 })), {
		message: `Destination is not empty: ${dest}`,
	});
});

test("copies, writes, then runs install and the planned installs in order", () => {
	const dest = join(mkdtempSync(join(tmpdir(), "dest-")), "app");
	const calls: string[][] = [];
	const run: Run = (cmd, args, opts) => {
		calls.push([cmd, ...args]);
		assert.equal(opts.cwd, dest);
		return { status: 0 };
	};
	scaffold(fakeTemplate({ "apps/api": { dependencies: ["express"] } }), dest, versions, run, () => "1.2.3");
	assert.equal(readFileSync(join(dest, ".nvmrc"), "utf8"), "24.1.0\n");
	assert.ok(existsSync(join(dest, "apps", "api", "package.json")));
	assert.deepEqual(calls, [
		["pnpm", "install"],
		["pnpm", "--filter", "./apps/api", "add", "-E", "express@1.2.3"],
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

test("scaffold pins every registry package to the resolved version and fails when none exists", () => {
	const tpl = fakeTemplate({ "apps/api": { dependencies: ["express", "@repo/db"] } });
	const dest = join(mkdtempSync(join(tmpdir(), "dest-")), "app");
	const calls: string[][] = [];
	scaffold(tpl, dest, versions, (cmd, args) => (calls.push([cmd, ...args]), { status: 0 }), () => "9.9.9");
	assert.deepEqual(calls[1], ["pnpm", "--filter", "./apps/api", "add", "-E", "express@9.9.9", "@repo/db@workspace:*"]);
	const none = (name: string): string => {
		throw new Error(`No stable release of ${name} older than 1440 minutes`);
	};
	const dest2 = join(mkdtempSync(join(tmpdir(), "dest-")), "app");
	assert.throws(() => scaffold(tpl, dest2, versions, () => ({ status: 0 }), none), /No stable release of express/);
});

test("pickStable stays within the requested major", () => {
	const times = { "24.9.0": old, "26.6.3": old, "24.10.1": old };
	assert.equal(pickStable(times, now, 1440, 24), "24.10.1");
});

test("pickStable skips entries whose date does not parse", () => {
	assert.equal(pickStable({ "2.0.0": "not a date", "1.0.0": old }, now, 1440), "1.0.0");
});

test("latestMajor is the major of a stable latest tag, otherwise undefined", () => {
	assert.equal(latestMajor({ latest: "7.4.2", next: "9.0.0" }), 7);
	assert.equal(latestMajor({ latest: "8.0.0-rc.19" }), undefined);
	assert.equal(latestMajor({}), undefined);
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
