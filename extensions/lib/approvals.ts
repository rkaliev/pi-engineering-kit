import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORK_DOC_DIRS } from "./workdocs.ts";

/** "Agreed with the user", so the file must be in git. Drafts and tasks in progress are not; implemented ones are deleted. */
const SETTLED = /^\s*(?:\*\*)?Status:(?:\*\*)?\s*(?:design|plan) approved\b/im;

/**
 * Task files whose status says the design or plan was approved but whose current content is not
 * committed: new, modified or staged. Returns project-relative paths; empty outside a git repo.
 */
export function uncommittedApproved(projectDir: string, dirs = WORK_DOC_DIRS): string[] {
	const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...dirs], {
		cwd: projectDir,
		encoding: "utf8",
		timeout: 5000,
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
