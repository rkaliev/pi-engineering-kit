import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chapterAnchor, checkTools, extractChangelog, indexChapters, prepareSource, stringify, type Doc, type Node } from "../skills/publishing-documents/scripts/publish.mts";

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

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/publishing-documents/scripts/publish.mts");
const KIT_THEME = resolve(dirname(SCRIPT), "../templates");
const NO_TOOLS = checkTools({ mermaid: true }).length > 0;
const SKIP = "mode: needs pandoc, typst and mmdc";
/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A throwaway project; `run` executes publish.mts in it. */
function project(t: TestContext, files: Record<string, string | Buffer>) {
	const dir = mkdtempSync(join(tmpdir(), "publish-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	const run = (...args: string[]) => {
		const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env: process.env });
		return { status: r.status, stdout: r.stdout, stderr: r.stderr };
	};
	const read = (name: string) => readFileSync(join(dir, name), "utf8");
	return { dir, run, read };
}

const GUIDE = "---\ntitle: Export service\nsubtitle: Integration guide\naudience: Partners\nversion: 1.2\n---\n\n# Overview\n\n| Field | Meaning |\n|---|---|\n| `report` | name |\n";
const DIAGRAM = "```mermaid\nsequenceDiagram\n    accTitle: Export request flow\n    A->>B: POST /exports\n```\n";

test("publish: builds HTML and PDF from one file", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project(t, { "docs/publish/guide.md": GUIDE });
	const r = p.run("docs/publish/guide.md", "--out", "out");
	assert.equal(r.status, 0, r.stderr);
	const out = JSON.parse(r.stdout) as { html: string; pdf: string };
	assert.equal(out.html, join(realpathSync(p.dir), "out/guide.html"));
	assert.ok(statSync(out.pdf).size > 1000);
	const html = readFileSync(out.html, "utf8");
	assert.match(html, /Export service/);
	assert.match(html, /Audience: Partners/);
	assert.match(html, /Version: 1\.2/);
	assert.doesNotMatch(html, /(src|href)="(?!data:|#|https?:)[^"]+"/);
});

test("publish: --docs follows the index and links chapters inside the document", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project(t, {
		"docs/README.md": "# Our service\n\n- [Flow](02-flow.md)\n- [Setup](01-setup.md)\n",
		"docs/01-setup.md": "# Setup\n\nThen read [the flow](02-flow.md#steps).\n",
		"docs/02-flow.md": "---\ntitle: Chapter title\n---\n\n# Flow\n\n## Steps\n\nOne.\n",
	});
	const r = p.run("--docs", "--out", "out");
	assert.equal(r.status, 0, r.stderr);
	const html = p.read("out/documentation.html");
	assert.ok(html.indexOf('id="ch-02-flow"') > 0 && html.indexOf('id="ch-02-flow"') < html.indexOf('id="ch-01-setup"'));
	assert.match(html, /href="#ch-02-flow--steps"/);
	assert.match(html, /id="ch-02-flow--steps"/);
	assert.match(html, /<title>Our service<\/title>/);
	assert.doesNotMatch(html, /Chapter title/);

	const empty = project(t, { "docs/README.md": "# Docs\n\nNothing yet.\n" });
	const e = empty.run("--docs", "--out", "out");
	assert.equal(e.status, 1);
	assert.match(e.stderr, /no chapters linked in docs\/README\.md/);
	assert.ok(!existsSync(join(empty.dir, "out")));
});

test("publish: --changelog builds one version", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project(t, { "CHANGELOG.md": "# Changelog\n\n## 0.2.0\n\n- Exports retry\n\n## 0.1.0\n\n- First\n" });
	const r = p.run("--changelog", "0.2.0", "--out", "out");
	assert.equal(r.status, 0, r.stderr);
	const html = p.read("out/release-notes-0.2.0.html");
	assert.match(html, /Release notes 0\.2\.0/);
	assert.match(html, /Exports retry/);
	assert.doesNotMatch(html, /First/);
});

