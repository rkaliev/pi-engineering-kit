/**
 * Bootstrap: loads the using-skills skill into every session so the other skills actually fire.
 *
 * Injected as a *user* message from the `context` event, placed after compaction summaries and
 * deduplicated by a marker. It is injected on every request: `context` edits are not persisted,
 * so injecting once would drop the rules from every later prompt. The message sits at a stable
 * position, so it stays inside the provider's prompt cache.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BOOTSTRAP_MARKER = "pi-engineering-kit:using-skills bootstrap";

const skillPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills", "using-skills", "SKILL.md");
let cached: string | null | undefined;

export default function bootstrapExtension(pi: ExtensionAPI) {
	pi.on("context", async (event) => {
		if (event.messages.some(containsMarker)) return undefined;
		const text = bootstrapText();
		if (!text) return undefined;

		let at = 0;
		while ((event.messages[at] as { role?: unknown } | undefined)?.role === "compactionSummary") at++;
		// Reuse the next message's timestamp so the injected message is byte-stable across requests.
		const timestamp = (event.messages[at] as { timestamp?: number } | undefined)?.timestamp ?? Date.now();
		const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp };
		return { messages: [...event.messages.slice(0, at), message, ...event.messages.slice(at)] };
	});
}

function bootstrapText(): string | null {
	if (cached !== undefined) return cached;
	try {
		const raw = readFileSync(skillPath, "utf8");
		const body = (/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(raw)?.[1] ?? raw).trim();
		cached = `<EXTREMELY_IMPORTANT>
${BOOTSTRAP_MARKER}

The using-skills skill is already loaded below for this session. Follow it. Do not load it again.
Relative paths in skills resolve against that skill's directory (this one: ${dirname(skillPath)}).

${body}
</EXTREMELY_IMPORTANT>`;
	} catch {
		cached = null;
	}
	return cached;
}

function containsMarker(message: unknown): boolean {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.includes(BOOTSTRAP_MARKER);
	if (!Array.isArray(content)) return false;
	return content.some(
		(part) => part?.type === "text" && typeof part.text === "string" && (part.text as string).includes(BOOTSTRAP_MARKER),
	);
}
