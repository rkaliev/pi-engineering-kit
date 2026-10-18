---
name: publishing-documents
description: Use when someone needs a document outside the repo, as a PDF or single-file HTML for a partner, client, auditor or manager, such as project docs, a report, a proposal or client release notes
---

# Publishing documents

A published document is a view of Markdown kept in the repo, built by one command into a single-file HTML and a PDF in the project's look. Its reader has no repo access: what they get stands on its own and holds only what is meant for them.

## The source stays Markdown in the repo

- **Project docs for outsiders:** choose chapters of `docs/`, never copy them. `--docs` takes every chapter in `docs/README.md`'s order; listing files takes only those, in your order.
- **A report or proposal:** `docs/publish/<doc>.md` with frontmatter (`title`, `subtitle`, `audience`, `version`, `date`, `lang`, `author`), committed like any doc.
- **Client release notes:** `--changelog <version>`. Where the entries are written for developers, write the client's version as `docs/publish/release-<version>.md` instead.

A copy edited for one reader drifts from the docs. When a chapter must differ for an audience, leave it out, or give that audience its own document in `docs/publish/`.

## Build

```bash
node "scripts/publish.ts" docs/01-overview.md docs/02-integration.md \
  --title "Payouts integration" --audience "Acme" --version 1.4 --theme docs/publish/theme --out <ignored dir>
```

(`scripts/publish.ts` is in this skill's directory.)

- **Tools:** pandoc ≥ 3.8, Typst, and mermaid-cli when there are diagrams. The script names what is missing; installing it needs the user's agreement.
- **Theme:** once per project, `--init-theme docs/publish/theme` and commit it; colours and fonts are at the top of `brand.typ` and `brand.css`. Without `--theme` the kit's theme is used.
- **Output:** a folder git ignores. The files are never committed; the Markdown is the record.
- **A failed build lists every finding.** A link into the repo: `--drop-repo-links` keeps its text and drops the link in the output; `--repo-url` only when this reader can open the repo. A diagram's `accTitle` becomes its alt text.
- **The team's docs stay written for the team.** Don't remove their links or rename code in them to suit an outside reader; the build options, leaving a chapter out, or a document of the reader's own in `docs/publish/` do that. Fix a source only where it is wrong for everyone.

## Before handing it over

1. **Audience.** Read every source for what this reader must not see: internal decisions and their reasons, prices, costs and margins, internal hosts and dashboards, on-call details, secrets, other customers. Leave that chapter out (decision records stay out unless asked for) or move the text.
2. **Gaps.** Placeholder hosts, `<token>`, TODOs, and what this reader needs but the docs don't say: list them for the user; never fill them with guesses.
3. **Look at every page** of the PDF, and the HTML: cover, contents, diagrams, tables and code not cut off.
4. **Report** the files, the sources used, what was left out and why, and what is still open.

Sending, uploading or publishing the file is the user's action.