test("publish: diagrams become SVG without a caption; a broken one fails", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project(t, {
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
	const p = project(t, { "docs/publish/api.md": "---\ntitle: API\n---\n\nSee [the handler](../../src/api.ts).\n", "src/api.ts": "" });
	const r = p.run("docs/publish/api.md", "--out", "out");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /docs\/publish\/api\.md: \.\.\/\.\.\/src\/api\.ts/);
	const ok = p.run("docs/publish/api.md", "--out", "out", "--repo-url", "https://git.example/r/blob/main");
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(p.read("out/api.html"), /href="https:\/\/git\.example\/r\/blob\/main\/src\/api\.ts"/);
});

test("publish: a relative image and a Cyrillic chapter name reach both outputs", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project(t, {
		"docs/README.md": "# Сервис\n\n- [Обзор](01-обзор.md)\n",
		"docs/01-обзор.md": "# Обзор\n\n![Схема](img/схема.png)\n",
		"docs/img/схема.png": PNG,
	});
	const r = p.run("--docs", "--out", "out", "--lang", "ru");
	assert.equal(r.status, 0, r.stderr);
	assert.match(p.read("out/documentation.html"), /src="data:image\/png;base64,/);
	assert.doesNotMatch(p.read("out/documentation.html"), /<figcaption/);
	assert.ok(statSync(join(p.dir, "out/documentation.pdf")).size > 1000);
});

test("publish: themes — the kit's by default, the project's with --theme, copied by --init-theme", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project(t, { "docs/publish/guide.md": GUIDE });
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
	const picked = p.run("docs/publish/guide.md", "--out", "picked");
	assert.equal(picked.status, 0, picked.stderr);
	assert.match(p.read("picked/guide.html"), /--accent: #b00020/, "docs/publish/theme is used without --theme");
	writeFileSync(join(p.dir, "docs/publish/theme/brand.typ"), "#let conf(..args) = { this is not typst");
	const broken = p.run("docs/publish/guide.md", "--out", "broken");
	assert.equal(broken.status, 1, "the project's brand.typ is what builds the PDF");
	assert.match(broken.stderr, /pandoc failed to build the PDF/);
});

