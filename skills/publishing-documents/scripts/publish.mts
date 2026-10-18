/**
 * Builds a standalone HTML file and a PDF from the repo's Markdown, for readers outside the repo.
 *
 *   node publish.mts (<file.md>… | --docs [<dir>] | --changelog <version> [<file>]) --out <dir>
 *        [--theme <dir>] [--repo-url <url> | --drop-repo-links] [--title …] [--subtitle …] [--audience …] [--version …] [--date …] [--lang …] [--author …]
 *   node publish.mts --init-theme <dir>
 *
 * Sources are read as GitHub-style Markdown (pandoc's commonmark_x) into pandoc's JSON tree, where links, heading
 * ids and images are checked and rewritten; the combined tree is written to HTML and to PDF (Typst).
 * Several files make one document in the given order (pass --title); links between them stay inside it.
 * Without --theme, docs/publish/theme/ is used when it exists, else the kit's theme.
 * Needs pandoc >= 3.8 and Typst, plus mermaid-cli (`mmdc`) when a source has a Mermaid diagram. On Windows, use WSL.
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

/**
 * One version's section of a CHANGELOG, without its heading; null when the version isn't there. Recognises
 * `## 1.2.0`, `## [1.2.0] - date` (Keep a Changelog), `## [1.2.0](compare-url) (date)` and `# [1.2.0](…)`.
 */
export function extractChangelog(text: string, version: string): string | null {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const heading = new RegExp(`^(#{1,6}) \\[?v?${escaped}\\]?(?=[\\s(]|$)`);
	const start = lines.findIndex((l) => heading.test(l));
	if (start < 0) return null;
	const level = lines[start]!.match(heading)![1]!.length;
	const rest = lines.slice(start + 1);
	// The section ends at a heading of the same or a higher level, or at any version heading
	// (semantic-release writes minors as `#` and patches as `##`); `#` lines inside code fences don't count.
	let fence: string | undefined;
	const end = rest.findIndex((l) => {
		const f = l.match(/^\s*(`{3,}|~{3,})/)?.[1];
		if (f && (!fence || f[0] === fence[0])) fence = fence ? undefined : f;
		return !fence && !f && (new RegExp(`^#{1,${level}} `).test(l) || /^#{1,6} \[?v?\d+\.\d+/.test(l));
	});
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

function toPosix(p: string): string {
	return p.split("\\").join("/");
}

// ---------------------------------------------------------------- pandoc's JSON tree

/** A node of pandoc's JSON AST: `t` is the type, `c` its contents (shape depends on the type). */
export type Node = { t: string; c?: any };
export type Doc = { "pandoc-api-version": number[]; meta: Record<string, Node>; blocks: Node[] };

/** The plain text of inlines, blocks or a metadata value. */
export function stringify(x: unknown): string {
	if (Array.isArray(x)) return x.map(stringify).join("");
	if (!x || typeof x !== "object") return "";
	const n = x as Node;
	if (n.t === "Str" || n.t === "MetaString") return n.c;
	if (n.t === "Space" || n.t === "SoftBreak" || n.t === "LineBreak") return " ";
	if (n.t === "Code") return n.c[1];
	if (n.t === "Link" || n.t === "Image" || n.t === "Span") return stringify(n.c[1]);
	if (n.t === "Note" || n.t === "RawInline" || n.t === "RawBlock" || n.t === "CodeBlock") return "";
	return stringify(n.c);
}

/** Calls `f` on every node, depth first, children before parents; `f` may return a replacement. */
function walk(x: unknown, f: (n: Node) => Node | undefined): unknown {
	if (Array.isArray(x)) return x.map((v) => walk(v, f));
	if (!x || typeof x !== "object") return x;
	const n = x as Node;
	if (typeof n.t !== "string") return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v, f)]));
	const inner: Node = "c" in n ? { t: n.t, c: walk(n.c, f) } : { t: n.t };
	return f(inner) ?? inner;
}

