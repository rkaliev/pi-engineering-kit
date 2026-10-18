import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chapterAnchor, checkTools, extractChangelog, parseIndex, rewriteLinks } from "../skills/publishing-documents/scripts/publish.ts";

test("parseIndex keeps the index order and only chapter links", () => {
	const readme = [
		"# Docs",
		"",
		"| Chapter | What |",
		"|---|---|",
		"| [02](02-flow.md) | flow |",
		"| [01](./01-setup.md) | setup |",
		"",
		"Decisions: [d](decisions/README.md). External: [x](https://e.com/03-x.md). Again: [02 again](02-flow.md).",
	].join("\n");
	assert.deepEqual(parseIndex(readme), ["02-flow.md", "01-setup.md"]);
});

test("extractChangelog returns one version's section", () => {
	const plain = "# Changelog\n\n## 0.2.0\n\n- b\n\n## 0.1.0\n\n- a\n";
	assert.equal(extractChangelog(plain, "0.2.0"), "- b");
	assert.equal(extractChangelog(plain, "0.1.0"), "- a");
	const kac = "# Changelog\r\n\r\n## [1.2.0] - 2026-10-01\r\n\r\n### Added\r\n\r\n- c\r\n\r\n## [1.1.0] - 2026-09-01\r\n\r\n- d\r\n";
	assert.equal(extractChangelog(kac, "1.2.0"), "### Added\n\n- c");
	assert.equal(extractChangelog(plain, "9.9.9"), null);
	assert.equal(extractChangelog(plain, "0.2"), null);
});

test("chapterAnchor is stable and ASCII-safe", () => {
	assert.equal(chapterAnchor("02-flow.md"), "ch-02-flow");
	const ru = chapterAnchor("01-обзор.md");
	assert.match(ru, /^ch-01-[0-9a-f]{8}$/);
	assert.equal(chapterAnchor("01-обзор.md"), ru);
	assert.notEqual(chapterAnchor("01-архитектура.md"), ru);
});

const repo = "/r";
const from = "/r/docs/01-setup.md";
const chapters = new Map([["/r/docs/01-setup.md", "ch-01-setup"], ["/r/docs/02-flow.md", "ch-02-flow"]]);

test("rewriteLinks: a link to another chapter becomes its anchor, without the fragment", () => {
	const { text, outside } = rewriteLinks("See [f](02-flow.md) and [o](02-flow.md#overview).", { from, chapters, repoDir: repo });
	assert.equal(text, "See [f](#ch-02-flow) and [o](#ch-02-flow).");
	assert.deepEqual(outside, []);
});

test("rewriteLinks: a link into the repo outside the document is reported", () => {
	const md = "Code: [c](../src/a.ts).";
	const { text, outside } = rewriteLinks(md, { from, chapters, repoDir: repo });
	assert.equal(text, md);
	assert.deepEqual(outside, ["docs/01-setup.md: ../src/a.ts"]);
});

test("rewriteLinks: with repoUrl the link is rewritten and keeps its fragment", () => {
	const { text, outside } = rewriteLinks("[c](../src/a.ts#L3) [r](/README.md)", {
		from,
		chapters,
		repoDir: repo,
		repoUrl: "https://git.example/r/blob/main",
	});
	assert.equal(text, "[c](https://git.example/r/blob/main/src/a.ts#L3) [r](https://git.example/r/blob/main/README.md)");
	assert.deepEqual(outside, []);
});

test("rewriteLinks: external links, anchors, mailto and code are left alone", () => {
	const md = [
		"[e](https://e.com/x.md) [a](#top) [m](mailto:a@b.c) [p](//cdn.example/x)",
		"Inline `[i](../src/a.ts)` stays.",
		"```md",
		"[k](../src/b.ts)",
		"```",
	].join("\n");
	const r = rewriteLinks(md, { from, chapters, repoDir: repo });
	assert.equal(r.text, md);
	assert.deepEqual(r.outside, []);
	assert.deepEqual(r.images, []);
});

