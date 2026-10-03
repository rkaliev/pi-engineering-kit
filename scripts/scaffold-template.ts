/**
 * Scaffold the ts-monorepo template into a new folder with current dependency versions.
 *
 *   node <kit>/scripts/scaffold-template.ts <dir> --postgres <major>   (or --postgres=<major>)
 *
 * Copies `templates/ts-monorepo/`, writes `.nvmrc` and `packageManager` from the running Node and pnpm,
 * `.postgres-version` from `--postgres` (the current supported major, postgresql.org/support/versioning),
 * and installs the packages in `scaffold.json` with `pnpm add -E`. Refuses a non-empty folder.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { checkPnpm, parseScaffoldArgs, scaffold } from "../extensions/lib/scaffold.ts";

let parsed;
try {
	parsed = parseScaffoldArgs(process.argv.slice(2));
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(2);
}
const { dest, postgres } = parsed;
if (process.platform === "win32") {
	// pnpm is a .cmd shim there; spawning it needs a shell, which this script avoids. Use WSL.
	console.error("Windows is not supported yet: run the script in WSL");
	process.exit(1);
}
const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
if (pnpm.status !== 0) {
	console.error(`pnpm is not installed or did not start: see pnpm.io/installation${pnpm.error ? ` (${pnpm.error.message})` : ""}`);
	process.exit(1);
}
const tooOld = checkPnpm(pnpm.stdout);
if (tooOld) {
	console.error(tooOld);
	process.exit(1);
}
try {
	scaffold(join(import.meta.dirname, "..", "templates", "ts-monorepo"), resolve(dest), {
		node: process.versions.node,
		pnpm: pnpm.stdout.trim(),
		postgres,
	});
	console.log(`Scaffolded ${resolve(dest)}`);
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
}
