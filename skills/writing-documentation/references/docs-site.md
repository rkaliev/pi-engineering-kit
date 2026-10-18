# A documentation site from docs/

A site is another way to read `docs/`, not a second copy of it. It is worth having when people outside the repo read the docs, or when the chapters outgrow the repo host's file view and need search. Otherwise the repo host's view of `docs/` is the site.

## The Markdown stays the source

- **Every word lives in `docs/`.** The site config holds the theme, the menu and the base path, never text. A page rendered only on the site is a page the repo doesn't have.
- **The chapters stay plain Markdown** with a `# Title` heading, readable on the repo host. A generator that needs frontmatter on every page, or its own content folder, is the wrong one for an existing `docs/`.
- **The menu comes from the files**, in their `NN-` order, never from a list typed into the config. A typed list is a second index: a new chapter missing from it is a page nobody finds. `docs/README.md` stays the index readers see first.
- **Links work in both places.** A link to a folder works on the repo host but is a missing page on the site: link the folder's `README.md`. A link out of `docs/` (to code) is a 404 on the site: rewrite it to the file's URL on the repo host in the config, or write the full URL.

## Choosing the generator

1. The project's own, if it has one.
2. A JS or TS project: **VitePress**. It reads `docs/` as it is, takes the title from the first heading, and fails the build on a dead link between pages.
3. Any other stack: **Zensical**, the successor to Material for MkDocs, which reads an `mkdocs.yml`; `zensical build --strict` fails on a dead link and the menu follows the files. A project already on Material for MkDocs stays on it until it migrates.

Before adding one, check that it is maintained (recent releases, no end-of-life notice) and tell the user what you found; this market moves. Adding the tool and its CI job needs the user's agreement, like any dependency.

## The build is a check

- **Strict:** a dead link or a missing page fails the build, in CI on every PR that touches `docs/`.
- **After the build,** check the links in the output: `lychee --offline <output dir>` finds the links the generator lets through (code paths, rewritten URLs).
- **Diagrams:** VitePress (through a plugin) and Zensical draw Mermaid in the browser, so a broken diagram builds fine; keep the `mmdc` check from `./checks.md`.
- **Index:** every chapter is in `docs/README.md` (the index check in `./checks.md`).

## Publishing

Publishing is an outward action. Before setting up a deploy, agree with the user:
- **who may read it.** A public site publishes all of `docs/`, decision records included, and a Pages site of a private repo can be public. Exclude what isn't for that audience, or choose access-controlled hosting.
- **when it updates:** on merge to the base branch, from CI; never from a laptop.

Build previews from the PR where the host offers them.

## Example: VitePress on an existing docs/

`docs/.vitepress/config.mts`, with `npx vitepress build docs` as the build command:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { defineConfig } from 'vitepress'

const docs = new URL('..', import.meta.url)
const repoFiles = 'https://github.com/<org>/<repo>/blob/main/'

// The menu is built from the chapter files, so no chapter can be missing from it.
const chapters = readdirSync(docs)
  .filter((f) => /^\d+-.+\.md$/.test(f))
  .sort()
  .map((f) => ({
    text: readFileSync(new URL(f, docs), 'utf8').match(/^# (.+)$/m)?.[1] ?? f,
    link: `/${f.replace(/\.md$/, '')}`,
  }))

export default defineConfig({
  title: '<project>',
  base: process.env.DOCS_BASE ?? '/',
  rewrites: { 'README.md': 'index.md', ':dir/README.md': ':dir/index.md' },
  markdown: {
    config(md) {
      // Links that leave docs/ (to code) open on the repo host.
      const render = md.renderer.rules.link_open ?? ((t, i, o, _e, self) => self.renderToken(t, i, o))
      md.renderer.rules.link_open = (tokens, i, options, env, self) => {
        const href = tokens[i].attrGet('href') ?? ''
        const path = posix.normalize(posix.join('docs', posix.dirname(env.relativePath), href))
        if (!/^[a-z]+:|^#/.test(href) && !path.startsWith('docs/')) tokens[i].attrSet('href', repoFiles + path)
        return render(tokens, i, options, env, self)
      }
    },
  },
  themeConfig: {
    search: { provider: 'local' },
    sidebar: [{ text: 'Chapters', items: chapters }],
  },
})
```