test("rewriteLinks: local images are collected and moved to assets/", () => {
	const md = "![x](<img/a b.png>) ![y](img/схема.png) ![w](https://e.com/w.png)";
	const r = rewriteLinks(md, { from, chapters, repoDir: repo });
	assert.equal(r.text, "![x](<assets/1-a b.png>) ![y](<assets/2-схема.png>) ![w](https://e.com/w.png)");
	assert.deepEqual(r.images, ["/r/docs/img/a b.png", "/r/docs/img/схема.png"]);
});

/** A fake command runner: `tools` maps a command to its `--version` output; absent means not installed. */
function fakeRun(tools: Record<string, string>, calls: string[] = []) {
	return (cmd: string) => {
		calls.push(cmd);
		return cmd in tools ? { status: 0, stdout: tools[cmd]! } : { status: null, stdout: "" };
	};
}
const allTools = { pandoc: "pandoc 3.8.3\nFeatures: +server\n", typst: "typst 0.15.1 (9dfd3a08)\n", mmdc: "11.4.0\n" };

test("checkTools: everything present gives no findings", () => {
	assert.deepEqual(checkTools({ mermaid: true }, fakeRun(allTools)), []);
});

test("checkTools: missing pandoc is named with how to install it", () => {
	const { pandoc: _, ...rest } = allTools;
	const findings = checkTools({ mermaid: false }, fakeRun(rest));
	assert.equal(findings.length, 1);
	assert.match(findings[0]!, /^pandoc not found: install pandoc 3\.8 or newer/);
});

test("checkTools: old pandoc is rejected", () => {
	assert.deepEqual(checkTools({ mermaid: false }, fakeRun({ ...allTools, pandoc: "pandoc 3.7.0\n" })), [
		"pandoc 3.7.0 is older than 3.8: upgrade it (https://pandoc.org/installing.html)",
	]);
});

test("checkTools: typst is required; mmdc only with diagrams", () => {
	const { typst: _, mmdc: __, ...onlyPandoc } = allTools;
	const calls: string[] = [];
	const findings = checkTools({ mermaid: false }, fakeRun(onlyPandoc, calls));
	assert.equal(findings.length, 1);
	assert.match(findings[0]!, /^typst not found/);
	assert.ok(!calls.includes("mmdc"));
	assert.match(checkTools({ mermaid: true }, fakeRun({ pandoc: allTools.pandoc, typst: allTools.typst })).join(), /^mmdc not found/);
});

// ---------------------------------------------------------------- the build (needs the real tools)

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/publishing-documents/scripts/publish.ts");
const KIT_THEME = resolve(dirname(SCRIPT), "../templates");
const NO_TOOLS = checkTools({ mermaid: true }).length > 0;
const SKIP = "mode: needs pandoc, typst and mmdc";
/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A throwaway project; `run` executes publish.ts in it. */
function project(files: Record<string, string | Buffer>) {
	const dir = mkdtempSync(join(tmpdir(), "publish-"));
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	const run = (...args: string[]) => {
		const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
		return { status: r.status, stdout: r.stdout, stderr: r.stderr };
	};
	const read = (name: string) => readFileSync(join(dir, name), "utf8");
	return { dir, run, read };
}

const GUIDE = "---\ntitle: Export service\nsubtitle: Integration guide\naudience: Partners\nversion: 1.2\n---\n\n# Overview\n\n| Field | Meaning |\n|---|---|\n| `report` | name |\n";
const DIAGRAM = "```mermaid\nsequenceDiagram\n    accTitle: Export request flow\n    A->>B: POST /exports\n```\n";

