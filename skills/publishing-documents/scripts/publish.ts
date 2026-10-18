/**
 * Builds a standalone HTML file and a PDF from the repo's Markdown, for readers outside the repo.
 *
 *   node publish.ts (<file.md>… | --docs [<dir>] | --changelog <version> [<file>]) --out <dir>
 *        [--theme <dir>] [--repo-url <url> | --drop-repo-links] [--title …] [--subtitle …] [--audience …] [--version …] [--date …] [--lang …]
 *   node publish.ts --init-theme <dir>
 *
 * Several files make one document in the given order (pass --title); links between them stay inside it.
 * Needs pandoc ≥ 3.8 and Typst, plus mermaid-cli (`mmdc`) when a source has a Mermaid diagram.
 * Every check runs before anything is written to --out; a failed check lists all findings on stderr.
 * Exit 0: built (stdout `{"html":…,"pdf":…}`), 1: a check failed, 2: usage.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHAPTER = /^\d+-[^/]+\.md$/;

/** Chapter files linked from a docs index (`docs/README.md`), in the index's order. */
export function parseIndex(readme: string): string[] {
	const chapters: string[] = [];
	for (const m of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
		const href = m[1]!.replace(/^\.\//, "");
		if (CHAPTER.test(href) && !chapters.includes(href)) chapters.push(href);
	}
	return chapters;
}

/** One version's section of a CHANGELOG, without its heading; null when the version isn't there. */
export function extractChangelog(text: string, version: string): string | null {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const heading = new RegExp(`^## \\[?${escaped}\\]?(\\s|$)`);
	const start = lines.findIndex((l) => heading.test(l));
	if (start < 0) return null;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => l.startsWith("## "));
	return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** The anchor id a chapter gets inside the combined document. */
export function chapterAnchor(file: string): string {
	const name = file.replace(/\.md$/, "");
	if (/^[a-z0-9-]+$/.test(name)) return `ch-${name}`;
	const digits = name.match(/^\d+/)?.[0] ?? "";
	const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
	return `ch-${digits ? `${digits}-` : ""}${hash}`;
}

export type LinkOptions = { from: string; chapters: Map<string, string>; repoDir: string; repoUrl?: string; assetsDir?: string; dropRepoLinks?: boolean };

/**
 * Makes a source's links work in a standalone document: chapter links become in-document anchors,
 * links into the repo are reported (or rewritten to `repoUrl`), and local images move to `assets/`.
 */
export function rewriteLinks(md: string, o: LinkOptions): { text: string; outside: string[]; images: string[] } {
	const outside: string[] = [];
	const images: string[] = [];
	const fromRel = toPosix(relative(o.repoDir, o.from));
	const rewrite = (prose: string) =>
		prose.replace(/(!?)\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))\)/g, (whole, bang: string, label: string, angled?: string, bare?: string) => {
			const href = (angled ?? bare)!;
			if (/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(href)) return whole;
			const [, path, rest] = href.match(/^([^?#]*)(.*)$/)!;
			const target = path!.startsWith("/") ? resolve(o.repoDir, `.${path}`) : resolve(dirname(o.from), path!);
			if (bang) {
				images.push(target);
				return `![${label}](<${o.assetsDir ?? "assets"}/${images.length}-${basename(target)}>)`;
			}
			const anchor = o.chapters.get(target);
			if (anchor) return `[${label}](#${anchor})`;
			if (o.dropRepoLinks) return label;
			if (o.repoUrl) return `[${label}](${o.repoUrl.replace(/\/$/, "")}/${toPosix(relative(o.repoDir, target))}${rest})`;
			outside.push(`${fromRel}: ${href}`);
			return whole;
		});
	// Links inside fenced code blocks and inline code are examples, not links.
	const text = md
		.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m)
		.map((part, i) => (i % 2 ? part : part.split(/(`[^`\n]*`)/).map((p, j) => (j % 2 ? p : rewrite(p))).join("")))
		.join("");
	return { text, outside, images };
}

function toPosix(p: string): string {
	return p.split("\\").join("/");
}

export type Run = (cmd: string, args: string[]) => { status: number | null; stdout: string };

/** What is missing or too old to build; empty when everything is there. */
export function checkTools(o: { mermaid: boolean }, run: Run = defaultRun): string[] {
	const findings: string[] = [];
	const pandoc = run("pandoc", ["--version"]);
	if (pandoc.status !== 0) findings.push(`pandoc not found: install pandoc ${PANDOC_MIN.join(".")} or newer (https://pandoc.org/installing.html)`);
	else {
		const version = pandoc.stdout.match(/^pandoc (\d+)\.(\d+)(?:\.\d+)*/m);
		const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0];
		if (major < PANDOC_MIN[0] || (major === PANDOC_MIN[0] && minor < PANDOC_MIN[1]))
			findings.push(`${version?.[0] ?? "pandoc (unknown version)"} is older than ${PANDOC_MIN.join(".")}: upgrade it (https://pandoc.org/installing.html)`);
	}
	if (run("typst", ["--version"]).status !== 0) findings.push("typst not found: install Typst (https://github.com/typst/typst#installation)");
	if (o.mermaid && run("mmdc", ["--version"]).status !== 0)
		findings.push("mmdc not found: the document has Mermaid diagrams; install @mermaid-js/mermaid-cli (npm i -g @mermaid-js/mermaid-cli)");
	return findings;
}

/** The pandoc version the theme was tested with. */
const PANDOC_MIN = [3, 8] as const;

function defaultRun(cmd: string, args: string[]) {
	const r = spawnSync(cmd, args, { encoding: "utf8" });
	return { status: r.status, stdout: r.stdout ?? "" };
}

const KIT_THEME = resolve(dirname(fileURLToPath(import.meta.url)), "../templates");
const THEME_FILES = ["brand.typ", "brand.css"];
const META_KEYS = ["title", "subtitle", "audience", "version", "date", "lang", "author"] as const;
type Meta = Partial<Record<(typeof META_KEYS)[number], string>>;
type Args = {
	files: string[];
	docs?: string;
	changelog?: { version: string; file: string };
	out?: string;
	theme?: string;
	repoUrl?: string;
	dropRepoLinks?: boolean;
	initTheme?: string;
	meta: Meta;
};
type Source = { path: string; body: string; anchor?: string };

class Usage extends Error {}

function parseArgs(argv: string[]): Args {
	const a: Args = { files: [], meta: {} };
	const value = (i: number) => {
		const v = argv[i + 1];
		if (v === undefined || v.startsWith("--")) throw new Usage(`${argv[i]} needs a value`);
		return v;
	};
	const optional = (i: number) => (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--docs") {
			a.docs = optional(i) ?? "docs";
			if (optional(i)) i++;
		} else if (arg === "--changelog") {
			const version = value(i++);
			const file = optional(i);
			if (file) i++;
			a.changelog = { version, file: file ?? "CHANGELOG.md" };
		} else if (arg === "--out") a.out = value(i++);
		else if (arg === "--theme") a.theme = value(i++);
		else if (arg === "--repo-url") a.repoUrl = value(i++);
		else if (arg === "--drop-repo-links") a.dropRepoLinks = true;
		else if (arg === "--init-theme") a.initTheme = value(i++);
		else if (arg.startsWith("--") && (META_KEYS as readonly string[]).includes(arg.slice(2))) a.meta[arg.slice(2) as keyof Meta] = value(i++);
		else if (arg.startsWith("--")) throw new Usage(`unknown option ${arg}`);
		else a.files.push(arg);
	}
	if (a.initTheme) return a;
	if ([a.files.length > 0, a.docs, a.changelog].filter(Boolean).length !== 1) throw new Usage("give one source: a file, --docs or --changelog");
	if (!a.out) throw new Usage("--out <dir> is required");
	return a;
}

/** Splits a leading `---` block of `key: value` lines from the body. */
function frontmatter(text: string): { meta: Meta; body: string } {
	const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?/);
	if (!m) return { meta: {}, body: text };
	const meta: Meta = {};
	for (const line of m[1]!.split("\n")) {
		const kv = line.match(/^([a-z]+):\s*(.*)$/);
		if (kv && (META_KEYS as readonly string[]).includes(kv[1]!)) meta[kv[1] as keyof Meta] = kv[2]!.replace(/^(["'])(.*)\1$/, "$2");
	}
	return { meta, body: text.slice(m[0].length) };
}

/** A file name from a title: lowercase ASCII words joined by hyphens, or `document`. */
function slug(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document";
}

function gitRoot(cwd: string): string {
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : cwd;
}

/** Gives the chapter's first `# ` heading the chapter's anchor, or adds an anchor before it. */
function anchorChapter(body: string, anchor: string): string {
	return /^# .+$/m.test(body) ? body.replace(/^# (.+?)\s*$/m, `# $1 {#${anchor}}`) : `[]{#${anchor}}\n\n${body}`;
}

/** Renders a source's Mermaid blocks to SVG in `build`; alt text comes from each diagram's `accTitle`. */
function renderDiagrams(body: string, build: string, name: string): { body: string } | { error: string } {
	if (!/^```mermaid\s*$/m.test(body)) return { body };
	writeFileSync(join(build, `${name}.src.md`), body);
	const r = spawnSync("mmdc", ["-i", `${name}.src.md`, "-o", `${name}.md`, "-e", "svg"], { cwd: build, encoding: "utf8" });
	if (r.status !== 0) return { error: (r.stderr || r.stdout).trim().split("\n").slice(-1)[0] ?? "" };
	// mmdc writes `![diagram](./x.svg "<accTitle>")`; the accTitle becomes the alt text.
	const rendered = readFileSync(join(build, `${name}.md`), "utf8").replace(
		/!\[diagram\]\((\.\/[^)\s]+\.svg)(?: "([^"]*)")?\)/g,
		(_, src: string, title?: string) => `![${title || "Diagram"}](${src})`,
	);
	return { body: rendered };
}

/** The command line: returns the exit code (0 built, 1 a check failed, 2 usage). */
export function main(argv: string[]): number {
	let a: Args;
	try {
		a = parseArgs(argv);
	} catch (e) {
		if (!(e instanceof Usage)) throw e;
		process.stderr.write(`publish: ${e.message}\n`);
		return 2;
	}
	const cwd = process.cwd();
	if (a.initTheme) {
		const dir = resolve(cwd, a.initTheme);
		const existing = THEME_FILES.filter((f) => existsSync(join(dir, f)));
		if (existing.length) {
			process.stderr.write(`publish: ${existing.map((f) => join(a.initTheme!, f)).join(", ")} already exists; the project's theme is never overwritten\n`);
			return 1;
		}
		mkdirSync(dir, { recursive: true });
		for (const f of THEME_FILES) copyFileSync(join(KIT_THEME, f), join(dir, f));
		process.stdout.write(`${JSON.stringify({ theme: dir })}\n`);
		return 0;
	}

	const repoDir = gitRoot(cwd);
	const findings: string[] = [];
	const fail = () => {
		process.stderr.write(findings.map((f) => `publish: ${f}\n`).join(""));
		return 1;
	};
	const rel = (p: string) => relative(repoDir, p).split("\\").join("/");

	// Sources and metadata.
	const sources: Source[] = [];
	let meta: Meta = {};
	let name: string;
	if (a.files.length) {
		const several = a.files.length > 1;
		for (const file of a.files) {
			const path = resolve(cwd, file);
			if (!existsSync(path)) {
				findings.push(`${file} not found`);
				continue;
			}
			const fm = frontmatter(readFileSync(path, "utf8"));
			if (!several) meta = fm.meta;
			sources.push({ path, body: fm.body, anchor: several ? chapterAnchor(basename(file)) : undefined });
		}
		if (several && !a.meta.title) findings.push("several files make one document: pass --title");
		name = several ? slug(a.meta.title ?? "") : basename(a.files[0]!).replace(/\.md$/, "");
	} else if (a.docs) {
		const index = resolve(cwd, a.docs, "README.md");
		if (!existsSync(index)) findings.push(`${rel(index)} not found`);
		else {
			const readme = readFileSync(index, "utf8");
			meta.title = readme.match(/^# (.+)$/m)?.[1]?.trim();
			const chapters = parseIndex(readme);
			if (!chapters.length) findings.push(`no chapters linked in ${rel(index)}`);
			for (const c of chapters) {
				const path = resolve(dirname(index), c);
				if (!existsSync(path)) findings.push(`${rel(path)} is linked from the index but not found`);
				else sources.push({ path, body: readFileSync(path, "utf8"), anchor: chapterAnchor(c) });
			}
		}
		name = "documentation";
	} else {
		const { version, file } = a.changelog!;
		const path = resolve(cwd, file);
		const section = existsSync(path) ? extractChangelog(readFileSync(path, "utf8"), version) : null;
		if (!existsSync(path)) findings.push(`${file} not found`);
		else if (section === null) findings.push(`version ${version} not found in ${file}`);
		else sources.push({ path, body: section });
		meta = { title: `Release notes ${version}`, version };
		name = `release-notes-${version}`;
	}
	meta = { ...meta, ...a.meta };
	meta.date ??= new Date().toISOString().slice(0, 10);
	meta.lang ??= "en";
	if (!meta.title && !findings.length) findings.push("no title: add `title:` to the frontmatter or pass --title");
	if (findings.length) return fail();

	// Tools, then every source: links, images, diagrams.
	findings.push(...checkTools({ mermaid: sources.some((s) => /^```mermaid\s*$/m.test(s.body)) }));
	if (findings.length) return fail();
	const theme = a.theme ? resolve(cwd, a.theme) : KIT_THEME;
	for (const f of THEME_FILES) if (!existsSync(join(theme, f))) findings.push(`${join(a.theme ?? KIT_THEME, f)} not found`);
	const build = mkdtempSync(join(tmpdir(), "publish-"));
	try {
		const chapters = new Map(sources.filter((s) => s.anchor).map((s) => [s.path, s.anchor!]));
		const bodies: string[] = [];
		sources.forEach((s, i) => {
			const links = rewriteLinks(s.body, { from: s.path, chapters, repoDir, repoUrl: a.repoUrl, dropRepoLinks: a.dropRepoLinks, assetsDir: `assets/${i + 1}` });
			findings.push(...links.outside);
			links.images.forEach((img, n) => {
				if (!existsSync(img)) findings.push(`${rel(s.path)}: image ${rel(img)} not found`);
				else {
					mkdirSync(join(build, "assets", String(i + 1)), { recursive: true });
					copyFileSync(img, join(build, "assets", String(i + 1), `${n + 1}-${basename(img)}`));
				}
			});
			const diagrams = renderDiagrams(links.text, build, `source-${i + 1}`);
			if ("error" in diagrams) findings.push(`diagram failed to render in ${rel(s.path)}: ${diagrams.error}`);
			else bodies.push(s.anchor ? anchorChapter(diagrams.body, s.anchor) : diagrams.body);
		});
		if (findings.length) return fail();

		// One document, two outputs.
		const thanks = [meta.audience && `Audience: ${meta.audience}`, meta.version && `Version: ${meta.version}`].filter(Boolean).join("\\\n");
		const yaml = Object.entries({ title: meta.title, subtitle: meta.subtitle, author: meta.author, date: meta.date, lang: meta.lang, thanks: thanks || undefined })
			.filter(([, v]) => v)
			.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
			.join("\n");
		writeFileSync(join(build, "doc.md"), `---\n${yaml}\n---\n\n${bodies.join("\n\n")}\n`);
		for (const f of THEME_FILES) copyFileSync(join(theme, f), join(build, f));
		const pandoc = (args: string[]) => spawnSync("pandoc", ["doc.md", "-f", "markdown-implicit_figures", "--toc", ...args], { cwd: build, encoding: "utf8" });
		for (const [format, args] of [
			["HTML", ["-s", "--embed-resources", "--css", "brand.css", "-o", "out.html"]],
			["PDF", ["--pdf-engine=typst", "-V", "template=brand.typ", "-o", "out.pdf"]],
		] as const) {
			const r = pandoc([...args]);
			if (r.status !== 0) findings.push(`pandoc failed to build the ${format}: ${r.stderr.trim()}`);
		}
		if (findings.length) return fail();

		const out = resolve(cwd, a.out!);
		mkdirSync(out, { recursive: true });
		const html = join(out, `${name}.html`);
		const pdf = join(out, `${name}.pdf`);
		copyFileSync(join(build, "out.html"), html);
		copyFileSync(join(build, "out.pdf"), pdf);
		process.stdout.write(`${JSON.stringify({ html, pdf })}\n`);
		return 0;
	} finally {
		rmSync(build, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
