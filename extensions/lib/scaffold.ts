import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface ScaffoldPlan {
	/** Template files to copy, relative to the template root. */
	copy: string[];
	/** Files written after the copy, by relative path. */
	writes: Record<string, string>;
	/** Commands to run in the destination, in order, after `pnpm install`. */
	installs: string[][];
}

type Lists = { dependencies?: string[]; devDependencies?: string[] };

export type Run = (
	cmd: string,
	args: string[],
	opts: { cwd: string },
) => { status: number | null; stdout?: string | undefined; stderr?: string | undefined; error?: Error | undefined };

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		if (name === "node_modules") return [];
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

/** Workspace packages (`@repo/*`) link to the repo; everything else gets the latest release. */
const isWorkspace = (name: string): boolean => name.startsWith("@repo/");

/** The registry package names a template installs, without the workspace ones. */
export function externalPackages(template: string): string[] {
	const lists: Record<string, Lists> = JSON.parse(readFileSync(join(template, "scaffold.json"), "utf8"));
	const names = Object.values(lists).flatMap((l) => [...(l.dependencies ?? []), ...(l.devDependencies ?? [])]);
	return [...new Set(names.filter((n) => !isWorkspace(n)))];
}

const compare = (a: number[], b: number[]): number => (a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The highest release without a pre-release part that is at least `minAgeMinutes` old, within `major` when given.
 * `times` is the registry `time` map: versions, plus `created` and `modified`, which are ignored.
 */
export function pickStable(
	times: Record<string, string>,
	now: Date,
	minAgeMinutes: number,
	major?: number,
): string | undefined {
	let best: { version: string; key: number[] } | undefined;
	for (const [version, published] of Object.entries(times)) {
		const m = SEMVER.exec(version);
		if (!m) continue;
		const age = now.getTime() - new Date(published).getTime();
		if (Number.isNaN(age) || age < minAgeMinutes * 60_000) continue;
		const key = [Number(m[1]), Number(m[2]), Number(m[3])];
		if (major !== undefined && key[0] !== major) continue;
		if (!best || compare(key, best.key) > 0) best = { version, key };
	}
	return best?.version;
}

/** The major of the `latest` dist-tag when it is a stable release: no pick may go above it. */
export function latestMajor(distTags: Record<string, string>): number | undefined {
	const m = SEMVER.exec(distTags["latest"] ?? "");
	return m ? Number(m[1]) : undefined;
}

export interface RegistryInfo {
	time: Record<string, string>;
	"dist-tags": Record<string, string>;
}

export function parseRegistryInfo(name: string, text: string): RegistryInfo {
	try {
		const info = JSON.parse(text);
		return { time: info.time ?? {}, "dist-tags": info["dist-tags"] ?? {} };
	} catch (e) {
		throw new Error(`pnpm view ${name}: answer is not JSON (${e instanceof Error ? e.message : e})`);
	}
}

/** Same release-age delay as the template's pnpm-workspace.yaml. */
export const MIN_RELEASE_AGE_MINUTES = 1440;

export type Resolve = (name: string, major?: number) => string;

const registryResolve: Resolve = (name, major) => {
	const r = spawnSync("pnpm", ["view", name, "time", "dist-tags", "--json"], { encoding: "utf8" });
	if (r.error) throw new Error(`pnpm view ${name} could not start: ${r.error.message}`);
	if (r.status !== 0) throw new Error(`pnpm view ${name} failed\n${r.stdout}${r.stderr}`);
	const info = parseRegistryInfo(name, r.stdout);
	const cap = major ?? latestMajor(info["dist-tags"]);
	const version = pickStable(info.time, new Date(), MIN_RELEASE_AGE_MINUTES, cap);
	if (!version) throw new Error(`No stable release of ${name} older than ${MIN_RELEASE_AGE_MINUTES} minutes`);
	return version;
};

export function planScaffold(
	template: string,
	dest: string,
	versions: { node: string; pnpm: string },
	pin: (name: string) => string = (name) => name,
): ScaffoldPlan {
	void dest;
	const spec = (name: string): string => (isWorkspace(name) ? `${name}@workspace:*` : pin(name));
	const copy = walk(template).map((f) => relative(template, f)).filter((f) => f !== "scaffold.json");
	const pkg = JSON.parse(readFileSync(join(template, "package.json"), "utf8"));
	const writes = {
		".nvmrc": `${versions.node}\n`,
		"package.json": `${JSON.stringify({ ...pkg, packageManager: `pnpm@${versions.pnpm}` }, null, 2)}\n`,
	};
	const lists: Record<string, Lists> = JSON.parse(readFileSync(join(template, "scaffold.json"), "utf8"));
	const installs: string[][] = [];
	for (const [workspace, { dependencies = [], devDependencies = [] }] of Object.entries(lists)) {
		const head = workspace === "." ? ["pnpm", "add", "-w", "-E"] : ["pnpm", "--filter", `./${workspace}`, "add", "-E"];
		if (dependencies.length > 0) installs.push([...head, ...dependencies.map(spec)]);
		if (devDependencies.length > 0) installs.push([...head, "-D", ...devDependencies.map(spec)]);
	}
	return { copy, writes, installs };
}

const spawn: Run = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, encoding: "utf8" });

/** Copy the template into `dest`, write `.nvmrc` and `packageManager`, then install. Throws on any failure. */
export function scaffold(
	template: string,
	dest: string,
	versions: { node: string; pnpm: string },
	run: Run = spawn,
	resolve: Resolve = registryResolve,
): void {
	if (existsSync(dest) && readdirSync(dest).length > 0) throw new Error(`Destination is not empty: ${dest}`);
	// @types/node follows the Node the project runs (.nvmrc), not the newest Node.
	const nodeMajor = Number(versions.node.split(".")[0]);
	const pinned = new Map(
		externalPackages(template).map((name) => [name, `${name}@${resolve(name, name === "@types/node" ? nodeMajor : undefined)}`]),
	);
	const plan = planScaffold(template, dest, versions, (name) => pinned.get(name) ?? name);
	for (const file of plan.copy) {
		mkdirSync(dirname(join(dest, file)), { recursive: true });
		cpSync(join(template, file), join(dest, file));
	}
	for (const [file, content] of Object.entries(plan.writes)) writeFileSync(join(dest, file), content);
	for (const command of [["pnpm", "install"], ...plan.installs]) {
		const [cmd = "", ...args] = command;
		const r = run(cmd, args, { cwd: dest });
		if (r.status !== 0) throw new Error(`${command.join(" ")} failed (exit ${r.status})\n${r.error?.message ?? ""}${r.stdout ?? ""}${r.stderr ?? ""}`);
	}
}
