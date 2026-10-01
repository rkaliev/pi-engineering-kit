/**
 * /kit-init: set a project up for this kit without copying templates by hand.
 *
 * Creates the missing `.pi/verify.json` (commands detected from AGENTS.md, package scripts or
 * build tools), `.pi/guard.json`, `.pi/model-routing.json`, and adds pi-subagents to
 * `.pi/settings.json`. Never overwrites an existing file. AGENTS.md is left to /onboard, which
 * writes it from the code; /kit-init offers to start it.
 *
 * `/kit-init` asks per file; `/kit-init --yes` creates everything missing without asking.
 * `--test-hygiene` also offers the stack-independent test-hygiene script for CI (`.ci/test-hygiene.mts`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { planInit, type InitItem } from "./lib/init.ts";

export default function initExtension(pi: ExtensionAPI) {
	pi.registerCommand("kit-init", {
		description: "Set this project up for pi-engineering-kit (.pi/verify.json, guard, model routing, subagents)",
		getArgumentCompletions: (prefix) => {
			// pi replaces the whole argument text: complete the last word and keep the earlier ones.
			const words = prefix.split(/\s+/);
			const last = words.pop() ?? "";
			const head = words.length > 0 ? `${words.join(" ")} ` : "";
			const options = [
				{ value: "--yes", description: "create all missing files without asking" },
				{ value: "--test-hygiene", description: "also offer the test-hygiene script for CI" },
			].filter((o) => o.value.startsWith(last) && !words.includes(o.value));
			return options.length > 0 ? options.map((o) => ({ value: `${head}${o.value}`, label: o.value, description: o.description })) : null;
		},
		handler: async (args, ctx) => {
			const words = args.split(/\s+/);
			const yes = words.includes("--yes");
			const plan = planInit(ctx.cwd, { copyHygiene: words.includes("--test-hygiene") });
			const pending = plan.filter((i) => i.status === "create" || i.status === "merge");

			if (!yes && !ctx.hasUI) {
				report(ctx, plan, [], "Nothing written (no UI to confirm). Re-run as `/kit-init --yes` to create the missing files.");
				return;
			}

			const written: InitItem[] = [];
			for (const item of pending) {
				const verb = item.status === "merge" ? "Update" : "Create";
				if (!yes && !(await ctx.ui.confirm(`kit-init: ${verb} ${item.target}?`, item.why))) continue;
				const file = join(ctx.cwd, item.target);
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, item.content!);
				written.push(item);
			}

			const needsOnboard = plan.some((i) => i.target === "AGENTS.md" && i.status === "missing");
			report(ctx, plan, written, needsOnboard ? "AGENTS.md is missing: run /onboard to write it from the code." : undefined);

			if (needsOnboard && !yes && ctx.hasUI) {
				const go = await ctx.ui.confirm("kit-init: run /onboard now?", "The agent maps the repo, proves the commands and proposes AGENTS.md.");
				if (go) pi.sendUserMessage("/onboard", { expandPromptTemplates: true });
			}
		},
	});

	function report(ctx: ExtensionCommandContext, plan: InitItem[], written: InitItem[], note?: string) {
		const mark = (i: InitItem) =>
			written.includes(i) ? (i.status === "merge" ? "updated" : "created") : i.status === "exists" ? "exists " : i.status === "missing" ? "missing" : "skipped";
		const lines = plan.map((i) => `  ${mark(i)}  ${i.target} (${i.why})`);
		const text = [`kit-init in ${ctx.cwd}:`, ...lines, ...(note ? ["", note] : [])].join("\n");
		if (ctx.hasUI) ctx.ui.notify(text, "info");
		else pi.sendMessage({ customType: "kit-init", display: true, content: text });
	}
}