test("publish: several files make one document in the given order; a left-out chapter is reported", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project(t, {
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
	assert.equal(p.run("docs/01-setup.md", "docs/02-flow.md", "--title", "Руководство партнёра", "--out", "out4").status, 0);
	assert.ok(existsSync(join(p.dir, "out4/руководство-партнёра.html")));
});

// ---------------------------------------------------------------- transforms on pandoc's JSON tree

const A = ["", [], []];
const str = (c: string): Node => ({ t: "Str", c });
const link = (text: string, url: string, title = ""): Node => ({ t: "Link", c: [A, [str(text)], [url, title]] });
const image = (alt: string, url: string): Node => ({ t: "Image", c: [A, [str(alt)], [url, ""]] });
const para = (...c: Node[]): Node => ({ t: "Para", c });
const header = (level: number, id: string, text: string): Node => ({ t: "Header", c: [level, [id, [], []], [str(text)]] });
const doc = (...blocks: Node[]): Doc => ({ "pandoc-api-version": [1, 23, 1], meta: {}, blocks });
const repo = "/r";
const from = "/r/docs/01-setup.md";
const chapters = new Map([["/r/docs/01-setup.md", "ch-01-setup"], ["/r/docs/02-flow.md", "ch-02-flow"], ["/r/docs/01-my setup.md", "ch-01-x"]]);
const opts = { from, chapters, repoDir: repo, assetsDir: "assets/1" };
/** The targets of every node of type `t` in the prepared blocks, in order. */
function targets(x: unknown, t = "Link", out: string[] = []): string[] {
	if (Array.isArray(x)) for (const v of x) targets(v, t, out);
	else if (x && typeof x === "object") {
		const n = x as Node;
		if (n.t === t) out.push(n.c[2][0]);
		if ("c" in n) targets(n.c, t, out);
	}
	return out;
}
const urls = (blocks: unknown) => targets(blocks);

test("stringify flattens inlines", () => {
	assert.equal(stringify([str("Export"), { t: "Space" }, { t: "Code", c: [A, "POST"] }, { t: "Space" }, { t: "Emph", c: [str("now")] }]), "Export POST now");
	assert.equal(stringify({ t: "MetaInlines", c: [str("A"), { t: "Space" }, str("B")] }), "A B");
});

test("indexChapters keeps the index order and only chapter links, decoded", () => {
	const readme = doc(
		header(1, "docs", "Docs"),
		para(link("02", "02-flow.md", "Flow"), link("01", "./01-setup.md"), link("sp", "01-my%20setup.md")),
		para(link("d", "decisions/README.md"), link("x", "https://e.com/03-x.md"), link("02 again", "02-flow.md")),
	);
	assert.deepEqual(indexChapters(readme), ["02-flow.md", "01-setup.md", "01-my setup.md"]);
});

test("prepareSource: links to chapters become anchors; titled, angle-bracket and encoded targets resolve", () => {
	const r = prepareSource(doc(para(link("f", "02-flow.md", "Flow"), link("o", "02-flow.md#overview"), link("s", "01-my%20setup.md"))), { ...opts, anchor: "ch-01-setup" });
	assert.deepEqual(urls(r.blocks), ["#ch-02-flow", "#ch-02-flow--overview", "#ch-01-x"]);
	assert.deepEqual(r.outside, []);
});

test("prepareSource: a chapter gets its own namespace and its fragments are checked", () => {
	const r = prepareSource(doc(header(1, "setup", "Setup"), header(2, "overview", "Overview"), para(link("o", "#overview"), link("n", "#nope"))), { ...opts, anchor: "ch-01-setup" });
	const [marker, ...rest] = r.blocks;
	assert.deepEqual(marker, { t: "Div", c: [["ch-01-setup", [], []], []] }, "an empty marker, so the contents list still sees the chapter's headings");
	assert.deepEqual(rest.slice(0, 2).map((h: Node) => h.c[1][0]), ["ch-01-setup--setup", "ch-01-setup--overview"]);
	assert.deepEqual(urls(r.blocks), ["#ch-01-setup--overview", "#ch-01-setup--nope"]);
	assert.deepEqual(r.findings, ["docs/01-setup.md: anchor #nope not found"]);
	const single = prepareSource(doc(header(2, "overview", "Overview"), para(link("o", "#overview"))), opts);
	assert.deepEqual(urls(single.blocks), ["#overview"]);
	assert.equal(single.blocks[0]!.t, "Header");
});

test("prepareSource: a link into the repo is reported, dropped or rewritten", () => {
	const src = doc(para(link("c", "../src/a.ts#L3", "Source")));
	assert.deepEqual(prepareSource(src, opts).outside, ["docs/01-setup.md: ../src/a.ts#L3"]);
	const dropped = prepareSource(src, { ...opts, dropRepoLinks: true });
	assert.deepEqual(dropped.outside, []);
	assert.deepEqual(urls(dropped.blocks), []);
	assert.equal(stringify(dropped.blocks), "c");
	const viaUrl = prepareSource(doc(para(link("c", "../src/a.ts#L3"), link("r", "/README.md"))), { ...opts, repoUrl: "https://git.example/r/blob/main/" });
	assert.deepEqual(urls(viaUrl.blocks), ["https://git.example/r/blob/main/src/a.ts#L3", "https://git.example/r/blob/main/README.md"]);
});

test("prepareSource: external links and mailto are left alone", () => {
	const r = prepareSource(doc(para(link("e", "https://e.com/x.md"), link("m", "mailto:a@b.c"), link("p", "//cdn.example/x"))), opts);
	assert.deepEqual(urls(r.blocks), ["https://e.com/x.md", "mailto:a@b.c", "//cdn.example/x"]);
	assert.deepEqual([r.outside, r.findings, r.images], [[], [], []]);
});

test("prepareSource: local images move to assets/, also inside a link", () => {
	const r = prepareSource(doc(para(image("x", "img/a%20b.png"), image("y", "img/схема.png"), image("w", "https://e.com/w.png")), para({ t: "Link", c: [A, [image("s", "img/s.png")], ["https://e.com", ""]] })), opts);
	assert.deepEqual(r.images, ["/r/docs/img/a b.png", "/r/docs/img/схема.png", "/r/docs/img/s.png"]);
	const imgs = targets(r.blocks, "Image");
	assert.deepEqual(imgs, ["assets/1/1-a b.png", "assets/1/2-схема.png", "https://e.com/w.png", "assets/1/3-s.png"]);
	assert.deepEqual(r.outside, []);
});

test("prepareSource: raw HTML with a local link fails; external raw HTML passes", () => {
	const r = prepareSource(doc({ t: "RawBlock", c: ["html", '<a href="../src/a.ts">a</a> <img src="https://e.com/x.png">'] }, para({ t: "RawInline", c: ["html", '<img src="img/x.png">'] })), opts);
	assert.deepEqual(r.findings, [
		"docs/01-setup.md: raw HTML link ../src/a.ts: write it as a Markdown link",
		"docs/01-setup.md: raw HTML link img/x.png: write it as a Markdown link",
	]);
});

test("publish: Markdown as GitHub reads it — CRLF frontmatter, a list after a line, the same heading in two chapters", (t) => {
	if (NO_TOOLS) return t.skip(SKIP);
	const p = project(t, {
		"docs/publish/crlf.md": "---\r\ntitle: CRLF guide\r\nsubtitle: For partners\r\naudience: Acme\r\nversion: 2\r\ndate: 2026-10-01\r\nlang: en\r\nauthor: Team\r\n---\r\n\r\nIt contains:\r\n- one\r\n- two\r\n",
		"docs/01-a.md": "# A\n\n## Overview\n\nSee [this](#overview).\n",
		"docs/02-b.md": "Intro first.\n\n# B\n\n## Overview\n\nSee [this](#overview) and https://example.com/docs.\n",
	});
	const r = p.run("docs/publish/crlf.md", "--out", "out");
	assert.equal(r.status, 0, r.stderr);
	const html = p.read("out/crlf.html");
	assert.match(html, /<title>CRLF guide/);
	assert.doesNotMatch(html, /<hr|<h1 id="[^"]*">(u|en|Team)<\/h1>/);
	assert.match(html, /<ul>\s*<li>one<\/li>/);
	const two = p.run("docs/01-a.md", "docs/02-b.md", "--title", "Both", "--out", "out2");
	assert.equal(two.status, 0, two.stderr);
	const both = p.read("out2/both.html");
	const toc = both.slice(both.indexOf('<nav id="TOC"'), both.indexOf("</nav>"));
	assert.match(toc, /href="#ch-01-a--a"/);
	assert.match(toc, /href="#ch-02-b--b"/, "a chapter that starts with a paragraph is still in the contents");
	assert.match(both, /<a href="https:\/\/example\.com\/docs"/, "a bare URL is a link, as on GitHub");
	for (const ch of ["ch-01-a", "ch-02-b"]) {
		assert.match(both, new RegExp(`id="${ch}--overview"`));
		assert.match(both, new RegExp(`href="#${ch}--overview"`));
	}
});

// ---------------------------------------------------------------- failures that need no tools (run in CI too)

test("publish: missing tools fail before anything is written", (t) => {
	const empty = mkdtempSync(join(tmpdir(), "publish-path-"));
	t.after(() => rmSync(empty, { recursive: true, force: true }));
	const p = project(t, { "docs/publish/guide.md": GUIDE });
	const r = spawnSync(process.execPath, [SCRIPT, "docs/publish/guide.md", "--out", "out"], { cwd: p.dir, encoding: "utf8", env: { PATH: empty } });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /pandoc not found/);
	assert.ok(!existsSync(join(p.dir, "out")));
});

