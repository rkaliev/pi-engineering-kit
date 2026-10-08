/**
 * Print the tokens a branch used: the main session and each subagent type, from the eng-kit ledger.
 *
 *   node <kit>/scripts/usage-log.ts [branch]
 *
 * Without a branch, the current one. The ledger is filled by the kit's hooks from the moment it is installed.
 */
import { branchSummary, summaryLine } from "../extensions/lib/usage.ts";
import { currentBranch } from "../extensions/lib/workdocs.ts";

const branch = process.argv[2] ?? currentBranch(process.cwd());
if (!branch) {
	console.error("Not on a branch: name one, as in `node scripts/usage-log.ts feat/x`.");
	process.exit(2);
}
console.log(`Tokens on ${branch}: ${summaryLine(branchSummary(process.cwd(), branch, process.env.ENG_KIT_USAGE_ROOT || undefined))}`);
