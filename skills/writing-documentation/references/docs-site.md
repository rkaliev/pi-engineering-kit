# A documentation site from docs/

A site is another way to read `docs/`, not a second copy of it. It is worth having when people outside the repo read the docs, or when the chapters outgrow the repo host's file view and need search. Otherwise the repo host's view of `docs/` is the site.

## The Markdown stays the source

- **Every word lives in `docs/`.** The site config holds the theme, the menu and the base path, never text. A page rendered only on the site is a page the repo doesn't have.
- **The chapters stay plain Markdown** with a `# Title` heading, readable on the repo host. A generator that needs frontmatter on every page, or its own content folder, is the wrong one for an existing `docs/`.
- **The menu comes from the files**, in their `NN-` order, never from a list typed into the config. A typed list is a second index: a new chapter missing from it is a page nobody finds. `docs/README.md` stays the index readers see first.
- **Links work in both places.** Link a folder through its `README.md`, and the site serves that file as the folder's index. A link out of `docs/` (to code) is a 404 on the site: the config rewrites it to the file's URL on the repo host, keeping any `#fragment`. Check what the generator does with these and with links from the repo root (`/src/…`); the example below handles them for VitePress. Where the generator can't rewrite them, name code by its path in backticks instead of linking it.
- **Working files stay off the site.** Task files (`docs/tasks/`) are excluded from the build and the search.

## Choosing the generator

1. The project's own, if it has one.
2. A JS or TS project: **VitePress**. It reads `docs/` as it is, takes the title from the first heading, and fails the build on a dead link between pages.
3. Any other stack: **Zensical**, the successor to Material for MkDocs, which reads an `mkdocs.yml`; `zensical build --strict` fails on a dead link and the menu follows the files. A project already on Material for MkDocs stays on it until it migrates.

Before adding one, check that it is maintained (recent releases, no end-of-life notice) and tell the user what you found; this market moves. Adding the tool and its CI job needs the user's agreement, like any dependency.

## The build is a check

- **Strict,** in CI on every PR, as a job the required `gate` job depends on (ci-quality-gates): a dead link or a missing page fails it. Don't limit it to PRs that touch `docs/`: the gate fails on a skipped job, and a code change can break a link to code.
- **Links to code** are checked on the Markdown source, before the rewrite: `lychee --offline docs` (the links row in `./checks.md`).
- **After the build,** check the links in the output offline: `lychee --offline --root-dir <absolute output dir> <output dir>` (output built with base `/`) finds local links the generator let through. The rewritten repo-host URLs it skips are the code links already checked on the source.
- **Anchors** across pages are not checked by the build, and GitHub and VitePress slug some headings differently; link pages rather than headings where you can.
- **Diagrams:** VitePress (through `vitepress-plugin-mermaid`) and Zensical draw Mermaid in the browser, so a broken diagram builds fine; keep the `mmdc` check from `./checks.md`.
- **Index:** every chapter is in `docs/README.md` (the index check in `./checks.md`).

## Publishing

Publishing is an outward action. Before setting up a deploy or PR previews, agree with the user:
- **who may read it.** A public site publishes all of `docs/`, decision records included; PR previews are usually public too, and a Pages site of a private repo can be public. Exclude what isn't for that audience, or choose access-controlled hosting.
- **when it updates:** on merge to the base branch, from CI; never from a laptop.

## Example: VitePress on an existing docs/

`docs/.vitepress/config.mts`, with `npx vitepress build docs` as the build command. It assumes `docs/` sits at the repo root; diagrams need `vitepress-plugin-mermaid` on top. Ignore `docs/.vitepress/cache` and `docs/.vitepress/dist` in git, and leave `.vitepress/` and `tasks/` out of the index check.

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

const docsDir = fileURLToPath(new URL('..', import.meta.url))
const repoDir = resolve(docsDir, '..')
const repoFiles = '<repo URL>/blob/<base branch>/' // GitLab: <repo URL>/-/blob/<base branch>/

// The menu is built from the chapter files, so no chapter can be missing from it.
const chapters = readdirSync(docsDir)
  .filter((f) => /^\d+-.+\.md$/.test(f))
  .sort()
  .map((f) => ({
    text: readFileSync(resolve(docsDir, f), 'utf8').match(/^# (.+)$/m)?.[1] ?? f,
    link: `/${f.replace(/\.md$/, '')}`,
  }))

export default defineConfig({
  title: '<project>',
  base: process.env.DOCS_BASE ?? '/',
  srcExclude: ['tasks/**'],
  rewrites: { 'README.md': 'index.md', ':dir/README.md': ':dir/index.md' },
  markdown: {
    config(md) {
      const render = md.renderer.rules.link_open ?? ((t, i, o, _e, self) => self.renderToken(t, i, o))
      md.renderer.rules.link_open = (tokens, i, options, env, self) => {
        const href = tokens[i].attrGet('href') ?? ''
        if (!/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(href)) {
          const [, path, rest] = href.match(/^([^?#]*)(.*)$/)!
          const page = env.realPath ?? resolve(docsDir, env.relativePath) // the search index sets no realPath
          // A link starting with / is from the repo root, as on the repo host.
          const target = path.startsWith('/') ? resolve(repoDir, `.${path}`) : resolve(dirname(page), path)
          const posixPath = (p: string) => p.split('\\').join('/')
          if (relative(docsDir, target).startsWith('..')) {
            // Code and other files outside docs/ open on the repo host.
            tokens[i].attrSet('href', repoFiles + posixPath(relative(repoDir, target)) + rest)
          } else if (path.startsWith('/') || /(^|\/)README\.md$/.test(path)) {
            // Made relative so the dead-link check sees it; a folder's README.md is its index page.
            const link = posixPath(relative(dirname(page), target)).replace(/(^|\/)README\.md$/, '$1index.md')
            tokens[i].attrSet('href', link + rest)
          }
        }
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