test("publish: builds HTML and PDF from one file", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project({ "docs/publish/guide.md": GUIDE });
	const r = p.run("docs/publish/guide.md", "--out", "out");
	assert.equal(r.status, 0, r.stderr);
	const out = JSON.parse(r.stdout) as { html: string; pdf: string };
	assert.equal(out.html, join(realpathSync(p.dir), "out/guide.html"));
	assert.ok(statSync(out.pdf).size > 1000);
	const html = readFileSync(out.html, "utf8");
	assert.match(html, /Export service/);
	assert.doesNotMatch(html, /(src|href)="(?!data:|#|https?:)[^"]+"/);
});

test("publish: --docs follows the index and links chapters inside the document", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project({
		"docs/README.md": "# Our service\n\n- [Flow](02-flow.md)\n- [Setup](01-setup.md)\n",
		"docs/01-setup.md": "# Setup\n\nThen read [the flow](02-flow.md#steps).\n",
		"docs/02-flow.md": "# Flow\n\n## Steps\n\nOne.\n",
	});
	const r = p.run("--docs", "--out", "out");
	assert.equal(r.status, 0, r.stderr);
	const html = p.read("out/documentation.html");
	assert.ok(html.indexOf('id="ch-02-flow"') > 0 && html.indexOf('id="ch-02-flow"') < html.indexOf('id="ch-01-setup"'));
	assert.match(html, /href="#ch-02-flow"/);
	assert.match(html, /<title>Our service<\/title>/);

	const empty = project({ "docs/README.md": "# Docs\n\nNothing yet.\n" });
	const e = empty.run("--docs", "--out", "out");
	assert.equal(e.status, 1);
	assert.match(e.stderr, /no chapters linked in docs\/README\.md/);
	assert.ok(!existsSync(join(empty.dir, "out")));
});

test("publish: --changelog builds one version and rejects an unknown one", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project({ "CHANGELOG.md": "# Changelog\n\n## 0.2.0\n\n- Exports retry\n\n## 0.1.0\n\n- First\n" });
	const r = p.run("--changelog", "0.2.0", "--out", "out");
	assert.equal(r.status, 0, r.stderr);
	const html = p.read("out/release-notes-0.2.0.html");
	assert.match(html, /Release notes 0\.2\.0/);
	assert.match(html, /Exports retry/);
	assert.doesNotMatch(html, /First/);
	const u = p.run("--changelog", "9.9.9", "--out", "out2");
	assert.equal(u.status, 1);
	assert.match(u.stderr, /version 9\.9\.9 not found in CHANGELOG\.md/);
});

test("publish: diagrams become SVG without a caption; a broken one fails", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project({
		"docs/publish/flow.md": `---\ntitle: Flow\n---\n\n# Flow\n\n${DIAGRAM}`,
		"docs/publish/broken.md": "---\ntitle: Broken\n---\n\n```mermaid\nsequenceDiagram\n    A->>: nothing\n    alt\n```\n",
	});
	const r = p.run("docs/publish/flow.md", "--out", "out");
	assert.equal(r.status, 0, r.stderr);
	const html = p.read("out/flow.html");
	assert.match(html, /data:image\/svg\+xml|<svg/);
	assert.match(html, /alt="Export request flow"/);
	assert.doesNotMatch(html, /Figure 1/);
	const b = p.run("docs/publish/broken.md", "--out", "out-broken");
	assert.equal(b.status, 1);
	assert.match(b.stderr, /diagram failed to render in docs\/publish\/broken\.md/);
	assert.ok(!existsSync(join(p.dir, "out-broken")));
});

test("publish: a link into the repo fails the build unless --repo-url", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project({ "docs/publish/api.md": "---\ntitle: API\n---\n\nSee [the handler](../../src/api.ts).\n", "src/api.ts": "" });
	const r = p.run("docs/publish/api.md", "--out", "out");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /docs\/publish\/api\.md: \.\.\/\.\.\/src\/api\.ts/);
	const ok = p.run("docs/publish/api.md", "--out", "out", "--repo-url", "https://git.example/r/blob/main");
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(p.read("out/api.html"), /href="https:\/\/git\.example\/r\/blob\/main\/src\/api\.ts"/);
});

