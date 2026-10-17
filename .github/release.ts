/**
 * Release notes for CI. `check` fails a PR whose package.json version has no CHANGELOG section, whose
 * .claude-plugin/plugin.json disagrees with it, or whose README or docs pin another version of the package
 * (`<name>@vX.Y.Z` in an install command); `notes <version>` prints that section for the GitHub Release.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The body under `## <version>`, up to the next `## ` heading. */
export function changelogSection(changelog: string, version: string): string {
	const lines = changelog.split("\n");
	const start = lines.findIndex((line) => line.trimEnd() === `## ${version}`);
	if (start === -1) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => line.startsWith("## "));
	const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
	if (!body) throw new Error(`CHANGELOG.md: the "## ${version}" section is empty`);
	return body;
}

/** Checks the release metadata in `dir` and returns the version. */
export function checkRelease(dir: string): string {
	const version = readVersion(join(dir, "package.json"));
	changelogSection(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), version);
	const plugin = join(dir, ".claude-plugin/plugin.json");
	if (existsSync(plugin)) {
		const pluginVersion = readVersion(plugin);
		if (pluginVersion !== version) throw new Error(`.claude-plugin/plugin.json has version ${pluginVersion}, package.json has ${version}`);
	}
	const name = String((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name);
	const pin = new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@v(\\d+\\.\\d+\\.\\d+[\\w.-]*)`, "g");
	const docs = existsSync(join(dir, "docs")) ? readdirSync(join(dir, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`) : [];
	for (const file of ["README.md", ...docs].filter((f) => existsSync(join(dir, f)))) {
		for (const m of readFileSync(join(dir, file), "utf8").matchAll(pin)) {
			if (m[1] !== version) throw new Error(`${file} pins ${name}@v${m[1]}, package.json has ${version}`);
		}
	}
	return version;
}

function readVersion(path: string): string {
	return String((JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, version] = process.argv.slice(2);
	const root = resolve(import.meta.dirname, "..");
	try {
		if (command === "check") console.log(`release metadata ok: ${checkRelease(root)}`);
		else if (command === "notes" && version) console.log(changelogSection(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version));
		else throw new Error("usage: node .github/release.ts check | notes <version>");
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
}
