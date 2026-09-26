export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export interface Mode {
	/** `provider/modelId` candidates, first available wins. */
	models: string[];
	thinking?: Thinking;
}

export interface Routing {
	modes: Record<string, Mode>;
	/** Command name (`review`, `skill:security-review`) → mode name. */
	commands: Record<string, string>;
}

export const EMPTY_ROUTING: Routing = { modes: {}, commands: {} };

/** Validate a raw `model-routing.json` object. Bad entries are dropped and reported, never thrown. */
export function parseRouting(raw: unknown): { routing: Routing; errors: string[] } {
	const errors: string[] = [];
	const routing: Routing = { modes: {}, commands: {} };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { routing, errors: ["model routing must be a JSON object with `modes` and `commands`"] };
	}
	const { modes, commands } = raw as { modes?: unknown; commands?: unknown };

	for (const [name, value] of Object.entries(isObject(modes) ? modes : {})) {
		const v = isObject(value) ? value : {};
		const list = typeof v.model === "string" ? [v.model] : Array.isArray(v.model) ? v.model : [];
		const models = list.filter((m): m is string => typeof m === "string" && /^[^/\s]+\/\S+$/.test(m));
		if (models.length === 0) {
			errors.push(`mode "${name}": "model" must be "provider/id" or a list of them`);
			continue;
		}
		let thinking: Thinking | undefined;
		if (v.thinking !== undefined) {
			if ((THINKING_LEVELS as readonly unknown[]).includes(v.thinking)) thinking = v.thinking as Thinking;
			else errors.push(`mode "${name}": unknown thinking level "${String(v.thinking)}" (use ${THINKING_LEVELS.join(", ")})`);
		}
		routing.modes[name] = { models, thinking };
	}
	for (const [command, mode] of Object.entries(isObject(commands) ? commands : {})) {
		if (typeof mode === "string" && routing.modes[mode]) routing.commands[command] = mode;
		else errors.push(`command "${command}": unknown mode "${String(mode)}"`);
	}
	return { routing, errors };
}

/** Project entries override global ones key by key. */
export function mergeRouting(global: Routing, project: Routing): Routing {
	return { modes: { ...global.modes, ...project.modes }, commands: { ...global.commands, ...project.commands } };
}

/** Mode for a user input that starts with a routed `/command` (including `/skill:name`). */
export function routeFor(text: string, routing: Routing): string | undefined {
	const match = /^\s*\/(\S+)/.exec(text);
	return match ? routing.commands[match[1]!] : undefined;
}

/** First candidate the registry knows and the user can actually use. */
export function pickModel<M>(
	candidates: string[],
	find: (provider: string, id: string) => M | undefined,
	available: (model: M) => boolean,
): M | undefined {
	for (const candidate of candidates) {
		const slash = candidate.indexOf("/");
		const model = find(candidate.slice(0, slash), candidate.slice(slash + 1));
		if (model && available(model)) return model;
	}
	return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