test("publish: a relative image and a Cyrillic chapter name reach both outputs", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project({
		"docs/README.md": "# Сервис\n\n- [Обзор](01-обзор.md)\n",
		"docs/01-обзор.md": "# Обзор\n\n![Схема](img/схема.png)\n",
		"docs/img/схема.png": PNG,
	});
	const r = p.run("--docs", "--out", "out", "--lang", "ru");
	assert.equal(r.status, 0, r.stderr);
	assert.match(p.read("out/documentation.html"), /src="data:image\/png;base64,/);
	assert.ok(statSync(join(p.dir, "out/documentation.pdf")).size > 1000);
});

test("publish: themes — the kit's by default, the project's with --theme, copied by --init-theme", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project({ "docs/publish/guide.md": GUIDE });
	const init = p.run("--init-theme", "docs/publish/theme");
	assert.equal(init.status, 0, init.stderr);
	for (const f of ["brand.typ", "brand.css"])
		assert.equal(p.read(`docs/publish/theme/${f}`), readFileSync(join(KIT_THEME, f), "utf8"));
	assert.equal(p.run("--init-theme", "docs/publish/theme").status, 1, "refuses to overwrite a project's theme");

	assert.equal(p.run("docs/publish/guide.md", "--out", "default").status, 0);
	assert.match(p.read("default/guide.html"), /--accent: #1f4e79/);
	writeFileSync(join(p.dir, "docs/publish/theme/brand.css"), p.read("docs/publish/theme/brand.css").replace("#1f4e79", "#b00020"));
	writeFileSync(join(p.dir, "docs/publish/theme/brand.typ"), p.read("docs/publish/theme/brand.typ").replace("#1f4e79", "#b00020"));
	const themed = p.run("docs/publish/guide.md", "--out", "themed", "--theme", "docs/publish/theme");
	assert.equal(themed.status, 0, themed.stderr);
	assert.match(p.read("themed/guide.html"), /--accent: #b00020/);
});

test("publish: several files make one document in the given order; a left-out chapter is reported", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project({
		"docs/01-setup.md": "# Setup\n\nThen read [the flow](02-flow.md).\n",
		"docs/02-flow.md": "# Flow\n\nOne.\n",
		"docs/03-ops.md": "# Ops\n\nInternal.\n",
		"docs/04-faq.md": "# FAQ\n\nSee [ops](03-ops.md).\n",
	});
	const r = p.run("docs/02-flow.md", "docs/01-setup.md", "--title", "Partner guide", "--audience", "Acme", "--out", "out");
	assert.equal(r.status, 0, r.stderr);
	const html = p.read("out/partner-guide.html");
	assert.ok(html.indexOf('id="ch-02-flow"') > 0 && html.indexOf('id="ch-02-flow"') < html.indexOf('id="ch-01-setup"'));
	assert.match(html, /href="#ch-02-flow"/);
	assert.doesNotMatch(html, /Internal/);
	const left = p.run("docs/01-setup.md", "docs/04-faq.md", "--title", "Guide", "--out", "out2");
	assert.equal(left.status, 1);
	assert.match(left.stderr, /docs\/04-faq\.md: 03-ops\.md/);
	assert.equal(p.run("docs/01-setup.md", "docs/02-flow.md", "--out", "out3").status, 1, "several files need --title");
});

test("rewriteLinks: dropRepoLinks keeps the text of a link into the repo and drops the link", () => {
	const r = rewriteLinks("The handler is [createPayout](../src/payouts.ts); see [f](02-flow.md).", { from, chapters, repoDir: repo, dropRepoLinks: true });
	assert.equal(r.text, "The handler is createPayout; see [f](#ch-02-flow).");
	assert.deepEqual(r.outside, []);
});
