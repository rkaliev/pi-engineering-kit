/**
 * Print the reviewer reports recorded for a commit (its latest round of reviews), so a repeat round
 * re-checks the open findings from the store instead of the author's summary of them.
 * From a plain folder with several repositories, the reports of every repository holding the commit.
 * Exits 1 when no review of that commit is recorded.
 *
 *   node <kit>/scripts/review-log.ts <rev>
 */
import { spawnSync } from "node:child_process";
import { readReports, reposFor } from "../extensions/lib/reviews.ts";

const rev = process.argv[2];
if (!rev) {
	console.error("Usage: node scripts/review-log.ts <rev>");
	process.exit(2);
}
const repos = reposFor(process.cwd(), rev);
if (repos.length === 0) {
	console.error(`${rev} is not a commit in this folder's repositories. Run it from inside the repository, e.g. \`cd <repo> && …\``);
	process.exit(1);
}
// Records are keyed by the repository, so any folder or worktree of it finds them.
const root = process.env.ENG_KIT_REVIEWS_ROOT || undefined;
let sha: string | undefined;
const seen = new Set<string>();
const reports: ReturnType<typeof readReports> = [];
for (const repo of repos) {
	const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { encoding: "utf8", cwd: repo });
	if (r.status !== 0) continue;
	sha ??= r.stdout.trim();
	for (const report of readReports(repo, r.stdout.trim(), root)) {
		// The same commit in several repositories carries identical records: print them once.
		const key = JSON.stringify(report);
		if (!seen.has(key)) {
			seen.add(key);
			reports.push(report);
		}
	}
}
if (!sha) {
	console.error(`${rev} is not a commit in this repository`);
	process.exit(1);
}
if (reports.length === 0) {
	console.error(`no recorded review for ${sha.slice(0, 7)}`);
	process.exit(1);
}
for (const { run, verdict, report } of reports) process.stdout.write(`## Reviewer run ${run} — ${verdict}\n\n${report}\n\n`);
