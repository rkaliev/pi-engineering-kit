import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRepos } from "./repos.ts";
import { finishedWorkDocs, onBaseBranch, WORK_DOC_DIRS } from "./workdocs.ts";

/** "Agreed with the user", so the file must be in git. Drafts and tasks in progress are not; implemented ones are deleted. */
const SETTLED = /^\s*(?:\*\*)?Status:(?:\*\*)?\s*(?:design|plan) approved\b/im;

/**
 * Task files whose status says the design or plan was approved but whose current content is not
 * committed: new, modified or staged. Returns project-relative paths; empty outside a git repo.
 */
export function uncommittedApproved(projectDir: string, dirs = WORK_DOC_DIRS, timeout = 5000): string[] {
	const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...dirs], {
		cwd: projectDir,
		encoding: "utf8",
		timeout,
	});
	if (r.status !== 0 || !r.stdout) return [];
	const files: string[] = [];
	for (const line of r.stdout.split("\n")) {
		if (line.length < 4 || line[0] === "D" || line[1] === "D") continue;
		let path = line.slice(3).trim();
		if (path.includes(" -> ")) path = path.split(" -> ").pop()!;
		path = path.replace(/^"(.*)"$/, "$1");
		if (!path.endsWith(".md")) continue;
		try {
			const head = readFileSync(join(projectDir, path), "utf8").split("\n").slice(0, 15).join("\n");
			if (SETTLED.test(head)) files.push(path);
		} catch {
			// unreadable or gone: nothing to commit
		}
	}
	return files;
}

/** `onBase` names the base branch when it is checked out: working documents are committed only on a work branch. */
export function approvalReminder(files: string[], onBase?: string): string {
	const where = onBase ? ` You are on ${onBase}, where task files never go: create a work branch first (\`git switch -c <type>/<topic>\`).` : "";
	return `Approval gate: approved task files are not committed: ${files.join(", ")}. An approval that isn't in git can be lost or silently edited.${where} Commit them now as their own commit (\`git add ${files.join(" ")} && git commit -m "docs: approve …"\`), or tell me why not.`;
}

/** Task files due a reminder at Stop, as `approvalReminder` and `workDocsReminder` take them. */
export interface TaskFileReminders {
	approved: string[];
	finished: string[];
	onBase: string | undefined;
	/** Workspace repositories not reached before the deadline, or known to be slow. */
	skipped: string[];
}

/**
 * The approved-but-uncommitted and the finished task files of the project or, in a workspace, of the session folder
 * and each repository (paths prefixed with its name), within `deadline`. `want` skips what was already reminded;
 * `slow` names repositories the session already found slow, which are skipped without a git call.
 */
export function taskFileReminders(projectDir: string, dirsFor: (root: string) => string[], deadline: number, want = { approved: true, finished: true }, slow: string[] = []): TaskFileReminders {
	const dirs = dirsFor(projectDir);
	const { kind, repos } = projectRepos(projectDir);
	if (kind !== "workspace") {
		const approved = want.approved ? uncommittedApproved(projectDir, dirs) : [];
		return { approved, finished: want.finished ? finishedWorkDocs(projectDir, dirs) : [], onBase: approved.length > 0 ? onBaseBranch(projectDir) : undefined, skipped: [] };
	}
	// The session folder holds no git: only its finished task files count.
	const due: TaskFileReminders = { approved: [], finished: want.finished ? finishedWorkDocs(projectDir, dirs) : [], onBase: undefined, skipped: [] };
	const bases: string[] = [];
	for (const name of repos) {
		const left = deadline - Date.now();
		if (left <= 0 || slow.includes(name)) {
			due.skipped.push(name);
			continue;
		}
		const dir = join(projectDir, name);
		const own = dirsFor(dir);
		if (want.approved) {
			const files = uncommittedApproved(dir, own, Math.min(5000, left));
			due.approved.push(...files.map((f) => `${name}/${f}`));
			const base = files.length > 0 ? onBaseBranch(dir) : undefined;
			if (base) bases.push(`${base} in ${name}`);
		}
		if (want.finished) due.finished.push(...finishedWorkDocs(dir, own).map((f) => `${name}/${f}`));
	}
	due.onBase = bases.length > 0 ? bases.join(", ") : undefined;
	return due;
}

/** A warning naming the repositories the reminders skipped, or undefined. */
export function taskFileWarning(skipped: string[]): string | undefined {
	return skipped.length > 0 ? `Task-file reminders skipped (no time left, or slow in this session): ${skipped.join(", ")}` : undefined;
}
