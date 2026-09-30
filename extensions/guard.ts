/**
 * Guard: blocks irreversible or secret-leaking tool calls and task files reaching the base
 * branch, and asks the human before outward-facing ones. Tightening rules from `.pi/guard.json`
 * always apply; `allow` and `workDocs` (which relax the defaults) apply only in trusted projects.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readProjectJson } from "./lib/config.ts";
import { checkCommand, checkPath, type GuardConfig, type GuardDecision } from "./lib/patterns.ts";
import { checkWorkDocs, WORK_DOC_DIRS } from "./lib/workdocs.ts";

export default function guardExtension(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const config = loadConfig(ctx);
		const input = event.input as Record<string, unknown>;
		let decision: GuardDecision;
		let subject: string;

		if (event.toolName === "bash" || event.toolName === "powershell") {
			subject = String(input.command ?? "");
			decision = checkCommand(subject, ctx.cwd, config);
			if (decision.action !== "block") decision = checkWorkDocs(subject, ctx.cwd, config.workDocs ?? WORK_DOC_DIRS) ?? decision;
		} else if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") {
			subject = String(input.path ?? "");
			decision = checkPath(event.toolName, subject, ctx.cwd, config);
		} else {
			return undefined;
		}

		if (decision.action === "allow") return undefined;
		if (decision.action === "block") return { block: true, reason: `Guard: ${decision.reason}` };

		if (!ctx.hasUI) {
			return { block: true, reason: `Guard: ${decision.reason} Needs human confirmation, which is unavailable in this mode.` };
		}
		const ok = await ctx.ui.confirm("Guard: confirm action", `${decision.reason}\n\n${event.toolName}: ${subject}`);
		return ok ? undefined : { block: true, reason: `Guard: the user declined. ${decision.reason} Ask how to proceed.` };
	});
}

function loadConfig(ctx: ExtensionContext): GuardConfig {
	const raw = readProjectJson<GuardConfig>(ctx.cwd, "guard");
	if (raw.error && ctx.hasUI) ctx.ui.notify(`Guard config ignored: ${raw.error}`, "warning");
	const trusted = ctx.isProjectTrusted();
	const regexes = (value: unknown) =>
		strings(value).filter((source) => {
			try {
				new RegExp(source);
				return true;
			} catch {
				if (ctx.hasUI) ctx.ui.notify(`Guard: invalid regex ignored in .pi/guard.json: ${source}`, "warning");
				return false;
			}
		});
	return {
		block: regexes(raw.block),
		confirm: regexes(raw.confirm),
		protectedPaths: strings(raw.protectedPaths),
		allow: trusted ? regexes(raw.allow) : [],
		workDocs: trusted && Array.isArray(raw.workDocs) ? strings(raw.workDocs) : undefined,
	};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
