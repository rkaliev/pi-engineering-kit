import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changelogSection, checkRelease } from "../.github/release.ts";

const CHANGELOG = "# Changelog\n\n## 0.2.0\n\n- Newest.\n\n## 0.1.0-rc\n\n- Candidate.\n\n## 0.1.0\n\n- First.\n  - Nested.\n\n## 0.0.9\n\n";

test("changelogSection returns the body of exactly that version", () => {
	assert.equal(changelogSection(CHANGELOG, "0.2.0"), "- Newest.");
	assert.equal(changelogSection(CHANGELOG, "0.1.0"), "- First.\n  - Nested.", "not 0.1.0-rc, and nested lines are kept");
	assert.equal(changelogSection(CHANGELOG, "0.1.0-rc"), "- Candidate.");
	assert.throws(() => changelogSection(CHANGELOG, "0.1.00"), /no "## 0\.1\.00" section/);
	assert.throws(() => changelogSection(CHANGELOG, "0.0.9"), /"## 0\.0\.9" section is empty/, "the last section, empty");
	assert.throws(() => changelogSection(CHANGELOG, "1.0.0"), /no "## 1\.0\.0" section/);
});

function repo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "release-"));
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

test("checkRelease: the package version has notes, and the plugin manifest agrees", () => {
	const pkg = (v: string) => JSON.stringify({ version: v });
	assert.equal(checkRelease(repo({ "package.json": pkg("0.2.0"), "CHANGELOG.md": CHANGELOG })), "0.2.0");
	assert.throws(() => checkRelease(repo({ "package.json": pkg("0.3.0"), "CHANGELOG.md": CHANGELOG })), /no "## 0\.3\.0" section/);
	const plugin = (v: string) => JSON.stringify({ name: "x", version: v });
	assert.equal(checkRelease(repo({ "package.json": pkg("0.2.0"), "CHANGELOG.md": CHANGELOG, ".claude-plugin/plugin.json": plugin("0.2.0") })), "0.2.0");
	assert.throws(
		() => checkRelease(repo({ "package.json": pkg("0.2.0"), "CHANGELOG.md": CHANGELOG, ".claude-plugin/plugin.json": plugin("0.1.0") })),
		/\.claude-plugin\/plugin\.json has version 0\.1\.0, package\.json has 0\.2\.0/,
	);
});

test("checkRelease: install commands in README and docs pin the package version", () => {
	const files = (pin: string) => ({
		"package.json": JSON.stringify({ name: "kit", version: "0.2.0" }),
		"CHANGELOG.md": CHANGELOG,
		"README.md": `pi install git:github.com/me/kit@v${pin}\nuses actions/checkout@v4 and other-kit@v9.9.9\n`,
		"docs/GUIDE.md": "pi install -l git:github.com/me/kit@v0.2.0\n",
	});
	assert.equal(checkRelease(repo(files("0.2.0"))), "0.2.0");
	assert.throws(() => checkRelease(repo(files("0.1.0"))), /README\.md pins kit@v0\.1\.0, package\.json has 0\.2\.0/);
	assert.throws(
		() => checkRelease(repo({ ...files("0.2.0"), "docs/GUIDE.md": "pi install git:github.com/me/kit@v0.0.1" })),
		/docs\/GUIDE\.md pins kit@v0\.0\.1, package\.json has 0\.2\.0/,
	);
	assert.throws(
		() => checkRelease(repo({ ...files("0.2.0"), "templates/settings.json": '{ "packages": ["git:github.com/me/kit@v0.0.1"] }' })),
		/templates\/settings\.json pins kit@v0\.0\.1/,
	);
	const prose = { ...files("0.2.0"), "docs/GUIDE.md": "Install git:github.com/me/kit@v0.2.0. Upgrading from kit@v0.1.0 needs nothing.\n" };
	assert.equal(checkRelease(repo(prose)), "0.2.0", "a sentence's full stop is not part of the version, and prose mentions are not pins");
});