test("publish: an unknown changelog version fails before the tools are needed", (t) => {
	const p = project(t, { "CHANGELOG.md": "# Changelog\n\n## 0.2.0\n\n- b\n" });
	const r = p.run("--changelog", "9.9.9", "--out", "out");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /version 9\.9\.9 not found in CHANGELOG\.md/);
	assert.ok(!existsSync(join(p.dir, "out")));
});

test("extractChangelog: release-please and semantic-release headings", () => {
	const rp = "# Changelog\n\n## [1.2.0](https://x/compare/v1.1.0...v1.2.0) (2026-10-01)\n\n### Features\n\n* a\n\n## [1.1.0](https://x) (2026-09-01)\n\n* b\n";
	assert.equal(extractChangelog(rp, "1.2.0"), "### Features\n\n* a");
	const sr = "# [1.3.0](https://x/compare) (2026-10-02)\n\n### Bug Fixes\n\n* c\n\n# [1.2.0](https://x) (2026-10-01)\n\n* d\n";
	assert.equal(extractChangelog(sr, "1.3.0"), "### Bug Fixes\n\n* c");
});

test("prepareSource: an anchor in another chapter is checked when its ids are known", () => {
	const chapterIds = new Map([["ch-02-flow", new Set(["overview"])]]);
	const r = prepareSource(doc(para(link("o", "02-flow.md#overview"), link("n", "02-flow.md#nope"))), { ...opts, anchor: "ch-01-setup", chapterIds });
	assert.deepEqual(urls(r.blocks), ["#ch-02-flow--overview", "#ch-02-flow--nope"]);
	assert.deepEqual(r.findings, ["docs/01-setup.md: 02-flow.md#nope not found"]);
});

