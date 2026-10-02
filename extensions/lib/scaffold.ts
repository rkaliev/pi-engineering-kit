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
) => { status: number | null; stdout?: string | undefined; stderr?: string | undefined };

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
 * The highest release without a pre-release part that is at least `minAgeMinutes` old.
 * `times` is the registry `time` map: versions, plus `created` and `modified`, which are ignored.
 */
export function pickStable(times: Record<string, string>, now: Date, minAgeMinutes: number): string | undefined {
	let best: { version: string; key: number[] } | undefined;
	for (const [version, published] of Object.entries(times)) {
		const m = SEMVER.exec(version);
		if (!m) continue;
		if (now.getTime() - new Date(published).getTime() < minAgeMinutes * 60_000) continue;
		const key = [Number(m[1]), Number(m[2]), Number(m[3])];
		const higher = !best || compare(key, best.key) > 0;
		if (higher) best = { version, key };
	}
	return best?.version;
}

/** Same release-age delay as the template's pnpm-workspace.yaml. */
export const MIN_RELEASE_AGE_MINUTES = 1440;

export type Resolve = (name: string) => string;

const registryResolve: Resolve = (name) => {
	const r = spawnSync("pnpm", ["view", name, "time", "--json"], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`pnpm view ${name} failed\n${r.stdout}${r.stderr}`);
	const version = pickStable(JSON.parse(r.stdout), new Date(), MIN_RELEASE_AGE_MINUTES);
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
	const copy = walk(template).map((f) => relative(template, f));
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
	const pinned = new Map(externalPackages(template).map((name) => [name, `${name}@${resolve(name)}`]));
	const plan = planScaffold(template, dest, versions, (name) => pinned.get(name) ?? name);
	for (const file of plan.copy) {
		mkdirSync(dirname(join(dest, file)), { recursive: true });
		cpSync(join(template, file), join(dest, file));
	}
	for (const [file, content] of Object.entries(plan.writes)) writeFileSync(join(dest, file), content);
	for (const command of [["pnpm", "install"], ...plan.installs]) {
		const [cmd = "", ...args] = command;
		const r = run(cmd, args, { cwd: dest });
		if (r.status !== 0) throw new Error(`${command.join(" ")} failed (exit ${r.status})\n${r.stdout ?? ""}${r.stderr ?? ""}`);
	}
}
