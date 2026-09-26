/**
 * Model routing: kit commands pick their own model and thinking level.
 *
 * `/review` → strongest model, `/implement` → mid-tier, and so on, configured in
 * `~/.pi/agent/model-routing.json` (global) and `.pi/model-routing.json` (project, trusted
 * projects only; it could otherwise route you to an unexpected paid model). Plain messages keep
 * the current model; follow-ups sent by extensions (the verify gate) never switch it.
 * `/mode <name>` switches manually.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readJsonFile, readProjectJson } from "./lib/config.ts";
import { EMPTY_ROUTING, mergeRouting, parseRouting, pickModel, routeFor, type Routing } from "./lib/routing.ts";

export default function modelsExtension(pi: ExtensionAPI) {
	let cached: Routing = EMPTY_ROUTING;
	const reported = new Set<string>();

	function load(ctx: ExtensionContext): Routing {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		const sources: Array<[string, Record<string, unknown>]> = [[join(agentDir, "model-routing.json"), readJsonFile(join(agentDir, "model-routing.json"))]];
		if (ctx.isProjectTrusted()) sources.push([".pi/model-routing.json", readProjectJson(ctx.cwd, "model-routing")]);

		let routing = EMPTY_ROUTING;
		for (const [file, raw] of sources) {
			if (Object.keys(raw).length === 0) continue; // absent
			const problems = raw.error ? [String(raw.error)] : [];
			const parsed = raw.error ? { routing: EMPTY_ROUTING, errors: [] } : parseRouting(raw);
			for (const problem of [...problems, ...parsed.errors.map((e) => `${file}: ${e}`)]) {
				if (!reported.has(problem) && ctx.hasUI) ctx.ui.notify(`Model routing: ${problem}`, "warning");
				reported.add(problem);
			}
			routing = mergeRouting(routing, parsed.routing);
		}
		cached = routing;
		return routing;
	}

	async function apply(modeName: string, routing: Routing, ctx: ExtensionContext): Promise<boolean> {
		const mode = routing.modes[modeName]!;
		// Compare by key: getAvailable() returns fresh objects, not the ones find() returns.
		const available = new Set(ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`));
		const model = pickModel(mode.models, (p, id) => ctx.modelRegistry.find(p, id), (m) => available.has(`${m.provider}/${m.id}`));
		if (!model) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Model routing: no available model for mode "${modeName}" (${mode.models.join(", ")}); keeping the current one.`, "warning");
			}
			return false;
		}
		const ok = await pi.setModel(model);
		if (ok && mode.thinking) pi.setThinkingLevel(mode.thinking);
		if (ctx.hasUI) {
			ctx.ui.notify(ok ? `Model → ${model.provider}/${model.id}${mode.thinking ? ` (${mode.thinking})` : ""} · mode ${modeName}` : `Model routing: could not switch to ${model.provider}/${model.id}`, ok ? "info" : "warning");
		}
		return ok;
	}

	pi.on("session_start", async (_event, ctx) => {
		load(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		const routing = load(ctx);
		const modeName = routeFor(event.text, routing);
		if (modeName) await apply(modeName, routing, ctx);
		return { action: "continue" as const };
	});

	pi.registerCommand("mode", {
		description: "Switch model mode (see model-routing.json), or list modes and routes",
		getArgumentCompletions: (prefix) =>
			Object.keys(cached.modes)
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name, description: cached.modes[name]!.models.join(", ") })),
		handler: async (args, ctx) => {
			const routing = load(ctx);
			const name = args.trim();
			if (!name) {
				const modes = Object.entries(routing.modes).map(([n, m]) => `  ${n}: ${m.models.join(" | ")}${m.thinking ? ` · ${m.thinking}` : ""}`);
				const routes = Object.entries(routing.commands).map(([c, m]) => `  /${c} → ${m}`);
				const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
				const text =
					modes.length > 0
						? `Current model: ${current}\nModes:\n${modes.join("\n")}\nRoutes:\n${routes.join("\n") || "  (none)"}`
						: "No model routing configured. Copy templates/model-routing.json to ~/.pi/agent/ or .pi/.";
				if (ctx.hasUI) ctx.ui.notify(text, "info");
				return;
			}
			if (!routing.modes[name]) {
				if (ctx.hasUI) ctx.ui.notify(`Model routing: unknown mode "${name}". Known: ${Object.keys(routing.modes).join(", ") || "none"}`, "warning");
				return;
			}
			await apply(name, routing, ctx);
		},
	});
}