test("prepareSource: #top and anchors from raw HTML are not findings", () => {
	const src = doc({ t: "RawBlock", c: ["html", '<a id="legacy"></a><a name="old"></a>'] }, para(link("t", "#top"), link("l", "#legacy"), link("o", "#old")));
	const inChapter = prepareSource(src, { ...opts, anchor: "ch-01-setup" });
	assert.deepEqual(inChapter.findings, []);
	assert.deepEqual(urls(inChapter.blocks), ["#ch-01-setup", "#ch-01-setup--legacy", "#ch-01-setup--old"]);
	assert.match(JSON.stringify(inChapter.blocks), /id=\\"ch-01-setup--legacy\\".*name=\\"ch-01-setup--old\\"/);
	const single = prepareSource(src, opts);
	assert.deepEqual(single.findings, []);
	assert.deepEqual(urls(single.blocks), ["#top", "#legacy", "#old"]);
});

test("extractChangelog: a # line in code doesn't end a section; a patch section after a minor is its own", () => {
	const fenced = "## 1.2.0\n\n- renamed\n\n```sh\n# rename the variable\nmv a b\n```\n\n## 1.1.0\n\n- old\n";
	assert.equal(extractChangelog(fenced, "1.2.0"), "- renamed\n\n```sh\n# rename the variable\nmv a b\n```");
	const sr = "# [1.3.0](https://x) (2026-10-03)\n\n* feature\n\n## [1.2.1](https://x) (2026-10-02)\n\n* fix\n\n# [1.2.0](https://x) (2026-10-01)\n\n* older\n";
	assert.equal(extractChangelog(sr, "1.3.0"), "* feature");
	assert.equal(extractChangelog(sr, "1.2.1"), "* fix");
});

test("publish: two sources with the same file name fail before the tools are needed", (t) => {
	const p = project(t, { "docs/01-setup.md": "# A\n", "docs/publish/01-setup.md": "# B\n" });
	const r = p.run("docs/01-setup.md", "docs/publish/01-setup.md", "--title", "T", "--out", "out");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /docs\/01-setup\.md and docs\/publish\/01-setup\.md have the same file name/);
	assert.ok(!existsSync(join(p.dir, "out")));
});