/** Every Link target, in document order. */
function linkTargets(blocks: unknown): string[] {
	const found: string[] = [];
	walk(blocks, (n) => {
		if (n.t === "Link") found.push(n.c[2][0]);
		return undefined;
	});
	return found;
}

function decode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Chapter files linked from a docs index's AST, decoded, in the index's order. */
export function indexChapters(doc: Doc): string[] {
	const chapters: string[] = [];
	for (const url of linkTargets(doc.blocks)) {
		const href = decode(url.replace(/[?#].*$/, "")).replace(/^\.\//, "");
		if (CHAPTER.test(href) && !chapters.includes(href)) chapters.push(href);
	}
	return chapters;
}

export type SourceOptions = {
	from: string;
	chapters: Map<string, string>;
	/** Each chapter's own ids (by chapter anchor), to check `NN-x.md#frag` links; unchecked when absent. */
	chapterIds?: Map<string, Set<string>>;
	anchor?: string;
	repoDir: string;
	repoUrl?: string;
	dropRepoLinks?: boolean;
	assetsDir: string;
};

/**
 * Makes one source stand alone: inside a chapter (`anchor`) its ids get the chapter's prefix and its blocks a
 * wrapping Div; chapter links become anchors, links into the repo are reported (or dropped, or rewritten to
 * `repoUrl`), local images move to `assetsDir`, and raw HTML pointing at local files is a finding.
 */
export function prepareSource(doc: Doc, o: SourceOptions): { blocks: Node[]; outside: string[]; images: string[]; findings: string[] } {
	const outside: string[] = [];
	const images: string[] = [];
	const findings: string[] = [];
	const fromRel = toPosix(relative(o.repoDir, o.from));
	const id = (local: string) => (o.anchor && local ? `${o.anchor}--${local}` : local);
	const ids = idsOf(doc.blocks);
	const resolveTarget = (path: string) => (path.startsWith("/") ? resolve(o.repoDir, `.${path}`) : resolve(dirname(o.from), path));

	const blocks = walk(doc.blocks, (n) => {
		const attr = attrOf(n);
		if (attr?.[0]) attr[0] = id(attr[0]);
		if (n.t === "RawInline" || n.t === "RawBlock") {
			if (!/^html/.test(n.c[0])) return undefined;
			for (const m of (n.c[1] as string).matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi))
				if (!isExternal(m[1]!)) findings.push(`${fromRel}: raw HTML link ${m[1]}: write it as a Markdown link`);
			// Anchors written as raw HTML (`<a id>`, `<a name>`) move into the chapter's namespace too.
			n.c[1] = (n.c[1] as string).replace(RAW_ID, (_, k: string, q: string, v: string) => `${k}=${q}${id(v)}${q}`);
			return undefined;
		}
		if (n.t !== "Link" && n.t !== "Image") return undefined;
		const url: string = n.c[2][0];
		if (isExternal(url)) return undefined;
		const [, rawPath, rest] = url.match(/^([^?#]*)(.*)$/)!;
		if (!rawPath) {
			const frag = decode(rest!.slice(1));
			if (n.t === "Link" && frag === "top" && !ids.has(frag)) n.c[2][0] = o.anchor ? `#${o.anchor}` : "#top";
			else if (n.t === "Link" && frag) {
				if (!ids.has(frag)) findings.push(`${fromRel}: anchor #${frag} not found`);
				n.c[2][0] = `#${id(frag)}`;
			}
			return undefined;
		}
		const target = resolveTarget(decode(rawPath));
		if (n.t === "Image") {
			images.push(target);
			n.c[2][0] = `${o.assetsDir}/${images.length}-${basename(target)}`;
			return undefined;
		}
		const chapter = o.chapters.get(target);
		const frag = rest!.startsWith("#") ? decode(rest!.slice(1)) : "";
		if (chapter && frag && o.chapterIds?.get(chapter) && !o.chapterIds.get(chapter)!.has(frag)) findings.push(`${fromRel}: ${url} not found`);
		if (chapter) n.c[2][0] = frag ? `#${chapter}--${frag}` : `#${chapter}`;
		else if (o.dropRepoLinks) return { t: "Span", c: [["", [], []], n.c[1]] };
		else if (o.repoUrl) n.c[2][0] = `${o.repoUrl.replace(/\/$/, "")}/${toPosix(relative(o.repoDir, target))}${rest}`;
		else outside.push(`${fromRel}: ${url}`);
		return undefined;
	}) as Node[];
	// An empty marker, not a wrapper: pandoc's contents list doesn't look inside a Div that doesn't start with a heading.
	return { blocks: o.anchor ? [{ t: "Div", c: [[o.anchor, [], []], []] }, ...blocks] : blocks, outside, images, findings };
}

const RAW_ID = /\b(id|name)\s*=\s*(["'])([^"']+)\2/gi;

/** Every id a source defines: headings, divs, spans, code, and `id`/`name` in raw HTML. */
export function idsOf(blocks: unknown): Set<string> {
	const ids = new Set<string>();
	walk(blocks, (n) => {
		const attr = attrOf(n);
		if (attr?.[0]) ids.add(attr[0]);
		if ((n.t === "RawInline" || n.t === "RawBlock") && /^html/.test(n.c[0])) for (const m of (n.c[1] as string).matchAll(RAW_ID)) ids.add(m[3]!);
		return undefined;
	});
	return ids;
}

/** A URL with a scheme, a protocol-relative URL, or data: — nothing to check locally. */
function isExternal(url: string): boolean {
	return /^[a-z][a-z0-9+.-]*:|^\/\//i.test(url);
}

/** The Attr ([id, classes, keyvals]) of a node that carries one, or undefined. */
function attrOf(n: Node): [string, string[], [string, string][]] | undefined {
	if (n.t === "Header") return n.c[1];
	if (n.t === "Div" || n.t === "Span" || n.t === "CodeBlock" || n.t === "Code") return n.c[0];
	return undefined;
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
/** Every external command gets this long; a hang becomes a finding instead of a stuck session. */
const TIMEOUT_MS = 300_000;
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
type Source = { path: string; text: string; anchor?: string };
type Ctx = { a: Args; cwd: string; repoDir: string; findings: string[] };

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

/** A file name from a title: lowercase letters and digits joined by hyphens, or `document`. */
function slug(title: string): string {
	return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "document";
}

function gitRoot(cwd: string): string {
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : cwd;
}

/** Runs a tool with the shared timeout; a non-zero exit or a timeout becomes `error`. */
function tool(cmd: string, args: string[], o: { cwd?: string; input?: string } = {}): { stdout: string; stderr: string; error?: string } {
	const r = spawnSync(cmd, args, { cwd: o.cwd, input: o.input, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
	const stderr = r.stderr ?? "";
	if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return { stdout: "", stderr, error: `${cmd} timed out after ${TIMEOUT_MS / 60_000} minutes` };
	if (r.status !== 0) return { stdout: r.stdout ?? "", stderr, error: stderr.trim() || `${cmd} exited with ${r.status ?? r.signal}` };
	return { stdout: r.stdout, stderr };
}

/** Parses GitHub-style Markdown into pandoc's tree. */
function parse(text: string): Doc | string {
	const r = tool("pandoc", ["-f", "commonmark_x+autolink_bare_uris", "-t", "json"], { input: text });
	return r.error ? r.error : (JSON.parse(r.stdout) as Doc);
}

/** Text from metadata in a source's frontmatter, for the keys publish.mts understands. */
function metaOf(doc: Doc): Meta {
	const meta: Meta = {};
	for (const k of META_KEYS) {
		const v = doc.meta[k];
		if (v) meta[k] = v.t === "MetaList" ? (v.c as Node[]).map(stringify).join(", ") : stringify(v);
	}
	return meta;
}

/** Inlines for one or more lines of plain text. */
function inlines(text: string): Node[] {
	return text.split("\n").flatMap((line, i) => [
		...(i ? [{ t: "LineBreak" }] : []),
		...line.split(" ").flatMap((w, j) => (j ? [{ t: "Space" }, { t: "Str", c: w }] : [{ t: "Str", c: w }])),
	]);
}

/** Step 1, text only: which files make the document, its file name and the metadata from the command line. */
function collectSources(ctx: Ctx): { sources: Source[]; name: string; meta: Meta; index?: string } {
	const { a, cwd, findings } = ctx;
	const read = (file: string, anchor?: string): Source | undefined => {
		const path = resolve(cwd, file);
		if (existsSync(path)) return { path, text: readFileSync(path, "utf8"), anchor };
		findings.push(`${file} not found`);
		return undefined;
	};
	if (a.files.length) {
		const several = a.files.length > 1;
		if (several && !a.meta.title) findings.push("several files make one document: pass --title");
		const seen = new Map<string, string>();
		for (const f of a.files) {
			const other = seen.get(basename(f));
			if (several && other) findings.push(`${other} and ${f} have the same file name: one document can't hold both chapters' anchors`);
			seen.set(basename(f), f);
		}
		const sources = a.files.map((f) => read(f, several ? chapterAnchor(basename(f)) : undefined)).filter((s): s is Source => !!s);
		return { sources, name: several ? slug(a.meta.title ?? "") : basename(a.files[0]!).replace(/\.md$/, ""), meta: {} };
	}
	if (a.docs) {
		const index = resolve(cwd, a.docs, "README.md");
		if (!existsSync(index)) findings.push(`${toPosix(relative(ctx.repoDir, index))} not found`);
		return { sources: [], name: "documentation", meta: {}, index };
	}
	const { version, file } = a.changelog!;
	const log = read(file);
	const section = log && extractChangelog(log.text, version);
	if (log && section === null) findings.push(`version ${version} not found in ${file}`);
	return { sources: log && section ? [{ path: log.path, text: section }] : [], name: `release-notes-${version}`, meta: { title: `Release notes ${version}`, version } };
}

/** Step 2: parse every source, check and rewrite it, copy images and render diagrams into `build`. */
function prepare(ctx: Ctx, collected: ReturnType<typeof collectSources>, build: string): { blocks: Node[]; meta: Meta; api: number[] } {
	const { a, repoDir, findings } = ctx;
	const rel = (p: string) => toPosix(relative(repoDir, p));
	let { sources, meta } = collected;
	if (collected.index) {
		const index = parse(readFileSync(collected.index, "utf8"));
		if (typeof index === "string") return findings.push(`${rel(collected.index)}: ${index}`), { blocks: [], meta, api: [] };
		const title = index.blocks.find((b) => b.t === "Header" && b.c[0] === 1);
		meta = { ...meta, title: title && stringify(title.c[2]) };
		const chapters = indexChapters(index);
		if (!chapters.length) findings.push(`no chapters linked in ${rel(collected.index)}`);
		sources = chapters.flatMap((c) => {
			const path = resolve(dirname(collected.index!), c);
			if (existsSync(path)) return [{ path, text: readFileSync(path, "utf8"), anchor: chapterAnchor(c) }];
			findings.push(`${rel(path)} is linked from the index but not found`);
			return [];
		});
	}
	const chapters = new Map(sources.filter((s) => s.anchor).map((s) => [s.path, s.anchor!]));
	const blocks: Node[] = [];
	let api: number[] = [];
	let diagrams = 0;
	let mmdc: { missing?: string } | undefined; // checked once, at the first diagram
	// Parse everything first, so a link into another chapter can be checked against that chapter's ids.
	const docs = sources.map((s) => parse(s.text));
	const chapterIds = new Map(sources.flatMap((s, i) => (s.anchor && typeof docs[i] !== "string" ? [[s.anchor, idsOf((docs[i] as Doc).blocks)]] : [])));
	sources.forEach((s, i) => {
		const doc = docs[i]!;
		if (typeof doc === "string") return void findings.push(`${rel(s.path)}: ${doc}`);
		api = doc["pandoc-api-version"];
		if (sources.length === 1 && !collected.index && !a.changelog) meta = { ...metaOf(doc), ...meta };
		const assetsDir = `assets/${i + 1}`;
		const r = prepareSource(doc, { from: s.path, chapters, chapterIds, anchor: s.anchor, repoDir, repoUrl: a.repoUrl, dropRepoLinks: a.dropRepoLinks, assetsDir });
		findings.push(...r.outside, ...r.findings);
		r.images.forEach((img, n) => {
			if (!existsSync(img)) return void findings.push(`${rel(s.path)}: image ${rel(img)} not found`);
			mkdirSync(join(build, assetsDir), { recursive: true });
			copyFileSync(img, join(build, assetsDir, `${n + 1}-${basename(img)}`));
		});
		blocks.push(...(walk(r.blocks, (n) => {
			if (n.t !== "CodeBlock" || !(n.c[0][1] as string[]).includes("mermaid")) return undefined;
			mmdc ??= { missing: checkTools({ mermaid: true }).find((f) => f.startsWith("mmdc")) };
			if (mmdc.missing) return void (findings.includes(mmdc.missing) || findings.push(mmdc.missing));
			const code: string = n.c[1];
			const file = `diagram-${++diagrams}`;
			writeFileSync(join(build, `${file}.mmd`), code);
			const run = tool("mmdc", ["-i", `${file}.mmd`, "-o", `${file}.svg`], { cwd: build });
			if (run.error) findings.push(`diagram failed to render in ${rel(s.path)}: ${run.error.split("\n").slice(-1)[0]}`);
			const alt = code.match(/^\s*accTitle:\s*(.+)$/m)?.[1]?.trim() ?? "Diagram";
			return { t: "Para", c: [{ t: "Image", c: [["", [], []], inlines(alt), [`${file}.svg`, ""]] }] };
		}) as Node[]));
	});
	return { blocks, meta, api };
}

/** Step 3: one tree, two outputs, written to `out.html` and `out.pdf` in `build`; false when a build or the final check failed. */
function build(ctx: Ctx, prepared: ReturnType<typeof prepare>, theme: string, build: string): boolean {
	const { findings } = ctx;
	const m = prepared.meta;
	const about = [m.audience && `Audience: ${m.audience}`, m.version && `Version: ${m.version}`].filter(Boolean).join("\n");
	const meta: Record<string, Node> = {};
	for (const k of ["title", "subtitle", "date"] as const) if (m[k]) meta[k] = { t: "MetaInlines", c: inlines(m[k]!) };
	if (m.author) meta.author = { t: "MetaList", c: [{ t: "MetaInlines", c: inlines(m.author) }] };
	meta.lang = { t: "MetaString", c: m.lang ?? "en" };
	// The PDF cover shows audience and version through `thanks` (pandoc forwards no custom fields to Typst);
	// pandoc's HTML template doesn't show `thanks`, so the HTML gets them as a block at the top.
	const pdf: Doc = { "pandoc-api-version": prepared.api, meta: about ? { ...meta, thanks: { t: "MetaInlines", c: inlines(about) } } : meta, blocks: prepared.blocks };
	const htmlBlocks = about ? [{ t: "Div", c: [["", ["doc-meta"], []], [{ t: "Para", c: inlines(about) }]] }, ...prepared.blocks] : prepared.blocks;
	writeFileSync(join(build, "pdf.json"), JSON.stringify(pdf));
	writeFileSync(join(build, "html.json"), JSON.stringify({ ...pdf, meta, blocks: htmlBlocks }));
	for (const f of THEME_FILES) copyFileSync(join(theme, f), join(build, f));
	for (const [format, args] of [
		["HTML", ["html.json", "-s", "--embed-resources", "--css", "brand.css", "-o", "out.html"]],
		["PDF", ["pdf.json", "--pdf-engine=typst", "-V", "template=brand.typ", "-o", "out.pdf"]],
	] as const) {
		const r = tool("pandoc", ["-f", "json", "--toc", ...args], { cwd: build });
		if (r.error) findings.push(`pandoc failed to build the ${format}: ${r.error}`);
		else if (r.stderr.trim()) process.stderr.write(`publish: pandoc (${format}): ${r.stderr.trim()}\n`);
	}
	if (findings.length) return false;
	// Defence in depth: nothing in the HTML may point at a local file.
	for (const m of readFileSync(join(build, "out.html"), "utf8").matchAll(/\b(?:href|src)="([^"]*)"/g))
		if (m[1] && !m[1].startsWith("#") && !/^data:/.test(m[1]) && !isExternal(m[1])) findings.push(`the HTML still points at a local file: ${m[1]}`);
	return !findings.length;
}

function initTheme(dir: string, shown: string): number {
	const existing = THEME_FILES.filter((f) => existsSync(join(dir, f)));
	if (existing.length) {
		process.stderr.write(`publish: ${existing.map((f) => join(shown, f)).join(", ")} already exists; the project's theme is never overwritten\n`);
		return 1;
	}
	mkdirSync(dir, { recursive: true });
	for (const f of THEME_FILES) copyFileSync(join(KIT_THEME, f), join(dir, f));
	process.stdout.write(`${JSON.stringify({ theme: dir })}\n`);
	return 0;
}

/** The command line: returns the exit code (0 built, 1 a check failed, 2 usage). */
export function main(argv: string[]): number {
	if (process.platform === "win32") {
		process.stderr.write("publish: run this in WSL; native Windows is not supported\n");
		return 2;
	}
	let a: Args;
	try {
		a = parseArgs(argv);
	} catch (e) {
		if (!(e instanceof Usage)) throw e;
		process.stderr.write(`publish: ${e.message}\n`);
		return 2;
	}
	const cwd = process.cwd();
	if (a.initTheme) return initTheme(resolve(cwd, a.initTheme), a.initTheme);
	const ctx: Ctx = { a, cwd, repoDir: gitRoot(cwd), findings: [] };
	const fail = () => (process.stderr.write(ctx.findings.map((f) => `publish: ${f}\n`).join("")), 1);

	const collected = collectSources(ctx);
	if (ctx.findings.length) return fail();
	ctx.findings.push(...checkTools({ mermaid: false }));
	const projectTheme = resolve(ctx.repoDir, "docs/publish/theme");
	const theme = a.theme ? resolve(cwd, a.theme) : existsSync(join(projectTheme, "brand.typ")) ? projectTheme : KIT_THEME;
	for (const f of THEME_FILES) if (!existsSync(join(theme, f))) ctx.findings.push(`${join(theme, f)} not found`);
	if (ctx.findings.length) return fail();

	const dir = mkdtempSync(join(tmpdir(), "publish-"));
	try {
		const prepared = prepare(ctx, collected, dir);
		const meta: Meta = { ...prepared.meta, ...a.meta };
		meta.date ??= new Date().toISOString().slice(0, 10);
		meta.lang ??= "en";
		if (!meta.title && !ctx.findings.length) ctx.findings.push("no title: add `title:` to the frontmatter or pass --title");
		if (ctx.findings.length || !build(ctx, { ...prepared, meta }, theme, dir)) return fail();

		const out = resolve(cwd, a.out!);
		mkdirSync(out, { recursive: true });
		const html = join(out, `${collected.name}.html`);
		const pdf = join(out, `${collected.name}.pdf`);
		copyFileSync(join(dir, "out.html"), html);
		copyFileSync(join(dir, "out.pdf"), pdf);
		process.stdout.write(`${JSON.stringify({ html, pdf })}\n`);
		return 0;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
