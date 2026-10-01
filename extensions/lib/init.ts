import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ciCoverage } from "./ci.ts";
import { readProjectJson } from "./config.ts";
import { DEFAULT_IGNORE, resolveVerifyCommands } from "./commands.ts";

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
/** The kit's test-hygiene script, copied into a project only on request. */
const hygieneScript = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "test-hygiene.ts");

/** Where /kit-init puts the test-hygiene script in a project; CI templates run it from here. */
export const HYGIENE_TARGET = ".ci/test-hygiene.mts";
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Everything /kit-init would do in `cwd`. Existing files are only ever merged (settings), replaced on request (an older test-hygiene copy), or left alone. */
export function planInit(cwd: string, options: { copyHygiene?: boolean } = {}): InitItem[] {
	const has = (rel: string) => existsSync(join(cwd, rel));
	const items: InitItem[] = [];

	if (has(".pi/verify.json")) items.push({ target: ".pi/verify.json", status: "exists", why: "verification commands" });
	else {
		const commands = detectVerifyCommands(cwd);
		items.push({
			target: ".pi/verify.json",
			status: "create",
			content: json({ commands, timeoutSec: 600, ignore: DEFAULT_IGNORE }),
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
	const hygiene = planHygiene(cwd, readFileSync(hygieneScript, "utf8"), options.copyHygiene === true, "/kit-init --test-hygiene");
	items.push(hygiene);
	// Report the CI gap in the same run that adds the script.
	items.push(planCi(cwd, "/skill:ci-quality-gates", existsSync(join(cwd, HYGIENE_TARGET)) || hygiene.status === "create"));

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

/** The test-hygiene script: offered, copied (or an older copy replaced) only on request, and reported when the project's copy is older. */
export function planHygiene(cwd: string, script: string, copy: boolean, flag: string): InitItem {
	const version = (text: string) => Number(/export const VERSION = "(\d+)"/.exec(text)?.[1] ?? 0);
	const ours = version(script);
	const file = join(cwd, HYGIENE_TARGET);
	const create = (why: string): InitItem => ({ target: HYGIENE_TARGET, status: existsSync(file) ? "merge" : "create", content: script, why });
	if (existsSync(file)) {
		const theirs = version(readFileSync(file, "utf8"));
		if (theirs >= ours) return { target: HYGIENE_TARGET, status: "exists", why: `test-hygiene v${theirs}` };
		if (copy) return create(`replace test-hygiene v${theirs} with the kit's v${ours}`);
		return { target: HYGIENE_TARGET, status: "missing", why: `test-hygiene v${theirs} is older than the kit's v${ours}; replace it by re-running with ${flag} after the user agrees` };
	}
	if (!copy) return { target: HYGIENE_TARGET, status: "missing", why: `optional: the stack-independent test-hygiene check for CI (ci-quality-gates); add it by re-running with ${flag} after the user agrees` };
	return create("test-hygiene check for CI: focused tests, skips without a linked issue, sleeps, retries, test counts");
}

/** CI is the second line of defence: it must run at least the verification commands. Reported, never written here. */
function planCi(cwd: string, hint: string, hasHygiene: boolean): InitItem {
	const configured = resolveVerifyCommands(cwd).commands;
	const commands = configured.length > 0 ? configured : detectVerifyCommands(cwd);
	const { files, missing, workDocsCheck, hygieneCheck } = ciCoverage(cwd, commands);
	if (files.length === 0) return { target: "CI", status: "missing", why: `no CI configuration found; run ${hint} to set up checks that don't depend on an agent session` };
	const guard = readProjectJson<{ workDocs: string[] }>(cwd, "guard");
	const wantsDocsCheck = !(Array.isArray(guard.workDocs) && guard.workDocs.length === 0);
	const gaps = [
		...(missing.length > 0 ? [`doesn't run: ${missing.join(", ")}`] : []),
		...(wantsDocsCheck && !workDocsCheck ? ["has no working-docs check (task files must not reach the base branch)"] : []),
		...(hasHygiene && !hygieneCheck ? [`doesn't run ${HYGIENE_TARGET}`] : []),
	];
	if (gaps.length > 0) return { target: "CI", status: "missing", why: `${files.join(", ")} ${gaps.join("; ")}; run ${hint}` };
	return { target: "CI", status: "exists", why: `${files.join(", ")} runs every verification command${wantsDocsCheck ? " and the working-docs check" : ""}` };
}
