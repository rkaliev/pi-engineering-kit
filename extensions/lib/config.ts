import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read `<cwd>/.pi/<name>.json`. Returns `{}` when the file is missing and
 * `{ error }` when it exists but is not valid JSON, so callers can tell the user.
 */
export function readProjectJson<T extends object>(cwd: string, name: string): Partial<T> & { error?: string } {
	return readJsonFile<T>(join(cwd, ".pi", `${name}.json`));
}

/** Same contract as readProjectJson, for an absolute path. */
export function readJsonFile<T extends object>(file: string): Partial<T> & { error?: string } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return {};
	}
	try {
		const value: unknown = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Partial<T>;
		return { error: `${file} must contain a JSON object` } as Partial<T> & { error: string };
	} catch (err) {
		return { error: `${file}: ${(err as Error).message}` } as Partial<T> & { error: string };
	}
}
