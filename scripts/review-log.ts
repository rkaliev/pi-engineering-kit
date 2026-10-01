/**
 * Print the reviewer reports recorded for a commit (its latest round of reviews), so a repeat round
 * re-checks the open findings from the store instead of the author's summary of them.
 * Exits 1 when no review of that commit is recorded.
 *
 *   node <kit>/scripts/review-log.ts <rev>
 */
import { spawnSync } from "node:child_process";
import { readReports } from "../extensions/lib/reviews.ts";

const rev = process.argv[2];
if (!rev) {
	console.error("Usage: node scripts/review-log.ts <rev>");
	process.exit(2);
}
const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { encoding: "utf8" });
const sha = r.status === 0 ? r.stdout.trim() : undefined;
if (!sha) {
	console.error(`${rev} is not a commit in this repository`);
	process.exit(1);
}
// Records are keyed by the repository, so any folder or worktree of it finds them.
const reports = readReports(process.cwd(), sha, process.env.ENG_KIT_REVIEWS_ROOT || undefined);
if (reports.length === 0) {
	console.error(`no recorded review for ${sha.slice(0, 7)}`);
	process.exit(1);
}
for (const { run, verdict, report } of reports) process.stdout.write(`## Reviewer run ${run} — ${verdict}\n\n${report}\n\n`);
