/**
 * Print the round number since the last Yes and the reviewer reports recorded for a commit (its latest round of
 * reviews), so a repeat round re-checks the open findings from the store instead of the author's summary of them.
 * Exits 1 when no review of that commit is recorded.
 *
 *   node <kit>/scripts/review-log.ts <rev>
 */
import { spawnSync } from "node:child_process";
import { highestFindingIds, readReports, reviewChain, roundNumber } from "../extensions/lib/reviews.ts";

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
const root = process.env.ENG_KIT_REVIEWS_ROOT || undefined;
const reports = readReports(process.cwd(), sha, root);
if (reports.length === 0) {
	console.error(`no recorded review for ${sha.slice(0, 7)}`);
	process.exit(1);
}
// The round number is counted from the last Yes, which closes a converged scope: receiving-code-review stops the
// author when rounds don't converge. A failed run has no range, so the chain ends at it.
const chain = reviewChain(process.cwd(), sha, root);
const earlier = chain.map((r) => `${r.base ? `${r.base.slice(0, 7)}..` : ""}${r.sha.slice(0, 7)} ${r.verdict}`).join(", ");
const ids = Object.entries(highestFindingIds(process.cwd(), chain, root)).map(([prefix, n]) => `${prefix}${n}`).join(", ");
process.stdout.write(`Round ${roundNumber(chain)} since the last Yes (the stop rule counts these). Earlier rounds, newest first: ${earlier}.\n`);
process.stdout.write(`Highest finding IDs so far: ${ids || "none"}; a new finding takes the next number.\n\n`);
for (const { run, verdict, report } of reports) process.stdout.write(`## Reviewer run ${run} — ${verdict}\n\n${report}\n\n`);
