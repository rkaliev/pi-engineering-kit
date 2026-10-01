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

/** Which verification commands the project's CI doesn't run (a plain text match, whitespace-normalized). */
export function ciCoverage(cwd: string, commands: string[]): CiCoverage {
	const files = findCiFiles(cwd);
	const norm = (s: string) => s.replace(/\s+/g, " ");
	const text = norm(files.map((f) => readFileSync(join(cwd, f), "utf8")).join("\n"));
	return {
		files,
		missing: files.length === 0 ? [...commands] : commands.filter((c) => !text.includes(norm(c).trim())),
		workDocsCheck: text.includes(WORK_DOCS_MARKER),
		hygieneCheck: text.includes(HYGIENE_MARKER),
	};
}
