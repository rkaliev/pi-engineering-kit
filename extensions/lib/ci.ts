import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** CI configuration files the kit knows how to read, relative to the project root. */
const CI_FILES = [".gitlab-ci.yml", "Jenkinsfile", "bitbucket-pipelines.yml", "azure-pipelines.yml", ".circleci/config.yml"];
const CI_DIRS = [".github/workflows"];

export interface CiCoverage {
	/** CI config files found, project-relative. */
	files: string[];
	/** Verification commands that no CI file runs. */
	missing: string[];
	/** A CI file has the `working-docs` job from the ci-quality-gates templates. */
	workDocsCheck: boolean;
	/** A CI file runs the kit's `test-hygiene` script. */
	hygieneCheck: boolean;
}

/** The CI job that fails when task files reach the base branch, found by its YAML key. */
export const WORK_DOCS_MARKER = "working-docs:";

/** The kit's test-hygiene script, as CI runs it. */
export const HYGIENE_MARKER = "test-hygiene.mts";

export function findCiFiles(cwd: string): string[] {
	const files = CI_FILES.filter((f) => existsSync(join(cwd, f)));
	for (const dir of CI_DIRS) {
		try {
			for (const name of readdirSync(join(cwd, dir))) if (/\.ya?ml$/.test(name)) files.push(`${dir}/${name}`);
		} catch {
			// no such directory
		}
	}
	return files.sort();
}

/** A parsed `turbo run` invocation: its task list and whether any flag narrows or changes what it runs. */
interface TurboRun {
	tasks: string[];
	/** A flag other than the output/performance ones that leave the task set alone. */
	narrowing: boolean;
}

/** Flags that don't change which tasks run; `true` when the flag takes a value. */
const HARMLESS_TURBO_FLAGS: Record<string, boolean> = {
	"--affected": false,
	"--continue": false,
	"--summarize": false,
	"--cache-dir": true,
	"--concurrency": true,
	"--output-logs": true,
	"--ui": true,
	"--log-order": true,
	"--no-daemon": false,
	"--token": true,
	"--team": true,
	"--env-mode": true,
	"--cache": true,
	"--force": false,
};

/** Parse `[<exec>] turbo run <tasks…> [flags]`; null when the command is not a turbo run. */
function parseTurboRun(command: string): TurboRun | null {
	const m = /(?:^|\s)turbo run((?:\s+\S+)*)\s*$/.exec(command);
	if (!m) return null;
	const words = m[1].split(/\s+/).filter(Boolean);
	const firstFlag = words.findIndex((w) => w.startsWith("-"));
	const tasks = firstFlag === -1 ? words : words.slice(0, firstFlag);
	let narrowing = false;
	for (let i = firstFlag === -1 ? words.length : firstFlag; i < words.length; i++) {
		const [flag, inline] = words[i].split(/=(.*)/s);
		if (!Object.hasOwn(HARMLESS_TURBO_FLAGS, flag)) {
			narrowing = true;
			break;
		}
		// `--cache-dir .turbo`: the value is the next word unless it is given inline
		if (HARMLESS_TURBO_FLAGS[flag] && inline === undefined && words[i + 1] !== undefined && !words[i + 1].startsWith("-")) i++;
	}
	return { tasks, narrowing };
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The tasks of a verify command of the form `<exec> turbo run <tasks>` (no flags), else null. */
function verifyTurboTasks(command: string): string[] | null {
	// a chain (`a && turbo run test`) or pipe is matched as text: its turbo part alone is not the whole command
	if (/&&|\|\||;|\|/.test(command)) return null;
	const parsed = parseTurboRun(collapse(command));
	// a verify command with flags of its own is matched as text instead
	return parsed && !/\bturbo run\b.*\s-/.test(command) && parsed.tasks.length > 0 ? parsed.tasks : null;
}

/** Which verification commands the project's CI doesn't run (text match, whitespace-normalized; turbo runs by task set). */
export function ciCoverage(cwd: string, commands: string[]): CiCoverage {
	const files = findCiFiles(cwd);
	// kit-init adds `--no` / `--no-install` so verification never downloads a tool; CI text may lack them.
	const norm = (s: string) =>
		s
			.replace(/\s+/g, " ")
			.replace(/\bnpx --no(?:-install)?(?![\w-])/g, "npx")
			.replace(/\bbunx --no-install\b/g, "bunx");
	const raw = files.map((f) => readFileSync(join(cwd, f), "utf8")).join("\n");
	const text = norm(raw);
	// Split before whitespace is collapsed, so a newline separates commands as `&&` does.
	const turboRuns = raw
		.split(/\r?\n|&&|\|\||;/)
		.map((c) => parseTurboRun(collapse(c).replace(/["']+$/, "")))
		.filter((t): t is TurboRun => t !== null && !t.narrowing);
	const covered = (c: string) => {
		const tasks = verifyTurboTasks(c);
		return tasks ? turboRuns.some((t) => tasks.every((x) => t.tasks.includes(x))) : text.includes(norm(c).trim());
	};
	return {
		files,
		missing: files.length === 0 ? [...commands] : commands.filter((c) => !covered(c)),
		workDocsCheck: text.includes(WORK_DOCS_MARKER),
		hygieneCheck: text.includes(HYGIENE_MARKER),
	};
}
