import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVerifyCommands } from "./commands.ts";

export interface InitItem {
	/** Path relative to the project root. */
	target: string;
	/** `missing` = not created by /kit-init (AGENTS.md is written by /onboard from the code). */
	status: "exists" | "create" | "merge" | "missing";
	/** Full file content to write for `create` / `merge`. */
	content?: string;
	why: string;
}

const SUBAGENTS = "npm:pi-subagents";
const templatesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Everything /kit-init would do in `cwd`. Existing files are only ever merged (settings) or left alone. */
export function planInit(cwd: string): InitItem[] {
	const has = (rel: string) => existsSync(join(cwd, rel));
	const items: InitItem[] = [];

	if (has(".pi/verify.json")) items.push({ target: ".pi/verify.json", status: "exists", why: "verification commands" });
	else {
		const commands = detectVerifyCommands(cwd);
		items.push({
			target: ".pi/verify.json",
			status: "create",
			content: json({ commands, timeoutSec: 600 }),
			why:
				commands.length > 0
					? `verification commands: ${commands.join(", ")}`
					: "no test/typecheck/build commands detected; fill in the commands before relying on the verify gate",
		});
	}

	items.push(
		has(".pi/guard.json")
			? { target: ".pi/guard.json", status: "exists", why: "project guard rules" }
			: {
					target: ".pi/guard.json",
					status: "create",
					content: json({ block: [], confirm: [], allow: [], protectedPaths: [] }),
					why: "empty project guard rules to extend (the built-in rules always apply)",
				},
	);

	items.push(
		has(".pi/model-routing.json")
			? { target: ".pi/model-routing.json", status: "exists", why: "model routing" }
			: {
					target: ".pi/model-routing.json",
					status: "create",
					content: readFileSync(join(templatesDir, "model-routing.json"), "utf8"),
					why: "per-command models (deep/fast/cheap); check the IDs with `pi --list-models`",
				},
	);

	items.push(planSettings(cwd));

	items.push(
		has("AGENTS.md")
			? { target: "AGENTS.md", status: "exists", why: "project instructions" }
			: { target: "AGENTS.md", status: "missing", why: "run /onboard: the agent writes it from the code and proven commands" },
	);
	return items;
}

function planSettings(cwd: string): InitItem {
	const target = ".pi/settings.json";
	const why = `add ${SUBAGENTS} (reviews, parallel scouting, per-task subagents)`;
	const file = join(cwd, target);
	if (!existsSync(file)) return { target, status: "create", content: json({ packages: [SUBAGENTS] }), why };

	let settings: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
		settings = parsed as Record<string, unknown>;
	} catch {
		return { target, status: "exists", why: "settings.json is not valid JSON; left untouched" };
	}
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const present = packages.some((p) => (typeof p === "string" ? p : (p as { source?: unknown })?.source) === SUBAGENTS);
	if (present) return { target, status: "exists", why: `${SUBAGENTS} already configured` };
	return { target, status: "merge", content: json({ ...settings, packages: [...packages, SUBAGENTS] }), why };
}

/** Best guess at the project's verification commands, fastest first. */
export function detectVerifyCommands(cwd: string): string[] {
	const fromAgents = resolveVerifyCommands(cwd);
	if (fromAgents.source === "AGENTS.md" && fromAgents.commands.length > 0) return fromAgents.commands;

	const has = (rel: string) => existsSync(join(cwd, rel));
	if (has("package.json")) {
		let scripts: Record<string, string> = {};
		try {
			scripts = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {};
		} catch {
			// unreadable package.json: fall through to other tools
		}
		const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
		const commands: string[] = [];
		for (const name of ["typecheck", "type-check", "lint", "test", "build"]) {
			const body = scripts[name];
			if (!body || /no test specified/.test(body)) continue;
			commands.push(name === "test" && pm !== "bun" ? `${pm} test` : `${pm} run ${name}`);
		}
		if (commands.length > 0) return commands;
	}
	if (has("gradlew")) return ["./gradlew check"];
	if (has("Cargo.toml")) return ["cargo test"];
	if (has("go.mod")) return ["go vet ./...", "go test ./..."];
	if (safeList(cwd).some((f) => f.endsWith(".sln") || f.endsWith(".csproj"))) return ["dotnet test"];
	if (has("pyproject.toml") || has("pytest.ini")) return ["pytest"];
	if (has("Makefile") && /^test:/m.test(readFileSync(join(cwd, "Makefile"), "utf8"))) return ["make test"];
	return [];
}

function safeList(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
