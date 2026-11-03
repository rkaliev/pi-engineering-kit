import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Puts a `git` first on PATH that, in the folder `slowDir` (a real path), logs each call to the returned `log` and
 * hangs for `seconds` (4 by default) when its arguments contain `only` or one of its strings (any call by default), and is the real git
 * everywhere else. The hang stands in for a slow repository: the code under test must kill the call at its own
 * deadline, long before the hang ends.
 * `restore` puts PATH back and removes the stand-in.
 */
export function slowGit(slowDir: string, only: string | string[] = "", seconds = 4): { log: string; restore: () => void } {
	const bin = mkdtempSync(join(tmpdir(), "slow-git-"));
	const log = join(bin, "calls.log");
	writeFileSync(log, "");
	const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const hang = `if [ "$PWD" = "${slowDir}" ]; then echo call >> "${log}"; case " $* " in ${[only].flat().map((o) => `*"${o}"*`).join("|")}) exec sleep ${seconds};; esac; fi`; // test-hygiene: allow the hang is the slow repository under test
	writeFileSync(join(bin, "git"), `#!/bin/sh\n${hang}\nexec "${real}" "$@"\n`, { mode: 0o755 });
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	return {
		log,
		restore: () => {
			process.env.PATH = path;
			rmSync(bin, { recursive: true, force: true });
		},
	};
}
