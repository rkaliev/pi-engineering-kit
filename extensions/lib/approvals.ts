import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Where specs and plans live (the kit's defaults). */
export const APPROVAL_DIRS = ["docs/specs", "docs/plans"];

/** A status that means "agreed with the user", so the file must be in git. Drafts and plans in progress are not. */
const SETTLED = /^\s*(?:\*\*)?Status:(?:\*\*)?\s*(approved|implemented|superseded|done)\b/im;

/**
 * Specs and plans whose status says they were approved (or later) but whose current content is
 * not committed: new, modified or staged. Returns project-relative paths; empty outside a git repo.
 */
export function uncommittedApproved(projectDir: string, dirs = APPROVAL_DIRS): string[] {
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

export function approvalReminder(files: string[]): string {
	return `Approval gate: approved specs or plans are not committed: ${files.join(", ")}. An approval that isn't in git can be lost or silently edited. Commit them now as their own commit (\`git add ${files.join(" ")} && git commit -m "docs: approve …"\`), or tell me why not.`;
}
